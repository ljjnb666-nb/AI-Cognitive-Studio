import { describe, expect, it } from "vitest";
import { readEnvironment } from "../src/env.js";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://app:app@localhost:5432/app",
    REDIS_URL: "redis://localhost:6379",
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "private-bucket",
    S3_ACCESS_KEY: "local-development-only",
    S3_SECRET_KEY: "local-development-only",
    S3_FORCE_PATH_STYLE: "true",
    ...overrides,
  };
}

describe("readEnvironment storage safety", () => {
  it("rejects missing production S3 configuration", () => {
    const input = environment({ NODE_ENV: "production" });
    delete input.S3_BUCKET;
    expect(() => readEnvironment(input)).toThrow("MISSING_PRODUCTION_S3_BUCKET");
  });

  it("rejects local credentials in production", () => {
    expect(() => readEnvironment(environment({ NODE_ENV: "production" }))).toThrow("UNSAFE_PRODUCTION_S3_ACCESS_KEY");
  });

  it("accepts non-dummy production credentials", () => {
    expect(readEnvironment(environment({ NODE_ENV: "production", S3_ACCESS_KEY: "production-access-key", S3_SECRET_KEY: "production-secret-key", BETTER_AUTH_SECRET: "production-auth-secret-that-is-long-enough", BETTER_AUTH_URL: "https://studio.example.com", PROVIDER_GATEWAY_KEYRING: '{"activeVersion":"v1","keys":{"v1":"safe"}}' }))).toMatchObject({ NODE_ENV: "production" });
  });

  it("allows local credentials outside production and parses the public endpoint", () => {
    expect(readEnvironment(environment({ NODE_ENV: "test", S3_PUBLIC_ENDPOINT: "http://localhost:9000" }))).toMatchObject({ S3_PUBLIC_ENDPOINT: "http://localhost:9000", S3_ACCESS_KEY: "local-development-only" });
  });

  it("parses a positive upload completion lease duration", () => {
    expect(readEnvironment(environment({ SOURCE_UPLOAD_COMPLETION_LEASE_MS: "1200" }))).toMatchObject({ SOURCE_UPLOAD_COMPLETION_LEASE_MS: 1200 });
    expect(() => readEnvironment(environment({ SOURCE_UPLOAD_COMPLETION_LEASE_MS: "0" }))).toThrow();
  });

  it("defaults every worker and dispatcher bound to one and rejects unsafe values", () => {
    expect(readEnvironment(environment())).toMatchObject({ WORKER_INGESTION_CONCURRENCY: 1, WORKER_BOOK_ANALYSIS_CONCURRENCY: 1, WORKER_PODCAST_GENERATION_CONCURRENCY: 1, WORKER_AUDIO_CONCURRENCY: 1, WORKER_SHORT_VIDEO_CONCURRENCY: 1, OUTBOX_DISPATCH_CONCURRENCY: 1 });
    for (const value of ["0", "-1", "33", "NaN"]) expect(() => readEnvironment(environment({ WORKER_INGESTION_CONCURRENCY: value }))).toThrow();
  });

  it("fails closed for production auth, keyring, and test-only escape hatches", () => {
    const production = environment({ NODE_ENV: "production", S3_ACCESS_KEY: "production-access-key", S3_SECRET_KEY: "production-secret-key", BETTER_AUTH_SECRET: "production-auth-secret-that-is-long-enough", BETTER_AUTH_URL: "https://studio.example.com", PROVIDER_GATEWAY_KEYRING: '{"activeVersion":"v1","keys":{"v1":"safe"}}' });
    expect(readEnvironment(production).WORKSPACE_EXPENSIVE_OPERATION_LIMIT).toBe(2);
    expect(() => readEnvironment({ ...production, BETA_PROVIDER_UX_TEST_CONNECTION_TRANSPORT: "deterministic" })).toThrow("UNSAFE_PRODUCTION_TEST_ESCAPE_HATCH");
    expect(() => readEnvironment({ ...production, PROVIDER_GATEWAY_KEYRING: "" })).toThrow("MISSING_PRODUCTION_PROVIDER_GATEWAY_KEYRING");
  });
});
