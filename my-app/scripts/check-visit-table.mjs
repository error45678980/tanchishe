// 验证 visit_log 表是否已创建：运行 node scripts/check-visit-table.mjs
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const match = envText.match(/DATABASE_URL\s*=\s*"?([^"\s]+)"?/);
const sql = neon(match[1]);

const rows = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'visit_log'
  ORDER BY ordinal_position
`;
console.log("visit_log 字段:", JSON.stringify(rows));
process.exit(0);
