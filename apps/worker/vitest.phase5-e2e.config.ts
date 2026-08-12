import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["../../packages/short-video-generation/tests/renderer.test.ts"],
    testTimeout: 120_000,
  },
});
