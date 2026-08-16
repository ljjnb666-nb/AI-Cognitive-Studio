import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", fileParallelism: false, include: ["tests/e2e-worker-isolation.regression.test.ts"], setupFiles: ["tests/setup-phase1-e2e.ts"], testTimeout: 30_000 } });
