import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/phase17",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  outputDir: "../../output/playwright/phase17",
  use: { baseURL: "http://localhost:3017", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm exec next start -p 3017", url: "http://localhost:3017/api/health", reuseExistingServer: false, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "", DATABASE_URL_TEST: process.env.DATABASE_URL_TEST ?? "", NODE_ENV: "test", BETA_ACCESS_MODE: "ENFORCED", BETTER_AUTH_SECRET: "phase17-browser-secret-must-be-at-least-32-characters", BETTER_AUTH_URL: "http://localhost:3017", BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3017", BETTER_AUTH_ALLOW_LOCALHOST_HTTP_FOR_TESTS: "true", BETTER_AUTH_TEST_RATE_LIMIT_MAX: "1000", WEB_DEV_BOOTSTRAP_IDENTITY: "false" } },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
