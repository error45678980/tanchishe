import SnakeGame from "./components/SnakeGame";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-10 font-sans dark:bg-black">
      <header className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl dark:text-zinc-50">
          🐍 贪吃蛇
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          开局前先填名字，每局成绩都会保存到 PostgreSQL 数据库
        </p>
      </header>

      <SnakeGame />
    </main>
  );
}
