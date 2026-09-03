import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/phase14",
  testMatch: "**/*.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  outputDir: "../../output/playwright/phase14",
  use: { baseURL: "http://localhost:3014", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm exec next start -p 3014", url: "http://localhost:3014/api/health", reuseExistingServer: false, env: { ...process.env, NODE_ENV: "test", BETTER_AUTH_SECRET: "phase14-browser-secret-must-be-at-least-32-characters", BETTER_AUTH_URL: "http://localhost:3014", BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3014", BETTER_AUTH_ALLOW_LOCALHOST_HTTP_FOR_TESTS: "true", WEB_DEV_BOOTSTRAP_IDENTITY: "false" } },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], browserName: "chromium" } }, { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } }],
});
