import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { confirmedRecordedProcessGone, forceKillRecordedPid, probeFreeTcpPort, processCreationTime, recordedProcessAlive, sleep, spawnBounded, type BoundedSpawnOptions } from "./mineru-process.js";
import { buildMineruServerArgs, parseMineruEndpoint, type MineruEndpoint } from "./mineru-commands.js";

/**
 * Claim-scoped MinerU doclib server lifecycle (BOOK-INGESTION-04B-3, hardened
 * in 04B-3 RF01).
 *
 * 04B-0 established that `mineru parse` is a CLIENT of a per-MINERU_HOME
 * doclib server (parse without a server: exit 1 "server_not_running"), that a
 * claim-scoped home + pinned unique port + shared immutable model root is the
 * proven parallel-safe architecture, and that on Windows the ENDPOINT FILE
 * (pid + server_id) is the ONLY durable server identity — the CLI's own pid is
 * the wrapper, ports are never ownership, and a graceful-stop RPC can reach
 * the wrong server under dual-bind.
 *
 * Consequently every claim runs its own short-lived server:
 *  - a fresh probe-allocated port is pinned via MINERU_DOCLIB_TCP_PORT
 *  - start is bounded; readiness evidence is the validated endpoint file
 *  - when the endpoint first becomes authoritative, the LIVE process creation
 *    time is captured as the identity fingerprint (RF01 P1-05)
 *  - stop is graceful first, then — ONLY IF the recorded pid still carries the
 *    SAME creation-time fingerprint (plus the image-class check) — a guarded
 *    force-kill. A same-image recycled pid is NEVER killed: safety beats
 *    cleanup, and the row is handed to the reconciler as ORPHANED instead.
 */

export type MineruServerStartFailure =
  | { kind: "EXECUTABLE_NOT_FOUND"; treeTerminationConfirmed: true; directChildExitObserved: true }
  | { kind: "START_TIMEOUT"; treeTerminationConfirmed: boolean; directChildExitObserved: boolean }
  | { kind: "START_FAILED"; stderrTail: string; treeTerminationConfirmed: boolean; directChildExitObserved: boolean }
  | { kind: "ABORTED"; treeTerminationConfirmed: boolean; directChildExitObserved: boolean };

export type MineruServerStopDisposition =
  | { kind: "STOPPED" }
  | { kind: "ALREADY_EXITED" }
  | { kind: "KILLED_BY_RECORDED_IDENTITY" }
  | { kind: "ORPHAN_SUSPECT"; reason: string }
  /**
   * RF02 P1-05: no endpoint identity existed, which is NOT proof the server
   * is gone — it may still be starting, the endpoint write may have been
   * delayed/lost, or a detached server may have survived its wrapper. The
   * caller must treat the claim home as live recovery evidence (never delete
   * it) and resolve the durable row ORPHANED unless it holds separate,
   * explicit process-tree proof that nothing survived.
   */
  | { kind: "NO_ENDPOINT_UNPROVEN" };

const ENDPOINT_FILE = "doclib.endpoint.json";
const ENDPOINT_POLL_MS = 250;
/** How long a graceful stop's effect is awaited before the guarded kill. */
const STOP_VERIFY_POLL_MS = 250;
const STOP_VERIFY_TIMEOUT_MS = 10_000;

export type MineruServerSessionInput = {
  executable: string;
  executableArgs: string[];
  homeDir: string;
  childEnvBase: NodeJS.ProcessEnv;
  startTimeoutMs: number;
  stopTimeoutMs: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
  /** Recorded-pid live-image guard (necessary condition only; production pins python). */
  processImagePattern?: RegExp;
};

export type MineruServerSession = {
  /** Validated endpoint identity once started; null until then. */
  readonly endpoint: MineruEndpoint | null;
  /** Creation-time fingerprint of the endpoint process once captured; null when never proven. */
  readonly endpointCreationTime: number | null;
  start(): Promise<MineruServerStartFailure | null>;
  stop(): Promise<MineruServerStopDisposition>;
};

export async function readMineruEndpointFile(homeDir: string): Promise<MineruEndpoint | null> {
  try {
    return parseMineruEndpoint(await readFile(join(homeDir, ENDPOINT_FILE), "utf8"));
  } catch {
    return null;
  }
}

