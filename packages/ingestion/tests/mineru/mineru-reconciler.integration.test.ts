import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@ai-cognitive/db";
import type { OcrServerReconcilerInput } from "../../src/mineru/mineru-reconciler.js";
import { acquireOcrHostLease, markOcrServerOrphaned, markOcrServerStartNeverStarted, markOcrServerStopped, markOcrServerStoppedProcessGone, markOcrServerStopping, recordOcrServerEndpoint, reconcileOcrServerInstances, releaseOcrHostLease } from "../../src/index.js";
import { confirmedRecordedProcessGone, recordedProcessAlive } from "../../src/mineru/mineru-process.js";
import { isWithinPath } from "../../src/mineru/mineru-config.js";
import { createRunFixtureHelper } from "../helpers/ocr/reconciler-fixtures.js";

/**
 * RF01 P1-05/P1-06 + RF02 P1-01/P1-02/P1-03 teeth:
 *  - ORPHANED rows are terminal, excluded from automatic discovery, and can
 *    never starve newer actionable rows (batching lives in the DB query);
 *  - every reconciler process action is fenced against the DURABLE DB
 *    endpoint identity (pid+serverId equality with the endpoint file) — the
 *    file alone is untrusted external-process output;
 *  - "proven gone" requires the shared repeated-negative-liveness rule;
 *  - same-image recycled pids and unprovable identities are never killed.
 */

const fakeMineruPath = join(import.meta.dirname, "../helpers/mineru/fake-mineru.mjs");
const tempRoots: string[] = [];
const spawnedPids: number[] = [];
const hostLeaseIds: string[] = [];

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mineru-reconciler-"));
  tempRoots.push(dir);
  return dir;
}

/** Spawns a long-lived node process (a stand-in "server") and returns its pid. */
function spawnLongLivedNode(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    setTimeout(() => resolve(child.pid!), 150);
  });
}

function killRecorded(pid: number): void {
  try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
}

afterEach(async () => {
  for (const pid of spawnedPids) killRecorded(pid);
  spawnedPids.length = 0;
  await createRunFixtureHelper.cleanup();
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
  delete process.env.MINERU_FAKE_STOP_LOG;
  delete process.env.MINERU_FAKE_STOP_MODE;
  delete process.env.MINERU_FAKE_SERVER_START_MODE;
});

afterAll(async () => { await prisma.$disconnect(); });


/**
 * LEGACY row creation for reconciler fixtures: reconciler tests simulate rows
 * left behind by hard crashes of OLDER code versions (pre-RF04 fence), which
 * the reconciler must still handle. Bypasses the live-lease handoff fence on
 * purpose; the production path is the fenced createOcrServerInstance.
 */
async function createLegacyServerRow(input: { workspaceId: string; sourceDocumentId: string; ingestionRunId: string; hostId: string; hostClaimToken: string; runExecutionToken: string; mineruHome: string }): Promise<string | null> {
  const row = await prisma.ocrServerInstance.create({ data: { ...input, status: "STARTING" }, select: { id: true } });
  return row.id;
}

function reconcilerConfig(hostId: string, homeRoot?: string): OcrServerReconcilerInput {
  return { hostId, executable: process.execPath, executableArgs: [fakeMineruPath], stopTimeoutMs: 10_000, homeRoot: homeRoot ?? join(tmpdir(), "no-such-fence-root"), processImagePattern: /node|python/i };
}

/** Creates a lapsed RUNNING row with an endpoint file and MATCHING DB identity. */
async function createLapsedRunningRow(hostId: string, home: string, endpoint: { pid: number; server_id: string }, runToken: string) {
  const fixture = await createRunFixtureHelper.create();
  // LEGACY crash row: pre-dates the live lease (poison may already exist on
  // this host from other orphans) — the reconciler still handles it.
  const claimToken = `hostclaim-${crypto.randomUUID()}`;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ ...endpoint, transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 }));
  await createLegacyServerRow({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: runToken, mineruHome: home });
  expect(await recordOcrServerEndpoint({ hostClaimToken: claimToken, endpoint: { pid: endpoint.pid, serverId: endpoint.server_id, transports: [{ type: "tcp" }] } })).toBe(true);
  // Model the crash: the lease expires after identity was recorded.
  await prisma.$executeRaw`UPDATE "OcrHostLease" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "hostId" = ${hostId}`;
  return { fixture, claimToken };
}

