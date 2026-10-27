/**
 * 四条蛇的配色。
 *
 * 座位号（slot）由服务端分配，颜色完全由客户端按 slot 取——
 * 服务端只管规则，不管颜色，所以这里是唯一的配色来源。
 */

export type PlayerColor = {
  body: string;
  head: string;
  eye: string;
  /** 名单 / 计分板上的小圆点 */
  dot: string;
  /** 浅色背景上的文字颜色（计分板用） */
  text: string;
};

export const PLAYER_COLORS: PlayerColor[] = [
  {
    body: "#22c55e",
    head: "#86efac",
    eye: "#052e16",
    dot: "#22c55e",
    text: "#15803d",
  },
  {
    body: "#38bdf8",
    head: "#7dd3fc",
    eye: "#082f49",
    dot: "#38bdf8",
    text: "#0369a1",
  },
  {
    body: "#a78bfa",
    head: "#c4b5fd",
    eye: "#2e1065",
    dot: "#a78bfa",
    text: "#6d28d9",
  },
  {
    body: "#fb923c",
    head: "#fdba74",
    eye: "#431407",
    dot: "#fb923c",
    text: "#c2410c",
  },
];

export function colorForSlot(slot: number): PlayerColor {
  return PLAYER_COLORS[((slot % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}

/** 棋盘底色调，和单人模式保持一致。 */
export const BOARD_COLORS = {
  background: "#0b1220",
  grid: "rgba(148, 163, 184, 0.14)",
  // 障碍物原本是 #1e293b，在深底上几乎糊成一团，
  // 提亮一档 + 更明显的描边，远看也能一眼分清哪块不能撞
  obstacleFill: "#243347",
  obstacleStroke: "#465a75",
  food: "#fb7185",
  foodBurst: "#fda4af",
  selfOutline: "rgba(255, 255, 255, 0.85)",
  selfRing: "rgba(255, 255, 255, 0.55)",
  nameTag: "rgba(15, 23, 42, 0.78)",
};
