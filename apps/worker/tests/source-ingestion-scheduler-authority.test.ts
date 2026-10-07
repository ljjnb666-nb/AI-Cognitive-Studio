import { describe, expect, it, vi } from "vitest";
import { OcrCapacityDeferredError, OcrCapacityDeferralError } from "@ai-cognitive/ingestion";
import { deferDeliveryOnPostCommitCapacitySignal } from "../src/source-ingestion.js";

/**
 * RF05 P1-02 worker scheduler-authority teeth: the BullMQ delivery is
 * deferred ONLY for the POST-COMMIT OcrCapacityDeferredError signal. A
 * generic capacity message, the PRE-COMMIT deferral error, and the
 * ownership-loss result NEVER defer.
 */

function spyJob(): { moveToDelayed: ReturnType<typeof vi.fn> } {
  return { moveToDelayed: vi.fn(async () => undefined) };
}

describe("worker capacity-deferral scheduler authority (RF05 P1-02)", () => {
  it("D: a generic Error('SOURCE_OCR_HOST_CAPACITY') NEVER moves the job to delayed", async () => {
    const job = spyJob();
    const deferred = await deferDeliveryOnPostCommitCapacitySignal(new Error("SOURCE_OCR_HOST_CAPACITY"), job as never, "token-1", 2_000);
    expect(deferred).toBe(false);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("E: the PRE-COMMIT OcrCapacityDeferralError NEVER moves the job to delayed", async () => {
    const job = spyJob();
    const preCommit = new OcrCapacityDeferralError({ workspaceId: "w", sourceDocumentId: "d", ingestionRunId: "r", physicalPageIndex: 1, routingGeneration: 1, pageClaimToken: "t", runExecutionToken: "rt" });
    const deferred = await deferDeliveryOnPostCommitCapacitySignal(preCommit, job as never, "token-1", 2_000);
    expect(deferred).toBe(false);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("B-chain: the ownership-loss result (INGESTION_EXECUTION_OWNERSHIP_LOST) NEVER moves the job to delayed", async () => {
    const job = spyJob();
    const deferred = await deferDeliveryOnPostCommitCapacitySignal(new Error("INGESTION_EXECUTION_OWNERSHIP_LOST"), job as never, "token-1", 2_000);
    expect(deferred).toBe(false);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("A: ONLY the POST-COMMIT OcrCapacityDeferredError defers the delivery", async () => {
    const job = spyJob();
    const deferred = await deferDeliveryOnPostCommitCapacitySignal(new OcrCapacityDeferredError(), job as never, "token-1", 2_000);
    expect(deferred).toBe(true);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "token-1");
  });

  it("without a job token nothing ever defers (deferral requires the delivery lock)", async () => {
    const job = spyJob();
    const deferred = await deferDeliveryOnPostCommitCapacitySignal(new OcrCapacityDeferredError(), job as never, undefined, 2_000);
    expect(deferred).toBe(false);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
