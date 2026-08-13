import { describe, expect, it } from "vitest";
import { developmentBootstrapAllowed } from "../lib/identity-policy";

describe("developmentBootstrapAllowed", () => {
  it("permits only an explicit development bootstrap", () => {
    expect(developmentBootstrapAllowed({ NODE_ENV: "development", WEB_DEV_BOOTSTRAP_IDENTITY: "true" })).toBe(true);
    expect(developmentBootstrapAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(developmentBootstrapAllowed({ NODE_ENV: "test", WEB_DEV_BOOTSTRAP_IDENTITY: "true" })).toBe(true);
  });

  it("fails closed in production except for the isolated Phase 6 acceptance harness", () => {
    expect(developmentBootstrapAllowed({ NODE_ENV: "production", WEB_DEV_BOOTSTRAP_IDENTITY: "true", DATABASE_URL: "postgresql://app:app@localhost:5433/ai_cognitive_studio" })).toBe(false);
    expect(developmentBootstrapAllowed({ NODE_ENV: "production", WEB_DEV_BOOTSTRAP_IDENTITY: "true", PHASE6_BROWSER_ACCEPTANCE: "true", DATABASE_URL: "postgresql://app:app@localhost:5433/ai_cognitive_studio_phase6_test" })).toBe(true);
  });
});
