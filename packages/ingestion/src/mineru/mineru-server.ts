import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { forceKillRecordedPid, probeFreeTcpPort, recordedProcessAlive, sleep, spawnBounded, type BoundedSpawnOptions } from "./mineru-process.js";
import { buildMineruServerArgs, parseMineruEndpoint, type MineruEndpoint } from "./mineru-commands.js";

/**
 * Claim-scoped MinerU doclib server lifecycle (BOOK-INGESTION-04B-3).
 *
 * 04B-0 established that `mineru parse` is a CLIENT of a per-MINERU_HOME
 * doclib server (parse without a server: exit 1 "server_not_running"), that a
 * claim-scoped home + pinned unique port + shared immutable model root is the
 * proven parallel-safe architecture, and that on Windows the ENDPOINT FILE
 * (pid + server_id) is the ONLY authoritative server identity — the CLI's own
 * pid is the wrapper, ports are never ownership, and a graceful-stop RPC can
 * reach the wrong server under dual-bind.
 *
 * Consequently every claim runs its own short-lived server:
 *  - a fresh probe-allocated port is pinned via MINERU_DOCLIB_TCP_PORT
 *  - start is bounded; readiness evidence is the validated endpoint file
 *  - stop is graceful first, then a guarded force-kill that re-reads the
 *    endpoint file, requires pid + serverId to match the recorded identity,
 *    requires the live process image to be a python interpreter (pid-reuse
 *    guard), and only then kills the recorded tree. Identity mismatch is
 *    reported as ORPHAN_SUSPECT and NEVER killed.
 */

export type MineruServerStartFailure =
  | { kind: "EXECUTABLE_NOT_FOUND" }
  | { kind: "START_TIMEOUT" }
  | { kind: "START_FAILED"; stderrTail: string }
  | { kind: "ABORTED" };

export type MineruServerStopDisposition =
  | { kind: "STOPPED" }
  | { kind: "ALREADY_EXITED" }
  | { kind: "KILLED_BY_RECORDED_IDENTITY" }
  | { kind: "ORPHAN_SUSPECT"; reason: string };

const ENDPOINT_FILE = "doclib.endpoint.json";
const ENDPOINT_POLL_MS = 250;
/** How long a graceful stop's effect is awaited before the guarded kill. */
const STOP_VERIFY_POLL_MS = 250;
const STOP_VERIFY_TIMEOUT_MS = 10_000;

export type MineruServerSession = {
  /** Validated endpoint identity once started; null until then. */
  readonly endpoint: MineruEndpoint | null;
  start(): Promise<MineruServerStartFailure | null>;
  stop(): Promise<MineruServerStopDisposition>;
};

export type MineruServerSessionInput = {
  executable: string;
  executableArgs: string[];
  homeDir: string;
  childEnvBase: NodeJS.ProcessEnv;
  startTimeoutMs: number;
  stopTimeoutMs: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
  /** Recorded-pid live-image guard (pid-reuse protection; production pins python). */
  processImagePattern?: RegExp;
};

