"use strict";

/**
 * 房间中枢：连接管理 + 大厅 + 50Hz 权威循环 + 广播 + 回收。
 *
 * 设计前提（很重要，改之前先看）：
 * 1. 房间状态全部放进程内存，不进数据库。Neon 是 HTTP 驱动且在新加坡，
 *    每帧写库会把游戏卡成 PPT。
 * 2. 因此部署必须单进程（pm2 fork 单实例）。开 cluster 会让房间分裂成
 *    互不可见的平行世界。
 * 3. 创建 / 加入房间只能走 WebSocket 首帧，不能走 app/api 路由——
 *    那边是另一个模块实例，会拿到一个空 Map。
 */

const { randomUUID, randomInt } = require("node:crypto");

const {
  CONFIG,
  MATCH_TIME_LIMIT_MS,
  OBSTACLE_SET,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  TIMING,
  LIMITS,
} = require("./config.js");
const game = require("./game.js");

const WS_OPEN = 1;

const ERROR_MESSAGES = {
  BAD_MESSAGE: "消息格式不对",
  ROOM_NOT_FOUND: "房间不存在或已解散，检查一下房间码",
  ROOM_FULL: "房间已满（最多 4 人）",
  ROOM_STARTED: "这一局已经开始了，等下一局吧",
  NAME_INVALID: "请先输入你的名字",
  NOT_HOST: "只有房主能操作",
  NOT_ENOUGH_PLAYERS: "至少需要 2 个人才能开始",
  RATE_LIMITED: "操作太快了，缓一缓",
  SERVER_FULL: "服务器房间已满，稍后再试",
  TOO_MANY_ROOMS: "你建的房间有点多，先用已有的房间吧",
  INTERNAL: "服务器开了个小差，请重试",
};

/* ------------------------------ 小工具 ------------------------------ */

function send(ws, payload) {
  if (!ws || ws.readyState !== WS_OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.error("[ws] 发送失败:", error);
  }
}

function sendError(ws, code) {
  send(ws, {
    type: "error",
    code,
    message: ERROR_MESSAGES[code] ?? "出错了",
  });
}

/** 清掉控制字符和零宽字符，免得名单里出现一条「看得见却读不出」的空名字。 */
function sanitizeName(value) {
  if (typeof value !== "string") return "";

  let cleaned = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || code === 0x7f;
    if (isControl || char === "\u200B" || char === "\uFEFF") continue;
    cleaned += char;
  }

  // 按码点截断，避免把 emoji 的代理对劈成两半
  return Array.from(cleaned.trim()).slice(0, 32).join("");
}

function normalizeCode(value) {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LENGTH);
}

function getIp(req) {
  // nginx 自己写的头优先：X-Forwarded-For 是客户端可以随便填的
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim().length > 0 && real.length <= 45) {
    return real.trim();
  }

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0].trim();
    if (first.length > 0 && first.length <= 45) return first;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * 只接受同源连接。
 *
 * 浏览器不会让别的站点读我们的 WebSocket 响应，但会允许它「连上来」——
 * 也就是 CSWSH。既然客户端永远和页面同源，那就直接比主机名。
 * 只比主机名不比端口：nginx 传下来的 Host 常常不带端口，比端口会误伤自己。
 * 没有 Origin 的（curl / 脚本）放行，限流另有安排。
 */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return true;

  let originHost;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  const rawHost = String(req.headers.host || req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();

  if (!rawHost) return true;

  // 去掉端口（IPv6 字面量形如 [::1]:3000）
  const hostOnly = rawHost.startsWith("[")
    ? rawHost.slice(0, rawHost.indexOf("]") + 1)
    : rawHost.split(":")[0];

  return originHost === hostOnly;
}

/* ------------------------------- Hub ------------------------------- */

