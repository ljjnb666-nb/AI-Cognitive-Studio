import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { platform } from "node:os";

/**
 * Bounded, identity-scoped child-process primitives for the MinerU executor
 * (BOOK-INGESTION-04B-3, hardened in 04B-3 RF01).
 *
 * Rules enforced here:
 *  - spawn argv arrays only; no shell is ever constructed
 *  - stdout/stderr are captured under explicit byte caps; overflow terminates
 *    the child (a degenerate process must not produce unlimited output)
 *  - every spawn has a hard deadline: timeout initiates termination of the
 *    directly spawned process tree, then a BOUNDED escalation window runs, and
 *    the caller ALWAYS receives a bounded disposition (RF01 P1-04). The
 *    disposition states honestly whether termination was CONFIRMED — a
 *    surviving (possibly orphaned) tree is never declared cleaned.
 *  - port probing is allocation only: a free port is never ownership evidence
 *  - live-process identity evidence includes the process CREATION TIME
 *    fingerprint (RF01 P1-05): an image-name match alone is explicitly NOT a
 *    pid-reuse guard.
 */

export type BoundedSpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  outputOverflow: boolean;
  /** The directly spawned child process emitted `exit` after termination was initiated. Evidence about the DIRECT child only. */
  directChildExitObserved: boolean;
  /**
   * The OWNED tree-termination operation completed successfully AND the direct
   * child exited afterwards. This claims the taskkill reported success for the
   * recorded tree — it is NOT kernel-level proof that every detached
   * descendant died (RF02 P2: never assert more than the evidence proves).
   */
  treeTerminationConfirmed: boolean;
  stdout: string;
  stderr: string;
  spawnErrorCode?: string;
};

export type BoundedSpawnOptions = {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
  windowsHide?: boolean;
  /**
   * Bounded window granted to termination after the deadline before the
   * caller receives its disposition anyway (default 5000ms; never infinite).
   */
  terminationGraceMs?: number;
  /**
   * Test-only seam for the owned tree-termination operation. Defaults to the
   * real taskkill/kill-by-recorded-pid implementation; injecting a failing
   * termination lets tests prove the disposition never overclaims.
   */
  terminateProcessTree?: (pid: number) => Promise<boolean>;
};

/** Captures a stream under a byte cap; resolves true if the cap was exceeded. */
function captureStream(stream: NodeJS.ReadableStream, maxBytes: number, onOverflow: () => void): { text: () => string; done: () => Promise<void> } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflowed = false;
  const done = new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      if (!overflowed && chunks.length < 64) chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > maxBytes && !overflowed) {
        overflowed = true;
        onOverflow();
        resolve();
      }
    });
    stream.on("end", () => resolve());
    stream.on("error", () => resolve());
  });
  return { text: () => Buffer.concat(chunks).toString("utf8"), done: () => done };
}

