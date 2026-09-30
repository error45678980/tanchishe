import type { PlayerScore } from "./types";

/**
 * 数据库直接返回的原始行。
 * Neon 的 HTTP 驱动不会做类型换算：bigint -> string、int -> number、
 * timestamptz -> ISO 字符串，所以这里按"实际可能拿到的类型"来声明。
 */
export type PlayerScoreRow = {
  id: string | number | bigint;
  name: string;
  score: number | string;
  created_at: string | Date;
};

/**
 * 把原始行规范化成稳定的前端类型。
 * 与其在查询处写 `as PlayerScore[]` 强行断言（类型会撒谎），
 * 不如在这里做一次真实的转换。
 */
export function toPlayerScore(row: PlayerScoreRow): PlayerScore {
  return {
    id: String(row.id),
    name: String(row.name),
    score: Number(row.score),
    created_at: new Date(row.created_at).toISOString(),
  };
}
