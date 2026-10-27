"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { useRoomSocket, type FeedItem, type HudPlayer, type MyDeath } from "@/app/hooks/useRoomSocket";
import { colorForSlot } from "@/lib/multiplayer/colors";
import { isMuted, playSound, setMuted, unlockAudio } from "@/lib/multiplayer/audio";
import {
  NAME_MAX_LENGTH,
  type DeathReason,
  type Direction,
  type ErrorCode,
  type PlayerPublic,
} from "@/lib/multiplayer/types";
import { readSavedName, saveName } from "@/lib/multiplayer/storage";
import MultiplayerBoard from "./MultiplayerBoard";
import RoomFrame from "./RoomFrame";
import RoomPad from "./RoomPad";

/** 死亡原因翻译成人话，用于棋盘上的播报 */
const DEATH_TEXT: Record<DeathReason, string> = {
  wall: "撞墙了",
  self: "撞到自己",
  body: "撞到别人",
  head_on: "同归于尽",
  disconnect: "掉线了",
  left: "离开了",
};

/** 播报里的一句话：能说出被谁撞的，就比干巴巴的"撞到别人"带劲 */
function feedSentence(item: FeedItem): string {
  if (item.killerName && item.reason === "body") return `撞上了 ${item.killerName}`;
  if (item.killerName && item.reason === "head_on") {
    return `与 ${item.killerName} 同归于尽`;
  }
  return DEATH_TEXT[item.reason];
}

/** 观战条上的"我怎么死的" */
function deathSentence(death: MyDeath | null): string {
  if (!death) return "你已阵亡";
  switch (death.reason) {
    case "wall":
      return "你撞墙了";
    case "self":
      return "你撞到了自己";
    case "body":
      return death.killerName ? `你撞上了 ${death.killerName}` : "你撞到了别人";
    case "head_on":
      return death.killerName ? `你和 ${death.killerName} 同归于尽` : "你撞上了别人";
    case "disconnect":
      return "你掉线了";
    case "left":
      return "你离开了房间";
    default:
      return "你已阵亡";
  }
}

const KEY_TO_DIRECTION: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
};

