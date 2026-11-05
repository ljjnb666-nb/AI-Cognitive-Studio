import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.ts"], exclude: ["tests/**/*.integration.test.ts", "tests/**/*.e2e.test.ts", "tests/phase8c-*.test.ts", "tests/e2e-worker-isolation.regression.test.ts"], fileParallelism: false } });
