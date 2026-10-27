/**
 * 自定义服务器：把 Next.js 和联机用的 WebSocket 挂在同一个端口上。
 *
 * 为什么需要它：App Router 的 route handler 接管不了 WebSocket upgrade，
 * 而联机需要双向实时通信，所以只能在 HTTP 层自己分流。
 *
 * 两条铁律（改这个文件前务必先看）：
 * 1. 非 /ws 的 upgrade 请求必须直接 return，绝不能 socket.destroy()，
 *    否则 Next dev 的 HMR 连接会被当场掐断。
 * 2. 不要给 /ws 建任何 page / route / middleware。Next 一旦匹配到路由，
 *    会 socket.end() 把连接抢走（见 next/dist/server/lib/router-server.js）。
 *
 * 还有一条：next.config.ts 里永远不要加 output: "standalone"，
 * 它和自定义 server 互斥，加了之后 npm start 直接起不来。
 */
const http = require("node:http");
const { parse } = require("node:url");
const { WebSocketServer } = require("ws");

// Windows 下没法用 `NODE_ENV=production node server.js` 这种写法，
// 所以用 --dev 参数判断，并且必须在 require("next") 之前设置好环境变量。
const dev = process.argv.includes("--dev");
process.env.NODE_ENV = dev ? "development" : "production";

const hostname = process.env.HOST || "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "3000", 10);

const next = require("next");

// 不传 hostname 给 Next：它会用 hostname 拼内部绝对地址，
// 传 0.0.0.0 会让 HMR 和 Server Action 的来源校验犯迷糊。
const app = next({ dev, dir: __dirname, port, turbopack: true });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = http.createServer((req, res) => {
      handle(req, res, parse(req.url || "/", true)).catch((error) => {
        console.error("[http] 请求处理失败:", error);
        if (!res.headersSent) res.statusCode = 500;
        res.end("Internal Server Error");
      });
    });

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 4 * 1024,
      perMessageDeflate: false,
      // 连接由 rooms.js 自己记账（要按 IP 限流），这里不需要再存一份
      clientTracking: false,
    });

    const hub = require("./server/rooms.js").createHub({ wss });

    server.on("upgrade", (req, socket, head) => {
      const { pathname } = parse(req.url || "/", true);
      // 铁律 1：不是 /ws 就让给 Next，千万别 destroy
      if (pathname !== "/ws") return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`端口 ${port} 已被占用，先关掉占用它的进程再启动。`);
      } else {
        console.error("[server] 服务器出错:", error);
      }
      process.exit(1);
    });

    server.listen(port, hostname, () => {
      console.log(
        `> 贪吃蛇已启动：http://localhost:${port}  (${dev ? "开发模式" : "生产模式"})`,
      );
      console.log(`> 联机通道：ws://localhost:${port}/ws`);
    });

    let closing = false;
    const shutdown = (signal) => {
      if (closing) return;
      closing = true;
      console.log(`\n[server] 收到 ${signal}，正在关闭…`);

      try {
        // 通知所有房间「服务器要重启了」，让前端给出人话提示
        hub.shutdown("server_restart");
      } catch (error) {
        console.error("[server] 关闭房间时出错:", error);
      }

      wss.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  })
  .catch((error) => {
    console.error("[server] Next.js 启动失败:", error);
    process.exit(1);
  });
