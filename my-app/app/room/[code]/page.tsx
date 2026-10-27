import type { Metadata } from "next";

import RoomClient from "@/app/components/RoomClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "加入房间 · 贪吃蛇",
};

export default async function JoinRoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  return <RoomClient mode="join" code={code.toUpperCase()} />;
}
