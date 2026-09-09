import { describe, expect, it } from "vitest";
import { deriveProcessingState, processingWaitLabel } from "../lib/processing-state";

const now = new Date("2026-01-01T00:03:00.000Z");
const run = (status: string, createdAt = new Date("2026-01-01T00:00:00.000Z")) => ({ status, createdAt });

describe("Phase 18.1 product processing state", () => {
  it("does not represent a missing durable run as queued", () => expect(deriveProcessingState({ hasIntelligence: false, workerAvailability: "AVAILABLE" })).toBe("NOT_STARTED"));
  it.each([
    [run("QUEUED"), undefined, "QUEUED_FOR_INGESTION"], [run("RUNNING"), undefined, "INGESTING"], [run("SUCCEEDED"), undefined, "WAITING_FOR_ANALYSIS"], [run("SUCCEEDED"), run("QUEUED"), "ANALYSIS_QUEUED"], [run("SUCCEEDED"), run("RUNNING"), "ANALYZING"], [run("FAILED"), undefined, "INGESTION_FAILED"], [run("SUCCEEDED"), run("FAILED"), "ANALYSIS_FAILED"],
  ])("derives durable states", (ingestion, analysis, expected) => expect(deriveProcessingState({ ingestion, analysis, workerAvailability: "AVAILABLE", hasIntelligence: false, now })).toBe(expected));
  it("only calls a stale queued run degraded when the worker is absent", () => {
    expect(deriveProcessingState({ ingestion: run("QUEUED"), workerAvailability: "AVAILABLE", hasIntelligence: false, now })).toBe("QUEUED_FOR_INGESTION");
    expect(deriveProcessingState({ ingestion: run("QUEUED"), workerAvailability: "DEGRADED", hasIntelligence: false, now })).toBe("PROCESSING_DEGRADED");
  });
  it("marks a stale running run degraded only when the worker heartbeat is absent", () => {
    expect(deriveProcessingState({ ingestion: { ...run("RUNNING"), startedAt: new Date("2026-01-01T00:00:00.000Z") }, workerAvailability: "DEGRADED", hasIntelligence: false, now })).toBe("PROCESSING_DEGRADED");
    expect(processingWaitLabel(new Date("2026-01-01T00:02:00.000Z"), now)).toBe("已等待 1 分钟");
  });
  it("treats immutable current intelligence as succeeded regardless of stale historical runs", () => {
    expect(deriveProcessingState({ ingestion: run("FAILED"), analysis: run("FAILED"), workerAvailability: "DEGRADED", hasIntelligence: true, now })).toBe("SUCCEEDED");
  });
});
