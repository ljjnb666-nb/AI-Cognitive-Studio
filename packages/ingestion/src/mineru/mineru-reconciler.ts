import { spawn } from "node:child_process";
import { prisma } from "@ai-cognitive/db";
import { logger } from "@ai-cognitive/shared";
import { markOcrServerOrphaned, markOcrServerStoppedProcessGone, listReconcilableOcrServerInstances } from "../ocr-durability.js";
import { buildMineruServerArgs } from "./mineru-commands.js";
import { isWithinPath } from "./mineru-config.js";
import { confirmedRecordedProcessGone, processCreationTime, sleep, spawnBounded } from "./mineru-process.js";
import { processPrecedesEndpointEvidence, readMineruEndpointFile } from "./mineru-server.js";

/**
 * SAME-HOST OCR server reconciler (BOOK-INGESTION-04B-3, RF01 P1-06, RF02
 * P1-01/P1-02/P1-03).
 *
 * A hard worker/process crash skips every finally block: an OcrServerInstance
 * row can stay STARTING/RUNNING while the real MinerU server survives, its
 * host lease expires, and a later claim starts a second server. This
 * reconciler converges such rows using ONLY durable evidence for the
 * CONFIGURED host (never cross-host) and never performs process cleanup it
 * cannot prove:
 *
 *  - discovery: only STARTING/RUNNING/STOPPING rows, batched IN THE DATABASE
 *    (orderBy + take). ORPHANED is a terminal, manual-intervention state and
 *    is deliberately excluded so old orphan rows can never starve newer
 *    actionable rows (RF02 P1-01).
 *  - ownership: a row whose host lease still holds its claimToken (live OR a
 *    run execution that is still live) is left alone — its owner is mid-flight.
 *  - durable-identity fence (RF02 P1-02): the endpoint FILE is untrusted
 *    external-process output. For RUNNING/STOPPING rows a graceful stop or
 *    kill requires the DB row's persisted pid/serverId to be present AND equal
 *    to the endpoint file's. STARTING rows without a recorded DB identity are
 *    never process-actioned on endpoint-file-only evidence.
 *  - liveness (RF02 P1-03): a server is "proven gone" only via the SHARED
 *    confirmedRecordedProcessGone helper (two consecutive negative probes) —
 *    the same rule the live session uses; a single empty tasklist result
 *    resolves ORPHANED, never STOPPED.
 *  - live-identity: cleanup only under the necessary RF01 P1-05 evidence
 *    (image class + a creation time that PREDATES the endpoint file the
 *    server itself wrote), graceful stop first, guarded kill second.
 *
 * No process-name sweeps, no port-only ownership, no kill-all-python, ever.
 */

export type OcrServerReconciliationResult = { examined: number; stopped: number; orphaned: number; skipped: number };

export type OcrServerReconcilerInput = {
  hostId: string;
  executable: string;
  executableArgs: string[];
  stopTimeoutMs: number;
  /** Configured per-claim temp home root (RF03 P1-04): the fence every cleanup target must live inside. */
  homeRoot: string;
  /** Upper bound on rows examined per sweep (enforced inside the DB query). */
  batchSize?: number;
  processImagePattern?: RegExp;
};

