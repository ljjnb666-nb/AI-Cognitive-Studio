import { spawn } from "node:child_process";
import { prisma } from "@ai-cognitive/db";
import { logger } from "@ai-cognitive/shared";
import { markOcrServerOrphaned, markOcrServerStoppedProcessGone, listReconcilableOcrServerInstances } from "../ocr-durability.js";
import { buildMineruServerArgs } from "./mineru-commands.js";
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
    await markOcrServerStoppedProcessGone(row.hostClaimToken, "RECONCILER_PROCESS_GONE");
    return "stopped";
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
      await markOcrServerStoppedProcessGone(row.hostClaimToken, "RECONCILER_GRACEFUL_STOP");
      return "stopped";
    }
  }
  // Re-prove identity IMMEDIATELY before the force kill (RF01 P1-05).
  if (!(await processPrecedesEndpointEvidence(endpoint!, row.mineruHome, imagePattern))) {
    await markOcrServerOrphaned(row.hostClaimToken, "RECONCILER_IDENTITY_UNPROVABLE");
    return "orphaned";
  }
  const killed = await killByRecordedIdentity(row.pid!);
  if (killed && await awaitEndpointProcessExit(endpoint!, row.mineruHome, imagePattern, 10_000)) {
    await markOcrServerStoppedProcessGone(row.hostClaimToken, "RECONCILER_FORCED_STOP");
    return "stopped";
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
