import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { platform } from "node:os";

/**
 * Bounded, identity-scoped child-process primitives for the MinerU executor
 * (BOOK-INGESTION-04B-3).
 *
 * Rules enforced here (04B-0 evidence + mission contract):
 *  - spawn argv arrays only; no shell is ever constructed
 *  - stdout/stderr are captured under explicit byte caps; overflow terminates
 *    the child (a degenerate process must not produce unlimited output)
 *  - every spawn has a hard timeout; on timeout the invocation's OWN process
 *    TREE is terminated (Windows: taskkill /PID <pid> /T /F via argv — the
 *    MinerU CLI spawns python children a bare kill() would orphan)
 *  - port probing is allocation only: a free port is never ownership evidence
 */

export type BoundedSpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  outputOverflow: boolean;
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
      resolve({ code: null, signal: null, timedOut: false, aborted: false, outputOverflow: false, stdout: "", stderr: "", spawnErrorCode: "CHILD_SPAWN_ERROR" });
      return;
    }
    const state: BoundedSpawnResult = { code: null, signal: null, timedOut: false, aborted: false, outputOverflow: false, stdout: "", stderr: "" };
    let settled = false;
    let timedOut = false;
    const stdout = captureStream(child.stdout!, options.maxOutputBytes, () => { state.outputOverflow = true; terminateTree(child.pid); });
    const stderr = captureStream(child.stderr!, options.maxOutputBytes, () => { state.outputOverflow = true; terminateTree(child.pid); });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      void Promise.all([stdout.done(), stderr.done()]).then(() => {
        state.stdout = stdout.text();
        state.stderr = stderr.text();
        resolve(state);
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      state.timedOut = true;
      terminateTree(child.pid);
    }, options.timeoutMs);
    const onAbort = () => {
      if (settled || timedOut) return;
      state.aborted = true;
      terminateTree(child.pid);
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      state.spawnErrorCode = error.code ?? "CHILD_SPAWN_ERROR";
      finish();
    });
    child.on("close", (code, signal) => {
      state.code = code;
      state.signal = signal;
      finish();
    });
  });
}

/**
 * Terminates a process TREE by recorded pid (Windows: taskkill /T /F; the
 * MinerU CLI wrapper parents python worker children). Argv-only — no shell.
 * Fire-and-forget: spawnBounded always also waits for `close`.
 */
function terminateTree(pid: number | undefined): void {
  if (!pid || platform() !== "win32") {
    if (pid) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    return;
  }
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch { /* already gone */ }
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

const taskListCommand = platform() === "win32" ? "tasklist" : "ps";

/**
 * Live-process evidence for a recorded pid. On Windows the image name must
 * match the expected server runtime pattern — the doclib server is a python
 * process, and this is the pid-reuse guard: a recycled pid owned by an
 * unrelated image is NEVER force-killed by identity-derived cleanup.
 */
export async function recordedProcessAlive(pid: number, expectedImagePattern: RegExp = /python/i): Promise<boolean> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = platform() === "win32" ? spawn(taskListCommand, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) : spawn(taskListCommand, ["-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
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
      if (platform() === "win32") {
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

/**
 * Force-kills a recorded pid's tree after `recordedProcessAlive`-style identity
 * verification has already happened at the call site. Windows argv-only.
 */
export async function forceKillRecordedPid(pid: number): Promise<boolean> {
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
