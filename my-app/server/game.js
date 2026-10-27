"use strict";

/**
 * 联机模式的权威游戏内核。
 *
 * 全部是纯函数 / 纯数据操作：不碰 socket、不碰定时器、不碰数据库，
 * 所以可以直接被 node --test 拉去做单元测试。
 *
 * 最核心的是 stepRoom()：它必须在一个 tick 内把所有该走的蛇
 * 「先统一算意图，再统一判碰撞，最后统一落子」，
 * 否则先后顺序会让两个人拿到不同的物理法则。
 */

const {
  CONFIG,
  DIRECTIONS,
  SPAWNS,
  OBSTACLE_SET,
  OBSTACLE_FLAT,
  STAMINA,
  TIMING,
} = require("./config.js");

/* ------------------------------ 小工具 ------------------------------ */

function key(point) {
  return `${point.x},${point.y}`;
}

function parseKey(id) {
  const comma = id.indexOf(",");
  return {
    x: Number(id.slice(0, comma)),
    y: Number(id.slice(comma + 1)),
  };
}

function flattenPoints(points) {
  const out = new Array(points.length * 2);
  for (let i = 0; i < points.length; i += 1) {
    out[i * 2] = points[i].x;
    out[i * 2 + 1] = points[i].y;
  }
  return out;
}

function flattenSet(cellSet) {
  const out = [];
  for (const id of cellSet) {
    const point = parseKey(id);
    out.push(point.x, point.y);
  }
  return out;
}

/* ------------------------------ 玩家状态 ------------------------------ */

function createPlayerState({ id, name, slot, isHost = false, resumeToken = "" }) {
  return {
    id,
    name,
    slot,
    isHost,
    resumeToken,
    ws: null,
    connected: true,
    disconnectedAt: 0,

    snake: [],
    dir: "right",
    queue: [],
    score: 0,
    stepMs: CONFIG.startStepMs,
    elapsedMs: 0,
    /** 玩家的意图：是否按着加速键 */
    boosting: false,
    /** 本帧实际是否在加速（体力耗尽时会被强制关掉） */
    boostActive: false,
    stamina: STAMINA.max,

    alive: true,
    deathReason: null,
    deathTick: null,
    /** 撞死他的人（撞墙 / 撞自己时为 null） */
    deathBy: null,
    /** 这个房间里的累计胜场，重开一局不清零 */
    wins: 0,

    // 每个 tick 的临时字段，不进快照
    nextHead: null,
    willEat: false,
  };
}

/** 按座位号把一条蛇摆回出生点。座位决定出生点和颜色，所以必须稳定。 */
function resetPlayerForMatch(player, slot) {
  const spawn = SPAWNS[slot % SPAWNS.length];
  const vec = DIRECTIONS[spawn.dir];

  const snake = [];
  for (let i = 0; i < 3; i += 1) {
    snake.push({ x: spawn.x - vec.x * i, y: spawn.y - vec.y * i });
  }

  player.snake = snake;
  player.dir = spawn.dir;
  player.queue = [];
  player.score = 0;
  player.stepMs = CONFIG.startStepMs;
  player.elapsedMs = 0;
  player.boosting = false;
  player.boostActive = false;
  player.stamina = STAMINA.max;
  player.alive = true;
  player.deathReason = null;
  player.deathTick = null;
  player.deathBy = null;
  player.nextHead = null;
  player.willEat = false;
}

/* ------------------------------ 房间壳 ------------------------------ */

/**
 * 造一个可供内核运行的最小房间对象。
 * 生产环境里 rooms.js 会在这个壳上再挂 socket / 计时 / 元数据。
 */
function createRoomShell(players, options = {}) {
  const config = { ...CONFIG, foodCount: 0, ...(options.config || {}) };
  const map = new Map();
  for (const player of players) map.set(player.id, player);

  return {
    config,
    phase: "playing",
    players: map,
    order: players.map((player) => player.id),
    foodSet: new Set(),
    obstacleSet: options.obstacles ?? OBSTACLE_SET,
    tick: 0,
    result: null,
  };
}

