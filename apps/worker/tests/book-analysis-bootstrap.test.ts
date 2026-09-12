import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  initial: { id: "bootstrap-1", status: "PENDING" },
  detail: {
    id: "bootstrap-1", workspaceId: "workspace-1", sourceDocumentId: "source-1", ingestionRunId: "ingestion-1", extractionId: "extraction-1", requestedByUserId: "user-1",
    ingestionRun: { status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: {} },
    sourceDocument: {}, extraction: { ingestionRunId: "ingestion-1", sourceDocumentId: "source-1" }, requestedBy: { workspaceId: "workspace-1", userId: "user-1" },
  },
  keyring: true,
  updates: [] as unknown[],
  findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), executeRaw: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@ai-cognitive/db", () => ({ prisma: {
  bookAnalysisBootstrap: { findUnique: state.findUnique, findUniqueOrThrow: state.findUniqueOrThrow, updateMany: state.updateMany, findMany: vi.fn() },
  currentDocumentExtraction: { findUnique: vi.fn() },
  $executeRaw: state.executeRaw, $transaction: vi.fn(),
} }));
vi.mock("@ai-cognitive/book-intelligence", () => ({ materializeChunkSet: vi.fn(), requestBookAnalysisForUser: vi.fn(), resolveBookProductExecution: vi.fn(), resolveBookAnalysisVersions: () => ({ pipelineVersion: "product-v1", promptVersion: "product-v1" }) }));
vi.mock("@ai-cognitive/ingestion", () => ({ BOOK_ANALYSIS_BOOTSTRAP_TOPIC: "book.analysis.bootstrap.requested", dispatchPendingOutbox: state.dispatch }));
vi.mock("@ai-cognitive/provider-gateway", () => ({ resolveCredentialKeyring: () => state.keyring ? { activeVersion: "test", keys: {} } : undefined }));

import { materializeChunkSet, requestBookAnalysisForUser, resolveBookProductExecution } from "@ai-cognitive/book-intelligence";
import { prisma } from "@ai-cognitive/db";
import { dispatchBookAnalysisBootstrapWithQueue, processBookAnalysisBootstrap } from "../src/book-analysis-bootstrap.js";

describe("BookAnalysisBootstrap fault boundaries", () => {
  beforeEach(() => {
    state.keyring = true; state.updates.length = 0;
    state.detail.ingestionRun.status = "SUCCEEDED";
    state.dispatch.mockReset().mockResolvedValue(1);
    state.findUnique.mockReset().mockResolvedValue(state.initial);
    state.findUniqueOrThrow.mockReset().mockResolvedValue(state.detail);
    state.updateMany.mockReset().mockImplementation(async (input: unknown) => { state.updates.push(input); return { count: 1 }; });
    state.executeRaw.mockReset().mockResolvedValue(1);
    vi.mocked(prisma.currentDocumentExtraction.findUnique).mockReset().mockResolvedValue({ extractionId: "extraction-1" } as never);
    vi.mocked(materializeChunkSet).mockReset().mockResolvedValue({ id: "chunk-set-1" } as never);
    vi.mocked(resolveBookProductExecution).mockReset().mockResolvedValue({ provider: "fixture", model: "book", configuration: {}, routePlan: { version: 1, routes: {} } } as never);
    vi.mocked(requestBookAnalysisForUser).mockReset().mockResolvedValue({ run: { id: "analysis-1" } } as never);
  });

  it("releases ownership into WAITING_FOR_PROVIDER without invoking chunking", async () => {
    state.keyring = false;
    await processBookAnalysisBootstrap("bootstrap-1");
    expect(materializeChunkSet).not.toHaveBeenCalled();
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "WAITING_FOR_PROVIDER", executionClaimToken: null }) }));
  });

  it("keeps the lease-owned row recoverable when a fault simulates a process crash", async () => {
    await expect(processBookAnalysisBootstrap("bootstrap-1", { faultInjector: point => { if (point === "afterBookAnalysisRequest") throw new Error("BOOK_ANALYSIS_BOOTSTRAP_SIMULATED_CRASH"); } })).rejects.toThrow("BOOK_ANALYSIS_BOOTSTRAP_SIMULATED_CRASH");
    expect(requestBookAnalysisForUser).toHaveBeenCalledTimes(1);
    expect(state.updateMany).not.toHaveBeenCalled();
  });

  it("uses a new durable generation in the BullMQ job identity", async () => {
    await dispatchBookAnalysisBootstrapWithQueue({ add: vi.fn() } as never);
    const options = state.dispatch.mock.calls[0]?.[0];
    expect(options.jobId({ bootstrapId: "bootstrap-1", dispatchGeneration: 2 })).toBe("bootstrap-1:2");
  });

  it("returns chunk-set contention to durable PENDING rather than terminal failure", async () => {
    vi.mocked(materializeChunkSet).mockRejectedValueOnce(new Error("CHUNK_SET_MATERIALIZATION_IN_PROGRESS"));
    await processBookAnalysisBootstrap("bootstrap-1");
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING", retryCount: { increment: 1 } }) }));
  });

  it("reserves FAILED_TERMINAL for permanent lineage violations", async () => {
    state.detail.ingestionRun.status = "FAILED";
    await expect(processBookAnalysisBootstrap("bootstrap-1")).rejects.toThrow("BOOK_ANALYSIS_BOOTSTRAP_LINEAGE_INVALID");
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED_TERMINAL" }) }));
  });
});
