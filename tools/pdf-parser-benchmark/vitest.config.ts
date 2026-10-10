import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/gt-annotation.test.mjs", "tests/gt-annotation-review.test.mjs"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Test files share one fixture/outputs data root — run sequentially so the
    // fixtures manifest and outputs never race across files.
    fileParallelism: false,
    // Tests operate on an isolated data root so the real smoke fixtures and
    // outputs under D:\ai-cognitive-pdf-benchmark-data are never touched.
    env: {
      BENCH_DATA_ROOT: "D:\\ai-cognitive-pdf-benchmark-data-test",
    },
  },
});