export async function createMineruServerSession(input: MineruServerSessionInput): Promise<MineruServerSession> {
  let endpoint: MineruEndpoint | null = null;
  /** Creation-time fingerprint captured when the endpoint became authoritative (null = never proven). */
  let endpointCreationTime: number | null = null;
  let stopped = false;

  async function captureFingerprint(candidate: MineruEndpoint): Promise<number | null> {
    return await processCreationTime(candidate.pid);
  }

  return {
    get endpoint() {
      return endpoint;
    },
    get endpointCreationTime() {
      return endpointCreationTime;
    },
    async start(): Promise<MineruServerStartFailure | null> {
      // Nothing was ever spawned on these paths: the tree proof is trivially
      // complete (EXECUTABLE_NOT_FOUND-grade evidence).
      if (stopped) return { kind: "ABORTED", treeTerminationConfirmed: true, directChildExitObserved: true };
      if (input.abortSignal?.aborted) return { kind: "ABORTED", treeTerminationConfirmed: true, directChildExitObserved: true };
      const port = await probeFreeTcpPort();
      const spawnOptions: BoundedSpawnOptions = {
        env: { ...input.childEnvBase, MINERU_DOCLIB_TCP_PORT: String(port) },
        cwd: input.homeDir,
        timeoutMs: input.startTimeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      };
      const startResult = await spawnBounded(input.executable, [...input.executableArgs, ...buildMineruServerArgs("start")], spawnOptions);
      // RF02 P1-05/P2: start failures carry the EXPLICIT process-tree
      // evidence from the owned start-wrapper termination, so the caller can
      // prove "nothing survived" instead of guessing from a missing endpoint.
      const evidence = { treeTerminationConfirmed: startResult.treeTerminationConfirmed, directChildExitObserved: startResult.directChildExitObserved };
      if (startResult.spawnErrorCode === "ENOENT") return { kind: "EXECUTABLE_NOT_FOUND", treeTerminationConfirmed: true, directChildExitObserved: true };
      if (input.abortSignal?.aborted && startResult.code === null) return { kind: "ABORTED", ...evidence };
      // Readiness evidence is the validated endpoint file, awaited under the
      // start budget (04B-0: the endpoint appears before usability; the parse
      // call itself is the usability probe and its failures are classified).
      const deadline = Date.now() + input.startTimeoutMs;
      while (endpoint === null && Date.now() < deadline) {
        if (input.abortSignal?.aborted) return { kind: "ABORTED", ...evidence };
        endpoint = await readMineruEndpointFile(input.homeDir);
        if (endpoint === null) await sleep(ENDPOINT_POLL_MS, input.abortSignal);
      }
      if (endpoint === null) {
        if (input.abortSignal?.aborted) return { kind: "ABORTED", ...evidence };
        if (startResult.timedOut || startResult.outputOverflow) return { kind: "START_TIMEOUT", ...evidence };
        return { kind: "START_FAILED", stderrTail: startResult.stderr.slice(-2000), ...evidence };
      }
      endpointCreationTime = await captureFingerprint(endpoint);
      return null;
    },
    async stop(): Promise<MineruServerStopDisposition> {
      if (stopped) return { kind: "STOPPED" };
      stopped = true;
      const recorded = endpoint ?? await readMineruEndpointFile(input.homeDir);
      // RF02 P1-05: absence of an endpoint is NOT proof of exit — the server
      // may never have started, still be starting, have lost the endpoint
      // write, or survive detached from a killed wrapper. The caller receives
      // an honest unproven disposition and must keep the recovery home.
      if (recorded === null) return { kind: "NO_ENDPOINT_UNPROVEN" };
      if (!input.abortSignal?.aborted) {
        const stopResult = await spawnBounded(input.executable, [...input.executableArgs, ...buildMineruServerArgs("stop")], { env: input.childEnvBase, cwd: input.homeDir, timeoutMs: input.stopTimeoutMs, maxOutputBytes: input.maxOutputBytes });
        if (stopResult.spawnErrorCode === "ENOENT") return await guardedKill(recorded);
        const exited = await awaitRecordedExit(recorded.pid, STOP_VERIFY_TIMEOUT_MS);
        if (exited) return { kind: "STOPPED" };
      }
      return await guardedKill(recorded);
    },
  };

  /** Polls until the RECORDED process is gone. A live pid whose creation time no longer matches the recorded fingerprint is a recycled pid — the recorded process IS gone. */
  async function awaitRecordedExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await confirmedRecordedProcessGone(pid, { expectedImagePattern: input.processImagePattern, signal: input.abortSignal })) return true;
      if (endpointCreationTime !== null && (await processCreationTime(pid)) !== endpointCreationTime) return true;
      if (Date.now() >= deadline) return false;
      await sleep(STOP_VERIFY_POLL_MS, input.abortSignal);
    }
  }

  /**
   * The ONLY force-kill path, and it requires LIVE identity evidence
   * (RF01 P1-05): the fingerprint captured when THIS claim's endpoint became
   * authoritative must exist, the endpoint pid+serverId must re-match the
   * file our own claim-scoped server wrote, the image class must match, AND
   * the live creation time must equal that fingerprint. A same-image recycled
   * pid fails the fingerprint equality — and a session that never captured a
   * fingerprint (crafted/stale endpoint, abort before capture) has NO live
   * identity evidence at all and is NEVER killed (ORPHAN_SUSPECT; the
   * reconciler may only act on its own evidence later).
   */
  async function guardedKill(recorded: MineruEndpoint): Promise<MineruServerStopDisposition> {
    const fresh = await readMineruEndpointFile(input.homeDir);
    if (!fresh || fresh.pid !== recorded.pid || fresh.serverId !== recorded.serverId) {
      if (await confirmedRecordedProcessGone(recorded.pid, { expectedImagePattern: input.processImagePattern, signal: input.abortSignal })) return { kind: "ALREADY_EXITED" };
      return { kind: "ORPHAN_SUSPECT", reason: "ENDPOINT_IDENTITY_MISMATCH" };
    }
    if (endpointCreationTime === null) return { kind: "ORPHAN_SUSPECT", reason: "IDENTITY_NOT_CAPTURED" };
    const liveCreationTime = await processCreationTime(recorded.pid);
    if (liveCreationTime === null) {
      if (await confirmedRecordedProcessGone(recorded.pid, { expectedImagePattern: input.processImagePattern, signal: input.abortSignal })) return { kind: "ALREADY_EXITED" };
      return { kind: "ORPHAN_SUSPECT", reason: "LIVE_IDENTITY_UNPROVABLE" };
    }
    if (liveCreationTime !== endpointCreationTime) {
      return { kind: "ORPHAN_SUSPECT", reason: "PID_REUSED_SAME_IMAGE" };
    }
    // The just-read creation time IS the live evidence: a dead process has no
    // creation time to read, and equality proves this pid is exactly the
    // recorded server. (An additional liveness probe here proved flaky under
    // abort/termination bursts and is intentionally not required before the kill.)
    if (!(await forceKillRecordedPid(recorded.pid))) return { kind: "ORPHAN_SUSPECT", reason: "FORCE_KILL_FAILED" };
    if (!(await awaitPidExit(recorded.pid, STOP_VERIFY_TIMEOUT_MS))) return { kind: "ORPHAN_SUSPECT", reason: "KILL_NOT_CONFIRMED" };
    return { kind: "KILLED_BY_RECORDED_IDENTITY" };
  }

  /** Post-kill liveness check: once teardown owns a kill, confirmation must
   *  outlive the work abort signal. Otherwise lease-loss/shutdown aborts can
   *  turn a successfully initiated kill into a false ORPHAN_SUSPECT before
   *  the OS has had time to reap the process. The loop remains hard-bounded
   *  by STOP_VERIFY_TIMEOUT_MS and performs no new work. */
  async function awaitPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await recordedProcessAlive(pid, input.processImagePattern ?? /python/i))) return true;
      if (Date.now() >= deadline) return false;
      await sleep(STOP_VERIFY_POLL_MS);
    }
  }
}

