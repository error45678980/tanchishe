// 清理排行榜里的脏数据：分数超出棋盘理论上限（0~400）的记录。
//
// 用法：
//   node scripts/clean-scores.mjs                 # 只体检，不改数据
//   node scripts/clean-scores.mjs --apply         # 真的删掉
//   node scripts/clean-scores.mjs --apply --name 校验测试 --name 端到端测试
//
// 背景：早期 /api/scores 完全信任客户端，控制台里一行 fetch 就能写进
// 999999 分。现在接口已经加了签名票据，这个脚本负责把历史脏数据清掉。
import { readFileSync } from "node:fs";
import pg from "pg";

const MAX_SCORE = 400;

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const match = envText.match(/DATABASE_URL\s*=\s*"?([^"\s]+)"?/);
if (!match) {
  console.error("ERROR: .env.local 里没找到 DATABASE_URL");
  process.exit(1);
}

const client = new pg.Client({ connectionString: match[1] });
await client.connect();

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");

const names = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--name" && argv[i + 1]) names.push(argv[i + 1]);
}

const invalidResult = await client.query(
  `SELECT id, name, score, created_at
   FROM public.playerscore
   WHERE score < 0 OR score > $1
   ORDER BY id`,
  [MAX_SCORE],
);
const invalid = invalidResult.rows;

console.log(`超出合理范围的记录：${invalid.length} 条`);
for (const row of invalid) {
  console.log(`  #${row.id}  ${row.name}  ${row.score}  ${new Date(row.created_at).toISOString()}`);
}

let named = [];
if (names.length > 0) {
  const namedResult = await client.query(
    `SELECT id, name, score, created_at
     FROM public.playerscore
     WHERE name = ANY($1)
     ORDER BY id`,
    [names],
  );
  named = namedResult.rows;
  console.log(`\n按名字匹配到的记录：${named.length} 条（${names.join(" / ")}）`);
  for (const row of named) {
    console.log(`  #${row.id}  ${row.name}  ${row.score}`);
  }
}

if (!apply) {
  console.log("\n这是体检模式，没有改动任何数据。确认无误后加 --apply 再跑一次。");
  await client.end();
  process.exit(0);
}

if (invalid.length > 0) {
  await client.query(`DELETE FROM public.playerscore WHERE score < 0 OR score > $1`, [MAX_SCORE]);
  console.log(`\n已删除 ${invalid.length} 条越界记录`);
}

for (const name of names) {
  await client.query(`DELETE FROM public.playerscore WHERE name = $1`, [name]);
  console.log(`已删除名字为「${name}」的记录`);
}

console.log("完成。");
await client.end();
process.exit(0);
