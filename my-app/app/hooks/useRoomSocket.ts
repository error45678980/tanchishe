"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ClientMessage,
  DeathReason,
  Direction,
  ErrorCode,
  MapPayload,
  PlayerPublic,
  RankingEntry,
  RoomConfig,
  RoomPhase,
  ServerMessage,
  SnakeState,
  Snapshot,
} from "@/lib/multiplayer/types";
import { RESUME_KEY_PREFIX } from "@/lib/multiplayer/types";
import { playSound, vibrate } from "@/lib/multiplayer/audio";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

/** 计分板用的轻量玩家状态，只在不影响画面的字段变化时才更新。 */
export type HudPlayer = {
  id: string;
  name: string;
  slot: number;
  score: number;
  alive: boolean;
  connected: boolean;
  boosting: boolean;
  length: number;
  stamina: number;
  wins: number;
};

/** 棋盘上飘过的死亡播报。 */
export type FeedItem = {
  id: string;
  name: string;
  slot: number;
  reason: DeathReason;
  /** 撞死他的人；撞墙 / 撞自己时为 null */
  killerName: string | null;
  at: number;
};

/** 自己这一局的死法，用来在观战条上说人话。 */
export type MyDeath = {
  reason: DeathReason;
  killerName: string | null;
};

export type GameOverInfo = {
  winnerId: string | null;
  reason: "last_alive" | "all_dead" | "time_up";
  ranking: RankingEntry[];
};

export type RoomError = { code: ErrorCode; message: string };

type Options = {
  /** 用户点了「创建 / 加入」之后才连，避免一进页面就握手 */
  enabled: boolean;
  mode: "create" | "join";
  code: string | null;
  name: string;
};

const PING_INTERVAL_MS = 5000;
const PONG_TIMEOUT_MS = 16000;
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 6000, 8000, 10000];

/** 这些错误重连也没用，直接停下来让用户看提示。 */
const FATAL_ERRORS: ErrorCode[] = [
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "ROOM_STARTED",
  "NAME_INVALID",
  "SERVER_FULL",
];

function hudSignature(states: SnakeState[]): string {
  let out = "";
  for (const state of states) {
    // 体力按 4 点一档取整：满血到空一共 25 档，
    // 既能让进度条看起来是连续的，又不会每帧都触发重渲染
    const staminaStep = Math.round(state.stamina / 4);
    out += `${state.id}:${state.score}:${state.alive ? 1 : 0}:${state.boosting ? 1 : 0}:${
      state.connected ? 1 : 0
    }:${state.snake.length}:${staminaStep}:${state.wins};`;
  }
  return out;
}

