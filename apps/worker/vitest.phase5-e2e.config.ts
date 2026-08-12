import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["../../packages/short-video-generation/tests/renderer.test.ts", "../../packages/short-video-generation/tests/lineage.integration.test.ts", "../../packages/short-video-generation/tests/phase5-durability.integration.test.ts", "tests/phase5-product-chain.e2e.test.ts"],
    setupFiles: ["tests/setup-phase1-e2e.ts"],
    testTimeout: 120_000,
  },
});
