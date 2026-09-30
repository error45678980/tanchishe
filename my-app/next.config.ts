import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 固定 Turbopack 的工作区根目录，否则它会向上找到 C:\Users\wwwwww
  // （那里恰好有个 package-lock.json）并把整个用户目录纳入文件监听。
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