/**
 * NECESSARY (not sufficient) cross-restart identity evidence for a claim home
 * we no longer hold in memory (RF01 P1-05/P1-06): the live process must be
 * OLDER than the endpoint file — the server necessarily existed before it
 * wrote the endpoint. A live pid created AFTER the endpoint was written is a
 * recycled pid and can never be force-killed on this evidence; the caller
 * reports ORPHANED instead.
 */
export async function processPrecedesEndpointEvidence(endpoint: MineruEndpoint, homeDir: string, expectedImagePattern: RegExp): Promise<boolean> {
  // RF03: liveness here is DUAL-SOURCE — the creation-time read IS the second
  // source and doubles as the identity fingerprint. A single tasklist
  // negative is a known false-negative shape under process churn and must not
  // veto cleanup evidence on its own: creationTime === null (neither source
  // can see the process) is the only "not alive" verdict.
  let endpointMtime: number | null = null;
  try {
    endpointMtime = (await stat(join(homeDir, ENDPOINT_FILE))).mtimeMs;
  } catch {
    return false;
  }
  const creationTime = await processCreationTime(endpoint.pid);
  if (creationTime === null) {
    const tasklistAlive = await recordedProcessAlive(endpoint.pid, expectedImagePattern);
    if (!tasklistAlive) return false;
    // Conflicting sources: tasklist sees a process whose creation time is
    // unreadable — identity is unprovable either way.
    return false;
  }
  return creationTime <= endpointMtime;
}