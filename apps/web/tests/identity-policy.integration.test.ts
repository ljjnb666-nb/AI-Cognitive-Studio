import { describe, expect, it } from "vitest";
import { browserIdentityMode, developmentBootstrapAllowed, testHarnessCredentialValid } from "../lib/identity-policy";

describe("developmentBootstrapAllowed", () => {
  it("permits only an explicit development bootstrap", () => {
    expect(developmentBootstrapAllowed({ NODE_ENV: "development", WEB_DEV_BOOTSTRAP_IDENTITY: "true" })).toBe(true);
    expect(developmentBootstrapAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(developmentBootstrapAllowed({ NODE_ENV: "test", WEB_DEV_BOOTSTRAP_IDENTITY: "true" })).toBe(true);
  });

  it("fails closed in production even when a development bootstrap flag is present", () => {
    expect(developmentBootstrapAllowed({ NODE_ENV: "production", WEB_DEV_BOOTSTRAP_IDENTITY: "true", DATABASE_URL: "postgresql://app:app@localhost:5433/ai_cognitive_studio" })).toBe(false);
    expect(developmentBootstrapAllowed({ NODE_ENV: "production", WEB_DEV_BOOTSTRAP_IDENTITY: "true", PHASE6_BROWSER_ACCEPTANCE: "true", DATABASE_URL: "postgresql://app:app@localhost:5433/ai_cognitive_studio_phase6_test" })).toBe(false);
  });

  it("rejects forged raw identity values and invalid harness credentials", () => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "production", PHASE6_BROWSER_ACCEPTANCE: "true", DATABASE_URL: "postgresql://app:app@localhost:5433/ai_cognitive_studio_phase6_test", WEB_TEST_HARNESS_TOKEN: "trusted-token", ACS_USER_ID: "forged-user", ACS_WORKSPACE_ID: "forged-workspace" };
    expect(browserIdentityMode(undefined, environment)).toBe("REQUIRED");
    expect(browserIdentityMode("wrong-token", environment)).toBe("REQUIRED");
    expect(testHarnessCredentialValid("wrong-token", environment)).toBe(false);
  });

  it("maps a valid harness credential only to the server-configured test identity mode", () => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "production", PHASE6_BROWSER_ACCEPTANCE: "true", DATABASE_URL: "postgresql://app:app@localhost:5433/ai_cognitive_studio_phase6_test", WEB_TEST_HARNESS_TOKEN: "trusted-token", WEB_TEST_HARNESS_EMAIL: "fixed@phase6.test" };
    expect(testHarnessCredentialValid("trusted-token", environment)).toBe(true);
    expect(browserIdentityMode("trusted-token", environment)).toBe("TEST_HARNESS");
  });
});
