import type { Metadata } from "next";

import RoomLobby from "@/app/components/RoomLobby";

export const metadata: Metadata = {
  title: "好友联机 · 贪吃蛇",
  description: "开一间房，和朋友在同一张地图上对战。",
};

export default function RoomHomePage() {
  return <RoomLobby />;
}