/* ------------------------------- 食物 ------------------------------- */

function isNearAnySpawn(x, y, distance) {
  for (const spawn of SPAWNS) {
    if (Math.abs(x - spawn.x) + Math.abs(y - spawn.y) < distance) return true;
  }
  return false;
}

/**
 * 把食物补到目标数量。
 * 开局时额外避开出生点附近，免得一睁眼就白送一颗豆。
 */
function refillFood(room, options = {}) {
  const target = room.foodTarget ?? room.config.foodCount;
  const need = target - room.foodSet.size;
  if (need <= 0) return;

  const occupied = new Set(room.obstacleSet);

  for (const player of room.players.values()) {
    if (!player.alive) continue;
    for (const segment of player.snake) occupied.add(key(segment));
  }
  for (const foodId of room.foodSet) occupied.add(foodId);

  // 已有豆子的上下左右不再放新豆，避免几颗豆挤成一坨
  const nearFood = new Set();
  for (const foodId of room.foodSet) {
    const point = parseKey(foodId);
    nearFood.add(`${point.x + 1},${point.y}`);
    nearFood.add(`${point.x - 1},${point.y}`);
    nearFood.add(`${point.x},${point.y + 1}`);
    nearFood.add(`${point.x},${point.y - 1}`);
  }

  const free = [];
  for (let y = 0; y < room.config.rows; y += 1) {
    for (let x = 0; x < room.config.cols; x += 1) {
      const id = `${x},${y}`;
      if (occupied.has(id)) continue;
      if (nearFood.has(id)) continue;
      if (options.avoidSpawnArea && isNearAnySpawn(x, y, 3)) continue;
      free.push(id);
    }
  }

  for (let i = 0; i < need && free.length > 0; i += 1) {
    const index = Math.floor(Math.random() * free.length);
    const picked = free[index];
    room.foodSet.add(picked);
    free.splice(index, 1);

    // 新豆的四个邻居也要从候选里剔除
    const point = parseKey(picked);
    const neighbors = [
      `${point.x + 1},${point.y}`,
      `${point.x - 1},${point.y}`,
      `${point.x},${point.y + 1}`,
      `${point.x},${point.y - 1}`,
    ];
    for (const neighbor of neighbors) {
      const at = free.indexOf(neighbor);
      if (at >= 0) free.splice(at, 1);
    }
  }
}

/* ------------------------------ 方向控制 ------------------------------ */

function isOpposite(a, b) {
  const vecA = DIRECTIONS[a];
  const vecB = DIRECTIONS[b];
  if (!vecA || !vecB) return false;
  return vecA.x === -vecB.x && vecA.y === -vecB.y;
}

/**
 * 把方向放进待生效队列。
 * 过滤掉 180° 掉头（会当场撞死自己）和重复方向，
 * 队列最多存 2 个，再多会让操作变迟钝。
 */
function enqueueDirection(player, direction) {
  if (!DIRECTIONS[direction]) return false;

  const last =
    player.queue.length > 0 ? player.queue[player.queue.length - 1] : player.dir;

  if (isOpposite(direction, last)) return false;
  if (direction === last) return false;
  if (player.queue.length >= 2) return false;

  player.queue.push(direction);
  return true;
}

/** 从队列里取一个合法方向真正生效。 */
function applyQueuedDirection(player) {
  while (player.queue.length > 0) {
    const direction = player.queue.shift();
    if (isOpposite(direction, player.dir)) continue;
    if (direction === player.dir) continue;
    player.dir = direction;
    break;
  }
}

/** 当前实际步长：正在加速时按比例缩短，但不低于下限。 */
function effectiveStepMs(player, config = CONFIG) {
  if (!player.boostActive) return player.stepMs;
  return Math.max(
    config.minBoostStepMs,
    Math.round(player.stepMs * config.boostFactor),
  );
}

/**
 * 结算本帧的体力。
 *
 * 用迟滞（hysteresis）而不是简单的 `stamina > 0`：
 * 已经在加速的人只要还有一点点体力就继续跑完，
 * 但想重新起步必须攒到 minToBoost。否则体力会在 0 附近
 * 一帧开一帧关，蛇走起来像在抽搐。
 */
