import { NextResponse } from "next/server";

import { LEADERBOARD_LIMIT, NAME_MAX_LENGTH } from "@/lib/constants";
import { sql } from "@/lib/db";
import { toPlayerScore, type PlayerScoreRow } from "@/lib/scores";

// 排行榜需要实时读库，禁用静态化。
export const dynamic = "force-dynamic";

const MAX_LIMIT = 100;

function resolveLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return LEADERBOARD_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * GET /api/scores?limit=10
 * 返回排行榜：分数高的在前，同分时先达成记录的排前面。
 */
export async function GET(request: Request) {
  try {
    const limit = resolveLimit(new URL(request.url).searchParams.get("limit"));

    const rows = (await sql`
      SELECT id, name, score, created_at
      FROM public.playerscore
      ORDER BY score DESC, created_at ASC
      LIMIT ${limit}
    `) as PlayerScoreRow[];

    return NextResponse.json({ scores: rows.map(toPlayerScore) });
  } catch (error) {
    console.error("[GET /api/scores] 查询排行榜失败:", error);
    return NextResponse.json({ error: "读取排行榜失败，请稍后重试" }, { status: 500 });
  }
}

/**
 * POST /api/scores
 * 请求体：{ name: string, score: number }
 * 每局游戏结束时写入一条记录。
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是合法的 JSON" }, { status: 400 });
  }

  const { name, score } = (payload ?? {}) as { name?: unknown; score?: unknown };

  if (typeof name !== "string" || name.trim() === "") {
    return NextResponse.json({ error: "玩家名字不能为空" }, { status: 400 });
  }

  const trimmedName = name.trim();
  if (trimmedName.length > NAME_MAX_LENGTH) {
    return NextResponse.json(
      { error: `玩家名字不能超过 ${NAME_MAX_LENGTH} 个字符` },
      { status: 400 },
    );
  }

  if (typeof score !== "number" || !Number.isInteger(score) || score < 0) {
    return NextResponse.json({ error: "分数必须是不小于 0 的整数" }, { status: 400 });
  }

  try {
    const rows = (await sql`
      INSERT INTO public.playerscore (name, score)
      VALUES (${trimmedName}, ${score})
      RETURNING id, name, score, created_at
    `) as PlayerScoreRow[];

    return NextResponse.json({ score: toPlayerScore(rows[0]) }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/scores] 保存成绩失败:", error);
    return NextResponse.json({ error: "保存成绩失败，请稍后重试" }, { status: 500 });
  }
}
