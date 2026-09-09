import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/phase9",
  testMatch: "beta-provider-ux.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: "../../output/playwright/beta-provider-ux",
  use: { baseURL: "http://localhost:3001", trace: "retain-on-failure", screenshot: "only-on-failure" },
  // `next dev` deliberately retains NODE_ENV=development for the zero-env proof.
  webServer: { command: "pnpm dev", url: "http://localhost:3001/api/health", reuseExistingServer: false, env: { ...process.env, WEB_DEV_BOOTSTRAP_IDENTITY: "false", PHASE6_BROWSER_ACCEPTANCE: "false" } },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
