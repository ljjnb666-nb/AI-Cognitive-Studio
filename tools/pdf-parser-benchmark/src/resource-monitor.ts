import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Disk free bytes for a path's volume. */
export async function diskFreeBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
}

/** Approximate available RAM (os.freemem maps to available physical memory). */
export function ramAvailableBytes(): number {
  return os.freemem();
}

export function ramTotalBytes(): number {
  return os.totalmem();
}

export type GpuState = {
  available: boolean;
  name: string | null;
  vramTotalMb: number | null;
  vramUsedMb: number | null;
  vramFreeMb: number | null;
  utilizationPct: number | null;
};

export async function gpuState(): Promise<GpuState> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 10_000 },
    );
    const [name, total, used, free, util] = stdout.trim().split(",").map((part) => part.trim());
    return {
      available: true,
      name: name ?? null,
      vramTotalMb: Number(total),
      vramUsedMb: Number(used),
      vramFreeMb: Number(free),
      utilizationPct: Number(util),
    };
  } catch {
    return { available: false, name: null, vramTotalMb: null, vramUsedMb: null, vramFreeMb: null, utilizationPct: null };
  }
}

/**
 * Samples the descendant process tree of a root PID on Windows:
 * one PowerShell/CIM query per tick, BFS over ParentProcessId.
 * WorkingSetSize is resident memory; kernel+user time approximates CPU time.
 */
export type TreeSample = { rssMb: number; cpuTimeMs: number; pids: number[] };

export class TreeResourceWatcher {
  private timer: NodeJS.Timeout | null = null;
  private peakRssMb = 0;
  private lastCpuTimeMs: number | null = null;
  private gpuPeakMb = 0;
  private gpuBaseline = 0;
  private gpuTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly rootPid: number,
    private readonly intervalMs = 1_500,
    private readonly gpuWatch = false,
  ) {}

  start(): void {
    this.running = true;
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    this.timer.unref();
    void this.sample();
    if (this.gpuWatch) {
      void gpuState().then((state) => {
        this.gpuBaseline = state.vramUsedMb ?? 0;
        this.gpuPeakMb = this.gpuBaseline;
      });
      this.gpuTimer = setInterval(async () => {
        const state = await gpuState();
        const used = state.vramUsedMb ?? 0;
        if (used > this.gpuPeakMb) this.gpuPeakMb = used;
      }, 2_000);
      this.gpuTimer.unref();
    }
  }

  private async sample(): Promise<void> {
    if (!this.running) return;
    try {
      const sample = await sampleTree(this.rootPid);
      if (sample.rssMb > this.peakRssMb) this.peakRssMb = sample.rssMb;
      if (sample.cpuTimeMs > 0) this.lastCpuTimeMs = sample.cpuTimeMs;
    } catch {
      // tree may have already exited — keep last known values
    }
  }

  stop(): { peakRssMb: number | null; cpuTimeMs: number | null; peakGpuMb: number | null } {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.gpuTimer) clearInterval(this.gpuTimer);
    // GPU peak is reported as device-level delta above the pre-run baseline;
    // WDDM per-process attribution is not reliable, so absolute numbers are device-wide.
    const gpuDelta = this.gpuWatch ? Math.max(0, this.gpuPeakMb - this.gpuBaseline) : null;
    return {
      peakRssMb: this.peakRssMb > 0 ? this.peakRssMb : null,
      cpuTimeMs: this.lastCpuTimeMs,
      peakGpuMb: gpuDelta,
    };
  }
}

type RawProcess = { pid: number; parent: number; wsMb: number; cpuMs: number };

async function listProcesses(): Promise<RawProcess[]> {
  const { stdout } = await execFileAsync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Csv -NoTypeInformation",
    ],
    { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
  );
  const lines = stdout.trim().split(/\r?\n/);
  const out: RawProcess[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((col) => col.replaceAll('"', "").trim());
    const pid = Number(cols[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({
      pid,
      parent: Number(cols[1]) || 0,
      wsMb: (Number(cols[2]) || 0) / (1024 * 1024),
      cpuMs: ((Number(cols[3]) || 0) + (Number(cols[4]) || 0)) / 10_000,
    });
  }
  return out;
}

export async function sampleTree(rootPid: number): Promise<TreeSample> {
  const processes = await listProcesses();
  const byParent = new Map<number, RawProcess[]>();
  for (const proc of processes) {
    const list = byParent.get(proc.parent) ?? [];
    list.push(proc);
    byParent.set(proc.parent, list);
  }
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  let rssMb = 0;
  let cpuTimeMs = 0;
  while (queue.length) {
    const current = queue.shift()!;
    const direct = byParent.get(current) ?? [];
    for (const child of direct) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      rssMb += child.wsMb;
      cpuTimeMs += child.cpuMs;
    }
  }
  return { rssMb, cpuTimeMs, pids: [...seen] };
}

export async function arePidsAlive(pids: number[]): Promise<number[]> {
  if (!pids.length) return [];
  const processes = await listProcesses();
  const alive = new Set(processes.map((proc) => proc.pid));
  return pids.filter((pid) => alive.has(pid));
}
