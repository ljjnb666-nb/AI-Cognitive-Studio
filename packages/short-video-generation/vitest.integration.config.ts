import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/**/*.integration.test.ts"],
    setupFiles: ["../db/tests/setup-storage.ts"],
    testTimeout: 30_000,
  },
});
