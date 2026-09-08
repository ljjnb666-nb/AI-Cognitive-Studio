import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/phase9",
  testMatch: "**/*.spec.ts",
  // The beta suite intentionally proves a zero-configuration built-in provider;
  // Phase 9 instead installs its deterministic fixture manifest.
  testIgnore: "beta-provider-ux.spec.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  outputDir: "../../output/playwright/phase9",
  use: { baseURL: "http://localhost:3001", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm exec next start -p 3001", url: "http://localhost:3001/api/health", reuseExistingServer: false, env: { ...process.env, NODE_ENV: "test", WEB_DEV_BOOTSTRAP_IDENTITY: "false", PHASE6_BROWSER_ACCEPTANCE: "false" } },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
