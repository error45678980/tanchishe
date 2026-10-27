/**
 * 联机模式的音效与震动。
 *
 * 全部用 Web Audio 现场合成，不加载任何音频文件——
 * 一个贪吃蛇犯不上为几声"叮咚"多传几百 KB 资源。
 *
 * 浏览器有自动播放限制：AudioContext 必须在用户手势里创建/恢复，
 * 所以在「创建房间」「加入房间」「开始游戏」这些点击里调 unlockAudio()。
 */

export type SoundName = "eat" | "death" | "tick" | "start" | "win" | "lose";

const MUTE_KEY = "snake:muted";

let context: AudioContext | null = null;
let muted = false;
let muteLoaded = false;

function ensureContext(): AudioContext | null {
  if (typeof window === "undefined") return null;

  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;

    try {
      context = new Ctor();
    } catch {
      return null;
    }
  }

  if (context.state === "suspended") {
    void context.resume().catch(() => {});
  }

  return context;
}

/** 在用户点击的回调里调一次，把音频上下文解锁。 */
export function unlockAudio(): void {
  ensureContext();
}

export function isMuted(): boolean {
  if (!muteLoaded && typeof window !== "undefined") {
    try {
      muted = window.localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      muted = false;
    }
    muteLoaded = true;
  }
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  muteLoaded = true;

  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  } catch {
    /* 存不了就只在本次会话生效 */
  }
}

/** 一个带指数包络的音符。指数包络听起来比线性自然得多。 */
function tone(
  frequency: number,
  duration: number,
  type: OscillatorType,
  volume: number,
  endFrequency?: number,
  delay = 0,
): void {
  const ac = ensureContext();
  if (!ac) return;

  const start = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  if (endFrequency) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, endFrequency),
      start + duration,
    );
  }

  // 不能直接 ramp 到 0，指数曲线要求正数
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(start);
  osc.stop(start + duration + 0.03);
}

export function playSound(name: SoundName): void {
  if (isMuted()) return;

  switch (name) {
    case "eat":
      tone(660, 0.08, "triangle", 0.1, 990);
      break;
    case "death":
      tone(260, 0.34, "sawtooth", 0.12, 70);
      tone(180, 0.3, "square", 0.05, 60, 0.04);
      break;
    case "tick":
      tone(560, 0.055, "square", 0.05);
      break;
    case "start":
      tone(440, 0.18, "triangle", 0.1, 880);
      break;
    case "win":
      tone(523, 0.13, "triangle", 0.11);
      tone(659, 0.13, "triangle", 0.11, undefined, 0.11);
      tone(784, 0.2, "triangle", 0.12, undefined, 0.22);
      break;
    case "lose":
      tone(392, 0.5, "sine", 0.09, 130);
      break;
  }
}

/** 手机上的短震动。静音时一起关掉，免得"关了声音还在抖"。 */
export function vibrate(pattern: number | number[]): void {
  if (isMuted()) return;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
    return;
  }
  try {
    navigator.vibrate(pattern);
  } catch {
    /* 有些浏览器要求用户已交互，失败就算了 */
  }
}
