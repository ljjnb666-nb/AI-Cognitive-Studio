import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    env: {
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: "playwright-test-secret-must-be-at-least-32-characters",
      BETTER_AUTH_URL: "http://127.0.0.1:3000",
      BETTER_AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:3000",
      DATABASE_URL: process.env.DATABASE_URL_TEST ?? "postgresql://app:app@localhost:5433/ai_cognitive_studio_test?schema=public",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
      S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000",
      S3_REGION: process.env.S3_REGION ?? "us-east-1",
      S3_BUCKET: process.env.S3_BUCKET ?? "ai-cognitive-studio-dev",
      S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "local-development-only",
      S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "local-development-only",
      S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? "true",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