export async function spawnBounded(executable: string, args: string[], options: BoundedSpawnOptions): Promise<BoundedSpawnResult> {
  return await new Promise<BoundedSpawnResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, { env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}), windowsHide: options.windowsHide ?? true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: null, signal: null, timedOut: false, aborted: false, outputOverflow: false, directChildExitObserved: false, treeTerminationConfirmed: false, stdout: "", stderr: "", spawnErrorCode: "CHILD_SPAWN_ERROR" });
      return;
    }
    const terminateProcessTree = options.terminateProcessTree ?? terminateTreeByPid;
    const state: BoundedSpawnResult = { code: null, signal: null, timedOut: false, aborted: false, outputOverflow: false, directChildExitObserved: false, treeTerminationConfirmed: false, stdout: "", stderr: "" };
    let settled = false;
    let exitObserved = false;
    let terminationInitiated = false;
    const stdout = captureStream(child.stdout!, options.maxOutputBytes, () => { state.outputOverflow = true; runTermination(); });
    const stderr = captureStream(child.stderr!, options.maxOutputBytes, () => { state.outputOverflow = true; runTermination(); });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      // Bounded stream drain: a surviving detached descendant can hold the
      // stdio pipes open forever; the captured chunks are already buffered,
      // so the caller is resolved with a bounded drain either way (RF01 P1-04).
      void Promise.race([Promise.all([stdout.done(), stderr.done()]), sleep(250)]).then(() => {
        state.stdout = stdout.text();
        state.stderr = stderr.text();
        resolve(state);
      });
    };
    // RF01 P1-04/RF02 P2: the deadline initiates OWNED tree termination
    // (awaited), grants a bounded grace window, escalates once, and then
    // ALWAYS resolves the caller. treeTerminationConfirmed requires BOTH the
    // owned termination operation to report success AND the direct child to
    // have exited afterwards — never more than the evidence proves.
    const graceMs = options.terminationGraceMs ?? 5_000;
    let graceTimer: NodeJS.Timeout | undefined;
    const deadlineTimer = setTimeout(() => {
      state.timedOut = true;
      runTermination();
      graceTimer = setTimeout(() => {
        if (exitObserved) return;
        // Escalation for the directly spawned tree, then the bounded disposition.
        runTermination();
        setTimeout(finish, Math.min(graceMs, 2_000));
      }, graceMs);
    }, options.timeoutMs);
    let terminationPromise: Promise<void> | null = null;
    let ownedTerminationSucceeded = false;
    const initiateTermination = async (): Promise<void> => {
      if (exitObserved || settled) return;
      terminationInitiated = true;
      const pid = child.pid;
      if (!pid) return;
      ownedTerminationSucceeded = await terminateProcessTree(pid).catch(() => false);
    };
    const runTermination = (): void => {
      terminationPromise ??= initiateTermination();
    };
    const onAbort = () => {
      if (settled || state.timedOut) return;
      state.aborted = true;
      runTermination();
      // Abort never waits unbounded either: bounded disposition below.
      graceTimer ??= setTimeout(() => { if (!exitObserved) finish(); }, graceMs);
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      state.spawnErrorCode = error.code ?? "CHILD_SPAWN_ERROR";
      finish();
    });
    child.on("exit", (code, signal) => {
      exitObserved = true;
      state.directChildExitObserved = terminationInitiated;
      state.code = code;
      state.signal = signal;
      clearTimeout(graceTimer);
      // The tree-termination verdict needs the OWNED termination operation's
      // awaited result, in EITHER completion order (taskkill usually completes
      // before the killed child's exit event surfaces). Wait BOUNDED — the
      // grace escalation always resolves the caller anyway.
      const verdict = () => {
        state.treeTerminationConfirmed = terminationInitiated && ownedTerminationSucceeded;
        finish();
      };
      if (terminationPromise) {
        void Promise.race([terminationPromise, sleep(3_000)]).then(verdict);
      } else {
        verdict();
      }
    });
    // `close` may never fire when a surviving detached descendant holds the
    // stdio pipes; the exit event above already resolved us with the honest
    // disposition, so close handling only covers the normal path.
    child.on("close", () => finish());
  });
}

/**
 * Terminates a process TREE by recorded pid (Windows: taskkill /T /F; the
 * MinerU CLI wrapper parents python worker children). Argv-only — no shell.
 * RF02 P2: the operation is OWNED — the taskkill/kill exit status is awaited
 * and reported, so a failed termination is observable and can never be
 * presented as a confirmed tree termination.
 */
