import { NextResponse } from "next/server";

import { getClientIp, isSameOrigin, retryAfterSeconds, takeToken } from "@/lib/request-guard";
import { issueRunTicket } from "@/lib/run-ticket";

export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
/** 每分钟最多领 30 张票：正常玩家一局领一张，刷子会被这里先拦住。 */
const LIMIT = 30;

/**
 * POST /api/runs
 *
 * 开局前领一张签名票据，结算时凭票提交成绩。
 * 没有票据的成绩一律不收——这样「控制台里直接 POST 一个 999999」
 * 就连门都进不来了。
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "来源不合法" }, { status: 403 });
  }

  const ip = getClientIp(request);
  if (!takeToken(`runs:${ip}`, LIMIT, WINDOW_MS)) {
    return NextResponse.json(
      { error: "开得太频繁了，缓一缓再玩" },
      { status: 429, headers: { "Retry-After": retryAfterSeconds(WINDOW_MS) } },
    );
  }

  try {
    const ticket = issueRunTicket();
    return NextResponse.json(ticket, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[POST /api/runs] 签发票据失败:", error);
    return NextResponse.json({ error: "服务器暂时无法开局，请稍后重试" }, { status: 500 });
  }
}
