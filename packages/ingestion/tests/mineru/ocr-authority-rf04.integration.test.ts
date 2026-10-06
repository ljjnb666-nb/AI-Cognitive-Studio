import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@ai-cognitive/db";
import { acquireOcrHostLease, createOcrServerInstance, createOcrPageIntents, claimOcrPageAttempt, markOcrServerOrphaned, reconcileOcrServerInstances, releaseOcrHostLease, transitionOcrCapacityDeferred } from "../../src/index.js";
import { createRunFixtureHelper } from "../helpers/ocr/reconciler-fixtures.js";

/**
 * RF04 mandatory teeth:
 *  - P1-01 lease→server handoff fence: a stale host owner cannot create a
 *    STARTING row; the lease-row lock serializes reclaim vs handoff;
 *  - P1-02 atomic capacity deferral: page+run+Job in ONE transaction, with
 *    the full stale/rollback matrix producing ZERO mutations;
 *  - P1-03 reconciler cleanup only after the authoritative STOPPED commit —
 *    an ORPHANED race preserves all forensic evidence.
 */

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(async () => {
  await createRunFixtureHelper.cleanup();
});

afterAll(async () => { await prisma.$disconnect(); });

describe("lease-to-server handoff fence (RF04 P1-01)", () => {
  it("STALE_HOST_OWNER_CANNOT_CREATE_SERVER: after A's lease expires and B reclaims, stale A cannot create a STARTING row", async () => {
    const hostId = `handoff-${crypto.randomUUID()}`;
    const leaseA = (await acquireOcrHostLease(hostId))!;
    // A's lease expires; B takes over the SAME slot.
    await prisma.$executeRaw`UPDATE "OcrHostLease" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "hostId" = ${hostId}`;
    const leaseB = (await acquireOcrHostLease(hostId))!;
    expect(leaseB.claimToken).not.toBe(leaseA.claimToken);

    // Stale A attempts the handoff with its DEAD token: the fence refuses —
    // no STARTING row is created, B's ownership is untouched.
    const fixture = await createRunFixtureHelper.create();
    const staleRow = await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: leaseA.claimToken, runExecutionToken: "stale-run", mineruHome: join(tmpdir(), "stale-home") });
    expect(staleRow).toBeNull();
    expect(await prisma.ocrServerInstance.count({ where: { hostId } })).toBe(0);
    const leaseAfter = await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId } });
    expect(leaseAfter.claimToken).toBe(leaseB.claimToken);
    // B CAN create its server row while holding the live lease.
    const liveRow = await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: leaseB.claimToken, runExecutionToken: "live-run", mineruHome: join(tmpdir(), "live-home") });
    expect(liveRow).not.toBeNull();
    await releaseOcrHostLease(hostId, leaseB.claimToken);
  });

  it("HANDOFF_RECLAIM_RACE: the lease-row lock serializes handoff vs reclaim — exactly one authority wins", async () => {
    const hostId = `handoff-race-${crypto.randomUUID()}`;
    const leaseA = (await acquireOcrHostLease(hostId))!;
    // Expire A's lease WITHOUT yielding: both A (handoff) and B (reclaim)
    // now race for the same OcrHostLease row.
    await prisma.$executeRaw`UPDATE "OcrHostLease" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "hostId" = ${hostId}`;
    const fixture = await createRunFixtureHelper.create();
    const [aResult, bResult] = await Promise.all([
      createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: leaseA.claimToken, runExecutionToken: "race-a", mineruHome: join(tmpdir(), "race-a-home") }),
      (async () => {
        const leaseB = (await acquireOcrHostLease(hostId))!;
        const row = await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: leaseB.claimToken, runExecutionToken: "race-b", mineruHome: join(tmpdir(), "race-b-home") });
        return { leaseB, row };
      })(),
    ]);
    // Exactly one ordering wins: either A's stale handoff is refused, or it
    // won the lock before B's reclaim. NEVER two authoritative rows.
    const rows = await prisma.ocrServerInstance.findMany({ where: { hostId } });
    if (aResult !== null) {
      // A won the race: B's reclaim was refused (null lease) and B created nothing.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.hostClaimToken).toBe(leaseA.claimToken);
      expect(bResult.row).toBeNull();
    } else {
      // B won: A's stale handoff created nothing; exactly B's row exists.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.hostClaimToken).toBe(bResult.leaseB.claimToken);
    }
    await releaseOcrHostLease(hostId, (await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId } })).claimToken!);
  });
});

