import { timingSafeEqual } from "node:crypto";

export type BrowserIdentityMode = "TEST_HARNESS" | "DEVELOPMENT_BOOTSTRAP" | "REQUIRED";

export function developmentBootstrapAllowed(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.NODE_ENV === "production") return false;

  return environment.WEB_DEV_BOOTSTRAP_IDENTITY === "true" || process.env.NODE_ENV !== "production";
}

export function testHarnessCredentialValid(credential: string | undefined, environment: NodeJS.ProcessEnv = process.env): boolean {
  const expected = environment.WEB_TEST_HARNESS_TOKEN;
  if (environment.PHASE6_BROWSER_ACCEPTANCE !== "true" || environment.DATABASE_URL?.includes("ai_cognitive_studio_phase6_test") !== true || !credential || !expected) return false;
  const actualBytes = Buffer.from(credential);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Browser-provided IDs are deliberately absent: only a verified provider seam may add identity later. */
export function browserIdentityMode(credential: string | undefined, environment: NodeJS.ProcessEnv = process.env): BrowserIdentityMode {
  if (testHarnessCredentialValid(credential, environment)) return "TEST_HARNESS";
  if (developmentBootstrapAllowed(environment)) return "DEVELOPMENT_BOOTSTRAP";
  return "REQUIRED";
}
