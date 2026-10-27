import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 联机的服务端代码是 Node 的 CJS 文件（require / module.exports），
    // 用 React 那套规则去检查只会得到一堆误报。
    "server.js",
    "server/**",
  ]),
]);

export default eslintConfig;
