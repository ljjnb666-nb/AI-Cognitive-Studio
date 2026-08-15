import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["tests/phase7/onboarding.concurrent.test.ts"] } });