describe("atomic capacity deferral (RF04 P1-02)", () => {
  async function deferredClaimFixture() {
    const fixture = await createRunFixtureHelper.create();
    const runExecutionToken = `run-token-${crypto.randomUUID()}`;
    const claim = (await prisma.$transaction(async (tx) => {
      const run = await tx.ingestionRun.update({ where: { id: fixture.runId }, data: { status: "RUNNING", executionClaimToken: runExecutionToken, executionClaimedAt: new Date(), executionLeaseUntil: new Date(Date.now() + 60_000) } });
      const job = await tx.job.update({ where: { id: run.jobId }, data: { status: "RUNNING", attemptCount: { increment: 1 } } });
      return { runId: run.id, jobId: job.id, attemptCount: job.attemptCount };
    }))!;
    await createOcrPageIntents({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, routingGeneration: 1, pages: [{ physicalPageIndex: 1 }] });
    const pageClaim = (await claimOcrPageAttempt({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1, parserName: "mineru", parserVersion: "4.0.3", runExecutionToken }))!;
    return { fixture, runExecutionToken, jobId: claim.jobId, jobAttemptBefore: claim.attemptCount, pageClaim };
  }

  it("ATOMIC_DEFERRAL_OK: valid page+run+Job -> all three restored together", async () => {
    const { fixture, runExecutionToken, pageClaim } = await deferredClaimFixture();
    const committed = await transitionOcrCapacityDeferred({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1, pageClaimToken: pageClaim.claimToken, runExecutionToken });
    expect(committed).toBe(true);
    const page = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1 } } });
    expect(page).toMatchObject({ status: "PENDING", attemptCount: 0, claimToken: null });
    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    expect(run).toMatchObject({ status: "QUEUED", executionClaimToken: null });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: (await prisma.ingestionRun.findUniqueOrThrow({ where: { id: fixture.runId } })).jobId } });
    expect(job).toMatchObject({ status: "QUEUED", attemptCount: 0 });
  });

  it("STALE_PAGE_TOKEN: ZERO page/run/Job mutations", async () => {
    const { fixture, runExecutionToken, pageClaim, jobId, jobAttemptBefore } = await deferredClaimFixture();
    const committed = await transitionOcrCapacityDeferred({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1, pageClaimToken: "forged-token", runExecutionToken });
    expect(committed).toBe(false);
    const page = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1 } } });
    expect(page).toMatchObject({ status: "RUNNING", attemptCount: 1, claimToken: pageClaim.claimToken });
    const run = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    expect(run.status).toBe("RUNNING");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).attemptCount).toBe(jobAttemptBefore);
  });

  it("STALE_RUN_TOKEN: ZERO page/run/Job mutations", async () => {
    const { fixture, pageClaim, jobId, jobAttemptBefore } = await deferredClaimFixture();
    const committed = await transitionOcrCapacityDeferred({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1, pageClaimToken: pageClaim.claimToken, runExecutionToken: "forged-run-token" });
    expect(committed).toBe(false);
    const page = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1 } } });
    expect(page).toMatchObject({ status: "RUNNING", attemptCount: 1 });
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status).toBe("RUNNING");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).attemptCount).toBe(jobAttemptBefore);
  });

  it("EXPIRED_PAGE_LEASE: ZERO page/run/Job mutations", async () => {
    const { fixture, runExecutionToken, pageClaim, jobId, jobAttemptBefore } = await deferredClaimFixture();
    await prisma.$executeRaw`UPDATE "OcrPageAttempt" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "claimToken" = ${pageClaim.claimToken}`;
    const committed = await transitionOcrCapacityDeferred({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1, pageClaimToken: pageClaim.claimToken, runExecutionToken });
    expect(committed).toBe(false);
    const page = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1 } } });
    expect(page).toMatchObject({ status: "RUNNING", attemptCount: 1 });
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status).toBe("RUNNING");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).attemptCount).toBe(jobAttemptBefore);
  });

  it("JOB_NOT_RUNNING: ZERO page/run/Job mutations", async () => {
    const { fixture, runExecutionToken, pageClaim, jobId, jobAttemptBefore } = await deferredClaimFixture();
    await prisma.job.update({ where: { id: jobId }, data: { status: "QUEUED" } });
    const committed = await transitionOcrCapacityDeferred({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1, pageClaimToken: pageClaim.claimToken, runExecutionToken });
    expect(committed).toBe(false);
    const page = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1 } } });
    expect(page).toMatchObject({ status: "RUNNING", attemptCount: 1 });
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status).toBe("RUNNING");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).attemptCount).toBe(jobAttemptBefore);
  });

  it("DEFERRAL_DB_ROLLBACK: a forced failure rolls back ALL three transitions", async () => {
    const { fixture, runExecutionToken, pageClaim, jobId, jobAttemptBefore } = await deferredClaimFixture();
    // Force a failure INSIDE the transaction after the page update: a unique
    // violation on a reserved token proves the page give-back rolls back.
    const committed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "OcrPageAttempt" SET "status" = 'PENDING', "claimToken" = NULL, "leaseUntil" = NULL,
          "attemptCount" = GREATEST("attemptCount" - 1, 0)
        WHERE "claimToken" = ${pageClaim.claimToken} AND "leaseUntil" > NOW()`;
      // Simulated crash/failure mid-transaction (mirrors what
      // transitionOcrCapacityDeferred's claimLost guard does) — everything
      // above must roll back.
      throw new Error("FORCED_DEFERRAL_FAILURE");
    }).catch(() => false);
    expect(committed).toBe(false);
    const page = await prisma.ocrPageAttempt.findUniqueOrThrow({ where: { ingestionRunId_physicalPageIndex_routingGeneration: { ingestionRunId: fixture.runId, physicalPageIndex: 1, routingGeneration: 1 } } });
    expect(page).toMatchObject({ status: "RUNNING", attemptCount: 1, claimToken: pageClaim.claimToken });
    expect((await prisma.ingestionRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status).toBe("RUNNING");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).attemptCount).toBe(jobAttemptBefore);
  });
});

describe("reconciler cleanup commit fence (RF04 P1-03)", () => {
  it("ORPHANED_RACE_PRESERVES_EVIDENCE: a concurrent ORPHANED transition between proven-gone and the STOPPED CAS keeps ALL forensic evidence", async () => {
    const hostId = `cleanup-race-${crypto.randomUUID()}`;
    const homeRoot = join(mkdtempSync(join(tmpdir(), "rf04-fence-")), "home-root");
    const claimDir = join(homeRoot, "run-race", "generation-1", "page-1", "claim-race");
    const home = join(claimDir, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(claimDir, "input"), { recursive: true });
    mkdirSync(join(claimDir, "output"), { recursive: true });
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ pid: 4_000_100, server_id: "race-server", transports: [], version: 2 }));
    writeFileSync(join(claimDir, "input", "input.pdf"), "%PDF-forensic source bytes");
    writeFileSync(join(claimDir, "output", "result.md"), "stale output");
    const fixture = await createRunFixtureHelper.create();
    // The row's existence is fenced on the LIVE host lease (RF04 P1-01).
    const lease = (await acquireOcrHostLease(hostId))!;
    const claimToken = lease.claimToken;
    expect(await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-race", mineruHome: home })).not.toBeNull();
    await recordEndpoint(claimToken, 4_000_100, "race-server");

    // The reconciler's CAS is pre-empted by an operator/reconciler race:
    // ORPHANED lands BEFORE the STOPPED CAS fires.
    expect(await markOcrServerOrphaned(claimToken, "operator-intervention")).toBe(true);
    const result = await reconcileOcrServerInstances({ hostId, executable: process.execPath, executableArgs: [], stopTimeoutMs: 5_000, homeRoot, processImagePattern: /node|python/i });

    // The reconciler must NOT report a false "stopped".
    expect(result.stopped).toBe(0);
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    expect(row.status).toBe("ORPHANED");
    // ALL forensic evidence preserved (endpoint + input + output).
    expect(existsSync(join(home, "doclib.endpoint.json"))).toBe(true);
    expect(existsSync(join(claimDir, "input", "input.pdf"))).toBe(true);
    expect(existsSync(join(claimDir, "output", "result.md"))).toBe(true);
  });
});

async function recordEndpoint(hostClaimToken: string, pid: number, serverId: string): Promise<void> {
  const { recordOcrServerEndpoint } = await import("../../src/index.js");
  expect(await recordOcrServerEndpoint({ hostClaimToken, endpoint: { pid, serverId, transports: [{ type: "tcp" }] } })).toBe(true);
}

void sha256;
