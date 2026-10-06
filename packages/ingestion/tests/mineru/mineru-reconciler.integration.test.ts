import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@ai-cognitive/db";
import { acquireOcrHostLease, createOcrServerInstance, createMineruServerSession, markOcrServerStopped, markOcrServerStopping, processPrecedesEndpointEvidence, readMineruEndpointFile, recordOcrServerEndpoint, reconcileOcrServerInstances, releaseOcrHostLease } from "../../src/index.js";
import { recordedProcessAlive } from "../../src/mineru/mineru-process.js";
import { createRunFixtureHelper } from "../helpers/ocr/reconciler-fixtures.js";

/**
 * RF01 P1-05/P1-06 teeth:
 *  - the same-host reconciler converges rows left by hard crashes, cleans ONLY
 *    provable processes on the CONFIGURED host, skips live owners, refuses
 *    same-image recycled pids, and never uses process-name sweeps;
 *  - a server session that never captured a live creation-time fingerprint has
 *    NO identity evidence and must NOT force-kill a same-image pid substitute.
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
    // Give the process a moment to register; creation time evidence is read later.
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
});

afterAll(async () => { await prisma.$disconnect(); });

function reconcilerConfig(hostId: string) {
  return { hostId, executable: process.execPath, executableArgs: [fakeMineruPath], stopTimeoutMs: 10_000, processImagePattern: /node|python/i };
}

describe("same-host OCR server reconciler (RF01 P1-06)", () => {
  it("skips rows whose host lease still belongs to a live claim", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const lease = (await acquireOcrHostLease(hostId))!;
    const fixture = await createRunFixtureHelper.create();
    // The row's hostClaimToken MUST be the live lease's actual token.
    const claimToken = lease.claimToken;
    const home = join(newTempDir(), "home");
    mkdirSync(home, { recursive: true });
    await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-x", mineruHome: home });
    await recordOcrServerEndpoint({ hostClaimToken: claimToken, endpoint: { pid: 4_000_000, serverId: "s", transports: [{ type: "tcp" }] } });

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, skipped: 1, stopped: 0, orphaned: 0 });
    expect((await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } })).status).toBe("RUNNING");
    await releaseOcrHostLease(hostId, lease.claimToken);
  });

  it("resolves a lapsed row with no endpoint evidence to ORPHANED without touching anything", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const fixture = await createRunFixtureHelper.create();
    const claimToken = `hostclaim-${crypto.randomUUID()}`;
    const home = join(newTempDir(), "home");
    mkdirSync(home, { recursive: true });
    await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-y", mineruHome: home });

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, orphaned: 1 });
    expect((await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } })).status).toBe("ORPHANED");
  });

  it("resolves a lapsed row whose endpoint process is proven dead to STOPPED", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const fixture = await createRunFixtureHelper.create();
    const claimToken = `hostclaim-${crypto.randomUUID()}`;
    const home = join(newTempDir(), "home");
    mkdirSync(home, { recursive: true });
    const endpoint = { pid: 4_000_001, server_id: "dead-server", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 };
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify(endpoint));
    await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-z", mineruHome: home });

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    console.log("ROW_DEBUG", JSON.stringify(row), JSON.stringify(result));
    expect(result).toMatchObject({ examined: 1, stopped: 1 });
    expect(row.status).toBe("STOPPED");
    expect(row.terminationReason).toBe("RECONCILER_PROCESS_GONE");
  });

  it("MUST NOT kill a same-image pid it cannot prove (recycled pid created AFTER the endpoint file) and marks the row ORPHANED", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const fixture = await createRunFixtureHelper.create();
    const claimToken = `hostclaim-${crypto.randomUUID()}`;
    const home = join(newTempDir(), "home");
    mkdirSync(home, { recursive: true });
    // Model the real recycled-pid world: the ORIGINAL server wrote the endpoint
    // at T1 and died; an unrelated same-image process was born at T3 > T1 and
    // now owns the pid. The substitute is spawned first, then the endpoint is
    // written and its mtime BACKDATED to before the substitute's creation —
    // exactly the stale-endpoint state a crash leaves behind.
    const substitutePid = await spawnLongLivedNode();
    spawnedPids.push(substitutePid);
    const substituteSpawnWallClock = Date.now();
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ pid: substitutePid, server_id: "stale-identity", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 }));
    utimesSync(join(home, "doclib.endpoint.json"), new Date(substituteSpawnWallClock - 2_000), new Date(substituteSpawnWallClock - 2_000));
    await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-recycled", mineruHome: home });

    // Sanity: the necessary evidence itself must FAIL for this substitute.
    const endpointEvidence = await readMineruEndpointFile(home);
    expect(endpointEvidence).not.toBeNull();
    expect(await processPrecedesEndpointEvidence(endpointEvidence!, home, /node|python/i)).toBe(false);

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    expect(result).toMatchObject({ examined: 1, orphaned: 1 });
    // THE SAFETY ASSERTION: the substitute process is still alive.
        expect(await recordedProcessAlive(substitutePid, /node/i)).toBe(true);
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    expect(row.status).toBe("ORPHANED");
    expect(row.terminationReason).toBe("RECONCILER_IDENTITY_UNPROVABLE");
  });

  it("stops a lapsed row's provable live server (creation time predates its endpoint file)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const fixture = await createRunFixtureHelper.create();
    const claimToken = `hostclaim-${crypto.randomUUID()}`;
    const home = join(newTempDir(), "home");
    mkdirSync(home, { recursive: true });
    // The "server" starts FIRST; its endpoint file is written AFTER by itself —
    // exactly the real world ordering the necessary evidence models.
    const serverPid = await spawnLongLivedNode();
    spawnedPids.push(serverPid);
    await new Promise((resolve) => setTimeout(resolve, 120));
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ pid: serverPid, server_id: "live-server", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 }));
    await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-live", mineruHome: home });

    const result = await reconcileOcrServerInstances(reconcilerConfig(hostId));
    const row = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: claimToken } });
    console.log("ROW_DEBUG_LIVE", JSON.stringify(row), JSON.stringify(result));
    expect(result).toMatchObject({ examined: 1, stopped: 1 });
    expect(row.status).toBe("STOPPED");
    expect(await recordedProcessAlive(serverPid, /node/i)).toBe(false);
  });
});

describe("server session force-kill identity gate (RF01 P1-05)", () => {
  it("refuses to force-kill a same-image substitute when the session never captured a live fingerprint", async () => {
    const home = join(newTempDir(), "crafted-home");
    mkdirSync(home, { recursive: true });
    const substitutePid = await spawnLongLivedNode();
    spawnedPids.push(substitutePid);
    // A fabricated/stale endpoint pointing at a live same-image process the
    // session never started: no captured fingerprint exists.
    writeFileSync(join(home, "doclib.endpoint.json"), JSON.stringify({ pid: substitutePid, server_id: "fabricated", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 }));
    const session = await createMineruServerSession({
      executable: process.execPath,
      executableArgs: [fakeMineruPath],
      homeDir: home,
      childEnvBase: { ...process.env, MINERU_HOME: home },
      startTimeoutMs: 5_000,
      stopTimeoutMs: 5_000,
      maxOutputBytes: 65_536,
      processImagePattern: /node|python/i,
      // The abort skips the graceful stop and goes straight to the guarded kill.
      abortSignal: AbortSignal.abort(),
    });
    expect(session.endpoint).toBeNull();
    const disposition = await session.stop();
    expect(disposition).toEqual({ kind: "ORPHAN_SUSPECT", reason: "IDENTITY_NOT_CAPTURED" });
    // THE SAFETY ASSERTION: the substitute is still alive.
        expect(await recordedProcessAlive(substitutePid, /node/i)).toBe(true);
  });

  it("keeps the state machine legal for stale late owners (STOPPING only from RUNNING)", async () => {
    const hostId = `reconciler-${crypto.randomUUID()}`;
    hostLeaseIds.push(hostId);
    const fixture = await createRunFixtureHelper.create();
    const claimToken = `hostclaim-${crypto.randomUUID()}`;
    await createOcrServerInstance({ workspaceId: fixture.workspaceId, sourceDocumentId: fixture.documentId, ingestionRunId: fixture.runId, hostId, hostClaimToken: claimToken, runExecutionToken: "run-state", mineruHome: join(newTempDir(), "home") });
    // STARTING -> STOPPED directly is the proven never-started cleanup path;
    // STARTING -> STOPPING is not expressible.
    expect(await markOcrServerStopping(claimToken, "illegal")).toBe(false);
    expect(await markOcrServerStopped(claimToken, "START_FAILED_NO_ENDPOINT")).toBe(true);
  });
});
