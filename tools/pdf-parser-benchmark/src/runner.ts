import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, terminateTree, type ProgramId } from "./process-launcher.js";
import { TreeResourceWatcher, arePidsAlive, sampleTree } from "./resource-monitor.js";

export type RunLimits = {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxOutputDirBytes: number;
};

export const DEFAULT_RUN_LIMITS: RunLimits = {
  timeoutMs: 600_000,
  maxStdoutBytes: 64 * 1024 * 1024,
  maxStderrBytes: 8 * 1024 * 1024,
  maxOutputDirBytes: 512 * 1024 * 1024,
};

export type RunnerOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killedByHarness: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  wallTimeMs: number;
  peakRssMb: number | null;
  cpuTimeMs: number | null;
  peakGpuMb: number | null;
  outputDirBytes: number;
  outputLimitExceeded: boolean;
  treePids: number[];
  treeKilledClean: boolean | null;
};

export type LaunchSpec = {
  programId: ProgramId;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};

export class Runner {
  constructor(private readonly limits: Partial<RunLimits> = {}) {}

  limitsWith(overrides?: Partial<RunLimits>): RunLimits {
    return { ...DEFAULT_RUN_LIMITS, ...this.limits, ...overrides };
  }

  async run(spec: LaunchSpec, limitsOverride?: Partial<RunLimits>): Promise<RunnerOutcome> {
    const limits = this.limitsWith(limitsOverride);
    const startedAt = Date.now();

    const child = launch(spec.programId, spec.argv, { cwd: spec.cwd, env: spec.env });

    // Attach the exit listener before anything async: a child that exits
    // immediately must not have its 'close' event missed.
    let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => undefined;
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      resolveExit = resolve;
    });
    child.onExit((code, signal) => resolveExit({ code, signal }));

    const watcherHandle = new TreeResourceWatcher(child.pid, 800, true);
    watcherHandle.start();

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let killedByHarness = false;
    let outputLimitExceeded = false;
    let outputDirBytes = 0;

    const sizeOutputDir = async (): Promise<number> => {
      try {
        return await directoryBytes(spec.cwd);
      } catch {
        return 0;
      }
    };

    const dirTimer = setInterval(() => {
      void sizeOutputDir().then((bytes) => {
        outputDirBytes = bytes;
        if (bytes > limits.maxOutputDirBytes && !outputLimitExceeded) {
          outputLimitExceeded = true;
          killedByHarness = true;
          void terminateTree(child.pid);
        }
      });
    }, 2_000);
    dirTimer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.maxStdoutBytes) {
        stdoutTruncated = true;
        killedByHarness = true;
        void terminateTree(child.pid);
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > limits.maxStderrBytes) {
        stderrTruncated = true;
        killedByHarness = true;
        void terminateTree(child.pid);
        return;
      }
      stderr += chunk.toString("utf8");
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killedByHarness = true;
      void terminateTree(child.pid);
    }, limits.timeoutMs);

    const treeBefore: number[] = await sampleTree(child.pid)
      .then((sample) => sample.pids)
      .catch(() => [child.pid]);

    const exit = await exitPromise;
    clearTimeout(timeoutHandle);
    clearInterval(dirTimer);
    const metrics = watcherHandle.stop();
    const wallTimeMs = Date.now() - startedAt;

    let treeKilledClean: boolean | null = null;
    if (killedByHarness) {
      const stillAlive = await arePidsAlive(treeBefore.filter((pid) => pid !== child.pid));
      treeKilledClean = stillAlive.length === 0;
    }
    outputDirBytes = await sizeOutputDir();

    return {
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      killedByHarness,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      wallTimeMs,
      peakRssMb: metrics.peakRssMb,
      cpuTimeMs: metrics.cpuTimeMs,
      peakGpuMb: metrics.peakGpuMb,
      outputDirBytes,
      outputLimitExceeded,
      treePids: treeBefore,
      treeKilledClean,
    };
  }
}

async function directoryBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else {
      try {
        total += (await stat(full)).size;
      } catch {
        // vanished mid-walk
      }
    }
  }
  return total;
}

export async function sha256File(path: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const handle = await fs.open(path, "r");
  try {
    const hash = createHash("sha256");
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function ensureCleanDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

/**
 * Atomic JSON write for run evidence: a crash mid-write must never leave a
 * half-written artifact at the final path (temp file → rename).
 */
export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const { rename } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}