/** Bounded condition poll for filesystem assertions. */
async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** True when the stop log exists AND lists the pid as a targeted stop. */
function logTargetsPid(path: string, pid: number): boolean {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).includes(String(pid));
  } catch {
    return false;
  }
}

describe("same-host OCR server reconciler (RF01 P1-06 + RF02)", () => {
  it("skips rows whose host lease still belongs to a live claim", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const fixture = await createRunFixtureHelper.create();
    // The SKIP path requires durable live ownership: acquire the lease and
    // create the row under its token (modern handoff, crash-simulated by
    // leaving everything RUNNING with a live endpoint identity).
    const lease = (await acquireOcrHostLease(hostId))!;
    const claimToken = lease.claimToken;
    const legacyHome = join(newTempDir(), "home");
    await createLegacyServerRow({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-x", mineruHome: legacyHome });
    const home = join(newTempDir(), "home");
    mkdirSync(home, { recursive: true });
    await recordOcrServerEndpoint({ hostClaimToken: claimToken, endpoint: { pid: 4_000_000, serverId: "s", transports: [{ type: "tcp" }] } });

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, skipped: 1, stopped: 0, orphaned: 0 });
    expect((await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } })).status).toBe("RUNNING");
  });

  it("resolves a lapsed row with no endpoint evidence to ORPHANED without touching anything", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const fixture = await createRunFixtureHelper.create();
    const home = join(newTempDir(), "home");
    mkdirSync(home, { recursive: true });
    const claimToken = `hostclaim-${crypto.randomUUID()}`;
    await createLegacyServerRow({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-y", mineruHome: home });

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, orphaned: 1 });
    expect((await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } })).status).toBe("ORPHANED");
  });

  it("resolves a lapsed row whose DB-matching endpoint process is proven gone to STOPPED", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const home = join(newTempDir(), "home");
    const { claimToken } = await createLapsedRunningRow(hostId, home, { pid: 4_000_001, server_id: "dead-server" }, "run-z");

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, stopped: 1 });
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    expect(row.status).toBe("STOPPED");
    expect(row.terminationReason).toBe("RECONCILER_PROCESS_GONE");
  });

  it("ORPHANED rows are terminal, excluded from discovery, and never starve newer actionable rows (RF02 P1-01)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    // 25 OLD terminal ORPHANED rows (> the 20-row batch)...
    const orphanTokens: string[] = [];
    for (let index = 0; index < 25; index++) {
      const fixture = await createRunFixtureHelper.create();
      const home = join(newTempDir(), `orphan-home-${index}`);
      const claimToken = `hostclaim-${crypto.randomUUID()}`;
      await createLegacyServerRow({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: `run-orphan-${index}`, mineruHome: home });
      orphanTokens.push(claimToken);
      expect(await markOcrServerOrphaned(claimToken, "old-crash")).toBe(true);
    }
    // ...created BEFORE the one newer stale actionable row.
    const home = join(newTempDir(), "home");
    const { claimToken: staleToken } = await createLapsedRunningRow(hostId, home, { pid: 4_000_002, server_id: "starved-server" }, "run-starved");

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    // The DB-batched discovery saw ONLY the actionable row: the 25 terminal
    // ORPHANED rows consumed zero batch capacity.
    expect(result).toMatchObject({ examined: 1, stopped: 1, orphaned: 0 });
    expect((await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: staleToken } })).status).toBe("STOPPED");
    for (const token of orphanTokens) {
      const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: token } });
      expect(row.status).toBe("ORPHANED");
      expect(row.terminationReason).toBe("old-crash");
    }
  });

  it("PID mismatch: DB says pid=A/serverId=X, the endpoint file lures with a live same-image pid=B — B is never stopped or killed, row ORPHANED (RF02 P1-02)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const home = join(newTempDir(), "home");
    // DB identity: pid A (dead), serverId X.
    const { claimToken } = await createLapsedRunningRow(hostId, home, { pid: 4_000_003, server_id: "db-identity" }, "run-pid-mismatch");
    // The endpoint file now lures with a LIVE same-image substitute pid B.
    const substitutePid = await spawnLongLivedNode();
    spawnedPids.push(substitutePid);
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ pid: substitutePid, server_id: "db-identity", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 }));
    const stopLog = join(newTempDir(), "stops.log");
    process.env.MINERU_FAKE_STOP_LOG = stopLog;

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, orphaned: 1 });
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    expect(row.status).toBe("ORPHANED");
    expect(row.terminationReason).toBe("RECONCILER_DB_IDENTITY_MISMATCH");
    // THE SAFETY ASSERTIONS: the substitute is alive; no stop command ever
    // targeted it.
    expect(await recordedProcessAlive(substitutePid, /node|python/i)).toBe(true);
    expect(logTargetsPid(stopLog, substitutePid)).toBe(false);
  });

  it("SERVER_ID mismatch: same pid but a forged serverId in the endpoint file — no process action, row ORPHANED (RF02 P1-02)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const home = join(newTempDir(), "home");
    const substitutePid = await spawnLongLivedNode();
    spawnedPids.push(substitutePid);
    // DB identity: pid = substitute (same), serverId = the TRUE one; the
    // endpoint file's serverId disagrees.
    const { claimToken } = await createLapsedRunningRow(hostId, home, { pid: substitutePid, server_id: "true-server-identity" }, "run-sid-mismatch");
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ pid: substitutePid, server_id: "forged-identity", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 }));
    const stopLog = join(newTempDir(), "stops.log");
    process.env.MINERU_FAKE_STOP_LOG = stopLog;

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, orphaned: 1 });
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    expect(row.status).toBe("ORPHANED");
    expect(row.terminationReason).toBe("RECONCILER_DB_IDENTITY_MISMATCH");
    expect(await recordedProcessAlive(substitutePid, /node|python/i)).toBe(true);
    expect(logTargetsPid(stopLog, substitutePid)).toBe(false);
  });

  it("STARTING rows without a recorded DB identity are never process-actioned on endpoint-file-only evidence (RF02 P1-02)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const fixture = await createRunFixtureHelper.create();
    const home = join(newTempDir(), "home");
    // A STARTING row: startup crashed before recordOcrServerEndpoint; the
    // endpoint FILE alone lures with a live same-image pid.
    const lurePid = await spawnLongLivedNode();
    spawnedPids.push(lurePid);
    const claimToken = `hostclaim-${crypto.randomUUID()}`;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ pid: lurePid, server_id: "unproven", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 }));
    await createLegacyServerRow({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-starting", mineruHome: home });
    const stopLog = join(newTempDir(), "stops.log");
    process.env.MINERU_FAKE_STOP_LOG = stopLog;

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, orphaned: 1 });
    const row = await prisma.ocrServerInstance.findFirstOrThrow({ where: { hostId, status: "ORPHANED" } });
    expect(row.terminationReason).toBe("RECONCILER_START_IDENTITY_UNPROVEN");
    expect(await recordedProcessAlive(lurePid, /node|python/i)).toBe(true);
    expect(logTargetsPid(stopLog, lurePid)).toBe(false);
  });

  it("stops a lapsed row's provable live server when DB and file identities AGREE (creation time predates its endpoint file)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const home = join(newTempDir(), "home");
    // The "server" starts FIRST; its endpoint file is written AFTER — the real
    // world ordering. DB identity is recorded to match.
    const serverPid = await spawnLongLivedNode();
    spawnedPids.push(serverPid);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const fixture = await createRunFixtureHelper.create();
    const lease = (await acquireOcrHostLease(hostId))!;
    const claimToken = lease.claimToken;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ pid: serverPid, server_id: "live-server", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 }));
    await createLegacyServerRow({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-live", mineruHome: home });
    expect(await recordOcrServerEndpoint({ hostClaimToken: claimToken, endpoint: { pid: serverPid, serverId: "live-server", transports: [{ type: "tcp" }] } })).toBe(true);
    // The crash lapses the lease after identity was recorded.
    await prisma.$executeRaw`UPDATE "OcrHostLease" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "hostId" = ${hostId}`;

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, stopped: 1 });
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    expect(row.status).toBe("STOPPED");
    expect(await recordedProcessAlive(serverPid, /node|python/i)).toBe(false);
  });

  it("cleans the retained claim tree ONLY after a proven stop, fenced by homeRoot (RF03 P1-04)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    // A realistic crashed-claim layout under a REAL home root.
    const homeRoot = join(newTempDir(), "home-root");
    const claimDir = join(homeRoot, "run-1", "generation-1", "page-0", "claim-abc");
    const home = join(claimDir, "home");
    const modelsDir = join(newTempDir(), "models");
    mkdirSync(modelsDir, { recursive: true });
    mkdirSync(join(home), { recursive: true });
    mkdirSync(join(claimDir, "input"), { recursive: true });
    mkdirSync(join(claimDir, "output"), { recursive: true });
    writeFileSync(join(claimDir, "input", "input.pdf"), "%PDF-fake source bytes");
    writeFileSync(join(claimDir, "output", "result.md"), "stale ocr output");
    // A NEIGHBOR claim that must survive.
    const neighborDir = join(homeRoot, "run-2", "generation-1", "page-0", "claim-neighbor");
    mkdirSync(join(neighborDir, "home"), { recursive: true });
    writeFileSync(join(neighborDir, "input.marker"), "neighbor data");

    const { claimToken } = await createLapsedRunningRow(hostId, home, { pid: 4_000_004, server_id: "cleanup-server" }, "run-cleanup");
    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId, homeRoot));
    expect(result).toMatchObject({ examined: 1, stopped: 1 });
    expect((await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } })).status).toBe("STOPPED");
    // The whole claim tree (with the source PDF leak) is gone...
    expect(existsSync(claimDir)).toBe(false);
    // ...the neighbor claim and the model root are untouched (bounded poll:
    // Windows existsSync can transiently return false for a fresh directory).
    expect(await waitForCondition(() => existsSync(neighborDir))).toBe(true);
    expect(await waitForCondition(() => existsSync(modelsDir))).toBe(true);
  });

  it("REFUSES cleanup when the durable mineruHome lies outside the configured homeRoot (RF03 P1-04)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    // A claim tree OUTSIDE any plausible fence root.
    const outsideRoot = join(newTempDir(), "outside-root");
    const claimDir = join(outsideRoot, "run-x", "claim-xyz");
    const home = join(claimDir, "home");
    const { claimToken } = await createLapsedRunningRow(hostId, home, { pid: 4_000_005, server_id: "outside-server" }, "run-outside");
    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId, join(newTempDir(), "different-fence-root")));
    expect(result).toMatchObject({ examined: 1, stopped: 1 });
    expect((await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } })).status).toBe("STOPPED");
    // The DB converged, but the fence refused the filesystem cleanup.
    expect(existsSync(claimDir)).toBe(true);
    expect(existsSync(join(claimDir, "home", "doclib.endpoint.json"))).toBe(true);
  });

  it("REFUSES cleanup for a non-application layout shape (<homeRoot>/random/home) (RF04 P2-02)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const homeRoot = join(newTempDir(), "home-root");
    // Durable mineruHome INSIDE the fence root but NOT the app-generated
    // shape: missing generation/page/claim segments.
    const claimDir = join(homeRoot, "random-folder");
    const home = join(claimDir, "home");
    const { claimToken } = await createLapsedRunningRow(hostId, home, { pid: 4_000_007, server_id: "layout-server" }, "run-layout");
    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId, homeRoot));
    expect(result).toMatchObject({ examined: 1, stopped: 1 });
    // DB converged, but the layout fence refused the recursive deletion.
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, "doclib.endpoint.json"))).toBe(true);
    void claimToken;
  });

  it("RF05 ORPHAN_CAS_RACE: the reconciler proves the process gone, an operator ORPHANS the row mid-flight (deterministic seam), the STOPPED CAS loses — evidence preserved, result NOT stopped (RF05 P2-01)", { timeout: 60_000 }, async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const homeRoot = join(newTempDir(), "home-root");
    const claimDir = join(homeRoot, "run-race", "generation-1", "page-1", "claim-race");
    const home = join(claimDir, "home");
    const { claimToken } = await createLapsedRunningRow(hostId, home, { pid: 4_000_100, server_id: "race-server" }, "run-race");
    mkdirSync(join(claimDir, "input"), { recursive: true });
    mkdirSync(join(claimDir, "output"), { recursive: true });
    writeFileSync(join(claimDir, "input", "input.pdf"), "%PDF-forensic source bytes");
    writeFileSync(join(claimDir, "output", "result.md"), "stale output");

    // Deterministic seam: pause the reconciler right before the STOPPED CAS
    // and perform the concurrent actor's ORPHANED transition, then resume.
    const config = reconcilerConfig(hostId, homeRoot);
    config.beforeStoppedCas = async (casRow: { hostClaimToken: string }) => {
      expect(casRow.hostClaimToken).toBe(claimToken);
      await markOcrServerOrphaned(claimToken, "operator-intervention");
    };
    const result = await reconcileOcrServerInstances(config);

    // STOPPED CAS lost; row remains ORPHANED; result is NOT "stopped".
    expect(result).toMatchObject({ examined: 1, stopped: 0, orphaned: 1 });
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    expect(row.status).toBe("ORPHANED");
    // ALL forensic evidence preserved (endpoint + input + output).
    expect(existsSync(join(home, "doclib.endpoint.json"))).toBe(true);
    expect(existsSync(join(claimDir, "input", "input.pdf"))).toBe(true);
    expect(existsSync(join(claimDir, "output", "result.md"))).toBe(true);
  });

  it("RF05 STOPPED_RESIDUE_CLEANUP control: when another authority already committed STOPPED, the reconciler idempotently cleans the remaining claim tree", { timeout: 60_000 }, async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const homeRoot = join(newTempDir(), "home-root");
    const claimDir = join(homeRoot, "run-ctrl", "generation-1", "page-1", "claim-ctrl");
    const home = join(claimDir, "home");
    const { claimToken } = await createLapsedRunningRow(hostId, home, { pid: 4_000_101, server_id: "ctrl-server" }, "run-ctrl");
    mkdirSync(join(claimDir, "input"), { recursive: true });
    writeFileSync(join(claimDir, "input", "input.pdf"), "%PDF-stale source bytes");

    // R2's seam lets R1 (a full prior pass) commit STOPPED + clean first;
    // R2's own CAS then loses and the re-read shows STOPPED -> idempotent
    // follow-through cleanup (no-op here) and an honest "stopped" result.
    const config = reconcilerConfig(hostId, homeRoot);
    config.beforeStoppedCas = async (casRow: { hostClaimToken: string }) => {
      expect(await markOcrServerStoppedProcessGone(casRow.hostClaimToken, "R1_WON")).toBe(true);
    };
    const result = await reconcileOcrServerInstances(config);
    expect(result).toMatchObject({ examined: 1, stopped: 1 });
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    expect(row.status).toBe("STOPPED");
    expect(existsSync(claimDir)).toBe(false);
  });

  it("ORPHANED rows keep their forensic home and are never cleaned (RF02 P1-04/RF03)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const homeRoot = join(newTempDir(), "home-root");
    const claimDir = join(homeRoot, "run-orphan", "claim-orphan");
    const home = join(claimDir, "home");
    const fixture = await createRunFixtureHelper.create();
    const claimToken = `hostclaim-${crypto.randomUUID()}`;
    await createLegacyServerRow({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-orphan", mineruHome: home });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ pid: 4_000_006, server_id: "orphan-server", transports: [], version: 2 }));
    expect(await markOcrServerOrphaned(claimToken, "unproven")).toBe(true);

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId, homeRoot));
    // ORPHANED is terminal: zero discovery, zero cleanup.
    expect(result).toMatchObject({ examined: 0 });
    expect(existsSync(claimDir)).toBe(true);
    expect(existsSync(join(home, "doclib.endpoint.json"))).toBe(true);
  });

  it("keeps the state machine legal for stale late owners (STOPPING only from RUNNING; STOPPED never from free-form STARTING)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const fixture = await createRunFixtureHelper.create();
    const claimToken = `hostclaim-${crypto.randomUUID()}`;
    await createLegacyServerRow({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-state", mineruHome: join(newTempDir(), "home") });
    expect(await markOcrServerStopping(claimToken, "illegal")).toBe(false);
    expect(await markOcrServerStopped(claimToken, "free-form")).toBe(false);
    expect(await markOcrServerStartNeverStarted(claimToken)).toBe(true);
  });
});

describe("confirmedRecordedProcessGone — the shared repeated-negative liveness rule (RF02 P1-03)", () => {
  it("probe #1 negative then probe #2 positive: NOT proven gone (mandatory flaky-probe tooth)", async () => {
    const probes = [false, true];
    const gone = await confirmedRecordedProcessGone(4_000_009, { probe: async () => probes.shift()! });
    expect(gone).toBe(false);
  });

  it("two consecutive negatives prove gone", async () => {
    const probes = [false, false];
    const gone = await confirmedRecordedProcessGone(4_000_010, { probe: async () => probes.shift()!, delayMs: 1 });
    expect(gone).toBe(true);
  });

  it("a positive probe at any observation means not gone", async () => {
    const gone = await confirmedRecordedProcessGone(4_000_011, { probe: async () => true });
    expect(gone).toBe(false);
  });
});
