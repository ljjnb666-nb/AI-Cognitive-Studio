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
    expect(readEnvironment(environment({ NODE_ENV: "production", S3_ACCESS_KEY: "production-access-key", S3_SECRET_KEY: "production-secret-key" }))).toMatchObject({ NODE_ENV: "production" });
  });

  it("allows local credentials outside production and parses the public endpoint", () => {
    expect(readEnvironment(environment({ NODE_ENV: "test", S3_PUBLIC_ENDPOINT: "http://localhost:9000" }))).toMatchObject({ S3_PUBLIC_ENDPOINT: "http://localhost:9000", S3_ACCESS_KEY: "local-development-only" });
  });
});
