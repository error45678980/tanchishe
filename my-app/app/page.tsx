import SnakeGame from "./components/SnakeGame";

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-1 flex-col items-center gap-4 bg-zinc-50 px-3 py-4 font-sans sm:gap-8 sm:px-6 sm:py-10 dark:bg-black">
      <header className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 sm:text-4xl dark:text-zinc-50">
          🐍 贪吃蛇
        </h1>
        <p className="mt-1 text-xs text-zinc-600 sm:mt-2 sm:text-sm dark:text-zinc-400">
          开局前先填名字，每局成绩都会保存到 PostgreSQL 数据库
        </p>
      </header>

      <SnakeGame />
    </main>
  );
}
