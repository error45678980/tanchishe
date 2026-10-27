import { Pool } from "pg";

/**
 * ⚠️ 这个文件只能在服务端（Server Component / Route Handler）引用。
 * 它依赖 process.env.DATABASE_URL，一旦被打进客户端 bundle 就会直接抛错。
 * 前后端共用的常量请写在 lib/constants.ts，类型写在 lib/types.ts。
 */

if (!process.env.DATABASE_URL) {
  throw new Error(
    "缺少环境变量 DATABASE_URL，请在 my-app/.env.local 中配置数据库连接串。",
  );
}

/**
 * 标准 PostgreSQL 连接池（node-postgres）。
 * 应用从池子里借连接用，用完还回去，比每次现连快。
 * 自建数据库和云数据库都能连，靠 DATABASE_URL 区分。
 */
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