/** 这些错误重连也救不回来，直接给用户一张说明卡。 */
const FATAL_ERRORS: ErrorCode[] = [
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "ROOM_STARTED",
  "NAME_INVALID",
  "SERVER_FULL",
  "INTERNAL",
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

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

type ScoreRow = HudPlayer & {
  /** 名单里有、但这局的快照里没有 → 结算阶段才进来的新朋友 */
  notInMatch?: boolean;
};

export default function RoomClient({
  mode,
  code,
}: {
  mode: "create" | "join";
  code: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("");
  const [active, setActive] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [boosting, setBoosting] = useState(false);
  const [muted, setMutedState] = useState(false);

  const socket = useRoomSocket({ enabled: active, mode, code, name });

  const { phase, selfId, players, hostId, config, map, status } = socket;

  // 把上次用过的名字填回来。
  // 放进微任务是为了避开 react-hooks/set-state-in-effect，
  // 顺便也避免服务端渲染与本地存储不一致造成 hydration 警告。
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

  // 读取上次的静音偏好（同样走微任务，避开 effect 里同步 setState 的限制）
  useEffect(() => {
    let cancelled = false;

    Promise.resolve().then(() => {
      if (cancelled) return;
      setMutedState(isMuted());
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // 倒计时每秒"嗒"一声。用 ref 记住上一声是第几秒，避免同一声重复播。
  const lastTickRef = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== "countdown" || !socket.countdownEndsAt) {
      lastTickRef.current = null;
      return;
    }

    const left = Math.max(
      1,
      Math.ceil((socket.countdownEndsAt - Date.now()) / 1000),
    );
    if (lastTickRef.current === left) return;

    lastTickRef.current = left;
    playSound("tick");
  }, [phase, now, socket.countdownEndsAt]);

  // 倒计时需要 10Hz 的钟；对局中只要 1Hz 更新剩余时间，没必要每秒重渲染十次
  useEffect(() => {
    if (phase !== "countdown" && phase !== "playing") return;

    const period = phase === "countdown" ? 100 : 1000;
    const timer = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(timer);
  }, [phase]);

  const isPlaying = phase === "playing";
  const me = socket.hudPlayers.find((player) => player.id === selfId) ?? null;
  const isHost = hostId !== null && hostId === selfId;
  const showBoard =
    phase === "countdown" || phase === "playing" || phase === "finished";

  const fatalError =
    status === "closed" && socket.error && FATAL_ERRORS.includes(socket.error.code)
      ? socket.error
      : null;

  const handleBoost = useCallback(
    (on: boolean) => {
      setBoosting(on);
      socket.sendBoost(on);
    },
    [socket],
  );

  /* ------------------------------ 键盘 ------------------------------ */

  useEffect(() => {
    if (!isPlaying) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // 输入法组字中，或者焦点在输入框里：这些键全部归输入框
      if (event.isComposing || event.keyCode === 229) return;
      if (isTypingTarget(event.target)) return;

      if (event.key === "Shift") {
        if (!event.repeat) handleBoost(true);
        return;
      }

      // 按住方向键时浏览器会疯狂重发 keydown，
      // 方向本身不需要重复下发，直接忽略能省掉一大堆无用消息
      if (event.repeat) return;

      const direction =
        KEY_TO_DIRECTION[event.key] ?? KEY_TO_DIRECTION[event.key.toLowerCase()];
      if (!direction) return;

      event.preventDefault(); // 别让方向键滚动页面
      socket.sendInput(direction);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") handleBoost(false);
    };

    // 切窗口 / 切标签页时 keyup 可能收不到，兜底松开油门
    const release = () => handleBoost(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [isPlaying, socket, handleBoost]);

  /* ------------------------------ 表单 ------------------------------ */

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = sanitizeName(draft);
    if (trimmed === "") {
      setFormError("请先输入你的名字");
      return;
    }
    if (Array.from(trimmed).length > NAME_MAX_LENGTH) {
      setFormError(`名字不能超过 ${NAME_MAX_LENGTH} 个字符`);
      return;
    }

    // 浏览器要求音频必须在用户手势里解锁，这里是最好的一次机会
    unlockAudio();

    saveName(trimmed);
    setFormError(null);
    setName(trimmed);
    setActive(true);
  };

  const toggleMute = () => {
    const next = !muted;
    setMutedState(next);
    setMuted(next);
    if (!next) {
      unlockAudio();
      playSound("tick");
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  /* ------------------------------ 未加入 ------------------------------ */

  if (!active) {
    return (
      <RoomFrame
        title="🐍 好友联机"
        subtitle={
          mode === "create" ? "开一间房，等朋友进来" : `房间 ${code ?? ""}`
        }
      >
        <form
          onSubmit={handleSubmit}
          className="flex w-full max-w-[400px] flex-col gap-3 rounded-xl border border-black/10 bg-white p-5 dark:border-white/10 dark:bg-zinc-900"
        >
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            {mode === "create" ? "创建新房间" : "加入房间"}
          </h2>

          {mode === "join" ? (
            <p className="font-mono text-2xl font-bold tracking-[0.25em] text-emerald-600 dark:text-emerald-400">
              {code ?? ""}
            </p>
          ) : null}

          <label
            htmlFor="room-name"
            className="text-xs font-medium text-zinc-500 dark:text-zinc-400"
          >
            你的名字
          </label>
          <input
            id="room-name"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setFormError(null);
            }}
            maxLength={NAME_MAX_LENGTH}
            placeholder="比如：小明"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            autoFocus
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-400 focus:outline-none dark:border-white/15 dark:bg-white/5 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />

          {formError ? <p className="text-xs text-rose-500">{formError}</p> : null}

          <button
            type="submit"
            className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-400"
          >
            {mode === "create" ? "创建并进入" : "加入房间"}
          </button>

          <Link
            href="/room"
            className="text-center text-xs text-zinc-500 hover:underline dark:text-zinc-400"
          >
            ← 返回大厅
          </Link>
        </form>
      </RoomFrame>
    );
  }

  /* ------------------------------ 进不去 ------------------------------ */

  if (fatalError) {
    return (
      <RoomFrame title="🐍 好友联机" subtitle="这间房进不去了">
        <div className="flex w-full max-w-[400px] flex-col items-center gap-4 rounded-xl border border-black/10 bg-white p-6 text-center dark:border-white/10 dark:bg-zinc-900">
          <p className="text-3xl">🚪</p>
          <p className="text-sm text-zinc-700 dark:text-zinc-200">
            {fatalError.message}
          </p>
          <Link
            href="/room"
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-400"
          >
            返回大厅
          </Link>
        </div>
      </RoomFrame>
    );
  }

  /* ------------------------------ 对局中 ------------------------------ */

  const maxPlayers = config?.maxPlayers ?? 4;
  const secondsLeft = socket.countdownEndsAt
    ? Math.max(1, Math.ceil((socket.countdownEndsAt - now) / 1000))
    : 3;

  // 快照里有的用快照，快照里还没有的（比如刚在结算阶段进来的新朋友）用名单补上，
  // 否则他会从战况榜里"消失"到下一局开始
  const rosterRow = (player: PlayerPublic): ScoreRow => ({
    id: player.id,
    name: player.name,
    slot: player.slot,
    score: player.score,
    alive: player.alive,
    connected: player.connected,
    boosting: false,
    length: player.length,
    stamina: 100,
    wins: player.wins,
    notInMatch: true,
  });

  const rows: ScoreRow[] = (() => {
    if (socket.hudPlayers.length === 0) return players.map(rosterRow);

    const known = new Set(socket.hudPlayers.map((row) => row.id));
    return [
      ...socket.hudPlayers,
      ...players.filter((player) => !known.has(player.id)).map(rosterRow),
    ];
  })();

  const sortedRows = rows.slice().sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.slot - b.slot;
  });

  const myScore = me?.score ?? 0;
  const padDisabled = !isPlaying || !me?.alive;

  const myStamina = Math.max(0, Math.min(100, me?.stamina ?? 100));
  const staminaLow = myStamina < 25;

  const remainingSeconds =
    socket.matchEndsAt === null
      ? null
      : Math.max(0, Math.ceil((socket.matchEndsAt - now) / 1000));
  const timeLabel =
    remainingSeconds === null
      ? null
      : `${String(Math.floor(remainingSeconds / 60)).padStart(2, "0")}:${String(
          remainingSeconds % 60,
        ).padStart(2, "0")}`;
  const timeRunningOut = remainingSeconds !== null && remainingSeconds <= 30;

  return (
    <RoomFrame
      title="🐍 好友联机"
      subtitle={
        showBoard
          ? "吃豆子变长，把别人逼到撞你"
          : "把下面的房间码或链接发给朋友"
      }
    >
      <section className="flex w-full max-w-[1000px] flex-col items-center gap-4 lg:flex-row lg:items-start lg:justify-center">
        <div className="flex w-full max-w-[520px] flex-col gap-3">
          {/* 顶栏 */}
          <div className="flex items-center justify-between gap-3 rounded-xl bg-zinc-900 px-3 py-2 text-xs text-zinc-100 sm:px-4 sm:text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">
                房间{" "}
                <span className="font-mono font-semibold tracking-[0.2em]">
                  {socket.roomCode ?? "——"}
                </span>
              </span>
              {showBoard && timeLabel ? (
                <span
                  className={`shrink-0 font-mono text-[11px] tabular-nums ${
                    timeRunningOut ? "text-rose-400" : "text-zinc-400"
                  }`}
                >
                  ⏱ {timeLabel}
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {boosting && isPlaying ? (
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                  ⚡ 加速中
                </span>
              ) : null}
              {socket.rtt !== null ? (
                <span className="hidden text-[10px] text-zinc-400 sm:inline">
                  {socket.rtt}ms
                </span>
              ) : null}
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? "打开声音" : "静音"}
                title={muted ? "打开声音" : "静音"}
                className="rounded p-0.5 text-zinc-400 transition-colors hover:text-zinc-100"
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" />
                  {muted ? (
                    <path
                      d="M10.5 6l3.5 4M14 6l-3.5 4"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      fill="none"
                    />
                  ) : (
                    <>
                      <path
                        d="M10.5 5.6a3.4 3.4 0 010 4.8"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        fill="none"
                      />
                      <path
                        d="M12.6 3.8a6.2 6.2 0 010 8.4"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        fill="none"
                      />
                    </>
                  )}
                </svg>
              </button>
              {showBoard ? (
                <span className="font-mono text-lg font-semibold tabular-nums text-emerald-400 sm:text-xl">
                  {myScore} 分
                </span>
              ) : null}
            </span>
          </div>

          {isPlaying && (me?.alive ?? true) ? (
            <div className="flex items-center gap-2 px-1">
              <span className="shrink-0 text-[10px] text-zinc-400">⚡</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
                <div
                  className={`h-full rounded-full transition-[width] duration-150 ${
                    staminaLow ? "bg-amber-500" : "bg-emerald-500"
                  }`}
                  style={{ width: `${myStamina}%` }}
                />
              </div>
              <span className="shrink-0 text-[10px] tabular-nums text-zinc-400">
                {staminaLow ? "体力不足" : "体力"}
              </span>
            </div>
          ) : null}

          {status === "reconnecting" ? (
            <p className="rounded-lg bg-amber-100 px-3 py-2 text-center text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
              连接中断，正在重连…
            </p>
          ) : null}

          {showBoard ? (
            <div
              className="relative mx-auto w-full touch-none select-none overflow-hidden rounded-xl ring-1 ring-black/10 dark:ring-white/15"
              style={{ maxWidth: "min(100%, 520px, 62dvh)" }}
            >
              <MultiplayerBoard
                snapshotRef={socket.snapshotRef}
                map={map}
                config={config}
                selfId={selfId}
                onSwipe={socket.sendInput}
                swipeEnabled={isPlaying}
              />

              {phase === "countdown" ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65 backdrop-blur-sm">
                  <p className="text-xs tracking-[0.3em] text-white/60">准备</p>
                  <p
                    key={secondsLeft}
                    className="countdown-pop font-mono text-6xl font-bold text-emerald-400"
                  >
                    {secondsLeft}
                  </p>
                  <p className="text-[11px] text-white/50">
                    方向键 / 滑动转向 · Shift 加速（要花体力）
                  </p>
                </div>
              ) : null}

              {/* 死亡播报：谁怎么死的，一眼看清 */}
              {isPlaying && socket.feed.length > 0 ? (
                <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1">
                  {socket.feed.map((item) => (
                    <div
                      key={item.id}
                      className="feed-in flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1 text-[10px] text-white/90 backdrop-blur-sm"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: colorForSlot(item.slot).dot }}
                      />
                      <span className="font-medium">{item.name}</span>
                      <span className="text-white/55">{feedSentence(item)}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {isPlaying && me && !me.alive ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/65 px-4 py-2 text-center text-xs text-white/85 backdrop-blur-sm">
                  {deathSentence(socket.myDeath)} · 观战中
                </div>
              ) : null}

              {phase === "finished" && socket.gameOver ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-black/82 p-5 text-center backdrop-blur-sm">
                  <h2 className="text-sm font-semibold text-white">
                    {socket.gameOver.winnerId === selfId
                      ? "🏆 你赢了"
                      : socket.gameOver.reason === "time_up"
                        ? "⏱ 时间到"
                        : socket.gameOver.winnerId
                          ? "本局结束"
                          : "全员阵亡"}
                  </h2>
                  {socket.gameOver.reason === "time_up" ? (
                    <p className="-mt-1 text-[10px] text-white/50">按剩余分数排名</p>
                  ) : null}

                  <ol className="flex w-full max-w-[240px] flex-col gap-1">
                    {socket.gameOver.ranking.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="w-4 shrink-0 text-right font-mono text-white/40">
                            {entry.rank}
                          </span>
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor: colorForSlot(entry.slot).dot,
                            }}
                          />
                          <span
                            className={`truncate ${
                              entry.id === selfId
                                ? "font-medium text-emerald-300"
                                : "text-white/90"
                            }`}
                          >
                            {entry.name}
                          </span>
                          {entry.alive ? (
                            <span className="shrink-0 text-[10px] text-emerald-400">
                              存活
                            </span>
                          ) : null}
                          {entry.wins > 0 ? (
                            <span className="shrink-0 text-[10px] text-amber-300">
                              {entry.wins}胜
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 font-mono text-white/60">
                          {entry.score}
                        </span>
                      </li>
                    ))}
                  </ol>

                  {isHost ? (
                    <button
                      type="button"
                      onClick={() => {
                        unlockAudio();
                        socket.sendRematch();
                      }}
                      className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-400"
                    >
                      再来一局
                    </button>
                  ) : (
                    <p className="text-[11px] text-white/50">等房主再开一局</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : phase === "lobby" ? (
            <div className="flex flex-col gap-4 rounded-xl border border-black/10 bg-white p-5 dark:border-white/10 dark:bg-zinc-900">
              <div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">房间码</p>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
                  <span className="font-mono text-3xl font-bold tracking-[0.22em] text-zinc-900 dark:text-zinc-50">
                    {socket.roomCode ?? "……"}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
                  >
                    {copied ? "已复制 ✓" : "复制邀请链接"}
                  </button>
                </div>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  把链接发到微信群，朋友点开就能进
                </p>
              </div>

              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  玩家 {players.length}/{maxPlayers}
                </p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {Array.from({ length: maxPlayers }).map((_, slot) => {
                    const player = players.find((item) => item.slot === slot);
                    const color = colorForSlot(slot);

                    return (
                      <li
                        key={slot}
                        className={`flex items-center justify-between rounded-lg px-2.5 py-2 text-sm ${
                          player ? "bg-zinc-50 dark:bg-white/5" : ""
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={
                              player
                                ? { backgroundColor: color.dot }
                                : { border: "1.5px dashed #a1a1aa" }
                            }
                          />
                          <span
                            className={
                              player
                                ? "text-zinc-800 dark:text-zinc-200"
                                : "text-zinc-400 dark:text-zinc-500"
                            }
                          >
                            {player ? player.name : "等待加入…"}
                          </span>
                        </span>
                        {player?.isHost ? (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                            房主
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>

              {isHost ? (
                <button
                  type="button"
                  onClick={() => {
                    unlockAudio();
                    socket.sendStart();
                  }}
                  disabled={players.length < 2}
                  className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:disabled:bg-white/10"
                >
                  {players.length < 2 ? "至少需要 2 个人" : "开始游戏"}
                </button>
              ) : (
                <p className="rounded-lg bg-zinc-100 px-3 py-2 text-center text-xs text-zinc-500 dark:bg-white/5 dark:text-zinc-400">
                  等房主点开始…
                </p>
              )}
            </div>
          ) : (
            <div className="flex h-[320px] items-center justify-center rounded-xl border border-black/10 bg-white text-sm text-zinc-500 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-400">
              正在连接房间…
            </div>
          )}

          {showBoard ? (
            <RoomPad
              onDirection={socket.sendInput}
              onBoost={handleBoost}
              boosting={boosting && isPlaying}
              disabled={padDisabled}
            />
          ) : null}

          {showBoard ? (
            <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
              <span className="lg:hidden">滑动棋盘或按方向键移动 · 按住 ⚡ 加速</span>
              <span className="hidden lg:inline">
                方向键 / WASD 移动 · 按住 Shift 加速
              </span>
            </p>
          ) : null}
        </div>

        {/* 侧栏：大厅讲规则，对局看战况 */}
        <aside className="w-full max-w-[520px] rounded-xl border border-black/10 bg-white p-4 lg:w-72 dark:border-white/10 dark:bg-zinc-900">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {showBoard ? "本局战况" : "怎么玩"}
            </h2>
            <span className="text-[10px] text-zinc-400">
              {status === "open" ? "已连接" : status === "reconnecting" ? "重连中" : "…"}
            </span>
          </div>

          {showBoard ? (
            <ol className="flex flex-col gap-1">
              {sortedRows.map((row, index) => (
                <li
                  key={row.id}
                  className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-sm ${
                    row.id === selfId ? "bg-emerald-50 dark:bg-emerald-500/10" : ""
                  } ${row.alive ? "" : "opacity-50"}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-4 shrink-0 text-center text-xs text-zinc-400">
                      {index + 1}
                    </span>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: colorForSlot(row.slot).dot }}
                    />
                    <span className="truncate text-zinc-800 dark:text-zinc-200">
                      {row.name}
                    </span>
                    {row.id === selfId ? (
                      <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">
                        你
                      </span>
                    ) : null}
                    {!row.connected ? (
                      <span className="shrink-0 text-[10px] text-amber-500">离线</span>
                    ) : null}
                    {row.wins > 0 ? (
                      <span className="shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        {row.wins}胜
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 pl-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {socket.hudPlayers.length === 0
                      ? ""
                      : row.notInMatch
                        ? "刚加入"
                        : row.alive
                          ? `${row.score} 分 · ${row.length} 节`
                          : "阵亡"}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <ul className="flex flex-col gap-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
              <li>① 把房间码或链接发给朋友</li>
              <li>② 至少 2 人，房主点「开始游戏」</li>
              <li>③ 吃豆子变长，把别人逼到撞你</li>
              <li>④ 撞墙 / 撞自己 / 撞到别人的蛇都会出局</li>
              <li>⑤ 加速要花体力，一直按着会空</li>
              <li>⑥ 每局 3 分钟，时间到按分数排名</li>
            </ul>
          )}

          <div className="mt-3 border-t border-black/5 pt-3 text-xs leading-relaxed text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            {showBoard
              ? "自己那条蛇有白色光环绕头，别认错了。"
              : "四个角各有一条蛇，出生点完全对称，没有谁占便宜。"}
          </div>

          <Link
            href="/room"
            onClick={() => socket.leave()}
            className="mt-3 block rounded-lg border border-black/10 py-1.5 text-center text-xs text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/5"
          >
            离开房间
          </Link>
        </aside>
      </section>
    </RoomFrame>
  );
}
