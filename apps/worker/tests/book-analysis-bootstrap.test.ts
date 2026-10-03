import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  initial: { id: "bootstrap-1", status: "PENDING", retryCount: 0, dispatchGeneration: 1 },
  detail: {
    id: "bootstrap-1", workspaceId: "workspace-1", sourceDocumentId: "source-1", ingestionRunId: "ingestion-1", extractionId: "extraction-1", requestedByUserId: "user-1",
    ingestionRun: { status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: {} },
    sourceDocument: {}, extraction: { ingestionRunId: "ingestion-1", sourceDocumentId: "source-1" }, requestedBy: { workspaceId: "workspace-1", userId: "user-1" },
  },
  keyring: true,
  capacity: true,
  updates: [] as unknown[],
  findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), bootstrapCreate: vi.fn(), ingestionFindMany: vi.fn(), executeRaw: vi.fn(), queryRaw: vi.fn(), transaction: vi.fn(), outboxCreate: vi.fn(),
  capacityCheck: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@ai-cognitive/db", () => ({ prisma: {
  bookAnalysisBootstrap: { findUnique: state.findUnique, findUniqueOrThrow: state.findUniqueOrThrow, updateMany: state.updateMany, findMany: state.findMany, create: state.bootstrapCreate },
  ingestionRun: { findMany: state.ingestionFindMany },
  currentDocumentExtraction: { findUnique: vi.fn() },
  outboxEvent: { create: state.outboxCreate },
  $executeRaw: state.executeRaw, $transaction: state.transaction,
}, workspaceExpensiveOperationCapacityAvailable: state.capacityCheck }));
vi.mock("@ai-cognitive/book-intelligence", () => ({ materializeChunkSet: vi.fn(), requestBookAnalysisForUser: vi.fn(), resolveBookProductExecution: vi.fn(), resolveBookAnalysisVersions: () => ({ pipelineVersion: "product-v1", promptVersion: "product-v1" }) }));
vi.mock("@ai-cognitive/ingestion", () => ({ BOOK_ANALYSIS_BOOTSTRAP_TOPIC: "book.analysis.bootstrap.requested", dispatchPendingOutbox: state.dispatch }));
vi.mock("@ai-cognitive/provider-gateway", () => ({ resolveCredentialKeyring: () => state.keyring ? { activeVersion: "test", keys: {} } : undefined }));

import { materializeChunkSet, requestBookAnalysisForUser, resolveBookProductExecution } from "@ai-cognitive/book-intelligence";
import { prisma } from "@ai-cognitive/db";
import { adoptHistoricalBookAnalysisBootstrapForIngestionRun, bookAnalysisBootstrapBlockingReason, bookAnalysisBootstrapJobId, classifyBootstrapError, dispatchBookAnalysisBootstrapWithQueue, processBookAnalysisBootstrap, rearmBookAnalysisBootstrapById, reconcileHistoricalBookAnalysisBootstraps, reconcileWaitingBookAnalysisBootstraps } from "../src/book-analysis-bootstrap.js";

