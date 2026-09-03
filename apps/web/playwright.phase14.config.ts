import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/phase14",
  testMatch: "**/*.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  outputDir: "../../output/playwright/phase14",
  use: { baseURL: "http://localhost:3014", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm exec next start -p 3014", url: "http://localhost:3014/api/health", reuseExistingServer: false, env: { ...process.env, NODE_ENV: "test", BETTER_AUTH_SECRET: "phase14-browser-secret-must-be-at-least-32-characters", BETTER_AUTH_URL: "http://localhost:3014", BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3014", BETTER_AUTH_ALLOW_LOCALHOST_HTTP_FOR_TESTS: "true", WEB_DEV_BOOTSTRAP_IDENTITY: "false", TEACH_BACK_TEST_GATEWAY: "PENDING_THEN_SUCCESS", PROVIDER_GATEWAY_MODEL_MANIFEST: JSON.stringify({ providers: [{ providerKey: "phase14-fixture", displayName: "Phase 14 Fixture", protocol: "TEST", adapterVersion: "phase14", models: [{ modelId: "phase14-assessment", families: ["TEXT_GENERATION"], confidence: "VERIFIED" }] }] }) } },
  projects: [
    { name: "mobile-375", use: { browserName: "chromium", viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
    { name: "tablet-768", use: { browserName: "chromium", viewport: { width: 768, height: 1024 } } },
    { name: "desktop-1024", use: { browserName: "chromium", viewport: { width: 1024, height: 768 } } },
    { name: "desktop-1440", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
  ],
});
