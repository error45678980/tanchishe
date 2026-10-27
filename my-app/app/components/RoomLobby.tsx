"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { NAME_MAX_LENGTH, ROOM_CODE_LENGTH } from "@/lib/multiplayer/types";
import { readSavedName, saveName } from "@/lib/multiplayer/storage";
import RoomFrame from "./RoomFrame";

/** 和单人模式同一套清洗规则：去掉控制字符与零宽字符。 */
function sanitizeName(value: string): string {
  let cleaned = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || code === 0x7f;
    if (isControl || char === "\u200B" || char === "\uFEFF") continue;
    cleaned += char;
  }
  return cleaned.trim();
}

export default function RoomLobby() {
  const router = useRouter();

  const [draft, setDraft] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 把上次用过的名字填回来。
  // 放到微任务里是为了不违反 react-hooks/set-state-in-effect（effect 里同步 setState），
  // 同时也能避开服务端渲染和客户端存储不一致导致的 hydration 警告。
  useEffect(() => {
    let cancelled = false;

    Promise.resolve().then(() => {
      if (cancelled) return;
      setDraft(readSavedName());
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const commitName = (): string | null => {
    const trimmed = sanitizeName(draft);

    if (trimmed === "") {
      setError("请先输入你的名字");
      return null;
    }
    if (Array.from(trimmed).length > NAME_MAX_LENGTH) {
      setError(`名字不能超过 ${NAME_MAX_LENGTH} 个字符`);
      return null;
    }

    saveName(trimmed);
    setError(null);
    return trimmed;
  };

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!commitName()) return;
    router.push("/room/new");
  };

  const handleJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!commitName()) return;

    const code = codeInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== ROOM_CODE_LENGTH) {
      setError(`房间码是 ${ROOM_CODE_LENGTH} 位字母加数字`);
      return;
    }

    router.push(`/room/${code}`);
  };

  return (
    <RoomFrame
      title="👥 好友联机"
      subtitle="开一间房，把链接丢进微信群，朋友点开就能一起玩"
    >
      <div className="flex w-full max-w-[440px] flex-col gap-5">
        <form
          onSubmit={handleCreate}
          className="flex flex-col gap-3 rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-900"
        >
          <label
            htmlFor="lobby-name"
            className="text-xs font-medium text-zinc-500 dark:text-zinc-400"
          >
            你的名字
          </label>
          <input
            id="lobby-name"
            name="playerName"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            maxLength={NAME_MAX_LENGTH}
            placeholder="比如：小明"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-400 focus:outline-none dark:border-white/15 dark:bg-white/5 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />

          {error ? <p className="text-xs text-rose-500">{error}</p> : null}

          <button
            type="submit"
            className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-400"
          >
            创建新房间
          </button>
        </form>

        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span className="h-px flex-1 bg-zinc-200 dark:bg-white/10" />
          或者加入朋友的房间
          <span className="h-px flex-1 bg-zinc-200 dark:bg-white/10" />
        </div>

        <form
          onSubmit={handleJoin}
          className="flex items-center gap-2 rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-900"
        >
          <input
            aria-label="房间码"
            value={codeInput}
            onChange={(event) => {
              setCodeInput(event.target.value.toUpperCase());
              setError(null);
            }}
            maxLength={ROOM_CODE_LENGTH}
            placeholder="房间码"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-center font-mono text-base tracking-[0.3em] text-zinc-900 uppercase placeholder:tracking-normal placeholder:text-zinc-400 focus:border-emerald-400 focus:outline-none dark:border-white/15 dark:bg-white/5 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
          >
            加入
          </button>
        </form>

        <p className="text-center text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          2 到 4 个人，同一张地图，吃豆子变长，
          <br className="sm:hidden" />
          撞墙、撞自己、撞到别人都会出局。
        </p>

        <Link
          href="/"
          className="text-center text-xs text-emerald-600 hover:underline dark:text-emerald-400"
        >
          ← 回到单人游戏
        </Link>
      </div>
    </RoomFrame>
  );
}