function createHub({ wss }) {
  /** @type {Map<string, object>} 房间码 → 房间 */
  const rooms = new Map();
  /** @type {Set<object>} 所有活动连接 */
  const sessions = new Set();
  /** @type {Map<string, number>} IP → 连接数 */
  const ipCounts = new Map();
  /** @type {Map<string, number[]>} IP → 最近几次建房的时间戳 */
  const roomCreations = new Map();

  /** 单个 IP 十分钟内最多建几个房。防的是「脚本无限建房把服务器塞满」。 */
  const ROOM_CREATE_WINDOW_MS = 10 * 60_000;
  const ROOM_CREATE_LIMIT = 5;

  let loopTimer = null;
  let sweepTimer = null;
  let heartbeatTimer = null;
  let shuttingDown = false;

  /* --------------------------- 房间码 --------------------------- */

  function generateCode() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      }
      if (!rooms.has(code)) return code;
    }
    throw new Error("房间码生成失败：可能房间太多了");
  }

  /** 建房频率闸门。返回 false 表示这个 IP 建得太勤了。 */
  function allowRoomCreation(ip) {
    const now = Date.now();
    const recent = (roomCreations.get(ip) ?? []).filter(
      (at) => now - at < ROOM_CREATE_WINDOW_MS,
    );

    if (recent.length >= ROOM_CREATE_LIMIT) {
      roomCreations.set(ip, recent);
      return false;
    }

    recent.push(now);
    roomCreations.set(ip, recent);
    return true;
  }

  function createRoom() {
    const now = Date.now();
    return {
      code: generateCode(),
      phase: "lobby",
      hostId: null,
      players: new Map(),
      order: [],
      config: CONFIG,
      obstacleSet: OBSTACLE_SET,
      foodSet: new Set(),
      tick: 0,
      startAt: 0,
      startedAt: 0,
      endsAt: 0,
      lastTickAt: now,
      lastSnapshotAt: 0,
      createdAt: now,
      lastActiveAt: now,
      finishedAt: 0,
      finishedAnnounced: false,
      result: null,
    };
  }

  /* ---------------------------- 序列化 ---------------------------- */

  function publicPlayers(room) {
    const list = [];
    for (const player of room.players.values()) {
      list.push({
        id: player.id,
        name: player.name,
        slot: player.slot,
        isHost: player.id === room.hostId,
        connected: player.connected,
        alive: player.alive,
        score: player.score,
        length: player.snake.length,
        wins: player.wins ?? 0,
      });
    }
    return list.sort((a, b) => a.slot - b.slot);
  }

  function buildJoined(room, player) {
    return {
      type: "joined",
      selfId: player.id,
      resumeToken: player.resumeToken,
      roomCode: room.code,
      phase: room.phase,
      config: room.config,
      players: publicPlayers(room),
      hostId: room.hostId,
      // 地图随 joined 一起发，倒计时那 3 秒就能看到棋盘而不是一块黑屏
      map: game.buildMapPayload(),
      serverTime: Date.now(),
    };
  }

  function buildStarted(room) {
    return {
      type: "started",
      startAt: room.startAt,
      endsAt: room.endsAt ?? 0,
      serverTime: Date.now(),
      config: room.config,
      map: game.buildMapPayload(),
      players: game.buildPlayerStates(room),
      foods: game.buildFoods(room),
    };
  }

  /* ----------------------------- 广播 ----------------------------- */

  function broadcast(room, payload, exceptWs) {
    const data = JSON.stringify(payload);
    for (const player of room.players.values()) {
      const ws = player.ws;
      if (!ws || ws === exceptWs) continue;
      if (ws.readyState !== WS_OPEN) continue;
      try {
        ws.send(data);
      } catch (error) {
        console.error("[ws] 广播失败:", error);
      }
    }
  }

  function broadcastRoster(room, exceptWs) {
    broadcast(
      room,
      {
        type: "roster",
        players: publicPlayers(room),
        hostId: room.hostId,
        serverTime: Date.now(),
      },
      exceptWs,
    );
  }

  function broadcastSnapshot(room, events) {
    const payload = game.buildSnapshot(room, events);
    const data = JSON.stringify(payload);

    for (const player of room.players.values()) {
      const ws = player.ws;
      if (!ws || ws.readyState !== WS_OPEN) continue;
      // 慢客户端保护：积压太多就先跳过这一帧，别拖累别人
      if (ws.bufferedAmount > LIMITS.maxBufferedBytes) continue;
      try {
        ws.send(data);
      } catch (error) {
        console.error("[ws] 快照广播失败:", error);
      }
    }
  }

  function announceGameOver(room) {
    if (!room.result || room.finishedAnnounced) return;

    room.finishedAnnounced = true;
    room.finishedAt = Date.now();

    broadcast(room, {
      type: "gameOver",
      winnerId: room.result.winnerId,
      reason: room.result.reason,
      ranking: room.result.ranking,
      serverTime: Date.now(),
    });
  }

  /* ---------------------------- 玩家进出 ---------------------------- */

  function firstFreeSlot(room) {
    const used = new Set();
    for (const player of room.players.values()) used.add(player.slot);

    for (let slot = 0; slot < room.config.maxPlayers; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return -1;
  }

  function addPlayer(session, room, name, isHost) {
    const slot = firstFreeSlot(room);
    if (slot < 0) {
      sendError(session.ws, "ROOM_FULL");
      return false;
    }

    const id = `p_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const player = game.createPlayerState({
      id,
      name,
      slot,
      isHost,
      resumeToken: randomUUID(),
    });

    player.ws = session.ws;
    player.connected = true;

    // 结算阶段进来的玩家没参加刚打完的这一局，先按「未上场」处理，
    // 等房主开下一局时 initMatch 会把他正常摆到出生点
    if (room.phase === "finished") {
      player.alive = false;
      player.snake = [];
    }

    room.players.set(id, player);
    room.order.push(id);
    if (!room.hostId) room.hostId = id;
    room.lastActiveAt = Date.now();

    session.roomCode = room.code;
    session.playerId = id;
    session.joined = true;

    send(session.ws, buildJoined(room, player));
    broadcastRoster(room, session.ws);

    // 让他也能看到刚才那局的结算，而不是对着一块空棋盘发呆
    if (room.phase === "finished" && room.result) {
      send(session.ws, {
        type: "gameOver",
        winnerId: room.result.winnerId,
        reason: room.result.reason,
        ranking: room.result.ranking,
        serverTime: Date.now(),
      });
    }

    return true;
  }

  function resumePlayer(session, room, player) {
    const previous = player.ws;

    player.ws = session.ws;
    player.connected = true;
    player.disconnectedAt = 0;

    session.roomCode = room.code;
    session.playerId = player.id;
    session.joined = true;
    room.lastActiveAt = Date.now();

    // 同一个座位被新连接接管，旧连接礼貌地请走
    if (previous && previous !== session.ws && previous.readyState === WS_OPEN) {
      try {
        previous.close(4000, "session replaced");
      } catch {
        /* 旧连接已经凉了，无所谓 */
      }
    }

    send(session.ws, buildJoined(room, player));

    if (room.phase === "playing" || room.phase === "countdown") {
      send(session.ws, buildStarted(room));
      if (room.phase === "countdown") {
        send(session.ws, {
          type: "phase",
          phase: "countdown",
          startAt: room.startAt,
          serverTime: Date.now(),
        });
      }
    }

    if (room.phase === "finished" && room.result) {
      send(session.ws, {
        type: "gameOver",
        winnerId: room.result.winnerId,
        reason: room.result.reason,
        ranking: room.result.ranking,
        serverTime: Date.now(),
      });
    }

    broadcastRoster(room, session.ws);
  }

  function removePlayer(room, player, reason) {
    room.players.delete(player.id);
    room.order = room.order.filter((id) => id !== player.id);

    if (room.hostId === player.id) {
      const next = room.players.values().next();
      room.hostId = next.done ? null : next.value.id;
    }

    if (room.players.size === 0) {
      rooms.delete(room.code);
      return;
    }

    broadcastRoster(room);

    if (room.phase === "playing" && player.alive) {
      // 主动退出的人算阵亡，让场上继续结算
      player.alive = false;
      player.deathReason = reason;
      player.deathTick = room.tick;
      player.snake = [];
      maybeFinish(room);
    }
  }

  function maybeFinish(room) {
    if (room.phase !== "playing") return;
    if (game.countAlive(room) > 1) return;

    game.finishMatch(room);
    announceGameOver(room);
  }

  /* ---------------------------- 对局流程 ---------------------------- */

  function startMatch(room) {
    game.initMatch(room);

    const now = Date.now();
    room.startAt = room.startAt || now;
    room.startedAt = now;
    room.endsAt = now + MATCH_TIME_LIMIT_MS;
    room.lastTickAt = now;
    room.lastSnapshotAt = 0;

    broadcast(room, buildStarted(room));
  }

  function tickRoom(room, now) {
    if (room.phase === "countdown") {
      if (now >= room.startAt) startMatch(room);
      return;
    }

    if (room.phase !== "playing") return;

    // 时间到：按当前排名收尾，避免两个人绕圈绕到天荒地老
    if (room.endsAt > 0 && now >= room.endsAt) {
      game.finishMatch(room, "time_up");
      announceGameOver(room);
      return;
    }

    const delta = now - room.lastTickAt;
    room.lastTickAt = now;

    const result = game.stepRoom(room, delta, now);

    if (result.moved) {
      room.lastActiveAt = now;
      const dueForSnapshot =
        result.events.length > 0 ||
        now - room.lastSnapshotAt >= room.config.snapshotMs;

      if (dueForSnapshot) {
        broadcastSnapshot(room, result.events);
        room.lastSnapshotAt = now;
      }
    }

    if (room.phase === "finished") {
      announceGameOver(room);
    }
  }

  /* ---------------------------- 消息处理 ---------------------------- */

  function allowMessage(session) {
    const now = Date.now();
    const elapsed = now - session.lastRefill;

    if (elapsed > 0) {
      session.tokens = Math.min(
        LIMITS.messagesPerSecond,
        session.tokens + (elapsed / 1000) * LIMITS.messagesPerSecond,
      );
      session.lastRefill = now;
    }

    if (session.tokens < 1) return false;
    session.tokens -= 1;
    return true;
  }

  function resolve(session) {
    if (!session.roomCode || !session.playerId) return null;

    const room = rooms.get(session.roomCode);
    if (!room) return null;

    const player = room.players.get(session.playerId);
    if (!player || player.ws !== session.ws) return null;

    return { room, player };
  }

  function handleJoin(session, message) {
    if (session.joined) return;

    const name = sanitizeName(message.name);
    if (!name) {
      sendError(session.ws, "NAME_INVALID");
      return;
    }

    // 重连优先：不管房间进行到哪一步，老座位都还给他
    if (typeof message.resumeToken === "string" && message.resumeToken) {
      for (const room of rooms.values()) {
        for (const player of room.players.values()) {
          if (player.resumeToken === message.resumeToken) {
            resumePlayer(session, room, player);
            return;
          }
        }
      }
      // 令牌失效（比如服务器重启过），往下走正常加入流程
    }

    if (message.create === true) {
      if (rooms.size >= LIMITS.maxRooms) {
        sendError(session.ws, "SERVER_FULL");
        return;
      }
      if (!allowRoomCreation(session.ip)) {
        sendError(session.ws, "TOO_MANY_ROOMS");
        return;
      }

      const room = createRoom();
      rooms.set(room.code, room);
      addPlayer(session, room, name, true);
      return;
    }

    const code = normalizeCode(message.roomCode);
    const room = rooms.get(code);

    if (!room) {
      sendError(session.ws, "ROOM_NOT_FOUND");
      return;
    }
    // 对局进行中不能进；但「刚打完、等房主开下一局」这个阶段要放人进来，
    // 否则晚到的朋友永远卡在门外，只能等房主重新建房。
    if (room.phase !== "lobby" && room.phase !== "finished") {
      sendError(session.ws, "ROOM_STARTED");
      return;
    }
    if (room.players.size >= room.config.maxPlayers) {
      sendError(session.ws, "ROOM_FULL");
      return;
    }

    addPlayer(session, room, name, false);
  }

  function handleInput(session, message) {
    const target = resolve(session);
    if (!target) return;

    const { room, player } = target;
    if (room.phase !== "playing" || !player.alive) return;

    game.enqueueDirection(player, message.dir);
  }

  function handleBoost(session, message) {
    const target = resolve(session);
    if (!target) return;

    const { room, player } = target;
    player.boosting = room.phase === "playing" && player.alive && message.on === true;
  }

  function handleStart(session) {
    const target = resolve(session);
    if (!target) return;

    const { room, player } = target;

    if (room.hostId !== player.id) {
      sendError(session.ws, "NOT_HOST");
      return;
    }
    if (room.phase !== "lobby") return;
    if (room.players.size < 2) {
      sendError(session.ws, "NOT_ENOUGH_PLAYERS");
      return;
    }

    room.phase = "countdown";
    room.startAt = Date.now() + room.config.countdownMs;
    room.lastTickAt = Date.now();

    broadcast(room, {
      type: "phase",
      phase: "countdown",
      startAt: room.startAt,
      serverTime: Date.now(),
    });
  }

  function handleRematch(session) {
    const target = resolve(session);
    if (!target) return;

    const { room, player } = target;

    if (room.hostId !== player.id) {
      sendError(session.ws, "NOT_HOST");
      return;
    }
    if (room.phase !== "finished") return;

    room.phase = "countdown";
    room.result = null;
    room.finishedAnnounced = false;
    room.finishedAt = 0;
    room.startedAt = 0;
    room.endsAt = 0;
    room.startAt = Date.now() + room.config.countdownMs;
    room.lastTickAt = Date.now();

    broadcast(room, {
      type: "phase",
      phase: "countdown",
      startAt: room.startAt,
      serverTime: Date.now(),
    });
  }

  function handleLeave(session) {
    const target = resolve(session);
    if (!target) return;

    const { room, player } = target;
    removePlayer(room, player, "left");

    session.roomCode = null;
    session.playerId = null;
    session.joined = false;
  }

  function handleMessage(session, raw) {
    if (shuttingDown) return;

    if (!allowMessage(session)) {
      sendError(session.ws, "RATE_LIMITED");
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendError(session.ws, "BAD_MESSAGE");
      return;
    }

    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      sendError(session.ws, "BAD_MESSAGE");
      return;
    }

    switch (message.type) {
      case "join":
        handleJoin(session, message);
        break;
      case "input":
        handleInput(session, message);
        break;
      case "boost":
        handleBoost(session, message);
        break;
      case "start":
        handleStart(session);
        break;
      case "rematch":
        handleRematch(session);
        break;
      case "leave":
        handleLeave(session);
        break;
      case "ping":
        send(session.ws, {
          type: "pong",
          // 只回显数字或短字符串：别让人拿这个字段当放大器
          t:
            typeof message.t === "number"
              ? message.t
              : typeof message.t === "string"
                ? message.t.slice(0, 32)
                : null,
          serverTime: Date.now(),
        });
        break;
      default:
        sendError(session.ws, "BAD_MESSAGE");
    }
  }

  function handleClose(session) {
    sessions.delete(session);

    const count = (ipCounts.get(session.ip) ?? 1) - 1;
    if (count <= 0) ipCounts.delete(session.ip);
    else ipCounts.set(session.ip, count);

    const target = resolve(session);
    if (!target) return;

    const { room, player } = target;

    player.ws = null;
    player.connected = false;
    player.disconnectedAt = Date.now();
    player.boosting = false;

    if (room.phase === "lobby") {
      // 还没开局，没必须留着座位
      removePlayer(room, player, "left");
      return;
    }

    // 对局中：蛇冻结原地，等 30 秒宽限；超时由 game.stepRoom 判死
    broadcastRoster(room);
    broadcastSnapshot(room, [
      { type: "playerLeft", playerId: player.id },
    ]);
  }

  /* ---------------------------- 连接接入 ---------------------------- */

  wss.on("connection", (ws, req) => {
    // 来源对不上就直接请走，连 session 都不建
    if (!isAllowedOrigin(req)) {
      try {
        ws.close(4003, "bad origin");
      } catch {
        /* 已经断了 */
      }
      return;
    }

    const ip = getIp(req);
    const current = ipCounts.get(ip) ?? 0;

    if (current >= LIMITS.maxConnectionsPerIp) {
      sendError(ws, "RATE_LIMITED");
      ws.close(4003, "too many connections");
      return;
    }

    ipCounts.set(ip, current + 1);

    const session = {
      ws,
      ip,
      roomCode: null,
      playerId: null,
      joined: false,
      tokens: LIMITS.messagesPerSecond,
      lastRefill: Date.now(),
    };

    sessions.add(session);

    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("message", (raw) => handleMessage(session, raw));
    ws.on("close", () => handleClose(session));
    ws.on("error", () => {
      /* 连接层的错误交给 close 处理，这里静默 */
    });
  });

  /* ----------------------------- 定时器 ----------------------------- */

  loopTimer = setInterval(() => {
    const now = Date.now();

    for (const room of rooms.values()) {
      try {
        tickRoom(room, now);
      } catch (error) {
        console.error(`[room ${room.code}] 循环出错:`, error);
      }
    }
  }, CONFIG.tickMs);

  sweepTimer = setInterval(() => {
    const now = Date.now();

    for (const [code, room] of rooms) {
      let online = 0;
      for (const player of room.players.values()) {
        if (player.connected) online += 1;
      }

      if (online === 0 && now - room.lastActiveAt > TIMING.emptyRoomTtlMs) {
        rooms.delete(code);
        continue;
      }

      if (
        room.phase === "finished" &&
        room.finishedAt > 0 &&
        now - room.finishedAt > TIMING.finishedRoomTtlMs
      ) {
        rooms.delete(code);
      }
    }

    // 建房记录也要回收，否则 Map 会随着 IP 数量一直长
    for (const [ip, stamps] of roomCreations) {
      const recent = stamps.filter((at) => now - at < ROOM_CREATE_WINDOW_MS);
      if (recent.length === 0) roomCreations.delete(ip);
      else roomCreations.set(ip, recent);
    }
  }, TIMING.sweepIntervalMs);

  heartbeatTimer = setInterval(() => {
    for (const session of sessions) {
      const ws = session.ws;
      if (!ws || ws.readyState !== WS_OPEN) continue;

      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {
          /* 已经断了 */
        }
        continue;
      }

      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* 忽略 */
      }
    }
  }, 30_000);

  /* ------------------------------ 关闭 ------------------------------ */

  function shutdown(reason) {
    shuttingDown = true;

    clearInterval(loopTimer);
    clearInterval(sweepTimer);
    clearInterval(heartbeatTimer);

    for (const room of rooms.values()) {
      broadcast(room, { type: "roomClosed", reason });
      for (const player of room.players.values()) {
        try {
          player.ws?.close(1001, "server shutting down");
        } catch {
          /* 忽略 */
        }
      }
    }

    rooms.clear();
  }

  return {
    shutdown,
    /** 测试 / 排查用：看一眼现在有多少房间 */
    stats() {
      return {
        rooms: rooms.size,
        sessions: sessions.size,
        players: [...rooms.values()].reduce((sum, room) => sum + room.players.size, 0),
      };
    },
  };
}

module.exports = { createHub, ERROR_MESSAGES };
