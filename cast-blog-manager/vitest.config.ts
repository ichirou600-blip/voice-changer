import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // 統合テストは Node で直接実行するため、
      // Next.js 専用の "server-only" ガードを無効化する
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
      "next/headers": fileURLToPath(new URL("./test/stubs/next-headers.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // DB を共有するため統合テストは直列で実行する
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
