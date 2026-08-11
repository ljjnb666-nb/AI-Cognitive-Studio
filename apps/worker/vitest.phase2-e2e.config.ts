import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/phase2-book.e2e.test.ts"], setupFiles: ["tests/setup-phase1-e2e.ts"], testTimeout: 45_000 } });
