/**
 * 本地存储的小包装。
 *
 * 全部做了 try/catch：Safari 隐私模式、部分 App 内嵌浏览器
 * 会直接让 sessionStorage 抛异常，不能因为这个把游戏搞崩。
 */

import { NAME_KEY, RESUME_KEY_PREFIX } from "./types";

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* 存不了就算了，不影响这一局 */
  }
}

export function readSavedName(): string {
  return safeGet(NAME_KEY) ?? "";
}

export function saveName(name: string): void {
  safeSet(NAME_KEY, name);
}

export function readResumeToken(code: string): string | null {
  return safeGet(RESUME_KEY_PREFIX + code);
}

/** 和页面共用的 URL，创建房间后地址已经换成 /room/CODE 了。 */
export function currentInviteUrl(): string {
  if (typeof window === "undefined") return "";
  return window.location.href;
}
