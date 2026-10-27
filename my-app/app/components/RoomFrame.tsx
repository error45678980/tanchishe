import type { ReactNode } from "react";

/**
 * 联机页面的统一外壳：标题 + 副标题 + 内容。
 * 和首页保持同一套间距与配色，让人感觉是同一个地方的两扇门。
 */
export default function RoomFrame({
  title,
  subtitle,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-1 flex-col items-center gap-4 bg-zinc-50 px-3 py-4 font-sans sm:gap-6 sm:px-6 sm:py-8 dark:bg-black">
      <header className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl dark:text-zinc-50">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-xs text-zinc-600 sm:mt-2 sm:text-sm dark:text-zinc-400">
            {subtitle}
          </p>
        ) : null}
      </header>

      {children}
    </main>
  );
}
