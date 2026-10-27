# 贪吃蛇（单人 + 好友联机）

Next.js 16 写的贪吃蛇。两种玩法：

- **单人模式**：`/`，成绩进 PostgreSQL 排行榜
- **好友联机**：`/room`，2–4 人在同一张 30×30 地图上实时对战，房间内排名

## 本地运行

> ⚠️ 命令必须在 **`my-app` 目录**里执行（仓库根目录的 `npm run dev` 会自动转进来）。

```bash
cd my-app
npm install
npm run dev
```

打开 <http://localhost:3000>。

想和朋友一起玩，把地址发给他们就行——但**别发 `localhost`**，那是你自己电脑的里屋。
要么用根目录的 `启动网站.bat` 起 Cloudflare 隧道，要么发同一 Wi-Fi 下的 `http://192.168.x.x:3000`。

## 常用命令

```bash
npm run dev        # 开发服务器（node server.js --dev）
npm run build      # 生产构建
npm start          # 生产运行（node server.js）
npm run lint       # ESLint
npm run test:game  # 联机内核的碰撞规则测试
```

## 联机模式是怎么跑起来的

```
浏览器 ──HTTP──▶ server.js ──▶ Next App Router（/、/room/*、/api/*）
   └────WS /ws──▶ WebSocketServer ──▶ server/rooms.js（内存房间）
                                      └─ 50Hz 服务端权威循环
```

- **服务端权威**：客户端只发「我要往哪转」，蛇怎么走、谁撞死谁、豆子刷哪里，全部由服务端算。
- **房间在内存里**：不进数据库，所以 **pm2 只能单实例**，开 cluster 会让房间分裂。
- **玩法**：吃豆子变长；撞墙、撞障碍、撞自己、撞到别人的蛇都会出局；两个蛇头抢同一格同归于尽；最后活着的赢。
- **时限 3 分钟**：时间到按剩余分数排名，防止两个人绕圈绕到天荒地老。
- **加速要花体力**：满体力能连飙约 3 秒，松手约 5.6 秒回满，耗尽后要回到 12 才能再次起步。
- **断线**：蛇冻结原地（仍占格、可被撞），30 秒内刷新页面能回到原座位。
- **晚到也能玩**：一局打完后、房主点「再来一局」之前，新朋友仍然可以进房，下一局直接参战。
- **胜场累计**：同一个房间里连打几局，赢的次数会一直累计（结算和战况榜都有「N胜」）。
- **死因说得清**：撞墙、撞自己、撞上谁，观战条和左上角播报都会写明白。
- **音效**：吃豆、阵亡、倒计时、胜负都有声音，全部是 Web Audio 现场合成的，不加载任何音频文件；右上角喇叭可静音（会记住）。

时限可以用环境变量临时改（调参或快速验证「时间到」结算）：

```bash
MATCH_TIME_LIMIT_MS=8000 npm start
```

### 三条不能碰的红线

1. **不要给 `/ws` 建 page / route / middleware**。Next 一旦匹配到路由，会把 WebSocket 连接抢走。
2. **不要在 `next.config.ts` 加 `output: "standalone"`**。它和自定义 server 互斥，加了 `npm start` 直接起不来。
3. **`server.js` 的 upgrade 监听里，非 `/ws` 的请求必须直接 `return`**，绝不能 `socket.destroy()`，否则 HMR 当场断掉。

## 目录速览

| 路径 | 作用 |
|---|---|
| `server.js` | HTTP + Next + WebSocket 分流 |
| `server/config.js` | 地图、出生点、障碍、玩法参数 |
| `server/game.js` | 权威游戏内核（纯函数，可单测） |
| `server/rooms.js` | 房间、大厅、50Hz 循环、广播、重连 |
| `lib/multiplayer/` | 前后端共享的协议类型与配色 |
| `app/room/` | 大厅、创建房间、加入房间三个页面 |
| `app/components/SnakeGame.tsx` | 单人模式（联机功能完全没有动它） |

## 部署

见仓库根目录的 `部署到阿里云.md`。
重点是 nginx 要加 `proxy_read_timeout 3600s`，以及 pm2 必须 `fork` 单实例。
