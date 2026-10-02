// 初始化访问记录表：运行 node scripts/init-visit-table.mjs
// 只需要跑一次，表已存在时会跳过
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

// 从 .env.local 里读出数据库连接串
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const match = envText.match(/DATABASE_URL\s*=\s*"?([^"\s]+)"?/);
if (!match) {
  console.error("ERROR: .env.local 里没找到 DATABASE_URL");
  process.exit(1);
}

const sql = neon(match[1]);

try {
  await sql`
    CREATE TABLE IF NOT EXISTS public.visit_log (
      id SERIAL PRIMARY KEY,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  console.log("OK: visit_log 表创建成功");
} catch (err) {
  console.error("FAIL:", err);
  process.exit(1);
}

process.exit(0);
