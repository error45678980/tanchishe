"use client";

import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { BOARD_COLORS, colorForSlot } from "@/lib/multiplayer/colors";
import type {
  Direction,
  MapPayload,
  RoomConfig,
  SnakeState,
  Snapshot,
} from "@/lib/multiplayer/types";

type Props = {
  snapshotRef: RefObject<Snapshot | null>;
  map: MapPayload | null;
  config: RoomConfig | null;
  selfId: string | null;
  /** 触屏滑动转向 */
  onSwipe?: (direction: Direction) => void;
  /** 只有对局中才接受滑动，其他阶段滑动不该误触发 */
  swipeEnabled?: boolean;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  decay: number;
  color: string;
  size: number;
};

type Ring = { x: number; y: number; life: number; color: string };

type Scene = {
  curr: Snapshot | null;
  /** 每条蛇上一次「真的动了」时的样子，用来做插值 */
  prevPlayers: Map<string, SnakeState>;
  /** 每条蛇上一次移动的时间戳，插值进度按它算 */
  movedAt: Map<string, number>;
  lastTick: number;
  particles: Particle[];
  rings: Ring[];
};

const DIRECTION_VECTORS: Record<Direction, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const SWIPE_MIN_DISTANCE = 24;
const FRAME_INTERVAL_MS = 32;

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

/* ------------------------------ 静态层 ------------------------------ */

/**
 * 网格和障碍物整局都不会变，只在开局时画一次存进离屏画布。
 * 之后每帧只要 drawImage 一下——这是手机上最省电的一刀。
 */
function drawStatic(
  ctx: CanvasRenderingContext2D,
  config: RoomConfig,
  map: MapPayload,
) {
  const { cols, rows, cell } = config;
  const width = cols * cell;
  const height = rows * cell;

  ctx.fillStyle = BOARD_COLORS.background;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = BOARD_COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let col = 1; col < cols; col += 1) {
    const x = col * cell + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let row = 1; row < rows; row += 1) {
    const y = row * cell + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  ctx.fillStyle = BOARD_COLORS.obstacleFill;
  ctx.strokeStyle = BOARD_COLORS.obstacleStroke;
  ctx.lineWidth = 1;
  for (let i = 0; i < map.obstacles.length; i += 2) {
    const x = map.obstacles[i] * cell;
    const y = map.obstacles[i + 1] * cell;
    traceRoundRect(ctx, x + 0.5, y + 0.5, cell - 1, cell - 1, 3);
    ctx.fill();
    ctx.stroke();
  }
}

/* ------------------------------ 特效 ------------------------------ */

function spawnEffects(scene: Scene, snapshot: Snapshot) {
  if (snapshot.events.length === 0) return;

  for (const event of snapshot.events) {
    if (event.type === "eat") {
      for (let i = 0; i < 8; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.2 + Math.random() * 2.6;
        scene.particles.push({
          x: event.x + 0.5,
          y: event.y + 0.5,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: 2.4 + Math.random() * 1.4,
          color: BOARD_COLORS.foodBurst,
          size: 1 + Math.random() * 1.4,
        });
      }
      continue;
    }

    if (event.type === "death") {
      const slot = snapshot.players.find((p) => p.id === event.playerId)?.slot ?? 0;
      const color = colorForSlot(slot);

      scene.rings.push({
        x: event.x + 0.5,
        y: event.y + 0.5,
        life: 1,
        color: color.head,
      });

      for (let i = 0; i < 18; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 5;
        scene.particles.push({
          x: event.x + 0.5,
          y: event.y + 0.5,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: 1.3 + Math.random() * 1.1,
          color: i % 3 === 0 ? color.head : color.body,
          size: 1.2 + Math.random() * 2,
        });
      }
    }
  }
}

function stepEffects(scene: Scene, dt: number) {
  if (scene.particles.length > 0) {
    for (const particle of scene.particles) {
      particle.x += (particle.vx * dt) / 1000;
      particle.y += (particle.vy * dt) / 1000;
      particle.vx *= 0.93;
      particle.vy *= 0.93;
      particle.life -= (particle.decay * dt) / 1000;
    }
    scene.particles = scene.particles.filter((particle) => particle.life > 0);
  }

  if (scene.rings.length > 0) {
    for (const ring of scene.rings) ring.life -= dt / 460;
    scene.rings = scene.rings.filter((ring) => ring.life > 0);
  }
}

/* ------------------------------ 插值 ------------------------------ */

/**
 * 一格一格地跳太生硬，这里在「上一次位置」和「这一次位置」之间做线性插值。
 *
 * 蛇的移动有个天然优势：第 i 节的新位置正好等于第 i-1 节的旧位置，
 * 所以逐节插值出来永远是一条沿轴向滑动的连续身体，不会斜着穿模。
 */
