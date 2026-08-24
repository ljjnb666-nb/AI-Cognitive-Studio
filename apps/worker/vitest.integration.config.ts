import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/**/*.integration.test.ts", "tests/phase8c-production-runtime.test.ts", "tests/phase8c-redis-lifecycle.test.ts", "tests/phase8c-podcast-gateway-runtime.test.ts", "tests/phase8c-podcast-speech-gateway-runtime.test.ts", "tests/phase8c-short-video-gateway-runtime.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20_000,
  },
});
