import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { pool } from "@/lib/db";
import {
  getClientIp,
  isSameOrigin,
  retryAfterSeconds,
  takeToken,
} from "@/lib/request-guard";

// 这个接口不走静态缓存，每次都真实写库
export const dynamic = "force-dynamic";

/** 同一个「IP + 浏览器」半小时内只记一次，避免刷新一下就是一条。 */
const DEDUPE_WINDOW_MS = 30 * 60_000;
/** 单个 IP 每小时最多 40 条，挡住脚本灌库。 */
const LIMIT_WINDOW_MS = 60 * 60_000;
const LIMIT = 40;
/** user_agent 截断长度：真实 UA 很少有超过 256 字符的。 */
const UA_MAX_LENGTH = 256;

/** key → 上次写入时间。进程内即可，重启后多记一条无伤大雅。 */
const seen = new Map<string, number>();

function pruneSeen(now: number) {
  if (seen.size < 10_000) return;
  for (const [key, at] of seen) {
    if (now - at > DEDUPE_WINDOW_MS) seen.delete(key);
  }
}

// POST /api/visit
// 记录一次页面访问：存 IP 和浏览器信息
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  // 经过隧道/代理时，真实 IP 一般在 x-forwarded-for 头里；
  // 这里统一交给 request-guard 解析，非法值会被丢掉。
  const ip = getClientIp(request);
  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, UA_MAX_LENGTH);

  if (!takeToken(`visit:${ip}`, LIMIT, LIMIT_WINDOW_MS)) {
    // 超限不报错：访客不该看到红字，静默丢弃即可
    return NextResponse.json(
      { ok: true, skipped: true },
      { status: 429, headers: { "Retry-After": retryAfterSeconds(LIMIT_WINDOW_MS) } },
    );
  }

  const now = Date.now();
  const fingerprint = createHash("sha1")
    .update(`${ip}\n${userAgent}`)
    .digest("hex");

  const last = seen.get(fingerprint);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  seen.set(fingerprint, now);
  pruneSeen(now);

  try {
    await pool.query(
      `INSERT INTO public.visit_log (ip, user_agent)
       VALUES ($1, $2)`,
      [ip, userAgent],
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    seen.delete(fingerprint); // 写失败就允许下次重试
    console.error("[POST /api/visit] 记录访问失败:", error);
    return NextResponse.json({ error: "记录访问失败" }, { status: 500 });
  }
}
