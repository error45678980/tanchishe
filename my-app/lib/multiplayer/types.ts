/**
 * 联机模式的通信协议。
 *
 * 这个文件只有类型和常量，没有任何运行时依赖，
 * 所以客户端组件可以放心 import，不会把服务端代码打进 bundle。
 *
 * 坐标系约定：所有坐标都是「格」，不是像素。
 * 像素换算只在 Canvas 里做一次（x * cell）。
 */

export type Direction = "up" | "down" | "left" | "right";

export type RoomPhase = "lobby" | "countdown" | "playing" | "finished";

export type DeathReason =
  | "wall"
  | "self"
  | "body"
  | "head_on"
  | "disconnect"
  | "left";

export type ErrorCode =
  | "BAD_MESSAGE"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ROOM_STARTED"
  | "NAME_INVALID"
  | "NOT_HOST"
  | "NOT_ENOUGH_PLAYERS"
  | "RATE_LIMITED"
  | "SERVER_FULL"
  | "INTERNAL";

/** 服务端下发的玩法参数。客户端不得硬编码任何棋盘尺寸。 */
export type RoomConfig = {
  cols: number;
  rows: number;
  cell: number;
  maxPlayers: number;
  foodCount: number;
  tickMs: number;
  snapshotMs: number;
  startStepMs: number;
  minStepMs: number;
  speedUpEvery: number;
  speedUpMs: number;
  boostFactor: number;
  minBoostStepMs: number;
  countdownMs: number;
};

/** 大厅名单里的一个玩家。 */
export type PlayerPublic = {
  id: string;
  name: string;
  slot: number;
  isHost: boolean;
  connected: boolean;
  alive: boolean;
  score: number;
  length: number;
  /** 本房间累计胜场，重开一局不清零 */
  wins: number;
};

export type SpawnPoint = { x: number; y: number; dir: Direction };

/** 扁平坐标数组：[x0, y0, x1, y1, ...] */
export type FlatPoints = number[];

export type MapPayload = {
  obstacles: FlatPoints;
  spawns: SpawnPoint[];
};

/** 棋盘上的一条蛇。 */
export type SnakeState = {
  id: string;
  name: string;
  slot: number;
  snake: FlatPoints;
  dir: Direction;
  score: number;
  alive: boolean;
  /** 本帧实际是否在加速（体力耗尽时服务端会强制关掉） */
  boosting: boolean;
  /** 剩余体力 0–100 */
  stamina: number;
  /** 当前每走一格的毫秒数，客户端用它算插值进度 */
  stepMs: number;
  /** 本房间累计胜场 */
  wins: number;
  connected: boolean;
};

export type GameEvent =
  | { type: "eat"; playerId: string; x: number; y: number }
  | {
      type: "death";
      playerId: string;
      reason: DeathReason;
      x: number;
      y: number;
      /** 撞死他的人；撞墙 / 撞自己 / 掉线时为 null */
      killerId: string | null;
    }
  | { type: "playerLeft"; playerId: string };

export type RankingEntry = {
  id: string;
  name: string;
  slot: number;
  score: number;
  alive: boolean;
  deathTick: number | null;
  wins: number;
  rank: number;
};

/* ------------------------------ 客户端 → 服务端 ------------------------------ */

export type ClientMessage =
  | {
      type: "join";
      name: string;
      /** 创建房间时省略 */
      roomCode?: string;
      create?: boolean;
      /** 断线重连凭证，来自上一次 joined */
      resumeToken?: string;
    }
  | { type: "input"; dir: Direction; seq: number }
  | { type: "boost"; on: boolean }
  | { type: "start" }
  | { type: "rematch" }
  | { type: "leave" }
  | { type: "ping"; t: number };

/* ------------------------------ 服务端 → 客户端 ------------------------------ */

export type Snapshot = {
  type: "snapshot";
  tick: number;
  serverTime: number;
  /** 本局结束时间戳（服务端时间），0 表示不限时 */
  endsAt: number;
  players: SnakeState[];
  foods: FlatPoints;
  events: GameEvent[];
};

export type ServerMessage =
  | {
      type: "joined";
      selfId: string;
      resumeToken: string;
      roomCode: string;
      phase: RoomPhase;
      config: RoomConfig;
      players: PlayerPublic[];
      hostId: string;
      map: MapPayload;
      serverTime: number;
    }
  | {
      type: "roster";
      players: PlayerPublic[];
      hostId: string;
      serverTime: number;
    }
  | {
      type: "phase";
      phase: RoomPhase;
      /** 仅 countdown 阶段存在 */
      startAt?: number;
      serverTime: number;
    }
  | {
      type: "started";
      startAt: number;
      /** 本局结束时间戳（服务端时间） */
      endsAt: number;
      serverTime: number;
      config: RoomConfig;
      map: MapPayload;
      players: SnakeState[];
      foods: FlatPoints;
    }
  | Snapshot
  | {
      type: "gameOver";
      winnerId: string | null;
      reason: "last_alive" | "all_dead" | "time_up";
      ranking: RankingEntry[];
      serverTime: number;
    }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "pong"; t: number; serverTime: number }
  | {
      type: "roomClosed";
      reason: "empty" | "expired" | "server_restart";
    };

/* -------------------------------- 常量 -------------------------------- */

/** 房间码长度，和后端保持一致。 */
export const ROOM_CODE_LENGTH = 6;

/** sessionStorage 里保存重连凭证的键。 */
export const RESUME_KEY_PREFIX = "snake:room:";

/** 昵称在本地记住，下次进来自动填好。 */
export const NAME_KEY = "snake:playerName";

/** 昵称最大长度，与数据库 playerscore.name 的 varchar(32) 对齐。 */
export const NAME_MAX_LENGTH = 32;
