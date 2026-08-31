import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "server-only": fileURLToPath(new URL("./tests/server-only.ts", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    setupFiles: ["../../packages/db/tests/setup.ts"],
  },
});
