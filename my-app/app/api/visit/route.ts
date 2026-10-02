import { NextResponse } from "next/server";

import { sql } from "@/lib/db";

// 这个接口不走静态缓存，每次都真实写库
export const dynamic = "force-dynamic";

// POST /api/visit
// 记录一次页面访问：存 IP 和浏览器信息
export async function POST(request: Request) {
  // 经过隧道/代理时，真实 IP 一般在 x-forwarded-for 头里
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const ip = (forwarded.split(",")[0] ?? "").trim() || "未知";
  const userAgent = request.headers.get("user-agent") ?? "";

  try {
    await sql`
      INSERT INTO public.visit_log (ip, user_agent)
      VALUES (${ip}, ${userAgent})
    `;
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[POST /api/visit] 记录访问失败:", error);
    return NextResponse.json({ error: "记录访问失败" }, { status: 500 });
  }
}
