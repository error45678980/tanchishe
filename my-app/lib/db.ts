import { neon } from "@neondatabase/serverless";

/**
 * ⚠️ 这个文件只能在服务端（Server Component / Route Handler）引用。
 * 它依赖 process.env.DATABASE_URL，一旦被打进客户端 bundle 就会直接抛错。
 * 前后端共用的常量请写在 lib/constants.ts，类型写在 lib/types.ts。
 */

if (!process.env.DATABASE_URL) {
  throw new Error(
    "缺少环境变量 DATABASE_URL，请在 my-app/.env.local 中配置 Neon 数据库连接串。",
  );
}

/**
 * Neon 的 HTTP 版数据库客户端：每次查询都是一次独立的 fetch，
 * 不需要维护连接池，适合部署在 Serverless / Edge 环境。
 */
export const sql = neon(process.env.DATABASE_URL);
