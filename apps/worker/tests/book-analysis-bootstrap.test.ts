import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  initial: { id: "bootstrap-1", status: "PENDING", retryCount: 0, dispatchGeneration: 1 },
  detail: {
    id: "bootstrap-1", workspaceId: "workspace-1", sourceDocumentId: "source-1", ingestionRunId: "ingestion-1", extractionId: "extraction-1", requestedByUserId: "user-1",
    ingestionRun: { status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: {} },
    sourceDocument: {}, extraction: { ingestionRunId: "ingestion-1", sourceDocumentId: "source-1" }, requestedBy: { workspaceId: "workspace-1", userId: "user-1" },
  },
  keyring: true,
  updates: [] as unknown[],
  findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), bootstrapCreate: vi.fn(), ingestionFindMany: vi.fn(), executeRaw: vi.fn(), queryRaw: vi.fn(), transaction: vi.fn(), outboxCreate: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@ai-cognitive/db", () => ({ prisma: {
  bookAnalysisBootstrap: { findUnique: state.findUnique, findUniqueOrThrow: state.findUniqueOrThrow, updateMany: state.updateMany, findMany: state.findMany, create: state.bootstrapCreate },
  ingestionRun: { findMany: state.ingestionFindMany },
  currentDocumentExtraction: { findUnique: vi.fn() },
  outboxEvent: { create: state.outboxCreate },
  $executeRaw: state.executeRaw, $transaction: state.transaction,
} }));
vi.mock("@ai-cognitive/book-intelligence", () => ({ materializeChunkSet: vi.fn(), requestBookAnalysisForUser: vi.fn(), resolveBookProductExecution: vi.fn(), resolveBookAnalysisVersions: () => ({ pipelineVersion: "product-v1", promptVersion: "product-v1" }) }));
vi.mock("@ai-cognitive/ingestion", () => ({ BOOK_ANALYSIS_BOOTSTRAP_TOPIC: "book.analysis.bootstrap.requested", dispatchPendingOutbox: state.dispatch }));
vi.mock("@ai-cognitive/provider-gateway", () => ({ resolveCredentialKeyring: () => state.keyring ? { activeVersion: "test", keys: {} } : undefined }));

import { materializeChunkSet, requestBookAnalysisForUser, resolveBookProductExecution } from "@ai-cognitive/book-intelligence";
import { prisma } from "@ai-cognitive/db";
import { classifyBootstrapError, dispatchBookAnalysisBootstrapWithQueue, processBookAnalysisBootstrap, reconcileHistoricalBookAnalysisBootstraps, reconcileWaitingBookAnalysisBootstraps } from "../src/book-analysis-bootstrap.js";

