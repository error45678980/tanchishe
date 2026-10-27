// 验证 visit_log 表是否已创建：运行 node scripts/check-visit-table.mjs
import { readFileSync } from "node:fs";
import pg from "pg";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const match = envText.match(/DATABASE_URL\s*=\s*"?([^"\s]+)"?/);
const client = new pg.Client({ connectionString: match[1] });
await client.connect();

const result = await client.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'visit_log'
  ORDER BY ordinal_position
`);
console.log("visit_log 字段:", JSON.stringify(result.rows));

await client.end();
process.exit(0);
