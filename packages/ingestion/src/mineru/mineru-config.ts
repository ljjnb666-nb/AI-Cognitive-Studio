import { statSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { Environment } from "@ai-cognitive/shared/server";
import { MINERU_EXECUTOR_NAME, MINERU_PINNED_TIER, MINERU_PINNED_VERSION } from "./mineru-commands.js";

/**
 * Explicit production runtime configuration for the real MinerU OCR executor
 * (BOOK-INGESTION-04B-3, hardened in 04B-3 RF01).
 *
 * Contract:
 *  - No configuration → null → production keeps the 04B-2 no-OCR behavior
 *    (EPUB/native PDFs are unaffected; OCR-routed PDFs end OCR_REQUIRED).
 *  - ANY recognized MinerU/OCR variable set without OCR_PROVIDER is malformed
 *    explicit configuration → fail fast (an ignored half-configuration must
 *    never silently disable OCR).
 *  - OCR_PROVIDER=mineru requires MINERU_MODEL_SOURCE=local (network model
 *    sources are banned; "auto" performs a live HF probe per 04B-0 evidence)
 *    and an existing local model root; MINERU_TIER is pinned to "flash" in v1
 *    (the only benchmarked production tier). Violations fail fast at startup —
 *    never a silent fallback that could enable network behavior.
 *  - MinerU 4.0.3 is the ONLY accepted production version. Provenance is the
 *    pinned constant; a declared MINERU_VERSION never alters it, and the
 *    configured executable+wrapper is probed via argv execution
 *    (verifyMineruRuntime) before the worker accepts OCR work.
 *  - Model root and per-claim temp home root must be disjoint (both
 *    containment directions and equality; Windows case-insensitive).
 *  - Model-repo COMPLETENESS is a bounded deterministic runtime failure
 *    (SOURCE_OCR_MODEL_NOT_FOUND); only the configured root's existence is a
 *    startup concern.
 */

export type MineruExecutorConfig = {
  /** Absolute path of the pinned MinerU executable (resolved at startup). */
  executable: string;
  /** Fixed argv prefix for every child invocation (wrapped runtimes, e.g. a venv python -m entry). Empty for a direct executable. */
  executableArgs: string[];
  /** Shared immutable local model root (MINERU_MODEL_BASE_DIR for children). */
  modelPath: string;
  modelSource: "local";
  tier: typeof MINERU_PINNED_TIER;
  hostId: string;
  /** Root under which per-claim MINERU_HOME/temp directories are created. */
  homeRoot: string;
  /** Hard timeout for one bounded parse invocation. */
  timeoutMs: number;
  /** Hard timeout for a claim-scoped doclib server start. */
  serverStartTimeoutMs: number;
  /** Hard timeout for the graceful server stop (guarded kill follows). */
  serverStopTimeoutMs: number;
  /** Bounded cap for MinerU markdown output. */
  maxOutputBytes: number;
  /**
   * MinerU version recorded in the executor descriptor provenance. It is the
   * PINNED production contract constant — never operator-declared text — and
   * verifyMineruRuntime must have proven the runtime reports exactly it.
   */
  version: typeof MINERU_PINNED_VERSION;
  /** Host-lease heartbeat cadence override (tests only; default OCR_HOST_LEASE_TTL_MS/3). */
  heartbeatIntervalMs?: number;
  /**
   * Live-image guard pattern for the recorded-endpoint pid (a NECESSARY
   * condition only; production pins the python interpreter, tests substitute
   * their double's runtime). RF01 P1-05: the image match alone is explicitly
   * NOT the pid-reuse guard — the creation-time fingerprint is.
   */
  processImagePattern?: RegExp;
};

/** Recognized OCR/MinerU variables: set WITHOUT OCR_PROVIDER they fail fast (RF01 P2: includes args/host id; MINERU_VERSION is recognized but never alters provenance). */
const OCR_VARIABLES = ["OCR_HOST_ID", "MINERU_EXECUTABLE", "MINERU_EXECUTABLE_ARGS", "MINERU_MODEL_SOURCE", "MINERU_MODEL_PATH", "MINERU_TIER", "MINERU_VERSION", "MINERU_TIMEOUT_MS", "MINERU_SERVER_START_TIMEOUT_MS", "MINERU_SERVER_STOP_TIMEOUT_MS", "MINERU_HOME_ROOT", "MINERU_MAX_OUTPUT_BYTES"] as const;

export type ResolveMineruConfigOptions = {
  /** Injectable PATH search root list (defaults to the process PATH). */
  pathDirectories?: string[];
  /** Injectable filesystem predicates for tests. */
  fileExists?: (path: string) => boolean;
  directoryExists?: (path: string) => boolean;
};

const defaultFileExists = (path: string): boolean => {
  try { return statSync(path).isFile(); } catch { return false; }
};
const defaultDirectoryExists = (path: string): boolean => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/** Resolves a bare executable name against PATH (Windows: with .exe siblings). */
function resolveExecutable(name: string, pathDirectories: string[], fileExists: (path: string) => boolean): string | null {
  if (name.includes("/") || name.includes("\\") || isAbsolute(name)) {
    const candidate = resolve(name);
    return fileExists(candidate) ? candidate : null;
  }
  const extensions = process.platform === "win32" && !name.toLowerCase().endsWith(".exe") ? ["", ".exe"] : [""];
  for (const directory of pathDirectories) {
    for (const extension of extensions) {
      const candidate = join(directory, name + extension);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function processPathDirectories(): string[] {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  return pathValue.split(delimiter).filter((entry) => entry.trim().length > 0);
}

/**
 * Case-aware containment/equality test (RF01 P1-09): Windows path semantics
 * are case-insensitive, so comparison lowercases there; every candidate that
 * equals the directory or lives inside it matches.
 */
export function isWithinPath(candidate: string, directory: string): boolean {
  const normalize = (value: string) => {
    const resolved = resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const candidateNormalized = normalize(candidate);
  const directoryNormalized = normalize(directory);
  const relative = candidateNormalized.slice(directoryNormalized.length);
  return candidateNormalized.startsWith(directoryNormalized) && (relative === "" || relative.startsWith(sep) || relative.startsWith("/"));
}

/**
 * Resolves the production OCR executor configuration, or null when OCR is
 * intentionally unconfigured. Throws (fail fast) on malformed explicit
 * configuration. Never falls back to network-capable defaults.
 */
export function resolveMineruExecutorConfig(environment: Environment, options: ResolveMineruConfigOptions = {}): MineruExecutorConfig | null {
  const fileExists = options.fileExists ?? defaultFileExists;
  const directoryExists = options.directoryExists ?? defaultDirectoryExists;
  const pathDirectories = options.pathDirectories ?? processPathDirectories();

  if (environment.OCR_PROVIDER !== "mineru") {
    const orphans = OCR_VARIABLES.filter((variable) => (environment as unknown as Record<string, unknown>)[variable] !== undefined);
    if (orphans.length > 0) throw new Error(`OCR_PROVIDER_REQUIRED:${orphans.join(",")}`);
    return null;
  }

  if (environment.MINERU_MODEL_SOURCE !== "local") throw new Error("OCR_MODEL_SOURCE_INVALID:MINERU_MODEL_SOURCE_MUST_BE_LOCAL");
  if (environment.MINERU_TIER !== undefined && environment.MINERU_TIER !== MINERU_PINNED_TIER) throw new Error(`OCR_TIER_UNSUPPORTED:${environment.MINERU_TIER}`);
  if (!environment.MINERU_MODEL_PATH) throw new Error("OCR_MODEL_PATH_REQUIRED");
  if (!directoryExists(environment.MINERU_MODEL_PATH)) throw new Error(`OCR_MODEL_PATH_INVALID:${environment.MINERU_MODEL_PATH}`);

  const executableName = environment.MINERU_EXECUTABLE ?? "mineru";
  const executable = resolveExecutable(executableName, pathDirectories, fileExists);
  if (!executable) throw new Error(`OCR_EXECUTABLE_NOT_FOUND:${executableName}`);
  let executableArgs: string[] = [];
  if (environment.MINERU_EXECUTABLE_ARGS !== undefined) {
    try {
      const parsed: unknown = JSON.parse(environment.MINERU_EXECUTABLE_ARGS);
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("not a string array");
      executableArgs = parsed;
    } catch {
      throw new Error("OCR_EXECUTABLE_ARGS_INVALID:MINERU_EXECUTABLE_ARGS_MUST_BE_JSON_STRING_ARRAY");
    }
  }

  const homeRoot = resolve(environment.MINERU_HOME_ROOT ?? join(resolve(tmpRoot()), MINERU_EXECUTOR_NAME));
  if (homeRoot.endsWith(sep) || homeRoot.length < 4) throw new Error("OCR_HOME_ROOT_INVALID");
  const modelPath = resolve(environment.MINERU_MODEL_PATH);
  // RF01 P1-09: the immutable model root and the mutable per-claim temp root
  // must be disjoint in BOTH containment directions and never equal — in
  // either overlap, per-claim mutable MinerU state would live inside the
  // supposedly immutable model tree.
  if (isWithinPath(modelPath, homeRoot) || isWithinPath(homeRoot, modelPath)) throw new Error("OCR_PATH_OVERLAP:MODEL_ROOT_AND_CLAIM_TEMP_ROOT_MUST_BE_DISJOINT");

  return {
    executable,
    executableArgs,
    modelPath,
    modelSource: "local",
    tier: MINERU_PINNED_TIER,
    version: MINERU_PINNED_VERSION,
    hostId: environment.OCR_HOST_ID ?? `mineru-${hostname()}`,
    homeRoot,
    timeoutMs: environment.MINERU_TIMEOUT_MS ?? 300_000,
    serverStartTimeoutMs: environment.MINERU_SERVER_START_TIMEOUT_MS ?? 180_000,
    serverStopTimeoutMs: environment.MINERU_SERVER_STOP_TIMEOUT_MS ?? 60_000,
    maxOutputBytes: environment.MINERU_MAX_OUTPUT_BYTES ?? 4_000_000,
  };
}

function tmpRoot(): string {
  return process.env.TMP ?? process.env.TEMP ?? (process.platform === "win32" ? join(process.env.SystemDrive ?? "C:", "Temp") : "/tmp");
}

export type MineruRuntimeVerification = { version: string };

/**
 * Proves the CONFIGURED executable+wrapper (same argv prefix as production
 * children) actually reports the pinned MinerU version. Argv execution only —
 * never shell text. Called at worker startup before OCR work is accepted;
 * a mismatching or malformed runtime fails fast (RF01 P1-08).
 */
export function verifyMineruRuntime(config: MineruExecutorConfig, options: { timeoutMs?: number } = {}): Promise<MineruRuntimeVerification> {
  return new Promise((resolveVerification, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.executable, [...config.executableArgs, "--version"], { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(new Error(`OCR_EXECUTABLE_NOT_FOUND:${config.executable}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        // First version-like token in the MinerU version line is the contract;
        // "4.0.3-fake" test doubles still resolve to their 4.0.3 base.
        const detected = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
        if (!detected) reject(new Error(`OCR_VERSION_UNVERIFIABLE:${stdout.slice(0, 200) || "empty"}`));
        else if (detected !== MINERU_PINNED_VERSION) reject(new Error(`OCR_VERSION_MISMATCH:${detected}`));
        else resolveVerification({ version: detected });
      }
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error("OCR_VERSION_PROBE_TIMEOUT"));
    }, options.timeoutMs ?? 30_000);
    child.stdout!.on("data", (chunk: Buffer) => { if (stdout.length < 8192) stdout += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? new Error(`OCR_EXECUTABLE_NOT_FOUND:${config.executable}`) : new Error("OCR_VERSION_PROBE_FAILED")));
    child.on("close", (code) => {
      if (code !== 0) finish(new Error(`OCR_VERSION_PROBE_FAILED:${stderr.slice(0, 200)}`));
      else finish();
    });
  });
}
