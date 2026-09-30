/**
 * 前后端共用的类型定义。
 */

/**
 * public.playerscore 表里的一行玩家成绩（已经规范化过的前端友好类型）。
 *
 * id 用 string 而不是 number：数据库列是 bigint，Neon 的 HTTP 驱动会把它
 * 返回成字符串以避免精度丢失，所以这里保持字符串，避免类型撒谎。
 */
export type PlayerScore = {
  id: string;
  name: string;
  score: number;
  created_at: string;
};
