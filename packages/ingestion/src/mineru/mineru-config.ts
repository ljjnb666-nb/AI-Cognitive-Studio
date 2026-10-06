import { statSync } from "node:fs";
import { hostname } from "node:os";
import { join, isAbsolute, resolve, dirname, sep } from "node:path";
import type { Environment } from "@ai-cognitive/shared/server";
import { MINERU_EXECUTOR_NAME, MINERU_PINNED_TIER, MINERU_PINNED_VERSION } from "./mineru-commands.js";

/**
 * Explicit production runtime configuration for the real MinerU OCR executor
 * (BOOK-INGESTION-04B-3).
 *
 * Contract:
 *  - No configuration → null → production keeps the 04B-2 no-OCR behavior
 *    (EPUB/native PDFs are unaffected; OCR-routed PDFs end OCR_REQUIRED).
 *  - ANY MinerU variable set without OCR_PROVIDER is malformed explicit
 *    configuration → fail fast (an ignored half-configuration must never
 *    silently disable OCR).
 *  - OCR_PROVIDER=mineru requires MINERU_MODEL_SOURCE=local (network model
 *    sources are banned; "auto" performs a live HF probe per 04B-0 evidence)
 *    and an existing local model root; MINERU_TIER is pinned to "flash" in v1
 *    (the only benchmarked production tier). Violations fail fast at startup —
 *    never a silent fallback that could enable network behavior.
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
  /** Pinned MinerU version recorded in the executor descriptor provenance. */
  version: string;
  /** OCR host capacity slot id (OcrHostLease.hostId). */
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
  /** Delay before a capacity-conflicted page attempt may retry. */
  capacityRetryDelayMs: number;
  /** Host-lease heartbeat cadence override (tests only; default OCR_HOST_LEASE_TTL_MS/3). */
  heartbeatIntervalMs?: number;
  /**
   * Live-image guard pattern for the recorded-endpoint pid (pid-reuse guard).
   * Production pins the python interpreter (04B-0: the doclib server is a
   * python process); tests substitute their double's runtime.
   */
  processImagePattern?: RegExp;
};

const MINERU_VARIABLES = ["MINERU_EXECUTABLE", "MINERU_MODEL_SOURCE", "MINERU_MODEL_PATH", "MINERU_TIER", "MINERU_VERSION", "MINERU_TIMEOUT_MS", "MINERU_SERVER_START_TIMEOUT_MS", "MINERU_SERVER_STOP_TIMEOUT_MS", "MINERU_HOME_ROOT", "MINERU_MAX_OUTPUT_BYTES", "MINERU_CAPACITY_RETRY_DELAY_MS"] as const;

export type ResolveMineruConfigOptions = {
  /** Injectable PATH search root list (defaults to the process PATH). */
  pathDirectories?: string[];
  /** Injectable filesystem predicate for tests. */
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
  return pathValue.split(";").filter((entry) => entry.trim().length > 0);
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
    const orphans = MINERU_VARIABLES.filter((variable) => (environment as unknown as Record<string, unknown>)[variable] !== undefined);
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

  const homeRoot = environment.MINERU_HOME_ROOT ?? join(resolve(tmpRoot()), MINERU_EXECUTOR_NAME);
  if (homeRoot.endsWith(sep) || homeRoot.length < 4) throw new Error("OCR_HOME_ROOT_INVALID");
  const modelPath = resolve(environment.MINERU_MODEL_PATH);
  if (isWithin(modelPath, homeRoot)) throw new Error("OCR_HOME_ROOT_INVALID:MODEL_PATH_MUST_BE_OUTSIDE_CLAIM_TEMP_ROOT");

  return {
    executable,
    executableArgs,
    modelPath,
    modelSource: "local",
    tier: MINERU_PINNED_TIER,
    version: environment.MINERU_VERSION ?? MINERU_PINNED_VERSION,
    hostId: environment.OCR_HOST_ID ?? `mineru-${hostname()}`,
    homeRoot,
    timeoutMs: environment.MINERU_TIMEOUT_MS ?? 300_000,
    serverStartTimeoutMs: environment.MINERU_SERVER_START_TIMEOUT_MS ?? 180_000,
    serverStopTimeoutMs: environment.MINERU_SERVER_STOP_TIMEOUT_MS ?? 60_000,
    maxOutputBytes: environment.MINERU_MAX_OUTPUT_BYTES ?? 4_000_000,
    capacityRetryDelayMs: environment.MINERU_CAPACITY_RETRY_DELAY_MS ?? 30_000,
  };
}

function tmpRoot(): string {
  // Lazy import avoidance: keep the module dependency surface sync-friendly.
  return process.env.TMP ?? process.env.TEMP ?? (process.platform === "win32" ? join(process.env.SystemDrive ?? "C:", "Temp") : "/tmp");
}

/** True when candidate equals or lives inside directory. */
export function isWithin(candidate: string, directory: string): boolean {
  const candidateAbsolute = resolve(candidate);
  const directoryAbsolute = resolve(directory);
  const relative = candidateAbsolute.slice(directoryAbsolute.length);
  return candidateAbsolute.startsWith(directoryAbsolute) && (relative === "" || relative.startsWith(sep) || relative.startsWith("/"));
}

export { dirname };
