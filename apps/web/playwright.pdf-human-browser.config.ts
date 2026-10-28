import { defineConfig, devices } from "@playwright/test";

/** Real Chromium + Next + PostgreSQL/MinIO; no external model or private book. */
export default defineConfig({
  testDir: "./tests/pdf-human-browser",
  testMatch: "**/*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: "../../output/playwright/pdf-human-browser",
  use: {
    baseURL: "http://localhost:3028",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm exec next start -p 3028",
    url: "http://localhost:3028/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      WEB_DEV_BOOTSTRAP_IDENTITY: "false",
      PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED: "false",
      BETTER_AUTH_SECRET: "pdf-human-browser-ci-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://localhost:3028",
      BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3028",
      BETTER_AUTH_ALLOW_LOCALHOST_HTTP_FOR_TESTS: "true",
      BETTER_AUTH_TEST_RATE_LIMIT_MAX: "1000",
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
