import type { Metadata } from "next";

import RoomClient from "@/app/components/RoomClient";

export const metadata: Metadata = {
  title: "创建房间 · 贪吃蛇",
};

export const dynamic = "force-dynamic";

export default function CreateRoomPage() {
  return <RoomClient mode="create" code={null} />;
}
