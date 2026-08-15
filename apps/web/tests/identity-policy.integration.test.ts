import { describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { browserIdentityMode, developmentBootstrapAllowed, testHarnessCredentialValid } from "../lib/identity-policy";
import { requiredAuthBaseUrl } from "../lib/auth-config";
import { ensurePersonalWorkspace } from "../lib/onboarding";

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

describe("requiredAuthBaseUrl", () => {
  it("fails fast for a missing or malformed canonical auth URL", () => {
    expect(() => requiredAuthBaseUrl({ NODE_ENV: "production" })).toThrow("BETTER_AUTH_URL_REQUIRED");
    expect(() => requiredAuthBaseUrl({ NODE_ENV: "production", BETTER_AUTH_URL: "not a url" })).toThrow("BETTER_AUTH_URL_INVALID");
    expect(() => requiredAuthBaseUrl({ NODE_ENV: "production", BETTER_AUTH_URL: "http://studio.example" })).toThrow("BETTER_AUTH_URL_HTTPS_REQUIRED");
  });

  it("accepts an explicit HTTPS production URL and a local development URL", () => {
    expect(requiredAuthBaseUrl({ NODE_ENV: "production", BETTER_AUTH_URL: "https://studio.example" })).toBe("https://studio.example");
    expect(requiredAuthBaseUrl({ NODE_ENV: "development", BETTER_AUTH_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
  });
});

describe("authenticated onboarding", () => {
  it("serializes concurrent first-workspace initialization without duplicates", async () => {
    const user = await prisma.user.create({ data: { email: `onboarding-${Date.now()}-${Math.random()}@test.invalid`, name: "Concurrent User" } });
    try {
      const identities = await Promise.all(Array.from({ length: 8 }, () => ensurePersonalWorkspace(user.id)));
      const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { memberships: true } });
      expect(new Set(identities.map((identity) => identity.memberships[0]!.workspaceId)).size).toBe(1);
      expect(refreshed.memberships).toHaveLength(1);
      expect(refreshed.defaultWorkspaceId).toBe(refreshed.memberships[0]!.workspaceId);
      await prisma.workspace.delete({ where: { id: refreshed.memberships[0]!.workspaceId } });
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });
});
