import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * 单人对局的「成绩票据」。
 *
 * 单机模式的蛇跑在浏览器里，服务端没法真的看着它走。
 * 所以这里换了个思路：不追求「绝对无法作弊」，而是把
 * 「打开控制台敲一行 fetch 就能刷 999999 分」这条路彻底堵死。
 *
 * 规则：
 * 1. 开局先向 /api/runs 领一张 HMAC 签名的票据（runId + 签发时间 + 过期时间）。
 * 2. 结算时带着票据提交，服务端验签，确认这张票据真的是自己签出去的。
 * 3. 票据只能用一次（重放保护）。
 * 4. 分数还要过两道物理检查：不能超过棋盘理论上限，也不能超过
 *    「这局实际玩了多久」能吃到的最多豆子数。
 *
 * 想再进一步（完全杜绝作弊）只能把单机内核搬到服务端做权威模拟，
 * 那是另一个量级的改造，暂时不做。
 */

/** 票据有效期。3 小时够打完任何一局，又不至于让泄露的票据永久可用。 */
const TICKET_TTL_MS = 3 * 60 * 60 * 1000;

/** 票据里的版本号，将来改格式时可以平滑过渡。 */
const TICKET_VERSION = 1;

/**
 * 棋盘理论上限：20×20 的格子，开局蛇身占 3 格，
 * 最多只能吃到 397 颗豆。留 3 点余量给将来改棋盘尺寸时的手滑。
 */
export const BOARD_MAX_SCORE = 400;

/**
 * 每秒最多能吃几颗豆。
 * 最快步长 42ms（加速状态）≈ 23.8 格/秒，理论上限也就是这个数；
 * 真实对局里食物密度远低于此，8 颗/秒已经宽到不会误杀正常玩家。
 */
export const MAX_SCORE_PER_SECOND = 8;

/** 固定余量，抵消计时误差 / 低端机掉帧导致的时长少算。 */
export const SCORE_GRACE = 8;

export type RunTicketPayload = {
  v: number;
  rid: string;
  iat: number;
  exp: number;
};

export type RunTicket = {
  runId: string;
  token: string;
  startedAt: number;
  expiresAt: number;
};

/**
 * 取签名密钥。
 *
 * 优先用 SCORE_SIGNING_SECRET；没配就退回 DATABASE_URL 派生一个——
 * 这样老部署不改环境变量也能立刻生效，而且重启后密钥不变（票据不会集体失效）。
 * 强烈建议还是显式配一个独立密钥，理由写在部署文档里。
 */
function resolveSecret(): string {
  const explicit = process.env.SCORE_SIGNING_SECRET?.trim();
  if (explicit && explicit.length >= 16) return explicit;

  const fallback = process.env.DATABASE_URL?.trim();
  if (fallback) return `snake-run-ticket:${fallback}`;

  throw new Error(
    "缺少 SCORE_SIGNING_SECRET（或 DATABASE_URL），无法签发成绩票据。",
  );
}

function sign(body: string): string {
  return createHmac("sha256", resolveSecret()).update(body).digest("base64url");
}

/** 签发一张新票据。 */
export function issueRunTicket(now: number = Date.now()): RunTicket {
  const payload: RunTicketPayload = {
    v: TICKET_VERSION,
    rid: randomUUID(),
    iat: now,
    exp: now + TICKET_TTL_MS,
  };

  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  return {
    runId: payload.rid,
    token: `${body}.${sign(body)}`,
    startedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

/**
 * 验签 + 结构校验。任何一步不对都返回 null，调用方统一按「票据无效」处理。
 */
export function verifyRunTicket(
  token: unknown,
  now: number = Date.now(),
): RunTicketPayload | null {
  if (typeof token !== "string") return null;
  if (token.length === 0 || token.length > 512) return null;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null; // 密钥缺失：宁可拒签，也不要放行
  }

  // timingSafeEqual 要求两边等长，长度不同直接判负
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  const { v, rid, iat, exp } = payload as Partial<RunTicketPayload>;

  if (v !== TICKET_VERSION) return null;
  if (typeof rid !== "string" || rid.length < 8 || rid.length > 64) return null;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  if (exp < now) return null; // 过期
  if (iat > now + 60_000) return null; // 来自未来（时钟被改过）

  return { v, rid, iat, exp };
}

/**
 * 这局「最多可能拿到多少分」。
 *
 * 时长取 wall clock 和客户端上报的**有效游玩时长**里更小的那个：
 * - 客户端老实上报 → 用有效时长（暂停不计），卡得更紧；
 * - 客户端瞎报一个超大值 → 被 wall clock 兜住；
 * - 客户端瞎报一个超小值 → 只会把自己的上限压低。
 *
 * 两种情况都不吃亏，所以直接取 min。
 */
export function maxPlausibleScore(wallElapsedMs: number, reportedMs?: number): number {
  const wall = Math.max(0, wallElapsedMs);
  const reported =
    typeof reportedMs === "number" && Number.isFinite(reportedMs) && reportedMs > 0
      ? Math.min(reportedMs, wall)
      : wall;

  const seconds = reported / 1000;
  const byTime = Math.floor(seconds * MAX_SCORE_PER_SECOND) + SCORE_GRACE;

  return Math.min(BOARD_MAX_SCORE, byTime);
}
