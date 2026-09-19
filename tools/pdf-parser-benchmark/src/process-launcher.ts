import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The single process-creation choke point of the benchmark harness.
 *
 * Security model:
 * - argument-list execution only; a shell is never involved on any platform;
 * - every execFile call site below passes a literal absolute executable path
 *   chosen by an exhaustive switch — no dynamically composed executable
 *   strings exist in this module;
 * - argv arrays carry all parameters (fixture paths, output dirs, flags);
 * - the "node" entry must equal the running interpreter and is verified at
 *   startup, so the benchmark cannot be relocated under a different runtime
 *   without an explicit update to this file.
 */

const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";

export type ProgramId = "node" | "docling_python" | "mineru_cli";

export function verifyRuntime(): void {
  if (process.execPath.toLowerCase() !== NODE_EXE.toLowerCase()) {
    throw new Error(`NODE_RUNTIME_MISMATCH: expected ${NODE_EXE}, running ${process.execPath}`);
  }
}

export type LaunchedProcess = {
  pid: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  onExit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
};

type LaunchOptions = { cwd: string; env?: Record<string, string> };

function describe(child: ChildProcess): LaunchedProcess {
  return {
    pid: child.pid!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    onExit: (listener) => {
      child.on("error", () => listener(null, null));
      child.on("close", (code, signal) => listener(code, signal));
    },
  };
}

const LAUNCH_ENV = (options: LaunchOptions): NodeJS.ProcessEnv => ({ ...process.env, ...options.env });

/** Exhaustive dispatch; each branch embeds its own literal executable path. */
export function launch(programId: ProgramId, argv: string[], options: LaunchOptions): LaunchedProcess {
  switch (programId) {
    case "node": {
      const child = execFile(
        "C:\\Program Files\\nodejs\\node.exe",
        argv,
        { cwd: options.cwd, env: LAUNCH_ENV(options), windowsHide: true, timeout: 0 },
        () => undefined,
      );
      return describe(child);
    }
    case "docling_python": {
      const child = execFile(
        "D:\\ai-cognitive-pdf-benchmark-data\\python\\docling\\Scripts\\python.exe",
        argv,
        { cwd: options.cwd, env: LAUNCH_ENV(options), windowsHide: true, timeout: 0 },
        () => undefined,
      );
      return describe(child);
    }
    case "mineru_cli": {
      const child = execFile(
        "D:\\ai-cognitive-pdf-benchmark-data\\python\\mineru\\Scripts\\mineru.exe",
        argv,
        { cwd: options.cwd, env: LAUNCH_ENV(options), windowsHide: true, timeout: 0 },
        () => undefined,
      );
      return describe(child);
    }
  }
}

/** Windows process-tree termination: taskkill /T walks child processes. */
export async function terminateTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 15_000 });
  } catch {
    // already gone — fine
  }
}

export function nodeExePath(): string {
  return NODE_EXE;
}