describe("BookAnalysisBootstrap fault boundaries", () => {
  beforeEach(() => {
    state.keyring = true; state.updates.length = 0; state.initial.status = "PENDING"; state.initial.retryCount = 0; state.initial.dispatchGeneration = 1;
    state.detail.ingestionRun.status = "SUCCEEDED";
    state.dispatch.mockReset().mockResolvedValue(1);
    state.findUnique.mockReset().mockResolvedValue(state.initial);
    state.findUniqueOrThrow.mockReset().mockResolvedValue(state.detail);
    state.findMany.mockReset().mockResolvedValue([]);
    state.ingestionFindMany.mockReset().mockResolvedValue([]);
    state.updateMany.mockReset().mockImplementation(async (input: unknown) => { state.updates.push(input); return { count: 1 }; });
    state.executeRaw.mockReset().mockResolvedValue(1);
    state.queryRaw.mockReset().mockResolvedValue([]);
    state.outboxCreate.mockReset().mockResolvedValue({ id: "outbox-1" });
    state.bootstrapCreate.mockReset().mockResolvedValue({ id: "bootstrap-1", dispatchGeneration: 1 });
    state.transaction.mockReset().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({ $queryRaw: state.queryRaw, ingestionRun: { findUniqueOrThrow: state.findUniqueOrThrow }, currentDocumentExtraction: prisma.currentDocumentExtraction, bookAnalysisBootstrap: { updateMany: state.updateMany, findUniqueOrThrow: state.findUniqueOrThrow, findUnique: state.findUnique, create: state.bootstrapCreate }, outboxEvent: { create: state.outboxCreate } }));
    vi.mocked(prisma.currentDocumentExtraction.findUnique).mockReset().mockResolvedValue({ extractionId: "extraction-1" } as never);
    vi.mocked(materializeChunkSet).mockReset().mockResolvedValue({ id: "chunk-set-1" } as never);
    vi.mocked(resolveBookProductExecution).mockReset().mockResolvedValue({ provider: "fixture", model: "book", configuration: {}, routePlan: { version: 1, routes: {} } } as never);
    vi.mocked(requestBookAnalysisForUser).mockReset().mockResolvedValue({ run: { id: "analysis-1" } } as never);
  });

  it("releases ownership into WAITING_FOR_PROVIDER without invoking chunking", async () => {
    state.keyring = false;
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    expect(materializeChunkSet).not.toHaveBeenCalled();
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "WAITING_FOR_PROVIDER", executionClaimToken: null }) }));
  });

  it("keeps the lease-owned row recoverable when a fault simulates a process crash", async () => {
    await expect(processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1, faultInjector: point => { if (point === "afterBookAnalysisRequest") throw new Error("BOOK_ANALYSIS_BOOTSTRAP_SIMULATED_CRASH"); } })).rejects.toThrow("BOOK_ANALYSIS_BOOTSTRAP_SIMULATED_CRASH");
    expect(requestBookAnalysisForUser).toHaveBeenCalledTimes(1);
    expect(state.updateMany).not.toHaveBeenCalled();
  });

  it("uses a new durable generation in the BullMQ job identity", async () => {
    await dispatchBookAnalysisBootstrapWithQueue({ add: vi.fn() } as never);
    const options = state.dispatch.mock.calls[0]?.[0];
    expect(options.jobId({ bootstrapId: "bootstrap-1", dispatchGeneration: 2 })).toBe("bootstrap-1:2");
  });

  it("does no work when the authoritative generation claim rejects a stale delivery", async () => {
    state.initial.dispatchGeneration = 2;
    state.executeRaw.mockResolvedValueOnce(0);
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    expect(materializeChunkSet).not.toHaveBeenCalled();
    expect(requestBookAnalysisForUser).not.toHaveBeenCalled();
  });

  it("returns chunk-set contention to durable PENDING rather than terminal failure", async () => {
    vi.mocked(materializeChunkSet).mockRejectedValueOnce(new Error("CHUNK_SET_MATERIALIZATION_IN_PROGRESS"));
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING", retryCount: 1, nextAttemptAt: expect.any(Date) }) }));
  });

  it("reserves FAILED_TERMINAL for permanent lineage violations", async () => {
    state.detail.ingestionRun.status = "FAILED";
    await expect(processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 })).rejects.toThrow("BOOK_ANALYSIS_BOOTSTRAP_LINEAGE_INVALID");
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED_TERMINAL" }) }));
  });

  it("does not rearm an expired RUNNING selection after a fresh claim wins the conditional update", async () => {
    const freshClaim = { executionClaimToken: "fresh-worker", executionLeaseUntil: new Date("2030-01-01T00:00:00.000Z"), dispatchGeneration: 7 };
    state.findMany.mockResolvedValue([{ id: "bootstrap-1", status: "RUNNING" }]);
    state.findUniqueOrThrow.mockResolvedValue({ workspaceId: "workspace-1", ...freshClaim });
    // The SQL mutation is the race fence: an empty RETURNING set means the fresh claim won.
    state.queryRaw.mockResolvedValue([]);
    await reconcileWaitingBookAnalysisBootstraps();
    expect(state.queryRaw).toHaveBeenCalledTimes(1);
    expect(state.outboxCreate).not.toHaveBeenCalled();
    expect(freshClaim).toEqual(expect.objectContaining({ executionClaimToken: "fresh-worker", dispatchGeneration: 7 }));
  });

  it("rearms a genuinely expired RUNNING row once and publishes its new generation", async () => {
    state.findMany.mockResolvedValue([{ id: "bootstrap-1", status: "RUNNING" }]);
    state.findUniqueOrThrow.mockResolvedValue({ workspaceId: "workspace-1" });
    state.queryRaw.mockResolvedValue([{ dispatchGeneration: 2 }]);
    await reconcileWaitingBookAnalysisBootstraps();
    expect(state.queryRaw).toHaveBeenCalledTimes(1);
    expect(state.outboxCreate).toHaveBeenCalledTimes(1);
    expect(state.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: { bootstrapId: "bootstrap-1", dispatchGeneration: 2 } }) }));
  });

  it("rearms provider waiting work and makes its new generation claimable", async () => {
    state.findMany.mockResolvedValue([{ id: "bootstrap-1", status: "WAITING_FOR_PROVIDER" }]);
    state.findUniqueOrThrow.mockResolvedValueOnce({ workspaceId: "workspace-1" }).mockResolvedValueOnce({ dispatchGeneration: 2 });
    await reconcileWaitingBookAnalysisBootstraps();
    expect(state.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bootstrap-1", status: "WAITING_FOR_PROVIDER" }, data: expect.objectContaining({ status: "PENDING", dispatchGeneration: { increment: 1 } }) }));
    expect(state.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: { bootstrapId: "bootstrap-1", dispatchGeneration: 2 } }) }));
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 2 });
    expect(requestBookAnalysisForUser).toHaveBeenCalledTimes(1);
  });

  it.each(["P1001", "P2024", "ECONNRESET", "ETIMEDOUT"])("returns structured transient %s errors to recoverable PENDING", async code => {
    vi.mocked(materializeChunkSet).mockRejectedValueOnce(Object.assign(new Error("database unavailable"), { code }));
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING", retryCount: 1 }) }));
  });

  it("returns unknown infrastructure errors to recoverable PENDING", async () => {
    expect(classifyBootstrapError(new Error("unexpected infrastructure failure"))).toBe("RECOVERABLE");
    vi.mocked(materializeChunkSet).mockRejectedValueOnce(new Error("unexpected infrastructure failure"));
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) }));
  });

  it.each(["BOOK_ANALYSIS_BOOTSTRAP_LINEAGE_INVALID", "BOOK_ANALYSIS_BOOTSTRAP_CURRENT_EXTRACTION_MISMATCH", "INGESTION_INITIATOR_REQUIRED"])("records permanent invariant %s as FAILED_TERMINAL", async code => {
    expect(classifyBootstrapError(new Error(code))).toBe("PERMANENT");
    await expect(processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1, faultInjector: point => { if (point === "afterClaim") throw new Error(code); } })).rejects.toThrow(code);
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED_TERMINAL", errorCode: code }) }));
  });

  it("uses exponential retry backoff capped at five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    vi.mocked(materializeChunkSet).mockRejectedValue(new Error("unexpected infrastructure failure"));
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    const first = state.updates.at(-1) as { data: { nextAttemptAt: Date } };
    state.updates.length = 0; state.initial.retryCount = 6;
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    const capped = state.updates.at(-1) as { data: { nextAttemptAt: Date } };
    expect(first.data.nextAttemptAt.getTime() - Date.now()).toBe(10_000);
    expect(capped.data.nextAttemptAt.getTime() - Date.now()).toBe(300_000);
    vi.useRealTimers();
  });

  it("adopts a historical successful current extraction exactly once with its original Job user", async () => {
    state.ingestionFindMany.mockResolvedValue([{ id: "ingestion-1" }]);
    state.queryRaw.mockResolvedValue([{ id: "ingestion-1" }]);
    state.findUniqueOrThrow.mockResolvedValue({ id: "ingestion-1", status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: { userId: "user-1" }, extraction: { id: "extraction-1" } });
    vi.mocked(prisma.currentDocumentExtraction.findUnique).mockResolvedValue({ extractionId: "extraction-1" } as never);
    state.findUnique.mockResolvedValue(null);
    expect(await reconcileHistoricalBookAnalysisBootstraps()).toBe(1);
    expect(state.bootstrapCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestedByUserId: "user-1", ingestionRunId: "ingestion-1", extractionId: "extraction-1" }) }));
    expect(state.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: { bootstrapId: "bootstrap-1", dispatchGeneration: 1 } }) }));
    state.findUnique.mockResolvedValue({ id: "bootstrap-1" });
    expect(await reconcileHistoricalBookAnalysisBootstraps()).toBe(0);
    expect(state.bootstrapCreate).toHaveBeenCalledTimes(1);
    expect(state.outboxCreate).toHaveBeenCalledTimes(1);
  });

  it("fails closed for historical lineage without a provable initiating user", async () => {
    state.ingestionFindMany.mockResolvedValue([{ id: "ingestion-1" }]);
    state.queryRaw.mockResolvedValue([{ id: "ingestion-1" }]);
    state.findUniqueOrThrow.mockResolvedValue({ id: "ingestion-1", status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: { userId: null }, extraction: { id: "extraction-1" } });
    expect(await reconcileHistoricalBookAnalysisBootstraps()).toBe(0);
    expect(state.bootstrapCreate).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
  });

  it("rejects historical adoption when the current extraction is from another lineage", async () => {
    state.ingestionFindMany.mockResolvedValue([{ id: "ingestion-1" }]);
    state.queryRaw.mockResolvedValue([{ id: "ingestion-1" }]);
    state.findUniqueOrThrow.mockResolvedValue({ id: "ingestion-1", status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: { userId: "user-1" }, extraction: { id: "extraction-1" } });
    vi.mocked(prisma.currentDocumentExtraction.findUnique).mockResolvedValue({ extractionId: "other-workspace-extraction" } as never);
    expect(await reconcileHistoricalBookAnalysisBootstraps()).toBe(0);
    expect(state.bootstrapCreate).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
  });
});