function updateStamina(player, deltaMs) {
  if (!player.alive) return;

  const wants = player.boosting === true;
  const canBoost = player.boostActive
    ? player.stamina > 0
    : player.stamina >= STAMINA.minToBoost;

  if (wants && canBoost) {
    player.boostActive = true;
    player.stamina = Math.max(
      0,
      player.stamina - (STAMINA.drainPerSecond * deltaMs) / 1000,
    );
    return;
  }

  player.boostActive = false;
  player.stamina = Math.min(
    STAMINA.max,
    player.stamina + (STAMINA.regenPerSecond * deltaMs) / 1000,
  );
}

/* ------------------------------- 对局 ------------------------------- */

function initMatch(room) {
  room.tick = 0;
  room.foodSet = new Set();
  room.result = null;
  room.phase = "playing";

  // 人多就多撒点豆：两个人 6 颗，四个人 8 颗，最多 10 颗
  room.foodTarget = Math.max(6, Math.min(10, room.players.size * 2));

  for (const player of room.players.values()) {
    resetPlayerForMatch(player, player.slot);
  }

  refillFood(room, { avoidSpawnArea: true });
}

/**
 * 推进一个 tick。
 *
 * 返回 { moved, events, aliveCount }。
 * moved=false 表示这一帧没有任何蛇移动（不需要广播快照）。
 */
