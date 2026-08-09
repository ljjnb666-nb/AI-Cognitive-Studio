import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors/app-error.js";

describe("AppError", () => {
  it("preserves the shared error contract", () => {
    const details = { jobId: "job-1" };
    const error = new AppError({
      code: "JOB_FAILED",
      message: "The job failed.",
      details,
      retryable: true,
    });

    expect(error).toMatchObject({
      name: "AppError",
      code: "JOB_FAILED",
      message: "The job failed.",
      details,
      retryable: true,
    });
  });
});
