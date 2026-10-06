import { spawn } from "node:child_process";
import { prisma } from "@ai-cognitive/db";
import { logger } from "@ai-cognitive/shared";
import { markOcrServerOrphaned, markOcrServerStopped, listReconcilableOcrServerInstances } from "../ocr-durability.js";
import { buildMineruServerArgs } from "./mineru-commands.js";
import { processCreationTime, recordedProcessAlive, sleep, spawnBounded } from "./mineru-process.js";
import { processPrecedesEndpointEvidence, readMineruEndpointFile } from "./mineru-server.js";

/**
 * SAME-HOST OCR server reconciler (BOOK-INGESTION-04B-3 RF01 P1-06).
 *
 * A hard worker/process crash skips every finally block: an OcrServerInstance
 * row can stay STARTING/RUNNING while the real MinerU server survives, its
 * host lease expires, and a later claim starts a second server. This
 * reconciler converges such rows using ONLY durable evidence for the
 * CONFIGURED host (never cross-host) and never performs process cleanup it
 * cannot prove:
 *
 *  - ownership: a row whose host lease still holds its claimToken (live OR a
 *    run execution that is still live) is left alone — its owner is mid-flight.
 *  - a lapsed row with NO endpoint file is resolved ORPHANED (nothing
 *    provable to clean).
 *  - a lapsed row whose endpoint process is proven DEAD resolves STOPPED.
 *  - a lapsed row with a live endpoint process is cleaned ONLY under the
 *    necessary live-identity evidence of RF01 P1-05 (pid+serverId from the
 *    claim's own endpoint file, image class, and a creation time that
 *    PREDATES the endpoint file the server itself wrote): graceful stop
 *    first, guarded kill second, ORPHANED whenever identity is unprovable —
 *    a same-image recycled pid is NEVER killed.
 *
 * No process-name sweeps, no port-only ownership, no kill-all-python, ever.
 */

export type OcrServerReconciliationResult = { examined: number; stopped: number; orphaned: number; skipped: number };

export type OcrServerReconcilerInput = {
  hostId: string;
  executable: string;
  executableArgs: string[];
  stopTimeoutMs: number;
  /** Upper bound on rows examined per sweep (bounded work per tick). */
  batchSize?: number;
  processImagePattern?: RegExp;
};

export async function reconcileOcrServerInstances(input: OcrServerReconcilerInput): Promise<OcrServerReconciliationResult> {
  const rows = await listReconcilableOcrServerInstances(input.hostId);
  const result: OcrServerReconciliationResult = { examined: 0, stopped: 0, orphaned: 0, skipped: 0 };
  for (const row of rows.slice(0, input.batchSize ?? 20)) {
    result.examined += 1;
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

async function reconcileRow(row: { id: string; hostClaimToken: string; runExecutionToken: string; mineruHome: string; status: string }, input: OcrServerReconcilerInput): Promise<"skipped" | "stopped" | "orphaned"> {
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
  if (endpoint === null) {
    await markOcrServerOrphaned(row.hostClaimToken, "RECONCILER_NO_ENDPOINT_EVIDENCE");
    return "orphaned";
  }
  if (!(await recordedProcessAlive(endpoint.pid, imagePattern))) {
    await markOcrServerStopped(row.hostClaimToken, "RECONCILER_PROCESS_GONE");
    return "stopped";
  }
  // Live process: cleanup ONLY under the necessary cross-restart identity
  // evidence (creation time predates the endpoint file the server wrote).
  if (!(await processPrecedesEndpointEvidence(endpoint, row.mineruHome, imagePattern))) {
    await markOcrServerOrphaned(row.hostClaimToken, "RECONCILER_IDENTITY_UNPROVABLE");
    return "orphaned";
  }
  const stopEnv: NodeJS.ProcessEnv = { ...process.env, MINERU_HOME: row.mineruHome };
  const stopResult = await spawnBounded(input.executable, [...input.executableArgs, ...buildMineruServerArgs("stop")], { env: stopEnv, cwd: row.mineruHome, timeoutMs: input.stopTimeoutMs, maxOutputBytes: 1_048_576 });
  if (stopResult.spawnErrorCode !== "ENOENT") {
    if (await awaitEndpointProcessExit(endpoint, row.mineruHome, imagePattern, 10_000)) {
      await markOcrServerStopped(row.hostClaimToken, "RECONCILER_GRACEFUL_STOP");
      return "stopped";
    }
  }
  // Re-prove identity IMMEDIATELY before the force kill (RF01 P1-05).
  if (!(await processPrecedesEndpointEvidence(endpoint, row.mineruHome, imagePattern))) {
    await markOcrServerOrphaned(row.hostClaimToken, "RECONCILER_IDENTITY_UNPROVABLE");
    return "orphaned";
  }
  const killed = await killByRecordedIdentity(endpoint.pid);
  if (killed && await awaitEndpointProcessExit(endpoint, row.mineruHome, imagePattern, 10_000)) {
    await markOcrServerStopped(row.hostClaimToken, "RECONCILER_FORCED_STOP");
    return "stopped";
  }
  await markOcrServerOrphaned(row.hostClaimToken, killed ? "RECONCILER_KILL_UNCONFIRMED" : "RECONCILER_KILL_REFUSED");
  return "orphaned";
}

async function awaitEndpointProcessExit(endpoint: { pid: number }, mineruHome: string, imagePattern: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await recordedProcessAlive(endpoint.pid, imagePattern))) return true;
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