function stepRoom(room, dtMs, now = Date.now()) {
  const config = room.config;
  const events = [];

  if (room.phase !== "playing") {
    return { moved: false, events, aliveCount: countAlive(room) };
  }

  // 卡顿 / GC / 机器休眠后 delta 会非常大，钳一下，不让蛇瞬移追帧
  const delta = Math.min(Math.max(dtMs, 0), 50);
  room.tick += 1;

  /* ---------- 0. 断线超过宽限期 → 判死 ---------- */
  for (const player of room.players.values()) {
    if (!player.alive || player.connected) continue;

    // 注意：disconnectedAt 可能是 0，不能用 !player.disconnectedAt 判断，
    // 那会把「时间戳恰好为 0」误当成「没记录过」。
    const since = Number.isFinite(player.disconnectedAt) ? player.disconnectedAt : now;
    if (now - since <= TIMING.disconnectGraceMs) continue;

    killPlayer(room, player, "disconnect", player.snake[0] ?? { x: 0, y: 0 }, events);
  }

  // 断线判死可能直接把场上打到只剩一个人（甚至无人），
  // 这时必须立刻收尾，不能等下一帧有人移动才结算。
  //
  // 注意 players.size >= 2 这个前提：单人房间是测试用的构造，
  // 真实对局至少 2 人开局，不加这个条件会让测试里的蛇一开局就「被结算」。
  if (room.players.size >= 2 && countAlive(room) <= 1) {
    finishMatch(room);
    return { moved: false, events, aliveCount: countAlive(room) };
  }

  /* ---------- 1. 结算体力，再挑出这一帧该走的蛇 ---------- */
  for (const player of room.players.values()) {
    updateStamina(player, delta);
  }

  const movers = [];
  for (const player of room.players.values()) {
    if (!player.alive || !player.connected) continue;

    player.elapsedMs += delta;
    const step = effectiveStepMs(player, config);
    if (player.elapsedMs < step) continue;

    // 每人每帧最多走一格；余量封顶，避免网络抖动后连跳好几格
    player.elapsedMs = Math.min(player.elapsedMs - step, step);
    applyQueuedDirection(player);
    movers.push(player);
  }

  if (movers.length === 0) {
    return { moved: false, events, aliveCount: countAlive(room) };
  }

  /* ---------- 2. 先算所有意图（基于移动前的棋盘） ---------- */
  for (const player of movers) {
    const vec = DIRECTIONS[player.dir];
    player.nextHead = {
      x: player.snake[0].x + vec.x,
      y: player.snake[0].y + vec.y,
    };
    // 吃不吃豆必须在移动前定下来：它决定尾巴要不要让位
    player.willEat = room.foodSet.has(key(player.nextHead));
  }

  /* ---------- 3. 撞墙 / 撞障碍 ---------- */
  const dead = new Map();

  for (const player of movers) {
    const head = player.nextHead;
    const outside =
      head.x < 0 ||
      head.y < 0 ||
      head.x >= config.cols ||
      head.y >= config.rows;

    if (outside || room.obstacleSet.has(key(head))) {
      dead.set(player.id, { reason: "wall", at: head });
    }
  }

  /* ---------- 4. 头对头：两个蛇头抢同一格，都死 ---------- */
  const headOwners = new Map();
  for (const player of movers) {
    if (dead.has(player.id)) continue;
    const id = key(player.nextHead);
    const owners = headOwners.get(id);
    if (owners) owners.push(player.id);
    else headOwners.set(id, [player.id]);
  }
  for (const player of movers) {
    if (dead.has(player.id)) continue;

    const owners = headOwners.get(key(player.nextHead)) ?? [];
    if (owners.length > 1) {
      // 同归于尽也要记下「被谁撞的」，结算时能说出人话
      const other = owners.find((id) => id !== player.id) ?? null;
      dead.set(player.id, {
        reason: "head_on",
        at: player.nextHead,
        killerId: other,
      });
    }
  }

  /* ---------- 5. 构造「移动后仍被占用」的格子 ----------
     尾巴让位规则：
       a) 本帧移动 + 不吃豆  → 尾巴离开，尾格让位
       b) 本帧移动 + 吃豆    → 尾巴留下，尾格仍占
       c) 本帧没动 / 断线冻结 → 整条身体都占
       d) 本帧已判定死亡      → 尸体不害人，不参与判定
  */
  const movingIds = new Set(movers.map((player) => player.id));
  const occupied = new Map();

  for (const player of room.players.values()) {
    if (!player.alive) continue;
    if (dead.has(player.id)) continue;

    const moving = movingIds.has(player.id);
    const keepTail = !moving || player.willEat;
    const body = keepTail ? player.snake : player.snake.slice(0, -1);

    for (const segment of body) {
      const id = key(segment);
      if (!occupied.has(id)) occupied.set(id, player.id);
    }
  }

  /* ---------- 6. 撞身体（含撞自己） ---------- */
  for (const player of movers) {
    if (dead.has(player.id)) continue;

    const owner = occupied.get(key(player.nextHead));
    if (owner === undefined) continue;

    dead.set(player.id, {
      reason: owner === player.id ? "self" : "body",
      at: player.nextHead,
      killerId: owner === player.id ? null : owner,
    });
  }

  /* ---------- 7. 统一结算死亡（此刻才真正清空尸体） ---------- */
  for (const [playerId, info] of dead) {
    const player = room.players.get(playerId);
    if (!player) continue;
    killPlayer(room, player, info.reason, info.at, events, info.killerId);
  }

  /* ---------- 8. 统一落子（只对幸存者） ---------- */
  for (const player of movers) {
    if (!player.alive) continue;

    player.snake.unshift(player.nextHead);

    if (player.willEat) {
      player.score += 1;

      if (player.score % config.speedUpEvery === 0) {
        player.stepMs = Math.max(config.minStepMs, player.stepMs - config.speedUpMs);
      }

      room.foodSet.delete(key(player.nextHead));
      events.push({
        type: "eat",
        playerId: player.id,
        x: player.nextHead.x,
        y: player.nextHead.y,
      });
    } else {
      player.snake.pop();
    }
  }

  /* ---------- 9. 补豆 ---------- */
  refillFood(room);

  /* ---------- 10. 收尾 ---------- */
  const aliveCount = countAlive(room);
  if (aliveCount <= 1) {
    finishMatch(room);
  }

  return { moved: true, events, aliveCount };
}

function countAlive(room) {
  let alive = 0;
  for (const player of room.players.values()) {
    if (player.alive) alive += 1;
  }
  return alive;
}

