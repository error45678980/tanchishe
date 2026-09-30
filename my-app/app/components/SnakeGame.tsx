"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { LEADERBOARD_LIMIT, NAME_MAX_LENGTH } from "@/lib/constants";
import type { PlayerScore } from "@/lib/types";

type Point = { x: number; y: number };
type Direction = "up" | "down" | "left" | "right";
type Status = "idle" | "running" | "paused" | "over";

/* ------------------------------- 棋盘参数 ------------------------------- */

const COLS = 20;
const ROWS = 20;
const CELL = 20;
const BOARD_WIDTH = COLS * CELL;
const BOARD_HEIGHT = ROWS * CELL;

const START_STEP_MS = 150; // 每前进一步的间隔，越大越慢
const MIN_STEP_MS = 65; // 速度上限
const SPEED_UP_EVERY = 5; // 每吃 5 个食物提速一档
const SPEED_UP_MS = 8; // 每档提速的毫秒数

const DIRECTIONS: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const KEY_TO_DIRECTION: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
};

/* ------------------------------- 游戏状态 ------------------------------- */

type GameState = {
  snake: Point[];
  direction: Point;
  /** 玩家连续按键时，待生效的方向队列 */
  queue: Direction[];
  food: Point | null;
  score: number;
  stepMs: number;
  elapsedMs: number;
  status: Status;
};

function samePoint(a: Point, b: Point) {
  return a.x === b.x && a.y === b.y;
}

/** 在所有空格子里随机挑一个放食物；没有空格子（蛇填满棋盘）时返回 null。 */
function spawnFood(snake: Point[]): Point | null {
  const occupied = new Set(snake.map((segment) => `${segment.x},${segment.y}`));
  const free: Point[] = [];

  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      if (!occupied.has(`${x},${y}`)) free.push({ x, y });
    }
  }

  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)];
}

function createGame(): GameState {
  const centerX = Math.floor(COLS / 2);
  const centerY = Math.floor(ROWS / 2);
  const snake: Point[] = [
    { x: centerX, y: centerY },
    { x: centerX - 1, y: centerY },
    { x: centerX - 2, y: centerY },
  ];

  return {
    snake,
    direction: DIRECTIONS.right,
    queue: [],
    food: spawnFood(snake),
    score: 0,
    stepMs: START_STEP_MS,
    elapsedMs: 0,
    status: "idle",
  };
}

/** 把方向按键放进待生效队列，顺带过滤掉 180° 掉头和重复方向。 */
function enqueueDirection(game: GameState, direction: Direction) {
  if (game.status !== "running") return;

  const last =
    game.queue.length > 0
      ? DIRECTIONS[game.queue[game.queue.length - 1]]
      : game.direction;
  const next = DIRECTIONS[direction];

  if (next.x === -last.x && next.y === -last.y) return; // 掉头会立刻撞死自己
  if (next.x === last.x && next.y === last.y) return; // 同一个方向，忽略
  if (game.queue.length >= 2) return; // 队列太长会让操作变迟钝

  game.queue.push(direction);
}

/** 前进一步。返回 false 表示本局结束（撞墙 / 撞自己 / 蛇填满棋盘）。 */
function stepGame(game: GameState): boolean {
  // 从队列里取出一个合法方向生效
  while (game.queue.length > 0) {
    const candidate = DIRECTIONS[game.queue.shift() as Direction];
    if (candidate.x === -game.direction.x && candidate.y === -game.direction.y) {
      continue;
    }
    game.direction = candidate;
    break;
  }

  const head = game.snake[0];
  const nextHead: Point = {
    x: head.x + game.direction.x,
    y: head.y + game.direction.y,
  };

  // 撞墙
  if (
    nextHead.x < 0 ||
    nextHead.y < 0 ||
    nextHead.x >= COLS ||
    nextHead.y >= ROWS
  ) {
    return false;
  }

  const willEat = game.food !== null && samePoint(game.food, nextHead);
  // 不吃食物时尾巴会往前挪一格，所以尾巴那一格不算撞到自己
  const body = willEat ? game.snake : game.snake.slice(0, -1);
  if (body.some((segment) => samePoint(segment, nextHead))) {
    return false;
  }

  game.snake.unshift(nextHead);

  if (!willEat) {
    game.snake.pop();
    return true;
  }

  game.score += 1;
  if (game.score % SPEED_UP_EVERY === 0) {
    game.stepMs = Math.max(MIN_STEP_MS, game.stepMs - SPEED_UP_MS);
  }

  game.food = spawnFood(game.snake);
  return game.food !== null;
}

