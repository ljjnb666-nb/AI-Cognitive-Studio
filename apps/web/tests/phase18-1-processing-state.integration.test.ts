import { describe, expect, it } from "vitest";
import { deriveProcessingState, deriveProcessingStatus, processingWaitLabel } from "../lib/processing-state";
import { processingAvailabilityFromHeartbeat } from "../lib/worker-heartbeat";
import { submitProcessingRecovery } from "../lib/processing-recovery";

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
  it("requires current intelligence even when the analysis run says succeeded", () => {
    expect(deriveProcessingState({ ingestion: run("SUCCEEDED"), analysis: run("SUCCEEDED"), workerAvailability: "AVAILABLE", hasIntelligence: false, now })).toBe("PROCESSING_DEGRADED");
    expect(deriveProcessingState({ ingestion: run("SUCCEEDED"), analysis: run("SUCCEEDED"), workerAvailability: "AVAILABLE", hasIntelligence: true, now })).toBe("SUCCEEDED");
  });
  it("uses the capability matching the current pipeline and rejects malformed heartbeat data", () => {
    const availability = processingAvailabilityFromHeartbeat(JSON.stringify({ capabilities: { ingestion: true, bookAnalysis: false, podcastGeneration: false, podcastAudio: false, shortVideoGeneration: false } }));
    expect(deriveProcessingState({ ingestion: run("QUEUED"), workerAvailability: availability, hasIntelligence: false, now })).toBe("QUEUED_FOR_INGESTION");
    expect(deriveProcessingState({ ingestion: run("SUCCEEDED"), analysis: run("QUEUED"), workerAvailability: availability, hasIntelligence: false, now })).toBe("PROCESSING_DEGRADED");
    expect(processingAvailabilityFromHeartbeat("not-json").bookAnalysis).toBe("UNKNOWN");
    expect(availability).toMatchObject({ podcastGeneration: "DEGRADED", podcastAudio: "DEGRADED", shortVideoGeneration: "DEGRADED" });
  });
  it.each([
    [undefined, undefined, false, "AVAILABLE", "NOT_STARTED", "INGESTION", "RETRY_INGESTION"],
    [run("QUEUED"), undefined, false, "AVAILABLE", "QUEUED_FOR_INGESTION", "INGESTION", "RECHECK"],
    [run("QUEUED"), undefined, false, "DEGRADED", "PROCESSING_DEGRADED", "INGESTION", "RETRY_INGESTION"],
    [{ ...run("RUNNING"), startedAt: new Date("2026-01-01T00:00:00.000Z") }, undefined, false, "DEGRADED", "PROCESSING_DEGRADED", "INGESTION", "RETRY_INGESTION"],
    [run("FAILED"), undefined, false, "AVAILABLE", "INGESTION_FAILED", "INGESTION", "RETRY_INGESTION"],
    [run("SUCCEEDED"), undefined, false, "DEGRADED", "WAITING_FOR_ANALYSIS", "BOOK_ANALYSIS", "RETRY_ANALYSIS"],
    [run("SUCCEEDED"), run("QUEUED"), false, "AVAILABLE", "ANALYSIS_QUEUED", "BOOK_ANALYSIS", "RECHECK"],
    [run("SUCCEEDED"), run("QUEUED"), false, "DEGRADED", "PROCESSING_DEGRADED", "BOOK_ANALYSIS", "RETRY_ANALYSIS"],
    [run("SUCCEEDED"), { ...run("RUNNING"), startedAt: new Date("2026-01-01T00:00:00.000Z") }, false, "DEGRADED", "PROCESSING_DEGRADED", "BOOK_ANALYSIS", "RETRY_ANALYSIS"],
    [run("SUCCEEDED"), run("FAILED"), false, "AVAILABLE", "ANALYSIS_FAILED", "BOOK_ANALYSIS", "RETRY_ANALYSIS"],
    [run("SUCCEEDED"), run("SUCCEEDED"), false, "AVAILABLE", "PROCESSING_DEGRADED", "BOOK_ANALYSIS", "REPAIR_CURRENT_INTELLIGENCE"],
    [run("SUCCEEDED"), run("SUCCEEDED"), true, "AVAILABLE", "SUCCEEDED", "COMPLETE", "NONE"],
  ] as const)("derives one stage-aware processing contract", (ingestion, analysis, hasIntelligence, workerAvailability, state, stage, recoveryAction) => {
    const status = deriveProcessingStatus({ ingestion, analysis, hasIntelligence, workerAvailability, now });
    expect(status).toMatchObject({ state, stage, recoveryAction });
  });
  it("keeps recovery errors safe and does not treat a failed response as a refreshable success", async () => {
    const failed = await submitProcessingRecovery("source", async () => new Response('{"error":"Prisma connection secret"}', { status: 500 }));
    const unavailable = await submitProcessingRecovery("source", async () => { throw new Error("redis password"); });
    const succeeded = await submitProcessingRecovery("source", async () => new Response(null, { status: 202 }));
    expect([failed, unavailable, succeeded]).toEqual(["PROCESSING_RECOVERY_FAILED", "PROCESSING_RECOVERY_FAILED", "RECOVERED"]);
  });
});
