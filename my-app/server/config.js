"use strict";

/**
 * 联机模式的全部参数与地图定义。
 *
 * 这个文件只被服务端 require（server.js / server/*.js），
 * 客户端拿到的是通过 WebSocket 下发的 RoomConfig + MapPayload，
 * 所以这里的任何改动都不需要动前端代码。
 */

/* ------------------------------- 棋盘 ------------------------------- */

const COLS = 30;
const ROWS = 30;
const CELL = 20;

/** 下发给客户端的公开配置（前端按它决定画布尺寸和手感）。 */
const CONFIG = {
  cols: COLS,
  rows: ROWS,
  cell: CELL,
  maxPlayers: 4,
  foodCount: 6,
  tickMs: 20,
  snapshotMs: 40,
  startStepMs: 150,
  minStepMs: 70,
  speedUpEvery: 5,
  speedUpMs: 8,
  boostFactor: 0.6,
  minBoostStepMs: 55,
  countdownMs: 3000,
};

/**
 * 对局时限。没有这个上限，两个人绕圈可以绕到天荒地老，
 * 房间永远不会结束，谁也别想再来一局。
 *
 * 想改时长（或者想快速验证「时间到」结算）可以用环境变量覆盖：
 *   MATCH_TIME_LIMIT_MS=8000 npm start
 */
const MATCH_TIME_LIMIT_MS =
  Number.parseInt(process.env.MATCH_TIME_LIMIT_MS ?? "", 10) || 180_000;

/**
 * 加速体力。
 *
 * 之前加速是零成本的，结果所有人全程按住 Shift 不放，
 * 「什么时候该飙车」这个决策就消失了。加上体力之后，
 * 加速变成一种要花掉的资源：
 *   - 满体力可以连续飙 100 / 32 ≈ 3.1 秒
 *   - 松开后 100 / 18 ≈ 5.6 秒回满
 *   - 耗尽后要回到 12 才能再次起步（迟滞，避免贴着 0 反复抖动）
 */
const STAMINA = {
  max: 100,
  drainPerSecond: 32,
  regenPerSecond: 18,
  minToBoost: 12,
};

/* ------------------------------- 方向 ------------------------------- */

const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const DIRECTION_NAMES = Object.keys(DIRECTIONS);

/* ------------------------------ 出生点 ------------------------------ */

/**
 * 四个出生点，绕地图中心 90° 旋转对称：
 *   R(x, y) = (ROWS - 1 - y, x)
 *   R(4,7)=(22,4) → R(22,4)=(25,22) → R(25,22)=(7,25) → R(7,25)=(4,7)
 * 所以四个人拿到的地形完全等价，没有谁占便宜。
 *
 * 出生行/列（row 7、col 22、row 22、col 7）整条都不放障碍，
 * 保证开局直行 25 格（约 3.75 秒）才会撞墙，够时间反应。
 */
const SPAWNS = [
  { x: 4, y: 7, dir: "right" },
  { x: 22, y: 4, dir: "down" },
  { x: 25, y: 22, dir: "left" },
  { x: 7, y: 25, dir: "up" },
];

/* ------------------------------ 障碍物 ------------------------------ */

/**
 * 只写左上象限的四组基础形状，剩下三份靠 90° 旋转生成。
 * 全是孤立的 2×2 / 1×3 小块，四周留出 ≥3 格空隙，
 * 不会形成死胡同，也不会把地图切成两半。
 */
const BASE_SHAPES = [
  // 横条 3
  [
    [9, 12],
    [10, 12],
    [11, 12],
  ],
  // 方块 2×2
  [
    [5, 15],
    [6, 15],
    [5, 16],
    [6, 16],
  ],
  // 竖条 3
  [
    [3, 11],
    [3, 12],
    [3, 13],
  ],
  // 中心 2×2（旋转四次回到自己）
  [
    [14, 14],
    [15, 14],
    [14, 15],
    [15, 15],
  ],
];

/** 绕地图中心顺时针旋转 90°。 */
function rotatePoint(x, y) {
  return [ROWS - 1 - y, x];
}

const OBSTACLE_CELLS = (() => {
  const seen = new Set();
  const cells = [];

  for (const shape of BASE_SHAPES) {
    let current = shape.map(([x, y]) => [x, y]);

    for (let turn = 0; turn < 4; turn += 1) {
      for (const [x, y] of current) {
        const id = `${x},${y}`;
        if (seen.has(id)) continue;
        seen.add(id);
        cells.push([x, y]);
      }
      current = current.map(([x, y]) => rotatePoint(x, y));
    }
  }

  return cells;
})();

/** 供服务端快速判碰的 Set<"x,y">。 */
const OBSTACLE_SET = new Set(OBSTACLE_CELLS.map(([x, y]) => `${x},${y}`));

/** 供客户端渲染的扁平数组 [x0,y0,x1,y1,...]。 */
const OBSTACLE_FLAT = OBSTACLE_CELLS.flat();

/* ----------------------------- 房间码 ----------------------------- */

/** 去掉 I / O / 0 / 1，避免朋友在微信里把 0 看成 O、1 看成 I。 */
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;

/* ------------------------------ 时限 ------------------------------ */

const TIMING = {
  /** 断线后蛇冻结多久，超时才判死 */
  disconnectGraceMs: 30_000,
  /** 空房间多久回收 */
  emptyRoomTtlMs: 10 * 60_000,
  /** 打完的房间多久回收 */
  finishedRoomTtlMs: 5 * 60_000,
  /** 回收巡检间隔 */
  sweepIntervalMs: 30_000,
};

/* ------------------------------ 防刷 ------------------------------ */

const LIMITS = {
  /** 单个 IP 同时保持的连接数 */
  maxConnectionsPerIp: 12,
  /** 全局房间上限 */
  maxRooms: 200,
  /** 单条消息上限（字节），与 ws 的 maxPayload 对齐 */
  maxPayload: 4 * 1024,
  /** 每个连接每秒最多多少条消息 */
  messagesPerSecond: 30,
  /** 单个 ws 缓冲超过这个值就跳过本次快照 */
  maxBufferedBytes: 64 * 1024,
};

module.exports = {
  COLS,
  ROWS,
  CELL,
  CONFIG,
  MATCH_TIME_LIMIT_MS,
  STAMINA,
  DIRECTIONS,
  DIRECTION_NAMES,
  SPAWNS,
  OBSTACLE_CELLS,
  OBSTACLE_SET,
  OBSTACLE_FLAT,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  TIMING,
  LIMITS,
};