async function terminateTreeByPid(pid: number | undefined): Promise<boolean> {
  if (!pid) return false;
  if (platform() !== "win32") {
    try { process.kill(pid); return true; } catch { return false; }
  }
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 10_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** Allocates a free loopback TCP port. Allocation is NOT ownership: the consumer pins it via env and treats bind failure as a bounded start failure. */
export async function probeFreeTcpPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

const isWindows = platform() === "win32";

/**
 * LIVE process creation-time fingerprint (RF01 P1-05). A recycled pid
 * necessarily carries a NEW creation time, so equality with a fingerprint
 * captured when identity was first established is the minimum live evidence
 * that the pid is still the SAME process. Returns null when the process does
 * not exist or creation time cannot be proven. The value is normalized to
 * EPOCH MILLISECONDS so callers can compare it against filesystem mtimes.
 */
export async function processCreationTime(pid: number): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (isWindows) {
    return await new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToFileTime()`], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve(null);
        return;
      }
      let out = "";
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 10_000);
      child.stdout!.on("data", (chunk: Buffer) => { if (out.length < 4096) out += chunk.toString("utf8"); });
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(fileTimeTicksToEpochMs(out.trim()));
      });
    });
  }
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ps", ["-o", "lstart=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 5_000);
    child.stdout!.on("data", (chunk: Buffer) => { if (out.length < 4096) out += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = Date.parse(out.trim());
      resolve(Number.isFinite(parsed) ? parsed : null);
    });
  });
}

/** Windows FILETIME (100ns ticks since 1601-01-01) → epoch milliseconds. The raw tick count exceeds MAX_SAFE_INTEGER, so the conversion divides in float space (sub-millisecond precision loss is irrelevant for identity evidence). */
function fileTimeTicksToEpochMs(raw: string): number | null {
  const ticks = Number.parseFloat(raw);
  if (!Number.isFinite(ticks) || ticks <= 0) return null;
  const epochMs = ticks / 10_000 - 11_644_473_600_000;
  return Number.isFinite(epochMs) && epochMs > 0 ? epochMs : null;
}

const taskListCommand = isWindows ? "tasklist" : "ps";

/**
 * Live-process evidence for a recorded pid. On Windows the image name must
 * match the expected server runtime pattern — a NECESSARY condition only
 * (RF01 P1-05: it is NOT, by itself, a pid-reuse guard; pair it with the
 * creation-time fingerprint).
 */
export async function recordedProcessAlive(pid: number, expectedImagePattern: RegExp = /python/i): Promise<boolean> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = isWindows ? spawn(taskListCommand, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) : spawn(taskListCommand, ["-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 5000);
    child.stdout!.on("data", (chunk: Buffer) => { if (out.length < 8192) out += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", () => {
      clearTimeout(timer);
      if (isWindows) {
        const line = out.split(/\r?\n/).find((candidate) => candidate.includes(String(pid)));
        if (!line) return resolve(false);
        const image = line.split(",")[0]?.replace(/"/g, "") ?? "";
        resolve(expectedImagePattern.test(image));
        return;
      }
      resolve(out.trim().length > 0);
    });
  });
}

/** Live identity: same pid, same image class, SAME creation-time fingerprint. */
export async function recordedProcessIdentityMatches(pid: number, creationTime: number | null, expectedImagePattern: RegExp): Promise<boolean> {
  if (creationTime === null) return false;
  if (!(await recordedProcessAlive(pid, expectedImagePattern))) return false;
  return (await processCreationTime(pid)) === creationTime;
}

/**
 * Force-kills a recorded pid's tree after live identity verification has
 * already happened at the call site. Windows argv-only.
 */
export async function forceKillRecordedPid(pid: number): Promise<boolean> {
  if (!isWindows) {
    try { process.kill(pid); return true; } catch { return false; }
  }
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 10000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** Bounded sleep (poll cadence helper — never a busy-wait). */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

/**
 * THE single liveness authority for recorded-pid cleanup decisions (RF02
 * P1-03), shared by the claim-scoped server session AND the crash reconciler:
 * a process is "proven gone" only after the required number of CONSECUTIVE
 * negative observations, separated by a small bounded delay. A single empty
 * tasklist/ps result is explicitly NOT proof. The probe is injectable for
 * tests (flaky-probe teeth) and defaults to the real recordedProcessAlive.
 */
export async function confirmedRecordedProcessGone(pid: number, options: { expectedImagePattern?: RegExp; observations?: number; delayMs?: number; signal?: AbortSignal; probe?: (pid: number, pattern?: RegExp) => Promise<boolean> } = {}): Promise<boolean> {
  const required = options.observations ?? 2;
  const probe = options.probe ?? recordedProcessAlive;
  const pattern = options.expectedImagePattern;
  let negatives = 0;
  for (;;) {
    if (await probe(pid, pattern)) return false;
    negatives += 1;
    if (negatives >= required) return true;
    await sleep(options.delayMs ?? 150, options.signal);
  }
}
