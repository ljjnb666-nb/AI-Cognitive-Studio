import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", fileParallelism: false, include: ["tests/phase3-podcast.e2e.test.ts"], setupFiles: ["tests/setup.ts"], testTimeout: 60_000 } });
