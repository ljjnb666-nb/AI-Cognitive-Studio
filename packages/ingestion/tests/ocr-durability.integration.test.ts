import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { acquireOcrHostLease, claimOcrPageAttempt, completeOcrPageAttempt, createOcrPageIntents, createOcrServerInstance, failOcrPageAttempt, listReconcilableOcrServerInstances, markOcrServerStatus, recordOcrServerEndpoint, releaseOcrHostLease, renewOcrHostLease, validateOcrServerInstanceContract } from "../src/ocr-durability.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];
const hostLeaseIds: string[] = [];
const runIds: string[] = [];

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function createRunFixture(status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" = "PENDING") {
  const user = await prisma.user.create({ data: { email: `ocr-${crypto.randomUUID()}@test`, name: "Ocr" } });
  const workspace = await prisma.workspace.create({ data: { name: `ocr-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(`blob-${crypto.randomUUID()}`), sizeBytes: 12, mediaType: "application/pdf", storageKey: `test/${crypto.randomUUID()}` } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "ocr-test" } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: 12, mediaType: "application/pdf", storageKey: blob.storageKey } });
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "pdf-router", normalizationVersion: "canonical-text-v1", status: "QUEUED" } });
  return { user, workspace, document, run };
}

afterAll(async () => {
  for (const runId of runIds) {
    const bootstraps = await prisma.bookAnalysisBootstrap.findMany({ where: { ingestionRunId: runId }, select: { id: true } });
    if (bootstraps.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: bootstraps.map((b) => b.id) } } });
  }
  await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.sourceSpan.deleteMany({ where: { sourceBlock: { extraction: { workspaceId: { in: workspaceIds } } } } });
  await prisma.sourceBlock.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
  await prisma.sourcePage.deleteMany({ where: { extraction: { workspaceId: { in: workspaceIds } } } });
  await prisma.bookAnalysisBootstrap.deleteMany({ where: { ingestionRunId: { in: runIds } } });
  await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.ocrServerInstance.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.uploadCompletion.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.uploadSession.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  await prisma.ocrHostLease.deleteMany({ where: { hostId: { in: hostLeaseIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  workspaceIds.length = 0;
  userIds.length = 0;
  runIds.length = 0;
  await prisma.$disconnect();
});

describe("OCR host lease (real PostgreSQL)", () => {
  it("HOST_LEASE acquires atomically and refuses a second live claim on the same host", async () => {
    const hostId = `host-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const first = await acquireOcrHostLease(hostId);
    expect(first).not.toBeNull();
    const second = await acquireOcrHostLease(hostId);
    expect(second).toBeNull();
    expect(await releaseOcrHostLease(hostId, first!.claimToken)).toBe(true);
    const third = await acquireOcrHostLease(hostId);
    expect(third).not.toBeNull();
  });

  it("HOST_LEASE_STALE_RELEASE_NOOP + HOST_LEASE_STALE_RENEW_NOOP: stale tokens never touch a newer owner's lease", async () => {
    const hostId = `host-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const dead = await acquireOcrHostLease(hostId);
    await prisma.$executeRaw`UPDATE "OcrHostLease" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "hostId" = ${hostId}`;
    const fresh = await acquireOcrHostLease(hostId);
    expect(fresh).not.toBeNull();
    expect(fresh!.claimToken).not.toBe(dead!.claimToken);
    expect(await renewOcrHostLease(hostId, dead!.claimToken)).toBe(false);
    expect(await releaseOcrHostLease(hostId, dead!.claimToken)).toBe(false);
    const row = await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId } });
    expect(row.claimToken).toBe(fresh!.claimToken);
    expect(row.leaseUntil).not.toBeNull();
    expect(await releaseOcrHostLease(hostId, fresh!.claimToken)).toBe(true);
  });
});

describe("OCR page checkpoint (real PostgreSQL)", () => {
  it("PAGE_CLAIM_EXCLUSIVE: one live claim per (run, page, generation); second claimant fails closed", async () => {
    const { workspace, document, run } = await createRunFixture();
    await createOcrPageIntents({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, routingGeneration: 1, pages: [{ physicalPageIndex: 4 }, { physicalPageIndex: 5 }] });
    const first = await claimOcrPageAttempt({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, physicalPageIndex: 4, routingGeneration: 1, parserName: "mineru", parserVersion: "4.0.3", parserMode: "flash" });
    expect(first).not.toBeNull();
    expect(first!.attemptCount).toBe(1);
    expect(await claimOcrPageAttempt({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, physicalPageIndex: 4, routingGeneration: 1, parserName: "mineru", parserVersion: "4.0.3" })).toBeNull();
  });

  it("PAGE_TRANSIENT_REQUEUE then PAGE_ATTEMPT_EXHAUSTION: transient requeues to PENDING; exhaustion terminalizes FAILED", async () => {
    const { workspace, document, run } = await createRunFixture();
    await createOcrPageIntents({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, routingGeneration: 1, pages: [{ physicalPageIndex: 0 }] });
    const key = { workspaceId: workspace.id, ingestionRunId: run.id, physicalPageIndex: 0, routingGeneration: 1 };
    const first = (await claimOcrPageAttempt({ ...key, sourceDocumentId: document.id, parserName: "mineru", parserVersion: "4.0.3" }))!;
    expect(await failOcrPageAttempt({ ...key, claimToken: first.claimToken, errorCode: "SOURCE_OCR_TIMEOUT", kind: "transient" })).toBe(true);
    let row = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: run.id, physicalPageIndex: 0, routingGeneration: 1 } } });
    expect(row.status).toBe("PENDING");
    expect(row.errorCode).toBe("SOURCE_OCR_TIMEOUT");
    expect(row.claimToken).toBeNull();
    const second = (await claimOcrPageAttempt({ ...key, sourceDocumentId: document.id, parserName: "mineru", parserVersion: "4.0.3", maxAttempts: 2 }))!;
    expect(second.attemptCount).toBe(2);
    expect(await failOcrPageAttempt({ ...key, claimToken: second.claimToken, errorCode: "SOURCE_OCR_TIMEOUT", kind: "transient", maxAttempts: 2 })).toBe(true);
    row = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: run.id, physicalPageIndex: 0, routingGeneration: 1 } } });
    expect(row.status).toBe("FAILED");
    const third = await claimOcrPageAttempt({ ...key, sourceDocumentId: document.id, parserName: "mineru", parserVersion: "4.0.3", maxAttempts: 2 });
    expect(third).toBeNull();
  });

  it("PAGE_STALE_COMPLETION_NOOP: a stale claim's completion fails closed and never replaces the authoritative checkpoint", async () => {
    const { workspace, document, run } = await createRunFixture();
    await createOcrPageIntents({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, routingGeneration: 1, pages: [{ physicalPageIndex: 2 }] });
    const key = { workspaceId: workspace.id, ingestionRunId: run.id, physicalPageIndex: 2, routingGeneration: 1 };
    const stale = (await claimOcrPageAttempt({ ...key, sourceDocumentId: document.id, parserName: "mineru", parserVersion: "4.0.3" }))!;
    await prisma.$executeRaw`UPDATE "OcrPageAttempt" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "ingestionRunId" = ${run.id}`;
    const fresh = (await claimOcrPageAttempt({ ...key, sourceDocumentId: document.id, parserName: "mineru", parserVersion: "4.0.3" }))!;
    expect(fresh.claimToken).not.toBe(stale.claimToken);
    expect(await completeOcrPageAttempt({ ...key, claimToken: stale.claimToken, authoritativeArtifactKey: "stale/attempt", textSha256: "stale", durationMs: 1 })).toBe(false);
    expect(await completeOcrPageAttempt({ ...key, claimToken: fresh.claimToken, authoritativeArtifactKey: "authoritative/attempt", textSha256: sha256("authoritative"), durationMs: 10 })).toBe(true);
    const row = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: run.id, physicalPageIndex: 2, routingGeneration: 1 } } });
    expect(row.status).toBe("SUCCEEDED");
    expect(row.authoritativeArtifactKey).toBe("authoritative/attempt");
  });

  it("TENANT_CROSS_BOUNDARY_REJECTED: cross-workspace claims and completions fail closed", async () => {
    const { workspace, document, run } = await createRunFixture();
    await createOcrPageIntents({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, routingGeneration: 1, pages: [{ physicalPageIndex: 1 }] });
    const stranger = await prisma.workspace.create({ data: { name: `stranger-${crypto.randomUUID()}` } });
    workspaceIds.push(stranger.id);
    const key = { ingestionRunId: run.id, physicalPageIndex: 1, routingGeneration: 1 };
    expect(await claimOcrPageAttempt({ workspaceId: stranger.id, sourceDocumentId: document.id, ...key, parserName: "mineru", parserVersion: "4.0.3" })).toBeNull();
    const own = (await claimOcrPageAttempt({ workspaceId: workspace.id, sourceDocumentId: document.id, ...key, parserName: "mineru", parserVersion: "4.0.3" }))!;
    expect(await completeOcrPageAttempt({ workspaceId: stranger.id, ...key, claimToken: own.claimToken, authoritativeArtifactKey: "x", textSha256: "x", durationMs: 1 })).toBe(false);
    expect(await failOcrPageAttempt({ workspaceId: stranger.id, ...key, claimToken: own.claimToken, errorCode: "X", kind: "terminal" })).toBe(false);
  });
});

describe("OCR server instance durable identity (real PostgreSQL)", () => {
  it("SERVER_STARTING_NULL_ENDPOINT_ALLOWED: STARTING persists before launch with nullable endpoint fields", async () => {
    const { workspace, document, run } = await createRunFixture();
    const hostClaimToken = `hostclaim-${crypto.randomUUID()}`;
    const id = await createOcrServerInstance({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, hostId: "host-A", hostClaimToken, runExecutionToken: "run-token-1", mineruHome: "D:/scratch/servers/home-A" });
    expect(id).not.toBeNull();
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken } });
    expect(row.status).toBe("STARTING");
    expect(row.pid).toBeNull();
    expect(row.serverId).toBeNull();
    expect(row.transports).toBeNull();
    expect(validateOcrServerInstanceContract(row)).toEqual([]);
  });

  it("SERVER_RUNNING_REQUIRES_ENDPOINT_IN_SERVICE_VALIDATOR: RUNNING without endpoint identity fails the contract", async () => {
    expect(validateOcrServerInstanceContract({ status: "RUNNING", pid: null, serverId: null, transports: null })).toContain("OCR_SERVER_ENDPOINT_REQUIRED");
    expect(validateOcrServerInstanceContract({ status: "STOPPING", pid: 1, serverId: "s", transports: [] })).toEqual([]);
    expect(validateOcrServerInstanceContract({ status: "STOPPED", pid: null, serverId: null, transports: null })).toEqual([]);
  });

  it("SERVER_OLD_INSTANCE_SURVIVES_NEW_HOST_CLAIM: reclaiming the host lease never overwrites prior instance evidence", async () => {
    const { workspace, document, run } = await createRunFixture();
    const hostId = `host-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const leaseA = (await acquireOcrHostLease(hostId))!;
    const claimA = `hostclaim-${crypto.randomUUID()}`;
    expect(await createOcrServerInstance({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, hostId, hostClaimToken: claimA, runExecutionToken: "runA", mineruHome: "home-A" })).not.toBeNull();
    expect(await recordOcrServerEndpoint({ hostClaimToken: claimA, endpoint: { pid: 111, serverId: "server-A", transports: [{ type: "tcp", base_url: "http://127.0.0.1:15980" }] } })).toBe(true);
    // A's lease expires; B takes over the SAME host capacity row.
    await prisma.$executeRaw`UPDATE "OcrHostLease" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "hostId" = ${hostId}`;
    const leaseB = await acquireOcrHostLease(hostId);
    expect(leaseB).not.toBeNull();
    const claimB = `hostclaim-${crypto.randomUUID()}`;
    expect(await createOcrServerInstance({ workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: run.id, hostId, hostClaimToken: claimB, runExecutionToken: "runB", mineruHome: "home-B" })).not.toBeNull();
    const survivor = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimA } });
    expect(survivor.status).toBe("RUNNING");
    expect(survivor.serverId).toBe("server-A");
    expect(survivor.pid).toBe(111);
    // B's fresh instance starts STARTING; late A may stop only its own row.
    const fresh = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimB } });
    expect(fresh.status).toBe("STARTING");
    expect(await markOcrServerStatus(claimA, "STOPPED", "stale-owner-cleanup")).toBe(true);
    expect((await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimB } })).status).toBe("STARTING");
    expect((await listReconcilableOcrServerInstances(hostId)).map((r) => r.hostClaimToken)).toContain(claimB);
    expect(await releaseOcrHostLease(hostId, leaseB!.claimToken)).toBe(true);
  });
});
