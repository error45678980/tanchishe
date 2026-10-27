/**
 * 接口层的公共护栏：来源校验、IP 提取、限流、请求体大小限制。
 *
 * 这些检查是「防脚本刷」而不是「防人」——真正的用户点不出这些请求，
 * 但控制台里一行 fetch 就能。挡不住的部分（比如伪造 IP 头）交给
 * nginx 用 X-Real-IP 覆盖，见部署文档。
 */

/* ------------------------------ 来源校验 ------------------------------ */

/**
 * 从 Host 头里取出主机名（去掉端口）。
 *
 * 不能直接比 host：nginx 默认用 `proxy_set_header Host $host`，
 * 端口会被吃掉；而浏览器的 Origin 带端口。直接比会把自己人也拦在门外。
 * 主机名不同才是真的跨站，端口不同不是安全边界。
 */
function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    // IPv6 字面量：[::1]:3000
    const end = value.indexOf("]");
    return end > 0 ? value.slice(0, end + 1) : value;
  }
  const colon = value.lastIndexOf(":");
  return colon > 0 ? value.slice(0, colon) : value;
}

/**
 * 只接受同源请求。
 *
 * 浏览器在跨站 POST 时一定会带 Origin，对不上就直接拒。
 * 没有 Origin 的（curl / 服务端调用）放行——反正它们也带不上 cookie，
 * 而且后面还有限流兜着。
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false; // Origin: null（沙箱 iframe）之类，一律不认
  }
  if (!originHost) return false;

  const candidates = [request.headers.get("host"), request.headers.get("x-forwarded-host")]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => hostnameOf(value))
    .filter(Boolean);

  if (candidates.length === 0) return true; // 拿不到 Host 就没法比，别误伤
  return candidates.includes(originHost);
}

/* -------------------------------- IP -------------------------------- */

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
/** 只允许 IP 里可能出现的字符，顺手挡掉往日志里塞垃圾字符串的行为。 */
const IPV6 = /^[0-9a-fA-F:.]+$/;

function normalizeIp(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 45) return null;

  // nginx / 隧道常见的 IPv4 映射写法：::ffff:1.2.3.4
  const mapped = value.startsWith("::ffff:") ? value.slice(7) : value;

  if (IPV4.test(mapped)) return mapped;
  if (value.includes(":") && IPV6.test(value)) return value;

  return null;
}

/**
 * 取真实客户端 IP。
 *
 * 优先级：X-Real-IP（nginx 自己写的，客户端改不了）> X-Forwarded-For 第一跳。
 * 拿不到合法 IP 就返回 "unknown"，让所有匿名请求共享同一个限流桶——
 * 宁可错杀，也不要让攻击者靠乱填头绕过限流。
 */
export function getClientIp(request: Request): string {
  const real = normalizeIp(request.headers.get("x-real-ip") ?? "");
  if (real) return real;

  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  for (const hop of forwarded.split(",")) {
    const parsed = normalizeIp(hop);
    if (parsed) return parsed;
  }

  return "unknown";
}

/* ------------------------------- 限流 ------------------------------- */

type Bucket = { count: number; resetAt: number };

/**
 * 固定窗口计数器。
 *
 * 为什么不用滑动窗口 / 令牌桶：这里要挡的是「控制台刷接口」，
 * 精度不重要，内存可控和实现简单更重要。
 * 每个 Next 路由是独立打包的，所以这个 Map 天然是「按接口」隔离的。
 */
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 20_000;
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }

  // 极端情况下（大量不同 IP）兜底，别让 Map 无限膨胀
  if (buckets.size > MAX_BUCKETS) {
    const overflow = buckets.size - MAX_BUCKETS;
    let removed = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++removed >= overflow) break;
    }
  }
}

/** 消耗一次配额；返回 false 表示超限。 */
export function takeToken(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** 给前端用的 Retry-After 秒数，避免客户端傻等。 */
export function retryAfterSeconds(windowMs: number): string {
  return String(Math.max(1, Math.ceil(windowMs / 1000)));
}

/* ----------------------------- 请求体 ----------------------------- */

export type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

/** 读 JSON，顺便卡一个体积上限，防止有人往里灌几 MB 的垃圾。 */
export async function readJsonBody(request: Request, maxBytes = 2048): Promise<JsonResult> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: "请求体太大了" };
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, status: 400, error: "读取请求体失败" };
  }

  if (raw.length > maxBytes) {
    return { ok: false, status: 413, error: "请求体太大了" };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, error: "请求体必须是合法的 JSON" };
  }
}
