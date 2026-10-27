import { NAME_MAX_LENGTH } from "./constants";

/**
 * 名字清洗（服务端版）。
 *
 * 客户端也有一份同样的逻辑，但那只负责「别把名字输错」，
 * 挡不住控制台直接发请求。真正说了算的是这里。
 *
 * 要挡的三类东西：
 * 1. 控制字符（\u0000-\u001F、\u007F）——会把日志 / 终端搅乱；
 * 2. 零宽字符（\u200B、\uFEFF）——排行榜上会出现「看得见却读不出」的空名字；
 * 3. 双向文本控制符（\u202A-\u202E、\u2066-\u2069）——能把名字倒着显示，
 *    冒充别人。
 */
const ZERO_WIDTH = new Set(["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF"]);

function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

export type NameResult = { ok: true; name: string } | { ok: false; error: string };

export function normalizePlayerName(input: unknown): NameResult {
  if (typeof input !== "string") {
    return { ok: false, error: "玩家名字不能为空" };
  }

  let cleaned = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (ZERO_WIDTH.has(char)) continue;
    if (isBidiControl(code)) continue;
    cleaned += char;
  }

  cleaned = cleaned.trim().replace(/\s+/g, " ");

  if (cleaned === "") {
    return { ok: false, error: "玩家名字不能为空" };
  }

  // 按码点截断，避免把 emoji 的代理对劈成两半
  const points = Array.from(cleaned);
  if (points.length > NAME_MAX_LENGTH) {
    return { ok: false, error: `玩家名字不能超过 ${NAME_MAX_LENGTH} 个字符` };
  }

  return { ok: true, name: points.join("") };
}
