"use client";

import type { PointerEvent as ReactPointerEvent } from "react";

import type { Direction } from "@/lib/multiplayer/types";

function PadButton({
  label,
  ariaLabel,
  onPress,
  disabled,
}: {
  label: string;
  ariaLabel: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onPointerDown={(event) => {
        event.preventDefault(); // 别让长按选中文字 / 双击缩放
        if (disabled) return;
        onPress();
      }}
      onContextMenu={(event) => event.preventDefault()}
      className="flex h-14 w-14 touch-none select-none items-center justify-center rounded-lg bg-zinc-200/70 text-xl font-semibold text-zinc-700 transition-colors active:bg-emerald-500 active:text-white disabled:opacity-40 dark:bg-white/5 dark:text-zinc-100 dark:active:bg-emerald-500"
    >
      {label}
    </button>
  );
}

/**
 * 移动端操控区：十字方向键 + 长按加速。
 * 布局刻意和单人模式保持一致，玩过单人的人不用重新学。
 */
export default function RoomPad({
  onDirection,
  onBoost,
  boosting,
  disabled,
}: {
  onDirection: (direction: Direction) => void;
  onBoost: (on: boolean) => void;
  boosting: boolean;
  disabled: boolean;
}) {
  const press = (direction: Direction) => () => onDirection(direction);

  const startBoost = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onBoost(true);
  };

  const stopBoost = () => {
    onBoost(false);
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-black/10 bg-white/80 p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] lg:hidden dark:border-white/10 dark:bg-zinc-900/70">
      <div className="grid grid-cols-3 grid-rows-3 gap-1.5">
        <span aria-hidden />
        <PadButton label="↑" ariaLabel="向上" onPress={press("up")} disabled={disabled} />
        <span aria-hidden />
        <PadButton label="←" ariaLabel="向左" onPress={press("left")} disabled={disabled} />
        <span aria-hidden />
        <PadButton label="→" ariaLabel="向右" onPress={press("right")} disabled={disabled} />
        <span aria-hidden />
        <PadButton label="↓" ariaLabel="向下" onPress={press("down")} disabled={disabled} />
        <span aria-hidden />
      </div>

      <button
        type="button"
        aria-label="按住加速"
        disabled={disabled}
        onPointerDown={startBoost}
        onPointerUp={stopBoost}
        onPointerCancel={stopBoost}
        onLostPointerCapture={stopBoost}
        onContextMenu={(event) => event.preventDefault()}
        className={`flex h-20 w-20 shrink-0 touch-none select-none flex-col items-center justify-center rounded-full text-xs font-semibold transition-all disabled:opacity-40 ${
          boosting
            ? "scale-95 bg-emerald-500 text-white ring-4 ring-emerald-500/30"
            : "bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300"
        }`}
      >
        <span className="text-lg leading-none">⚡</span>
        <span className="mt-0.5">按住加速</span>
      </button>
    </div>
  );
}