export async function reconcileOcrServerInstances(input: OcrServerReconcilerInput): Promise<OcrServerReconciliationResult> {
  const rows = await listReconcilableOcrServerInstances(input.hostId, input.batchSize ?? 20);
  const result: OcrServerReconciliationResult = { examined: rows.length, stopped: 0, orphaned: 0, skipped: 0 };
  for (const row of rows) {
    try {
      const disposition = await reconcileRow(row, input);
      if (disposition === "skipped") result.skipped += 1;
      else if (disposition === "stopped") result.stopped += 1;
      else result.orphaned += 1;
    } catch (error) {
      result.skipped += 1;
      logger.warn("mineru.reconciler.row_error", { hostId: input.hostId, serverInstanceId: row.id, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
  }
  if (result.examined > 0) logger.info("mineru.reconciler.sweep", { hostId: input.hostId, ...result });
  return result;
}

/**
 * RF03 P1-04: after a PROVEN stop, the claim tree retained by a hard crash
 * (home/ + input/input.pdf + output/*) is an unbounded disk + source-data
 * leak. Cleanup happens ONLY when every safety gate holds:
 *  - the converged row's durable mineruHome is the ONLY path input;
 *  - it points at the application-generated layout "<claim>/home";
 *  - the whole claim tree lives INSIDE the configured homeRoot (so the shared
 *    model root and anything outside the per-claim temp tree can never match);
 *  - the claim directory is removed as one unit — never another claim, never
 *    ORPHANED rows (their callers never reach cleanup), and if the path fence
 *    cannot be proven the data is left in place with a stable warning.
 */
async function cleanupRetainedClaimData(mineruHome: string, input: OcrServerReconcilerInput): Promise<void> {
  try {
    const { basename, dirname, sep } = await import("node:path");
    const { lstat, rm } = await import("node:fs/promises");
    // RF04 P2-02: the ONLY deletable shape is the application-generated
    // layout, validated segment by segment (case-insensitive containment on
    // Windows via isWithinPath):
    //   <homeRoot>/<runId>/generation-<int>/page-<int>/claim-<suffix>/home
    // Arbitrary DB text like "<homeRoot>/random-folder/home" is refused.
    if (!isWithinPath(mineruHome, input.homeRoot) || basename(mineruHome) !== "home") {
      logger.warn("mineru.reconciler.cleanup_refused", { reason: "PATH_FENCE_FAILED", mineruHome });
      return;
    }
    const claimDir = dirname(mineruHome);
    const segments = claimDir.slice(input.homeRoot.length).split(sep).filter((segment) => segment.length > 0);
    const layoutValid = segments.length === 4
      && segments[0]!.length > 0
      && /^generation-[0-9]+$/.test(segments[1]!)
      && /^page-[0-9]+$/.test(segments[2]!)
      && /^claim-.+$/.test(segments[3]!);
    if (!layoutValid || !isWithinPath(claimDir, input.homeRoot) || claimDir === input.homeRoot) {
      logger.warn("mineru.reconciler.cleanup_refused", { reason: "PATH_FENCE_FAILED", mineruHome });
      return;
    }
    // Junction/reparse surprise guard: refuse to recurse through anything
    // that is not a real directory at the deletion root.
    const claimStat = await lstat(claimDir).catch(() => null);
    if (claimStat === null || claimStat.isSymbolicLink() || !claimStat.isDirectory()) {
      logger.warn("mineru.reconciler.cleanup_refused", { reason: "CLAIM_ROOT_NOT_REAL_DIRECTORY", mineruHome });
      return;
    }
    // Bounded retries: Windows can transiently hold a just-touched directory
    // (AV/indexer scans); a refused cleanup would silently leak the claim.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await rm(claimDir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(200);
      }
    }
    if (lastError !== null) throw lastError;
  } catch (error) {
    logger.warn("mineru.reconciler.cleanup_refused", { reason: "CLEANUP_IO_FAILED", mineruHome, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
  }
}

/**
 * RF04 P1-03: cleanup is authorized ONLY by the durable STOPPED commit. The
 * CAS can legitimately lose (another reconciler/manual action moved the row
 * to ORPHANED first); when it does, the row is RE-READ and cleanup proceeds
 * only if the durable current state is STOPPED for this same instance.
 * ORPHANED rows keep their forensic evidence — never cleaned.
 */
async function convergeStoppedAndCleanup(row: { hostClaimToken: string; mineruHome: string }, reason: string, input: OcrServerReconcilerInput): Promise<boolean> {
  const committed = await markOcrServerStoppedProcessGone(row.hostClaimToken, reason);
  if (!committed) {
    const current = await prisma.ocrServerInstance.findUnique({ where: { hostClaimToken: row.hostClaimToken }, select: { status: true, pid: true, serverId: true } });
    if (current?.status !== "STOPPED") {
      logger.warn("mineru.reconciler.cleanup_refused", { reason: "STOPPED_COMMIT_LOST", currentStatus: current?.status ?? "missing", hostClaimToken: row.hostClaimToken });
      return false;
    }
    // Another authority already committed STOPPED for this same instance.
    return true;
  }
  await cleanupRetainedClaimData(row.mineruHome, input);
  return true;
}

async function reconcileRow(row: { id: string; hostClaimToken: string; runExecutionToken: string; mineruHome: string; pid: number | null; serverId: string | null; status: string }, input: OcrServerReconcilerInput): Promise<"skipped" | "stopped" | "orphaned"> {
  // Ownership evidence 1: the host lease still belongs to this claim.
  const lease = await prisma.ocrHostLease.findUnique({ where: { hostId: input.hostId }, select: { claimToken: true, leaseUntil: true } });
  const leaseHeldByThisClaim = lease?.claimToken === row.hostClaimToken;
  if (leaseHeldByThisClaim && lease!.leaseUntil !== null && lease!.leaseUntil.getTime() > Date.now()) return "skipped";
  if (leaseHeldByThisClaim) {
    // Ownership evidence 2: the lease expired but a LIVE run execution with
    // this row's token may still be mid-cleanup — never race a live owner.
    const liveExecution = await prisma.ingestionRun.findFirst({ where: { executionClaimToken: row.runExecutionToken, status: "RUNNING", executionLeaseUntil: { gt: new Date() } }, select: { id: true } });
    if (liveExecution) return "skipped";
  }

  const imagePattern = input.processImagePattern ?? /python/i;
  const endpoint = await readMineruEndpointFile(row.mineruHome);

  // RF02 P1-02 durable-identity fence: the endpoint file is UNTRUSTED
  // external-process output. Any process action (graceful stop OR kill)
  // requires the DURABLE DB identity to exist and to EQUAL the file's.
  // STARTING rows legitimately lack DB identity — endpoint-file-only
  // evidence is never promoted into authoritative identity.
  const dbIdentityPresent = row.pid !== null && row.serverId !== null;
  const identitiesAgree = dbIdentityPresent && endpoint !== null && endpoint.pid === row.pid && endpoint.serverId === row.serverId;
  if (!identitiesAgree) {
    // A live same-image process that the DB cannot vouch for is NEVER
    // stopped or killed; the row becomes terminal ORPHANED evidence and the
    // claim home keeps its forensic state.
    await markOcrServerOrphaned(row.hostClaimToken, dbIdentityPresent ? "RECONCILER_DB_IDENTITY_MISMATCH" : "RECONCILER_START_IDENTITY_UNPROVEN");
    return "orphaned";
  }

  // Proven gone: the SHARED conservative rule (two consecutive negatives).
  if (await confirmedRecordedProcessGone(row.pid!, { expectedImagePattern: imagePattern })) {
    if (await convergeStoppedAndCleanup(row, "RECONCILER_PROCESS_GONE", input)) return "stopped";
    return "orphaned";
  }

  // Live process: cleanup ONLY under the necessary cross-restart identity
  // evidence (creation time predates the endpoint file the server wrote).
  if (!(await processPrecedesEndpointEvidence(endpoint!, row.mineruHome, imagePattern))) {
    await markOcrServerOrphaned(row.hostClaimToken, "RECONCILER_IDENTITY_UNPROVABLE");
    return "orphaned";
  }
  const stopEnv: NodeJS.ProcessEnv = { ...process.env, MINERU_HOME: row.mineruHome };
  const stopResult = await spawnBounded(input.executable, [...input.executableArgs, ...buildMineruServerArgs("stop")], { env: stopEnv, cwd: row.mineruHome, timeoutMs: input.stopTimeoutMs, maxOutputBytes: 1_048_576 });
  if (stopResult.spawnErrorCode !== "ENOENT") {
    if (await awaitEndpointProcessExit(endpoint!, row.mineruHome, imagePattern, 10_000)) {
      if (await convergeStoppedAndCleanup(row, "RECONCILER_GRACEFUL_STOP", input)) return "stopped";
      return "orphaned";
    }
  }
  // Re-prove identity IMMEDIATELY before the force kill (RF01 P1-05).
  if (!(await processPrecedesEndpointEvidence(endpoint!, row.mineruHome, imagePattern))) {
    await markOcrServerOrphaned(row.hostClaimToken, "RECONCILER_IDENTITY_UNPROVABLE");
    return "orphaned";
  }
  const killed = await killByRecordedIdentity(row.pid!);
  if (killed && await awaitEndpointProcessExit(endpoint!, row.mineruHome, imagePattern, 10_000)) {
    if (await convergeStoppedAndCleanup(row, "RECONCILER_FORCED_STOP", input)) return "stopped";
    return "orphaned";
  }
  await markOcrServerOrphaned(row.hostClaimToken, killed ? "RECONCILER_KILL_UNCONFIRMED" : "RECONCILER_KILL_REFUSED");
  return "orphaned";
}

async function awaitEndpointProcessExit(endpoint: { pid: number }, mineruHome: string, imagePattern: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await confirmedRecordedProcessGone(endpoint.pid, { expectedImagePattern: imagePattern, delayMs: 250 })) return true;
    // A live pid created after the endpoint file is a recycled pid — the
    // recorded server is gone either way.
    const creation = await processCreationTime(endpoint.pid);
    const evidence = await endpointMtime(mineruHome);
    if (creation !== null && evidence !== null && creation > evidence) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

async function endpointMtime(mineruHome: string): Promise<number | null> {
  try {
    const { stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    return (await stat(join(mineruHome, "doclib.endpoint.json"))).mtimeMs;
  } catch {
    return null;
  }
}

/** Windows argv-only tree kill of the recorded pid (identity verified by the caller). */
async function killByRecordedIdentity(pid: number): Promise<boolean> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = process.platform === "win32" ? spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }) : spawn("kill", ["-9", String(pid)], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 10_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