describe("BookAnalysisBootstrap fault boundaries", () => {
  beforeEach(() => {
    state.keyring = true; state.capacity = true; state.updates.length = 0; state.initial.status = "PENDING"; state.initial.retryCount = 0; state.initial.dispatchGeneration = 1;
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
    state.capacityCheck.mockReset().mockImplementation(async () => state.capacity);
    vi.mocked(prisma.currentDocumentExtraction.findUnique).mockReset().mockResolvedValue({ extractionId: "extraction-1" } as never);
    vi.mocked(materializeChunkSet).mockReset().mockResolvedValue({ id: "chunk-set-1" } as never);
    vi.mocked(resolveBookProductExecution).mockReset().mockResolvedValue({ provider: "fixture", model: "book", configuration: {}, routePlan: { version: 1, routes: {} } } as never);
    vi.mocked(requestBookAnalysisForUser).mockReset().mockResolvedValue({ run: { id: "analysis-1" } } as never);
  });

  it("derives capacity, provider, lease, and recovery blocking reasons without a new durable state", () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    expect(bookAnalysisBootstrapBlockingReason({ status: "PENDING", errorCode: "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED" }, now)).toBe("CAPACITY_LIMIT");
    expect(bookAnalysisBootstrapBlockingReason({ status: "WAITING_FOR_PROVIDER" }, now)).toBe("PROVIDER_NOT_READY");
    expect(bookAnalysisBootstrapBlockingReason({ status: "RUNNING", executionLeaseUntil: new Date("2026-09-13T00:01:00.000Z") }, now)).toBe("ACTIVE_LEASE");
    expect(bookAnalysisBootstrapBlockingReason({ status: "RUNNING", executionLeaseUntil: new Date("2026-09-12T23:59:00.000Z") }, now)).toBe("RECOVERY_REQUIRED");
    expect(bookAnalysisBootstrapBlockingReason({ status: "PENDING" }, now)).toBe("NONE");
  });

  it("releases ownership into WAITING_FOR_PROVIDER without invoking chunking", async () => {
    state.keyring = false;
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    expect(materializeChunkSet).not.toHaveBeenCalled();
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "WAITING_FOR_PROVIDER", executionClaimToken: null }) }));
  });

  it("defers capacity backpressure without consuming retry budget, chunking, or provider work", async () => {
    state.capacity = false;
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    expect(materializeChunkSet).not.toHaveBeenCalled();
    expect(requestBookAnalysisForUser).not.toHaveBeenCalled();
    expect(state.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING", errorCode: "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED", nextAttemptAt: null }) }));
  });

  it("keeps repeated capacity deferral on the same generation and retry budget", async () => {
    state.capacity = false;
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    await processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1 });
    expect(requestBookAnalysisForUser).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(2);
    for (const update of state.updates as Array<{ data: { retryCount?: number; errorCode?: string } }>) {
      expect(update.data).toMatchObject({ errorCode: "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED" });
      expect(update.data.retryCount).toBeUndefined();
    }
  });

  it("keeps the lease-owned row recoverable when a fault simulates a process crash", async () => {
    await expect(processBookAnalysisBootstrap("bootstrap-1", { expectedDispatchGeneration: 1, faultInjector: point => { if (point === "afterBookAnalysisRequest") throw new Error("BOOK_ANALYSIS_BOOTSTRAP_SIMULATED_CRASH"); } })).rejects.toThrow("BOOK_ANALYSIS_BOOTSTRAP_SIMULATED_CRASH");
    expect(requestBookAnalysisForUser).toHaveBeenCalledTimes(1);
    expect(state.updateMany).not.toHaveBeenCalled();
  });

  it("uses a BullMQ-safe, deterministic, generation-sensitive durable job identity", async () => {
    await dispatchBookAnalysisBootstrapWithQueue({ add: vi.fn() } as never, { aggregateIds: ["bootstrap-1"] });
    const options = state.dispatch.mock.calls[0]?.[0];
    const generationOne = options.jobId({ bootstrapId: "bootstrap-1", dispatchGeneration: 1 });
    const generationTwo = options.jobId({ bootstrapId: "bootstrap-1", dispatchGeneration: 2 });
    expect(generationOne).toBe("book-analysis-bootstrap-bootstrap-1-g1");
    expect(generationOne).toBe(bookAnalysisBootstrapJobId({ bootstrapId: "bootstrap-1", dispatchGeneration: 1 }));
    expect(options.jobId({ bootstrapId: "bootstrap-1", dispatchGeneration: 1 })).toBe(generationOne);
    expect(generationOne).not.toContain(":");
    expect(generationOne).not.toMatch(/^\d+$/);
    expect(generationTwo).toBe("book-analysis-bootstrap-bootstrap-1-g2");
    expect(generationTwo).not.toBe(generationOne);
    expect(options.aggregateIds).toEqual(["bootstrap-1"]);
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
    state.findUnique.mockResolvedValue({ id: "bootstrap-1", status: "RUNNING", workspaceId: "workspace-1", nextAttemptAt: null, executionLeaseUntil: new Date("2000-01-01T00:00:00.000Z") });
    state.findUniqueOrThrow.mockResolvedValue({ workspaceId: "workspace-1", ...freshClaim });
    // The SQL mutation is the race fence: an empty RETURNING set means the fresh claim won.
    state.queryRaw.mockResolvedValue([]);
    await reconcileWaitingBookAnalysisBootstraps();
    expect(state.queryRaw).toHaveBeenCalledTimes(1);
    expect(state.outboxCreate).not.toHaveBeenCalled();
    expect(freshClaim).toEqual(expect.objectContaining({ executionClaimToken: "fresh-worker", dispatchGeneration: 7 }));
  });

  it("rearms only the exact waiting target once and publishes its next generation", async () => {
    state.findUnique.mockResolvedValueOnce({ id: "bootstrap-b", status: "WAITING_FOR_PROVIDER", workspaceId: "workspace-b", nextAttemptAt: null, executionLeaseUntil: null }).mockResolvedValueOnce({ id: "bootstrap-b", status: "PENDING", workspaceId: "workspace-b", nextAttemptAt: null, executionLeaseUntil: null });
    state.findUniqueOrThrow.mockResolvedValue({ dispatchGeneration: 2 });
    await expect(rearmBookAnalysisBootstrapById("bootstrap-b")).resolves.toBe("REARMED");
    expect(state.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "bootstrap-b", status: "WAITING_FOR_PROVIDER" }) }));
    expect(state.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ aggregateId: "bootstrap-b", payload: { bootstrapId: "bootstrap-b", dispatchGeneration: 2 } }) }));
    await expect(rearmBookAnalysisBootstrapById("bootstrap-b")).resolves.toBe("NOT_ELIGIBLE");
    expect(state.outboxCreate).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an unknown or provider-unready exact rearm without mutation", async () => {
    state.findUnique.mockResolvedValueOnce(null);
    await expect(rearmBookAnalysisBootstrapById("unknown")).resolves.toBe("NOT_FOUND");
    state.findUnique.mockResolvedValueOnce({ id: "bootstrap-1", status: "WAITING_FOR_PROVIDER", workspaceId: "workspace-1", nextAttemptAt: null, executionLeaseUntil: null });
    state.keyring = false;
    await expect(rearmBookAnalysisBootstrapById("bootstrap-1")).resolves.toBe("NOT_READY");
    expect(state.updateMany).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
  });

  it("discovers capacity-blocked work but exact rearm leaves it untouched while capacity remains full", async () => {
    state.findUnique.mockResolvedValue({ id: "bootstrap-1", status: "PENDING", workspaceId: "workspace-1", nextAttemptAt: null, executionLeaseUntil: null, errorCode: "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED", analysisRunId: null });
    state.capacity = false;
    await expect(rearmBookAnalysisBootstrapById("bootstrap-1")).resolves.toBe("CAPACITY_DEFERRED");
    expect(state.updateMany).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
  });

  it("rearms capacity-blocked work after a slot is released and publishes one new generation", async () => {
    state.findUnique.mockResolvedValue({ id: "bootstrap-1", status: "PENDING", workspaceId: "workspace-1", nextAttemptAt: null, executionLeaseUntil: null, errorCode: "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED", analysisRunId: null });
    state.findUniqueOrThrow.mockResolvedValueOnce({ dispatchGeneration: 2 }).mockResolvedValue(state.detail);
    state.capacity = true;

    await expect(rearmBookAnalysisBootstrapById("bootstrap-1")).resolves.toBe("REARMED");

    expect(state.capacityCheck).toHaveBeenCalledWith(expect.any(Object), "workspace-1", 2);
    expect(state.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "bootstrap-1", status: "PENDING", errorCode: "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED", analysisRunId: null, executionLeaseUntil: null }),
      data: expect.objectContaining({ status: "PENDING", errorCode: null, dispatchGeneration: { increment: 1 } }),
    }));
    expect(state.outboxCreate).toHaveBeenCalledTimes(1);
    expect(state.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ aggregateId: "bootstrap-1", payload: { bootstrapId: "bootstrap-1", dispatchGeneration: 2 } }) }));
  });

  it("routes a capacity-blocked candidate through the exact rearm core", async () => {
    state.findMany.mockResolvedValue([{ id: "bootstrap-1" }]);
    state.findUnique.mockResolvedValue({ id: "bootstrap-1", status: "PENDING", workspaceId: "workspace-1", nextAttemptAt: null, executionLeaseUntil: null, errorCode: "WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED", analysisRunId: null });
    state.capacity = false;
    await expect(reconcileWaitingBookAnalysisBootstraps()).resolves.toBe(1);
    expect(state.capacityCheck).toHaveBeenCalledTimes(1);
    expect(state.updateMany).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
  });

  it("rearms a genuinely expired RUNNING row once and publishes its new generation", async () => {
    state.findMany.mockResolvedValue([{ id: "bootstrap-1", status: "RUNNING" }]);
    state.findUnique.mockResolvedValue({ id: "bootstrap-1", status: "RUNNING", workspaceId: "workspace-1", nextAttemptAt: null, executionLeaseUntil: new Date("2000-01-01T00:00:00.000Z") });
    state.findUniqueOrThrow.mockResolvedValue({ workspaceId: "workspace-1" });
    state.queryRaw.mockResolvedValue([{ dispatchGeneration: 2 }]);
    await reconcileWaitingBookAnalysisBootstraps();
    expect(state.queryRaw).toHaveBeenCalledTimes(1);
    expect(state.outboxCreate).toHaveBeenCalledTimes(1);
    expect(state.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: { bootstrapId: "bootstrap-1", dispatchGeneration: 2 } }) }));
  });

  it("rearms provider waiting work and makes its new generation claimable", async () => {
    state.findMany.mockResolvedValue([{ id: "bootstrap-1", status: "WAITING_FOR_PROVIDER" }]);
    state.findUnique.mockResolvedValue({ id: "bootstrap-1", status: "WAITING_FOR_PROVIDER", workspaceId: "workspace-1", nextAttemptAt: null, executionLeaseUntil: null });
    state.findUniqueOrThrow.mockResolvedValueOnce({ dispatchGeneration: 2 }).mockResolvedValue(state.detail);
    await reconcileWaitingBookAnalysisBootstraps();
    expect(state.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "bootstrap-1", status: "WAITING_FOR_PROVIDER" }), data: expect.objectContaining({ status: "PENDING", dispatchGeneration: { increment: 1 } }) }));
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

  it("adopts only the explicit target when multiple eligible ingestions exist", async () => {
    const target = { id: "ingestion-b", status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-b", job: { userId: "user-1" }, extraction: { id: "extraction-b" } };
    state.queryRaw.mockResolvedValue([{ id: "ingestion-b" }]);
    state.findUniqueOrThrow.mockResolvedValue(target);
    state.findUnique.mockResolvedValue(null);
    state.bootstrapCreate.mockResolvedValue({ id: "bootstrap-b", dispatchGeneration: 1 });
    vi.mocked(prisma.currentDocumentExtraction.findUnique).mockResolvedValue({ extractionId: "extraction-b" } as never);

    await expect(adoptHistoricalBookAnalysisBootstrapForIngestionRun("ingestion-b")).resolves.toBe("ADOPTED");
    expect(state.ingestionFindMany).not.toHaveBeenCalled();
    expect(state.bootstrapCreate).toHaveBeenCalledTimes(1);
    expect(state.bootstrapCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ingestionRunId: "ingestion-b", sourceDocumentId: "source-b", extractionId: "extraction-b" }) }));
    expect(state.outboxCreate).toHaveBeenCalledTimes(1);
    expect(state.bootstrapCreate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ingestionRunId: "ingestion-a" }) }));
  });

  it("makes exact-target adoption idempotent", async () => {
    state.queryRaw.mockResolvedValue([{ id: "ingestion-1" }]);
    state.findUniqueOrThrow.mockResolvedValue({ id: "ingestion-1", status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: { userId: "user-1" }, extraction: { id: "extraction-1" } });
    state.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "bootstrap-1" });

    await expect(adoptHistoricalBookAnalysisBootstrapForIngestionRun("ingestion-1")).resolves.toBe("ADOPTED");
    await expect(adoptHistoricalBookAnalysisBootstrapForIngestionRun("ingestion-1")).resolves.toBe("ALREADY_ADOPTED");
    expect(state.bootstrapCreate).toHaveBeenCalledTimes(1);
    expect(state.outboxCreate).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an unknown exact ingestion target", async () => {
    state.queryRaw.mockResolvedValue([]);
    await expect(adoptHistoricalBookAnalysisBootstrapForIngestionRun("unknown-ingestion")).resolves.toBe("NOT_FOUND");
    expect(state.bootstrapCreate).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
  });

  it("fails closed for a stale or cross-workspace current extraction", async () => {
    state.queryRaw.mockResolvedValue([{ id: "ingestion-1" }]);
    state.findUniqueOrThrow.mockResolvedValue({ id: "ingestion-1", status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: { userId: "user-1" }, extraction: { id: "extraction-1" } });
    vi.mocked(prisma.currentDocumentExtraction.findUnique).mockResolvedValue({ extractionId: "other-workspace-extraction" } as never);

    await expect(adoptHistoricalBookAnalysisBootstrapForIngestionRun("ingestion-1")).resolves.toBe("NOT_ELIGIBLE");
    expect(prisma.currentDocumentExtraction.findUnique).toHaveBeenCalledWith({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: "source-1", workspaceId: "workspace-1" } } });
    expect(state.bootstrapCreate).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
  });

  it("fails closed for invalid initiating-user provenance", async () => {
    state.queryRaw.mockResolvedValue([{ id: "ingestion-1" }]);
    state.findUniqueOrThrow.mockResolvedValue({ id: "ingestion-1", status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: { userId: null }, extraction: { id: "extraction-1" } });

    await expect(adoptHistoricalBookAnalysisBootstrapForIngestionRun("ingestion-1")).resolves.toBe("NOT_ELIGIBLE");
    expect(state.bootstrapCreate).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an unsupported ingestion state", run: { id: "ingestion-1", status: "FAILED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: { userId: "user-1" }, extraction: { id: "extraction-1" } } },
    { label: "a missing extraction", run: { id: "ingestion-1", status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: { userId: "user-1" }, extraction: null } },
  ])("fails closed for %s", async ({ run }) => {
    state.queryRaw.mockResolvedValue([{ id: "ingestion-1" }]);
    state.findUniqueOrThrow.mockResolvedValue(run);

    await expect(adoptHistoricalBookAnalysisBootstrapForIngestionRun("ingestion-1")).resolves.toBe("NOT_ELIGIBLE");
    expect(state.bootstrapCreate).not.toHaveBeenCalled();
    expect(state.outboxCreate).not.toHaveBeenCalled();
  });

  it("keeps batch discovery limit semantics while delegating each selected candidate to the exact-target core", async () => {
    state.ingestionFindMany.mockResolvedValue([{ id: "ingestion-1" }]);
    state.queryRaw.mockResolvedValue([{ id: "ingestion-1" }]);
    state.findUniqueOrThrow.mockResolvedValue({ id: "ingestion-1", status: "SUCCEEDED", workspaceId: "workspace-1", sourceDocumentId: "source-1", job: { userId: "user-1" }, extraction: { id: "extraction-1" } });
    vi.mocked(prisma.currentDocumentExtraction.findUnique).mockResolvedValue({ extractionId: "extraction-1" } as never);
    state.findUnique.mockResolvedValue(null);
    expect(await reconcileHistoricalBookAnalysisBootstraps(1)).toBe(1);
    expect(state.ingestionFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1, orderBy: { completedAt: "asc" } }));
    expect(state.bootstrapCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ requestedByUserId: "user-1", ingestionRunId: "ingestion-1", extractionId: "extraction-1" }) }));
    expect(state.outboxCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: { bootstrapId: "bootstrap-1", dispatchGeneration: 1 } }) }));
    state.findUnique.mockResolvedValue({ id: "bootstrap-1" });
    expect(await reconcileHistoricalBookAnalysisBootstraps(1)).toBe(0);
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
