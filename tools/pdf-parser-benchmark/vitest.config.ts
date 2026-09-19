import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Tests operate on an isolated data root so the real smoke fixtures and
    // outputs under D:\ai-cognitive-pdf-benchmark-data are never touched.
    env: {
      BENCH_DATA_ROOT: "D:\\ai-cognitive-pdf-benchmark-data-test",
    },
  },
});
