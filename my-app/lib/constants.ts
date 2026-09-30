/**
 * 前后端共用的常量（这个文件没有任何副作用，可以放心在客户端组件里引用）。
 */

/** 玩家名字的最大长度，与数据库 playerscore.name 的 varchar(32) 对齐。 */
export const NAME_MAX_LENGTH = 32;

/** 排行榜一次返回 / 显示的条数。 */
export const LEADERBOARD_LIMIT = 10;
