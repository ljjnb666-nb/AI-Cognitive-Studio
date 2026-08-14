import { defineConfig, devices } from "@playwright/test";

const environment = {
  ...process.env,
  NODE_ENV: "test",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET!,
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
  WEB_DEV_BOOTSTRAP_IDENTITY: "false",
  PHASE6_BROWSER_ACCEPTANCE: "false",
};

export default defineConfig({
  testDir: "./tests/phase7",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  outputDir: "../../output/playwright/phase7",
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm exec next start -p 3000", url: "http://localhost:3000/api/health", reuseExistingServer: false, env: environment },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