export function useRoomSocket({ enabled, mode, code, name }: Options) {
  const wsRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const lastTickRef = useRef(0);
  const seqRef = useRef(0);
  const hudSignatureRef = useRef("");
  const manualCloseRef = useRef(false);
  /** 消息回调里拿不到最新的 state，自己的 id 单独放一个 ref */
  const selfIdRef = useRef<string | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [selfId, setSelfId] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(code);
  const [phase, setPhase] = useState<RoomPhase | null>(null);
  const [config, setConfig] = useState<RoomConfig | null>(null);
  const [players, setPlayers] = useState<PlayerPublic[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [map, setMap] = useState<MapPayload | null>(null);
  const [gameOver, setGameOver] = useState<GameOverInfo | null>(null);
  const [error, setError] = useState<RoomError | null>(null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [hudPlayers, setHudPlayers] = useState<HudPlayer[]>([]);
  const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null);
  /** 本局结束的本地时间戳（已经从服务端时间换算过） */
  const [matchEndsAt, setMatchEndsAt] = useState<number | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [myDeath, setMyDeath] = useState<MyDeath | null>(null);

  const sendRaw = useCallback((message: ClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* 发送失败交给 close 事件处理 */
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let fatal = false;
    let attempt = 0;
    let connectedOnce = false;
    let lastPongAt = Date.now();

    let startTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;

    manualCloseRef.current = false;

    const clearTimers = () => {
      if (startTimer) clearTimeout(startTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (watchdog) clearInterval(watchdog);
      startTimer = null;
      reconnectTimer = null;
      pingTimer = null;
      watchdog = null;
    };

    const applyHud = (states: SnakeState[]) => {
      const signature = hudSignature(states);
      if (signature === hudSignatureRef.current) return;
      hudSignatureRef.current = signature;

      setHudPlayers(
        states.map((state) => ({
          id: state.id,
          name: state.name,
          slot: state.slot,
          score: state.score,
          alive: state.alive,
          connected: state.connected,
          boosting: state.boosting,
          length: state.snake.length / 2,
          stamina: state.stamina,
          wins: state.wins,
        })),
      );
    };

    const handleMessage = (raw: string) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }

      switch (message.type) {
        case "joined": {
          selfIdRef.current = message.selfId;
          setSelfId(message.selfId);
          setRoomCode(message.roomCode);
          setPhase(message.phase);
          setConfig(message.config);
          setPlayers(message.players);
          setHostId(message.hostId);
          setMap(message.map);
          setError(null);

          try {
            sessionStorage.setItem(
              RESUME_KEY_PREFIX + message.roomCode,
              message.resumeToken,
            );
          } catch {
            /* 隐私模式下 sessionStorage 可能不可用，不影响游戏 */
          }

          // 创建房间后把地址换成可分享的链接。
          // 必须用 replaceState 而不是 router.replace——后者会重挂组件、重连一次。
          if (mode === "create") {
            window.history.replaceState(null, "", `/room/${message.roomCode}`);
          }
          break;
        }

        case "roster": {
          setPlayers(message.players);
          setHostId(message.hostId);
          break;
        }

        case "phase": {
          setPhase(message.phase);

          if (message.phase === "countdown" && message.startAt) {
            // 用服务端时间差换算成本地时间戳，避开两台机器时钟不一致
            setCountdownEndsAt(
              Date.now() + (message.startAt - message.serverTime),
            );
          }
          if (message.phase === "playing") {
            setGameOver(null);
            setCountdownEndsAt(null);
          }
          break;
        }

        case "started": {
          setPhase("playing");
          setConfig(message.config);
          setMap(message.map);
          setGameOver(null);
          setCountdownEndsAt(null);
          setError(null);
          setFeed([]);
          setMyDeath(null);
          playSound("start");

          // 服务端时间差换成本地时间戳，两台机器时钟不一致也不会算歪
          setMatchEndsAt(
            message.endsAt > 0
              ? Date.now() + (message.endsAt - message.serverTime)
              : null,
          );

          lastTickRef.current = 0;
          snapshotRef.current = {
            type: "snapshot",
            tick: 0,
            serverTime: message.serverTime,
            endsAt: message.endsAt,
            players: message.players,
            foods: message.foods,
            events: [],
          };
          hudSignatureRef.current = "";
          applyHud(message.players);
          break;
        }

        case "snapshot": {
          // 网络乱序时丢掉旧帧，避免蛇「倒着走」
          if (message.tick <= lastTickRef.current) break;
          lastTickRef.current = message.tick;
          snapshotRef.current = message;
          applyHud(message.players);

          if (message.events.length > 0) {
            const me = selfIdRef.current;
            const nameOf = (id: string | null): string | null =>
              id ? (message.players.find((item) => item.id === id)?.name ?? null) : null;

            const now = Date.now();
            const entries: FeedItem[] = [];
            let ateSelf = false;

            for (const event of message.events) {
              if (event.type === "eat") {
                if (event.playerId === me) ateSelf = true;
                continue;
              }

              if (event.type !== "death") continue;

              const player = message.players.find((item) => item.id === event.playerId);
              const killerName = nameOf(event.killerId);

              entries.push({
                id: `${message.tick}-${event.playerId}`,
                name: player?.name ?? "有人",
                slot: player?.slot ?? 0,
                reason: event.reason,
                killerName,
                at: now,
              });

              if (event.playerId === me) {
                setMyDeath({ reason: event.reason, killerName });
                playSound("death");
                vibrate(60);
              }
            }

            if (ateSelf) playSound("eat");
            if (entries.length > 0) {
              setFeed((previous) => [...previous, ...entries].slice(-4));
            }
          }
          break;
        }

        case "gameOver": {
          setPhase("finished");
          setGameOver({
            winnerId: message.winnerId,
            reason: message.reason,
            ranking: message.ranking,
          });
          playSound(
            message.winnerId && message.winnerId === selfIdRef.current ? "win" : "lose",
          );
          break;
        }

        case "error": {
          setError({ code: message.code, message: message.message });
          if (FATAL_ERRORS.includes(message.code)) {
            fatal = true;
            setStatus("closed");
          }
          break;
        }

        case "pong": {
          lastPongAt = Date.now();
          setRtt(Math.max(0, Date.now() - message.t));
          break;
        }

        case "roomClosed": {
          fatal = true;
          setStatus("closed");
          setError({
            code: "INTERNAL",
            message: "房间已关闭，请让房主重新创建",
          });
          break;
        }
      }
    };

    const connect = () => {
      if (disposed || fatal || manualCloseRef.current) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/ws`;

      setStatus(connectedOnce ? "reconnecting" : "connecting");

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        setStatus("closed");
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }

        attempt = 0;
        connectedOnce = true;
        lastPongAt = Date.now();
        setStatus("open");
        setError(null);

        let resumeToken: string | null = null;
        if (code) {
          try {
            resumeToken = sessionStorage.getItem(RESUME_KEY_PREFIX + code);
          } catch {
            resumeToken = null;
          }
        }

        const joinMessage: ClientMessage = {
          type: "join",
          name,
          ...(mode === "create" ? { create: true } : { roomCode: code ?? undefined }),
          ...(resumeToken ? { resumeToken } : {}),
        };
        ws.send(JSON.stringify(joinMessage));

        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
          }
        }, PING_INTERVAL_MS);

        // 半开连接检测：移动网络下 socket 可能「看起来还开着」但已经收不到数据
        watchdog = setInterval(() => {
          if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
            try {
              ws.close();
            } catch {
              /* 忽略 */
            }
          }
        }, 4000);
      };

      ws.onmessage = (event) => {
        if (typeof event.data === "string") handleMessage(event.data);
      };

      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (watchdog) clearInterval(watchdog);
        pingTimer = null;
        watchdog = null;

        if (disposed || fatal || manualCloseRef.current) {
          setStatus("closed");
          return;
        }

        const delay =
          RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
        attempt += 1;
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        /* onclose 会紧跟着触发，统一在那里处理重连 */
      };
    };

    // StrictMode 下 effect 会「挂载 → 清理 → 再挂载」，
    // 直接连会白白建两个房间。留一点缓冲让第一次连接在清理时被取消。
    const startDelay = process.env.NODE_ENV === "development" ? 80 : 0;
    startTimer = setTimeout(connect, startDelay);

    return () => {
      disposed = true;
      clearTimers();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
      }
    };
  }, [enabled, mode, code, name]);

  // 死亡播报自动过期。只在真的有播报时才跑定时器，闲着的时候一点开销都没有。
  useEffect(() => {
    if (feed.length === 0) return;

    const timer = setTimeout(() => {
      setFeed((previous) => previous.filter((item) => Date.now() - item.at < 3200));
    }, 600);

    return () => clearTimeout(timer);
  }, [feed]);

  const sendInput = useCallback(
    (dir: Direction) => {
      seqRef.current += 1;
      sendRaw({ type: "input", dir, seq: seqRef.current });
    },
    [sendRaw],
  );

  const sendBoost = useCallback(
    (on: boolean) => {
      sendRaw({ type: "boost", on });
    },
    [sendRaw],
  );

  const sendStart = useCallback(() => {
    sendRaw({ type: "start" });
  }, [sendRaw]);

  const sendRematch = useCallback(() => {
    sendRaw({ type: "rematch" });
  }, [sendRaw]);

  const leave = useCallback(() => {
    manualCloseRef.current = true;
    sendRaw({ type: "leave" });
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    }
    setStatus("closed");
  }, [sendRaw]);

  return {
    status,
    selfId,
    roomCode,
    phase,
    config,
    players,
    hostId,
    map,
    gameOver,
    error,
    rtt,
    hudPlayers,
    countdownEndsAt,
    matchEndsAt,
    feed,
    myDeath,
    snapshotRef,
    sendInput,
    sendBoost,
    sendStart,
    sendRematch,
    leave,
  };
}