export async function createMineruServerSession(input: MineruServerSessionInput): Promise<MineruServerSession> {
  const endpointPath = join(input.homeDir, ENDPOINT_FILE);
  let endpoint: MineruEndpoint | null = null;
  let stopped = false;

  async function readEndpoint(): Promise<MineruEndpoint | null> {
    try {
      return parseMineruEndpoint(await readFile(endpointPath, "utf8"));
    } catch {
      return null;
    }
  }

  return {
    get endpoint() {
      return endpoint;
    },
    async start(): Promise<MineruServerStartFailure | null> {
      if (stopped) return { kind: "ABORTED" };
      if (input.abortSignal?.aborted) return { kind: "ABORTED" };
      const port = await probeFreeTcpPort();
      const spawnOptions: BoundedSpawnOptions = {
        env: { ...input.childEnvBase, MINERU_DOCLIB_TCP_PORT: String(port) },
        cwd: input.homeDir,
        timeoutMs: input.startTimeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      };
      const startResult = await spawnBounded(input.executable, [...input.executableArgs, ...buildMineruServerArgs("start")], spawnOptions);
      if (startResult.spawnErrorCode === "ENOENT") return { kind: "EXECUTABLE_NOT_FOUND" };
      if (input.abortSignal?.aborted && startResult.code === null) return { kind: "ABORTED" };
      // Readiness evidence is the validated endpoint file, awaited under the
      // start budget (04B-0: the endpoint appears before usability; the parse
      // call itself is the usability probe and its failures are classified).
      const deadline = Date.now() + input.startTimeoutMs;
      while (endpoint === null && Date.now() < deadline) {
        if (input.abortSignal?.aborted) return { kind: "ABORTED" };
        endpoint = await readEndpoint();
        if (endpoint === null) await sleep(ENDPOINT_POLL_MS, input.abortSignal);
      }
      if (endpoint === null) {
        if (input.abortSignal?.aborted) return { kind: "ABORTED" };
        if (startResult.timedOut || startResult.outputOverflow) return { kind: "START_TIMEOUT" };
        return { kind: "START_FAILED", stderrTail: startResult.stderr.slice(-2000) };
      }
      return null;
    },
    async stop(): Promise<MineruServerStopDisposition> {
      if (stopped) return { kind: "STOPPED" };
      stopped = true;
      const recorded = endpoint ?? await readEndpoint();
      if (input.abortSignal?.aborted && recorded === null) return { kind: "ORPHAN_SUSPECT", reason: "ABORTED_BEFORE_ENDPOINT" };
      if (recorded === null) return { kind: "ALREADY_EXITED" };
      if (!input.abortSignal?.aborted) {
        const stopResult = await spawnBounded(input.executable, [...input.executableArgs, ...buildMineruServerArgs("stop")], { env: input.childEnvBase, cwd: input.homeDir, timeoutMs: input.stopTimeoutMs, maxOutputBytes: input.maxOutputBytes });
        if (stopResult.spawnErrorCode === "ENOENT") return await guardedKill(recorded, endpointPath, input.processImagePattern);
        const exited = await awaitPidExit(recorded.pid, STOP_VERIFY_TIMEOUT_MS, input.processImagePattern, input.abortSignal);
        if (exited) return { kind: "STOPPED" };
      }
      return await guardedKill(recorded, endpointPath, input.processImagePattern);
    },
  };
}

/** Polls until the recorded pid disappears (or the budget expires). */
async function awaitPidExit(pid: number, timeoutMs: number, expectedImagePattern?: RegExp, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await recordedProcessAlive(pid, expectedImagePattern))) return true;
    if (Date.now() >= deadline || signal?.aborted) return false;
    await sleep(STOP_VERIFY_POLL_MS, signal);
  }
}

/**
 * The ONLY force-kill path: endpoint identity (pid + serverId) must re-match
 * the file our own claim-scoped server wrote, and the live image must be a
 * python interpreter. Anything else is never killed (ORPHAN_SUSPECT) — port
 * alone, image name sweeps, and stale pids are all banned by 04B-0 evidence.
 */
async function guardedKill(recorded: MineruEndpoint, endpointPath: string, expectedImagePattern?: RegExp): Promise<MineruServerStopDisposition> {
  const fresh = await (async () => {
    try {
      return parseMineruEndpoint(await readFile(endpointPath, "utf8"));
    } catch {
      return null;
    }
  })();
  if (!fresh || fresh.pid !== recorded.pid || fresh.serverId !== recorded.serverId) {
    if (!(await recordedProcessAlive(recorded.pid, expectedImagePattern))) return { kind: "ALREADY_EXITED" };
    return { kind: "ORPHAN_SUSPECT", reason: "ENDPOINT_IDENTITY_MISMATCH" };
  }
  if (!(await recordedProcessAlive(recorded.pid, expectedImagePattern))) return { kind: "ALREADY_EXITED" };
  if (!(await forceKillRecordedPid(recorded.pid))) return { kind: "ORPHAN_SUSPECT", reason: "FORCE_KILL_FAILED" };
  if (!(await awaitPidExit(recorded.pid, STOP_VERIFY_TIMEOUT_MS, expectedImagePattern))) return { kind: "ORPHAN_SUSPECT", reason: "KILL_NOT_CONFIRMED" };
  return { kind: "KILLED_BY_RECORDED_IDENTITY" };
}