function killPlayer(room, player, reason, at, events, killerId = null) {
  player.alive = false;
  player.deathReason = reason;
  player.deathTick = room.tick;
  player.deathBy = killerId;
  player.snake = [];
  player.queue = [];
  player.boosting = false;
  player.boostActive = false;

  events.push({
    type: "death",
    playerId: player.id,
    reason,
    x: at?.x ?? 0,
    y: at?.y ?? 0,
    killerId,
  });
}

/* ------------------------------- 结算 ------------------------------- */

function buildRanking(room) {
  const all = [...room.players.values()];

  const sorted = all.slice().sort((a, b) => {
    // 活着的永远排前面
    if (a.alive !== b.alive) return a.alive ? -1 : 1;

    // 死得越晚越靠前
    const aTick = a.deathTick ?? Number.POSITIVE_INFINITY;
    const bTick = b.deathTick ?? Number.POSITIVE_INFINITY;
    if (aTick !== bTick) return bTick - aTick;

    // 同帧阵亡的，分数高的靠前
    if (a.score !== b.score) return b.score - a.score;

    // 还平就按座位号，保证结果稳定可复现
    return a.slot - b.slot;
  });

  return sorted.map((player, index) => ({
    id: player.id,
    name: player.name,
    slot: player.slot,
    score: player.score,
    alive: player.alive,
    deathTick: player.deathTick,
    wins: player.wins ?? 0,
    rank: index + 1,
  }));
}

/**
 * 收尾。
 * forcedReason 用来表达「不是打到只剩一个人」的结束方式，比如时间到。
 */
function finishMatch(room, forcedReason) {
  if (room.phase === "finished") return room.result;

  room.phase = "finished";

  // 先算一次排名找出赢家，把胜场记上，再算一次把 wins 带进结果
  const provisional = buildRanking(room);
  const champion = provisional[0] && provisional[0].alive ? provisional[0] : null;

  if (champion) {
    const winner = room.players.get(champion.id);
    if (winner) winner.wins = (winner.wins ?? 0) + 1;
  }

  room.result = {
    winnerId: champion ? champion.id : null,
    reason: forcedReason ?? (champion ? "last_alive" : "all_dead"),
    ranking: buildRanking(room),
  };

  return room.result;
}

/* ------------------------------ 序列化 ------------------------------ */

function buildMapPayload() {
  return {
    obstacles: OBSTACLE_FLAT,
    spawns: SPAWNS,
  };
}

/** 豆子坐标的扁平数组，开局全量包和每帧快照共用。 */
function buildFoods(room) {
  return flattenSet(room.foodSet);
}

function buildSnapshot(room, events) {
  return {
    type: "snapshot",
    tick: room.tick,
    serverTime: Date.now(),
    endsAt: room.endsAt ?? 0,
    players: buildPlayerStates(room),
    foods: flattenSet(room.foodSet),
    events,
  };
}

/** 每条蛇的完整状态。快照和 started 全量包共用这一份结构。 */
function buildPlayerStates(room) {
  const players = [];

  for (const player of room.players.values()) {
    players.push({
      id: player.id,
      name: player.name,
      slot: player.slot,
      snake: flattenPoints(player.snake),
      dir: player.dir,
      score: player.score,
      alive: player.alive,
      // 注意这里发的是「实际是否在加速」，不是玩家的按键意图——
      // 体力耗尽时服务端会强制关掉，客户端要能立刻看到
      boosting: player.boostActive,
      stamina: Math.round(player.stamina),
      stepMs: player.stepMs,
      wins: player.wins ?? 0,
      connected: player.connected,
    });
  }

  return players;
}

module.exports = {
  key,
  parseKey,
  flattenPoints,
  flattenSet,
  createPlayerState,
  resetPlayerForMatch,
  createRoomShell,
  refillFood,
  enqueueDirection,
  applyQueuedDirection,
  effectiveStepMs,
  initMatch,
  stepRoom,
  countAlive,
  buildRanking,
  finishMatch,
  buildMapPayload,
  buildFoods,
  buildSnapshot,
  buildPlayerStates,
};
