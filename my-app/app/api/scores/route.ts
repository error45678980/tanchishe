import { NextResponse } from "next/server";

import { LEADERBOARD_LIMIT } from "@/lib/constants";
import { pool } from "@/lib/db";
import {
  getClientIp,
  isSameOrigin,
  readJsonBody,
  retryAfterSeconds,
  takeToken,
} from "@/lib/request-guard";
import { BOARD_MAX_SCORE, maxPlausibleScore, verifyRunTicket } from "@/lib/run-ticket";
import { toPlayerScore, type PlayerScoreRow } from "@/lib/scores";
import { normalizePlayerName } from "@/lib/validation";

// 排行榜需要实时读库，禁用静态化。
export const dynamic = "force-dynamic";

const MAX_LIMIT = 100;

/* ------------------------------ 提交限流 ------------------------------ */

const SUBMIT_WINDOW_MS = 10 * 60_000;
/** 十分钟最多交 20 局。正常人打不了这么多，刷子会先撞墙。 */
const SUBMIT_LIMIT = 20;

const HOURLY_WINDOW_MS = 60 * 60_000;
/** 一小时最多 60 局，给「十分钟 20 局」再叠一层天花板。 */
const HOURLY_LIMIT = 60;

/* ---------------------------- 票据重放保护 ---------------------------- */

/**
 * 已经用过的 runId。值存的是票据过期时间，用来判断什么时候可以回收。
 *
 * 进程内存储：单实例部署（pm2 fork）足够，重启后清空——但票据本身
 * 有时效，且分数还受物理上限约束，风险可控。
 */
const usedRuns = new Map<string, number>();

function pruneUsedRuns(now: number) {
  if (usedRuns.size < 5_000) return;
  for (const [runId, expiresAt] of usedRuns) {
    if (expiresAt <= now) usedRuns.delete(runId);
  }
}

function resolveLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return LEADERBOARD_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * GET /api/scores?limit=10
 * 返回排行榜：分数高的在前，同分时先达成记录的排前面。
 *
 * 顺便过滤掉超出棋盘理论上限的记录：历史上被注入的 999999 分
 * 即使还躺在库里，也不会再出现在榜单上。
 */
export async function GET(request: Request) {
  try {
    const limit = resolveLimit(new URL(request.url).searchParams.get("limit"));

    const result = await pool.query(
      `SELECT id, name, score, created_at
       FROM public.playerscore
       WHERE score >= 0 AND score <= $1
       ORDER BY score DESC, created_at ASC
       LIMIT $2`,
      [BOARD_MAX_SCORE, limit],
    );
    const rows = result.rows as PlayerScoreRow[];

    return NextResponse.json(
      { scores: rows.map(toPlayerScore) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[GET /api/scores] 查询排行榜失败:", error);
    return NextResponse.json({ error: "读取排行榜失败，请稍后重试" }, { status: 500 });
  }
}

/**
 * POST /api/scores
 * 请求体：{ name, score, runId, token, durationMs? }
 *
 * 光有分数不够，还得带上开局时领的签名票据：
 * - 验签 → 确认这张票是我们自己签的，不是控制台里编的；
 * - 限时 → 票据过期不收；
 * - 限次 → 一张票只能交一次；
 * - 限量 → 分数不能超过「棋盘上限」和「这局时长能吃到的最多豆子」。
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "来源不合法" }, { status: 403 });
  }

  const ip = getClientIp(request);
  if (
    !takeToken(`scores:${ip}`, SUBMIT_LIMIT, SUBMIT_WINDOW_MS) ||
    !takeToken(`scores-hour:${ip}`, HOURLY_LIMIT, HOURLY_WINDOW_MS)
  ) {
    return NextResponse.json(
      { error: "提交太频繁了，稍后再试" },
      { status: 429, headers: { "Retry-After": retryAfterSeconds(SUBMIT_WINDOW_MS) } },
    );
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const { name, score, runId, token, durationMs } = (body.value ?? {}) as {
    name?: unknown;
    score?: unknown;
    runId?: unknown;
    token?: unknown;
    durationMs?: unknown;
  };

  const nameResult = normalizePlayerName(name);
  if (!nameResult.ok) {
    return NextResponse.json({ error: nameResult.error }, { status: 400 });
  }

  if (typeof score !== "number" || !Number.isInteger(score) || score < 0) {
    return NextResponse.json({ error: "分数必须是不小于 0 的整数" }, { status: 400 });
  }

  if (score > BOARD_MAX_SCORE) {
    return NextResponse.json(
      { error: `分数超出合理范围（棋盘最多 ${BOARD_MAX_SCORE} 分）` },
      { status: 400 },
    );
  }

  const now = Date.now();
  const ticket = verifyRunTicket(token, now);
  if (!ticket) {
    return NextResponse.json(
      { error: "成绩校验失败，请重新开始一局" },
      { status: 401 },
    );
  }

  if (typeof runId !== "string" || runId !== ticket.rid) {
    return NextResponse.json({ error: "成绩校验失败，请重新开始一局" }, { status: 401 });
  }

  const reportedMs =
    typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : undefined;

  const allowed = maxPlausibleScore(now - ticket.iat, reportedMs);
  if (score > allowed) {
    return NextResponse.json(
      { error: `成绩与对局时长不匹配（本局最多 ${allowed} 分）` },
      { status: 400 },
    );
  }

  // 先占位再写库：中间没有 await，不会出现两个请求同时通过检查的窗口
  if (usedRuns.has(ticket.rid)) {
    return NextResponse.json(
      { error: "这局成绩已经提交过了", code: "DUPLICATE_RUN" },
      { status: 409 },
    );
  }
  usedRuns.set(ticket.rid, ticket.exp);
  pruneUsedRuns(now);

  try {
    const result = await pool.query(
      `INSERT INTO public.playerscore (name, score)
       VALUES ($1, $2)
       RETURNING id, name, score, created_at`,
      [nameResult.name, score],
    );
    const rows = result.rows as PlayerScoreRow[];

    return NextResponse.json({ score: toPlayerScore(rows[0]) }, { status: 201 });
  } catch (error) {
    usedRuns.delete(ticket.rid); // 写库失败就把票据还回去，允许重试
    console.error("[POST /api/scores] 保存成绩失败:", error);
    return NextResponse.json({ error: "保存成绩失败，请稍后重试" }, { status: 500 });
  }
}