/* ------------------------------- 画面渲染 ------------------------------- */

/** 自己画圆角矩形，避免依赖 ctx.roundRect 的浏览器兼容性。 */
function traceRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawBoard(ctx: CanvasRenderingContext2D, game: GameState) {
  // 底色
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

  // 网格线
  ctx.strokeStyle = "rgba(148, 163, 184, 0.14)";
  ctx.lineWidth = 1;
  for (let col = 1; col < COLS; col += 1) {
    ctx.beginPath();
    ctx.moveTo(col * CELL + 0.5, 0);
    ctx.lineTo(col * CELL + 0.5, BOARD_HEIGHT);
    ctx.stroke();
  }
  for (let row = 1; row < ROWS; row += 1) {
    ctx.beginPath();
    ctx.moveTo(0, row * CELL + 0.5);
    ctx.lineTo(BOARD_WIDTH, row * CELL + 0.5);
    ctx.stroke();
  }

  // 食物
  if (game.food) {
    ctx.fillStyle = "#fb7185";
    ctx.beginPath();
    ctx.arc(
      game.food.x * CELL + CELL / 2,
      game.food.y * CELL + CELL / 2,
      CELL / 2 - 3,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  // 蛇身
  game.snake.forEach((segment, index) => {
    ctx.fillStyle = index === 0 ? "#86efac" : "#22c55e";
    traceRoundRect(
      ctx,
      segment.x * CELL + 1.5,
      segment.y * CELL + 1.5,
      CELL - 3,
      CELL - 3,
      5,
    );
    ctx.fill();
  });

  // 蛇眼睛（画在垂直于前进方向的两侧）
  const head = game.snake[0];
  const eyeOffset = CELL * 0.22;
  const eyeRadius = CELL * 0.09;
  const centerX = head.x * CELL + CELL / 2;
  const centerY = head.y * CELL + CELL / 2;
  const offsetX = game.direction.y * eyeOffset;
  const offsetY = game.direction.x * eyeOffset;

  ctx.fillStyle = "#052e16";
  for (const sign of [1, -1]) {
    ctx.beginPath();
    ctx.arc(centerX + offsetX * sign, centerY + offsetY * sign, eyeRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 把 canvas 按屏幕像素比放大，避免高分屏发虚。 */
function setupCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = BOARD_WIDTH * dpr;
  canvas.height = BOARD_HEIGHT * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * 纯取数函数：只负责请求，不碰任何 React 状态，
 * 这样 effect / 事件处理都能安全复用。
 */
async function fetchLeaderboard(): Promise<PlayerScore[]> {
  const response = await fetch(`/api/scores?limit=${LEADERBOARD_LIMIT}`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | { scores?: PlayerScore[]; error?: string }
    | null;

  if (!response.ok) {
    throw new Error(data?.error ?? `读取失败（HTTP ${response.status}）`);
  }

  return Array.isArray(data?.scores) ? data.scores : [];
}

/* ------------------------------- React 组件 ------------------------------- */

export default function SnakeGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<GameState | null>(null);
  /** 真正的玩家名字：开局时写入，结束提交时读取，避免闭包拿到旧值 */
  const playerNameRef = useRef("");
  /** 游戏循环里调用不到最新的 React 回调，用 ref 转发一层 */
  const finishRef = useRef<(finalScore: number) => void>(() => {});

  const [status, setStatus] = useState<Status>("idle");
  const [score, setScore] = useState(0);
  const [playerName, setPlayerName] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const [leaderboard, setLeaderboard] = useState<PlayerScore[]>([]);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [boardError, setBoardError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 只创建一次游戏状态；用惰性初始化避免每次渲染都重新计算
  if (gameRef.current === null) {
    gameRef.current = createGame();
  }

  /**
   * 刷新排行榜。
   * 只能在事件处理函数或异步回调里调用：effect 里同步触发 setState
   * 会引起级联渲染（ESLint 的 react-hooks/set-state-in-effect 会直接报错）。
   */
  const loadLeaderboard = useCallback(async () => {
    try {
      setLeaderboard(await fetchLeaderboard());
      setBoardError(null);
    } catch (error) {
      setBoardError(error instanceof Error ? error.message : "排行榜加载失败");
    } finally {
      setLoadingBoard(false);
    }
  }, []);

  /** 手动刷新排行榜（事件处理函数里可以放心地同步 setState） */
  const handleRefreshLeaderboard = () => {
    setLoadingBoard(true);
    setBoardError(null);
    void loadLeaderboard();
  };

  /** 游戏结束：先把成绩写进数据库，再刷新排行榜 */
  const handleGameOver = useCallback(
    async (finalScore: number) => {
      setStatus("over");
      setScore(finalScore);
      setSaving(true);
      setSaveError(null);

      try {
        const response = await fetch("/api/scores", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: playerNameRef.current, score: finalScore }),
        });
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;

        if (!response.ok) {
          throw new Error(data?.error ?? `保存失败（HTTP ${response.status}）`);
        }

        await loadLeaderboard();
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : "保存成绩失败");
      } finally {
        setSaving(false);
      }
    },
    [loadLeaderboard],
  );

  // 让游戏循环永远调用到最新的 handleGameOver
  useEffect(() => {
    finishRef.current = (finalScore: number) => {
      void handleGameOver(finalScore);
    };
  }, [handleGameOver]);

  // 首次进入页面就拉一次排行榜。
  // 所有 setState 都放在 Promise 回调里，effect 体内不做同步状态更新。
  useEffect(() => {
    let cancelled = false;

    fetchLeaderboard()
      .then((scores) => {
        if (cancelled) return;
        setLeaderboard(scores);
        setBoardError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBoardError(error instanceof Error ? error.message : "排行榜加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoadingBoard(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // 游戏主循环：requestAnimationFrame 负责推进逻辑 + 重绘
  useEffect(() => {
    const canvas = canvasRef.current;
    const game = gameRef.current;
    if (!canvas || !game) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    setupCanvas(canvas, ctx);

    let frame = 0;
    let previous = performance.now();

    const loop = (now: number) => {
      // 切到后台再切回来时 delta 会非常大，钳制一下避免蛇瞬移
      const delta = Math.min(now - previous, 200);
      previous = now;

      if (game.status === "running") {
        game.elapsedMs += delta;
        while (game.elapsedMs >= game.stepMs) {
          game.elapsedMs -= game.stepMs;
          if (!stepGame(game)) {
            game.status = "over";
            game.elapsedMs = 0;
            finishRef.current(game.score);
            break;
          }
        }
      }

      drawBoard(ctx, game);
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  // 键盘控制
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const game = gameRef.current;
      if (!game) return;

      const direction =
        KEY_TO_DIRECTION[event.key] ?? KEY_TO_DIRECTION[event.key.toLowerCase()];

      if (direction) {
        event.preventDefault(); // 别让方向键滚动页面
        enqueueDirection(game, direction);
        return;
      }

      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault(); // 别让空格滚动页面
        if (game.status === "running") {
          game.status = "paused";
          setStatus("paused");
        } else if (game.status === "paused") {
          game.status = "running";
          setStatus("running");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /** 开一局新游戏（必须原地修改对象，游戏循环才看得到新状态） */
  const resetGame = useCallback((nameToUse: string) => {
    const game = gameRef.current;
    if (!game) return;

    Object.assign(game, createGame());
    game.status = "running";

    playerNameRef.current = nameToUse;
    setPlayerName(nameToUse);
    setScore(0);
    setSaveError(null);
    setStatus("running");
  }, []);

  const handleStart = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = nameInput.trim();
    if (trimmed === "") {
      setFormError("请先输入你的名字");
      return;
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      setFormError(`名字不能超过 ${NAME_MAX_LENGTH} 个字符`);
      return;
    }

    setFormError(null);
    resetGame(trimmed);
  };

  const handlePauseToggle = () => {
    const game = gameRef.current;
    if (!game) return;

    if (game.status === "running") {
      game.status = "paused";
      setStatus("paused");
    } else if (game.status === "paused") {
      game.status = "running";
      setStatus("running");
    }
  };

  /** 回到"输入名字"的初始界面 */
  const handleBackToIdle = () => {
    const game = gameRef.current;
    if (game) {
      Object.assign(game, createGame());
    }
    setStatus("idle");
    setScore(0);
    setSaveError(null);
    setNameInput(playerName || nameInput);
  };

  const overlayVisible = status !== "running";

  return (
    <section className="flex w-full flex-col items-center gap-6 lg:flex-row lg:items-start lg:justify-center">
      <div className="flex w-full max-w-[420px] flex-col gap-3">
        {/* 顶部信息条 */}
        <div className="flex items-center justify-between rounded-xl bg-zinc-900 px-4 py-2 text-sm text-zinc-100">
          <span className="truncate">
            玩家：<span className="font-medium">{playerName || "—"}</span>
          </span>
          <span className="font-mono text-lg font-semibold text-emerald-400">
            {score} 分
          </span>
        </div>

        {/* 棋盘 */}
        <div className="relative overflow-hidden rounded-xl ring-1 ring-black/10 dark:ring-white/15">
          <canvas
            ref={canvasRef}
            width={BOARD_WIDTH}
            height={BOARD_HEIGHT}
            className="block h-auto w-full"
          />

          {overlayVisible && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/75 p-6 text-center backdrop-blur-sm">
              {status === "idle" && (
                <form
                  onSubmit={handleStart}
                  className="flex w-full max-w-xs flex-col gap-3"
                >
                  <h2 className="text-lg font-semibold text-white">
                    输入名字，开始游戏
                  </h2>
                  <input
                    value={nameInput}
                    onChange={(event) => {
                      setNameInput(event.target.value);
                      setFormError(null);
                    }}
                    maxLength={NAME_MAX_LENGTH}
                    placeholder="你的名字"
                    autoFocus
                    className="w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-center text-white placeholder:text-white/40 focus:border-emerald-400 focus:outline-none"
                  />
                  {formError && <p className="text-xs text-rose-300">{formError}</p>}
                  <button
                    type="submit"
                    className="rounded-lg bg-emerald-500 px-4 py-2 font-medium text-white transition-colors hover:bg-emerald-400"
                  >
                    开始游戏
                  </button>
                </form>
              )}

              {status === "paused" && (
                <>
                  <h2 className="text-lg font-semibold text-white">已暂停</h2>
                  <div className="flex flex-wrap justify-center gap-3">
                    <button
                      type="button"
                      onClick={handlePauseToggle}
                      className="rounded-lg bg-emerald-500 px-4 py-2 font-medium text-white transition-colors hover:bg-emerald-400"
                    >
                      继续
                    </button>
                    <button
                      type="button"
                      onClick={handleBackToIdle}
                      className="rounded-lg border border-white/25 px-4 py-2 font-medium text-white transition-colors hover:bg-white/10"
                    >
                      重新开始
                    </button>
                  </div>
                </>
              )}

              {status === "over" && (
                <>
                  <h2 className="text-lg font-semibold text-white">游戏结束</h2>
                  <p className="font-mono text-4xl font-bold text-emerald-400">
                    {score} 分
                  </p>
                  <p className="text-xs text-zinc-300">
                    {saving
                      ? "正在保存成绩…"
                      : saveError
                        ? `保存失败：${saveError}`
                        : "成绩已保存到数据库"}
                  </p>
                  {saveError && (
                    <button
                      type="button"
                      onClick={() => void handleGameOver(score)}
                      className="text-xs text-amber-300 underline decoration-dotted"
                    >
                      重试保存
                    </button>
                  )}
                  <div className="flex flex-wrap justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => resetGame(playerName)}
                      className="rounded-lg bg-emerald-500 px-4 py-2 font-medium text-white transition-colors hover:bg-emerald-400"
                    >
                      再来一局
                    </button>
                    <button
                      type="button"
                      onClick={handleBackToIdle}
                      className="rounded-lg border border-white/25 px-4 py-2 font-medium text-white transition-colors hover:bg-white/10"
                    >
                      换个名字
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
          方向键 / WASD 控制方向，空格暂停或继续
        </p>
      </div>

      {/* 排行榜 */}
      <aside className="w-full max-w-[420px] rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-900 lg:w-80">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            排行榜 TOP {LEADERBOARD_LIMIT}
          </h2>
          <button
            type="button"
            onClick={handleRefreshLeaderboard}
            className="text-xs text-emerald-600 hover:underline dark:text-emerald-400"
          >
            刷新
          </button>
        </div>

        {loadingBoard ? (
          <p className="py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
            加载中…
          </p>
        ) : boardError ? (
          <p className="py-6 text-center text-xs text-rose-500 dark:text-rose-400">
            {boardError}
          </p>
        ) : leaderboard.length === 0 ? (
          <p className="py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
            还没有任何记录，快来当第一个吧！
          </p>
        ) : (
          <ol className="flex flex-col gap-1">
            {leaderboard.map((entry, index) => (
              <li
                key={entry.id}
                title={new Date(entry.created_at).toLocaleString("zh-CN")}
                className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-sm ${
                  entry.name === playerName ? "bg-emerald-50 dark:bg-emerald-500/10" : ""
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-5 shrink-0 text-center text-xs text-zinc-400">
                    {index + 1}
                  </span>
                  <span className="truncate text-zinc-800 dark:text-zinc-200">
                    {entry.name}
                  </span>
                </span>
                <span className="shrink-0 pl-2 font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                  {entry.score}
                </span>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </section>
  );
}