function segmentAt(
  player: SnakeState,
  prev: SnakeState | null,
  index: number,
  alpha: number,
): { x: number; y: number } {
  const currentX = player.snake[index * 2];
  const currentY = player.snake[index * 2 + 1];

  if (!prev || alpha >= 1) return { x: currentX, y: currentY };

  const prevX = prev.snake[index * 2];
  const prevY = prev.snake[index * 2 + 1];
  if (prevX === undefined || prevY === undefined) return { x: currentX, y: currentY };

  return {
    x: prevX + (currentX - prevX) * alpha,
    y: prevY + (currentY - prevY) * alpha,
  };
}

/* ------------------------------ 动态层 ------------------------------ */

function drawDynamic(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  config: RoomConfig,
  selfId: string | null,
  now: number,
  dt: number,
  displayScale: number,
) {
  const snapshot = scene.curr;
  if (!snapshot) return;

  const { cell } = config;

  stepEffects(scene, dt);

  // 豆子：轻微呼吸感
  const pulse = 1 + Math.sin(now / 320) * 0.08;
  ctx.fillStyle = BOARD_COLORS.food;
  for (let i = 0; i < snapshot.foods.length; i += 2) {
    const cx = snapshot.foods[i] * cell + cell / 2;
    const cy = snapshot.foods[i + 1] * cell + cell / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, (cell / 2 - 4) * pulse, 0, Math.PI * 2);
    ctx.fill();
  }

  // 蛇
  for (const player of snapshot.players) {
    if (!player.alive || player.snake.length === 0) continue;

    const prev = scene.prevPlayers.get(player.id) ?? null;
    const movedAt = scene.movedAt.get(player.id) ?? 0;
    const stepMs = Math.max(40, player.stepMs);
    const alpha = Math.min(1, Math.max(0, (now - movedAt) / stepMs));

    const color = colorForSlot(player.slot);
    const isSelf = player.id === selfId;
    const count = player.snake.length / 2;

    for (let i = 0; i < count; i += 1) {
      const point = segmentAt(player, prev, i, alpha);
      const x = point.x * cell;
      const y = point.y * cell;
      const isHead = i === 0;

      ctx.fillStyle = isHead ? color.head : color.body;

      if (isHead && player.boosting) {
        ctx.save();
        ctx.shadowColor = color.head;
        ctx.shadowBlur = 14;
      }

      traceRoundRect(ctx, x + 1.5, y + 1.5, cell - 3, cell - 3, 5);
      ctx.fill();

      if (isHead && player.boosting) ctx.restore();

      if (isSelf) {
        ctx.strokeStyle = BOARD_COLORS.selfOutline;
        ctx.lineWidth = 1.4;
        traceRoundRect(ctx, x + 1.5, y + 1.5, cell - 3, cell - 3, 5);
        ctx.stroke();
      }
    }

    const head = segmentAt(player, prev, 0, alpha);
    const headCenterX = head.x * cell + cell / 2;
    const headCenterY = head.y * cell + cell / 2;

    // 蛇眼睛（画在垂直于前进方向的两侧）
    const vec = DIRECTION_VECTORS[player.dir];
    const eyeOffset = cell * 0.2;
    const eyeRadius = cell * 0.085;

    ctx.fillStyle = color.eye;
    for (const sign of [1, -1]) {
      ctx.beginPath();
      ctx.arc(
        headCenterX + vec.y * eyeOffset * sign,
        headCenterY + vec.x * eyeOffset * sign,
        eyeRadius,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }

    // 自己的蛇：套一圈会呼吸的光环，四个人混战时一眼找到自己
    if (isSelf) {
      const glow = 0.45 + 0.35 * Math.sin(now / 280);
      ctx.strokeStyle = `rgba(255, 255, 255, ${glow.toFixed(2)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(headCenterX, headCenterY, cell * 0.68, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 名字标签
    const label = player.name.length > 6 ? `${player.name.slice(0, 5)}…` : player.name;
    if (label) {
      // 画布逻辑宽度是 600，手机上会被缩到 ~366，
      // 固定字号会缩成 7px 的蚂蚁字。这里按实际缩放反推，
      // 让屏幕上的字号稳定在 9px 上下（夹在 9–15 之间防止过大过小）。
      const scale = Math.max(0.3, displayScale);
      const fontSize = Math.round(Math.min(15, Math.max(9, 9 / scale)));
      ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const textWidth = ctx.measureText(label).width;
      const paddingX = 4;
      const boxWidth = textWidth + paddingX * 2;
      const boxHeight = fontSize + 5;
      const boxX = headCenterX - boxWidth / 2;
      const boxY = headCenterY - cell * 0.5 - boxHeight - 2;

      ctx.globalAlpha = 0.82;
      ctx.fillStyle = BOARD_COLORS.nameTag;
      traceRoundRect(ctx, boxX, boxY, boxWidth, boxHeight, 4);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = isSelf ? "#ffffff" : "rgba(226, 232, 240, 0.92)";
      ctx.fillText(label, headCenterX, boxY + boxHeight / 2);
    }
  }

  // 死亡冲击波
  for (const ring of scene.rings) {
    const life = Math.max(0, ring.life);
    ctx.globalAlpha = life * 0.75;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ring.x * cell, ring.y * cell, (1 - life) * cell * 1.8 + cell * 0.3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 粒子
  for (const particle of scene.particles) {
    ctx.globalAlpha = Math.max(0, Math.min(1, particle.life));
    ctx.fillStyle = particle.color;
    ctx.beginPath();
    ctx.arc(particle.x * cell, particle.y * cell, particle.size, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

/* ------------------------------ 组件 ------------------------------ */

export default function MultiplayerBoard({
  snapshotRef,
  map,
  config,
  selfId,
  onSwipe,
  swipeEnabled = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(
    null,
  );

  const sceneRef = useRef<Scene>({
    curr: null,
    prevPlayers: new Map(),
    movedAt: new Map(),
    lastTick: -1,
    particles: [],
    rings: [],
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !config || !map) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = config.cols * config.cell;
    const height = config.rows * config.cell;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 静态层：网格 + 障碍，整局只画这一次
    const staticCanvas = document.createElement("canvas");
    staticCanvas.width = width * dpr;
    staticCanvas.height = height * dpr;
    const staticCtx = staticCanvas.getContext("2d");
    if (staticCtx) {
      staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStatic(staticCtx, config, map);
    }

    const scene = sceneRef.current;
    scene.curr = null;
    scene.prevPlayers.clear();
    scene.movedAt.clear();
    scene.particles = [];
    scene.rings = [];
    scene.lastTick = -1;

    // 画布实际显示尺寸 / 逻辑尺寸，用来反推名字标签该用多大字号
    let displayScale = canvas.clientWidth > 0 ? canvas.clientWidth / width : 1;
    const updateScale = () => {
      if (canvas.clientWidth > 0) displayScale = canvas.clientWidth / width;
    };
    window.addEventListener("resize", updateScale);

    let frame = 0;
    let lastDraw = 0;

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);

      // 切到后台就停笔，手机能省一大截电
      if (document.hidden) return;

      if (now - lastDraw < FRAME_INTERVAL_MS) return;
      const dt = Math.min(now - lastDraw, 100);
      lastDraw = now;

      const snapshot = snapshotRef.current;
      if (snapshot && snapshot.tick !== scene.lastTick) {
        if (snapshot.tick < scene.lastTick) {
          // 新一局：把上一局的插值状态和特效残渣清干净
          scene.prevPlayers.clear();
          scene.movedAt.clear();
          scene.particles = [];
          scene.rings = [];
        } else if (scene.curr) {
          // 逐条蛇判断「这一帧到底动没动」，动了的才重置插值起点。
          // 用全局时间戳会让没动的蛇跟着别人的节奏抽一下。
          for (const player of snapshot.players) {
            const before = scene.curr.players.find((item) => item.id === player.id);
            if (!before) continue;

            const moved =
              before.snake[0] !== player.snake[0] ||
              before.snake[1] !== player.snake[1];

            if (moved) {
              scene.prevPlayers.set(player.id, before);
              scene.movedAt.set(player.id, now);
            }
          }
        }

        scene.curr = snapshot;
        scene.lastTick = snapshot.tick;
        spawnEffects(scene, snapshot);
      }

      ctx.drawImage(staticCanvas, 0, 0, width, height);
      drawDynamic(ctx, scene, config, selfId, now, dt, displayScale);
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateScale);
    };
  }, [config, map, selfId, snapshotRef]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!swipeEnabled || !onSwipe) return;
    swipeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
    };
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;

    if (!start || !onSwipe || start.pointerId !== event.pointerId) return;

    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN_DISTANCE) return;

    const direction: Direction =
      Math.abs(dx) > Math.abs(dy)
        ? dx > 0
          ? "right"
          : "left"
        : dy > 0
          ? "down"
          : "up";

    onSwipe(direction);
  };

  const handlePointerCancel = () => {
    swipeStartRef.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={600}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onContextMenu={(event) => event.preventDefault()}
      className="block h-auto w-full touch-none"
    />
  );
}
