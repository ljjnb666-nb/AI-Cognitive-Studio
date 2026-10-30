import { isApprovedMineruManifest } from "./mineru-approved-inventory.js";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { OCR_STANDARD_MIN_AVAILABLE_MEMORY_BYTES } from "../ocr-step6-2a.js";
import { MINERU_PINNED_VERSION } from "./mineru-commands.js";

/**
 * STEP6-2B-1: guarded MinerU STANDARD execution admission (default off).
 *
 * Authority boundary (Candidate / Admission / Authority):
 *  - Candidate  = STEP6-1 tier decision (a proposal, never execution).
 *  - Admission  = THIS module + the runtime recheck inside the executor:
 *    double experiment switch, verified local model manifest identity, source
 *    byte-identity recheck, and a live memory floor. Admission still grants
 *    nothing on its own.
 *  - Authority  = the EXISTING 04B-3 machinery, unchanged: run execution
 *    claim token, OcrPageAttempt claim, host lease, per-claim server
 *    lifecycle, attempt budget, fenced completions.
 *
 * Nothing here weakens the flash default: standard admission state exists in
 * the executor config ONLY when both experiment flags are explicitly "true"
 * AND a manifest verifies against the pinned MinerU 4.0.3 local model root.
 * A page refused at runtime recheck demotes to the pinned flash tier — the
 * exact pre-slice production behaviour — and the refusal is recorded in the
 * execution facts, never silently dropped.
 *
 * Trust model for STEP6-2A interop: 2A's raster-evidence claim cannot be
 * honestly produced in v1 (the trusted path has no page rasterizer), so this
 * module implements the runtime admission on facts the executor CAN verify
 * itself. 2A stays the pure planning gate it was merged as.
 */

export const MINERU_STANDARD_TIER = "standard" as const;
export const MINERU_STANDARD_MANIFEST_ENV = "MINERU_STANDARD_MODEL_MANIFEST" as const;
export const MINERU_STANDARD_MIN_FREE_MEMORY_BYTES_ENV = "MINERU_STANDARD_MIN_FREE_MEMORY_BYTES" as const;
export const MINERU_STANDARD_TIMEOUT_MS_ENV = "MINERU_STANDARD_TIMEOUT_MS" as const;

export const MINERU_STANDARD_MANIFEST_SCHEMA = "mineru-standard-manifest-v1" as const;
/** Default standard budget: the 1.2B VLM cold path is far slower than flash. */
export const MINERU_STANDARD_DEFAULT_TIMEOUT_MS = 600_000;
export const MINERU_STANDARD_DEFAULT_MIN_FREE_MEMORY_BYTES = OCR_STANDARD_MIN_AVAILABLE_MEMORY_BYTES;
export const MINERU_STANDARD_MAX_TIMEOUT_MS = 3_600_000;
export const MINERU_STANDARD_MAX_MIN_FREE_MEMORY_BYTES = 68_719_476_736; // 64 GiB sanity ceiling
export const MINERU_STANDARD_MANIFEST_MAX_FILES = 64;
export const MINERU_STANDARD_MANIFEST_MAX_FILE_BYTES = 2_147_483_648; // 2 GiB per model file
export const MINERU_STANDARD_MANIFEST_MAX_TOTAL_BYTES = 8_589_934_592; // 8 GiB per manifest

export type MineruStandardManifestFile = { path: string; sha256: string; sizeBytes: number };
export type MineruStandardManifest = {
  schemaVersion: typeof MINERU_STANDARD_MANIFEST_SCHEMA;
  mineruVersion: typeof MINERU_PINNED_VERSION;
  files: MineruStandardManifestFile[];
};

const isSha256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/**
 * Conservative manifest path charset: forward slashes only, no drive letters,
 * no dots-only segments, no "..", no leading/trailing slash. This makes path
 * traversal structurally impossible before any filesystem contact.
 */
const MANIFEST_PATH_PATTERN = /^(?!\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
function isSafeManifestPath(value: string): boolean {
  if (!MANIFEST_PATH_PATTERN.test(value) || value.includes("//")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Strict manifest parse: null on ANY structural deviation (untrusted file content). */
export function parseMineruStandardManifest(raw: string): MineruStandardManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const manifest = value as Partial<MineruStandardManifest> | null;
  if (!manifest || typeof manifest !== "object") return null;
  if (manifest.schemaVersion !== MINERU_STANDARD_MANIFEST_SCHEMA) return null;
  if (manifest.mineruVersion !== MINERU_PINNED_VERSION) return null;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MINERU_STANDARD_MANIFEST_MAX_FILES) return null;
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of manifest.files) {
    const entry = file as Partial<MineruStandardManifestFile> | null;
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.path !== "string" || !isSafeManifestPath(entry.path)) return null;
    if (!isSha256(entry.sha256)) return null;
    if (typeof entry.sizeBytes !== "number" || !Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes < 0 || (entry.sizeBytes === 0 && !entry.path.endsWith("/.mineru_complete"))) || entry.sizeBytes > MINERU_STANDARD_MANIFEST_MAX_FILE_BYTES) return null;
    if (seen.has(entry.path)) return null;
    seen.add(entry.path);
    totalBytes += entry.sizeBytes;
  }
  if (totalBytes > MINERU_STANDARD_MANIFEST_MAX_TOTAL_BYTES) return null;
  return { schemaVersion: MINERU_STANDARD_MANIFEST_SCHEMA, mineruVersion: MINERU_PINNED_VERSION, files: manifest.files.map((file) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes })) };
}

export type MineruStandardAdmissionConfig = {
  /** Absolute path of the verified manifest file (audit identity). */
  manifestPath: string;
  manifest: MineruStandardManifest;
  /** SHA-256 of the exact manifest bytes — the model identity recorded per execution. */
  manifestSha256: string;
  /** Runtime safety reserve may only be raised above the fixed 1 GiB floor. */
  minRuntimeFreeMemoryBytes?: number;
  minFreeMemoryBytes: number;
  timeoutMs: number;
};

const isPositiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Resolves the standard admission configuration from the environment.
 * Returns null when standard is not requested (manifest variable absent).
 * Throws (fail fast, never half-configured) on any malformed value.
 * The double experiment switch state is a STRUCTURAL precondition owned by the
 * caller (mineru-config): this config may only exist when both flags are on.
 */
export function parseMineruStandardAdmissionConfig(
  environment: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string,
): MineruStandardAdmissionConfig | null {
  const manifestPathRaw = environment[MINERU_STANDARD_MANIFEST_ENV];
  if (manifestPathRaw === undefined) return null;
  if (manifestPathRaw.trim().length === 0) throw new Error(`OCR_STANDARD_MANIFEST_INVALID:${MINERU_STANDARD_MANIFEST_ENV}`);
  const manifestPath = resolve(manifestPathRaw);

  let raw: string;
  try {
    raw = readFile(manifestPath);
  } catch {
    throw new Error(`OCR_STANDARD_MANIFEST_UNREADABLE:${manifestPath}`);
  }
  const manifest = parseMineruStandardManifest(raw);
  if (!manifest) throw new Error(`OCR_STANDARD_MANIFEST_INVALID:${manifestPath}`);
  const manifestSha256 = createHash("sha256").update(raw, "utf8").digest("hex");

  const minFreeRaw = environment[MINERU_STANDARD_MIN_FREE_MEMORY_BYTES_ENV];
  let minFreeMemoryBytes = MINERU_STANDARD_DEFAULT_MIN_FREE_MEMORY_BYTES;
  if (minFreeRaw !== undefined) {
    const parsed = Number(minFreeRaw);
    if (!isPositiveSafeInteger(parsed) || parsed > MINERU_STANDARD_MAX_MIN_FREE_MEMORY_BYTES) throw new Error(`OCR_STANDARD_CONFIG_INVALID:${MINERU_STANDARD_MIN_FREE_MEMORY_BYTES_ENV}`);
    minFreeMemoryBytes = parsed;
  }
  const timeoutRaw = environment[MINERU_STANDARD_TIMEOUT_MS_ENV];
  let timeoutMs = MINERU_STANDARD_DEFAULT_TIMEOUT_MS;
  if (timeoutRaw !== undefined) {
    const parsed = Number(timeoutRaw);
    if (!isPositiveSafeInteger(parsed) || parsed > MINERU_STANDARD_MAX_TIMEOUT_MS) throw new Error(`OCR_STANDARD_CONFIG_INVALID:${MINERU_STANDARD_TIMEOUT_MS_ENV}`);
    timeoutMs = parsed;
  }
  return { manifestPath, manifest, manifestSha256, minFreeMemoryBytes, timeoutMs };
}

export type MineruStandardModelsFailure = { path: string; reason: string };
export type MineruStandardModelsVerification =
  | { ok: true; filesChecked: number; totalBytes: number }
  | { ok: false; failures: MineruStandardModelsFailure[] };

/** Mirrors mineru-config.isWithinPath (kept local to avoid a config<->admission import cycle). */
function pathWithinRoot(candidate: string, root: string): boolean {
  const normalize = (value: string) => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value));
  const candidateNormalized = normalize(candidate);
  const rootNormalized = normalize(root);
  const relative = candidateNormalized.slice(rootNormalized.length);
  return candidateNormalized.startsWith(rootNormalized) && (relative === "" || relative.startsWith(sep) || relative.startsWith("/"));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const chunkSize = 4 * 1024 * 1024;
    const buffer = Buffer.alloc(chunkSize);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === chunkSize ? buffer : buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest("hex");
}

/**
 * Verifies every manifest file inside the immutable local model root: strict
 * containment, exact size, full streaming SHA-256. Called ONCE at worker
 * startup — a single mismatch refuses the whole standard admission (the
 * executor factory additionally refuses to start standard work without this
 * proof). Model files are never modified by this check.
 */
export async function verifyMineruStandardModels(modelRoot: string, admission: MineruStandardAdmissionConfig): Promise<MineruStandardModelsVerification> {
  if (!isApprovedMineruManifest(admission.manifest)) return { ok:false, failures:[{path:"<manifest>",reason:"UNAPPROVED_MODEL_INVENTORY"}] };
  return verifyMineruModelFiles(modelRoot, admission);
}

/** File verifier only. This does not grant production model approval. */
export async function verifyMineruModelFiles(modelRoot: string, admission: MineruStandardAdmissionConfig): Promise<MineruStandardModelsVerification> {
  const failures: MineruStandardModelsFailure[] = [];
  let totalBytes = 0;
  let physicalRoot: string;
  try {
    physicalRoot = await realpath(modelRoot);
  } catch {
    return { ok: false, failures: [{ path: "<model-root>", reason: "MODEL_ROOT_UNAVAILABLE" }] };
  }
  for (const file of admission.manifest.files) {
    const candidate = resolve(modelRoot, ...file.path.split("/"));
    if (!pathWithinRoot(candidate, modelRoot)) {
      failures.push({ path: file.path, reason: "ESCAPES_MODEL_ROOT" });
      continue;
    }
    let info;
    let physicalCandidate: string;
    try {
      // lstat rejects a symlink at the final file; realpath also detects
      // symlinked ancestor directories escaping the verified model root.
      info = await lstat(candidate);
      physicalCandidate = await realpath(candidate);
    } catch {
      failures.push({ path: file.path, reason: "MISSING" });
      continue;
    }
    if (info.isSymbolicLink() || !pathWithinRoot(physicalCandidate, physicalRoot)) {
      failures.push({ path: file.path, reason: "SYMLINK_OR_ROOT_ESCAPE" });
      continue;
    }
    if (!info.isFile()) {
      failures.push({ path: file.path, reason: "NOT_A_REGULAR_FILE" });
      continue;
    }
    if (info.size !== file.sizeBytes) {
      failures.push({ path: file.path, reason: `SIZE_MISMATCH:${info.size}!=${file.sizeBytes}` });
      continue;
    }
    let digest: string;
    try {
      digest = await sha256File(candidate);
    } catch {
      failures.push({ path: file.path, reason: "UNREADABLE" });
      continue;
    }
    if (digest !== file.sha256) {
      failures.push({ path: file.path, reason: "HASH_MISMATCH" });
      continue;
    }
    totalBytes += file.sizeBytes;
  }
  return failures.length === 0 ? { ok: true, filesChecked: admission.manifest.files.length, totalBytes } : { ok: false, failures };
}

// ---------------------------------------------------------------------------
// Per-page runtime admission recheck (executor-side, trusted facts only).
// ---------------------------------------------------------------------------

export const MINERU_STANDARD_EXECUTION_REASONS = [
  "ADMITTED",
  "STANDARD_NOT_REQUESTED",
  "MODELS_UNVERIFIED",
  "SOURCE_CLAIM_ABSENT",
  "SOURCE_CLAIM_INVALID",
  "SOURCE_HASH_MISMATCH",
  "MEMORY_INSUFFICIENT",
  /** Executor-level: claim doclib has no standard engines (2B-2 bootstrap pending). */
  "ENGINES_NOT_READY",
] as const;
export type MineruStandardExecutionReason = (typeof MINERU_STANDARD_EXECUTION_REASONS)[number];

export type MineruStandardExecutionRecheck = {
  admitted: boolean;
  reason: MineruStandardExecutionReason;
  manifestSha256: string | null;
};

/**
 * The executor's trusted per-page recheck, on facts it verifies itself:
 *  1. admission config exists (structurally implies BOTH experiment switches)
 *  2. startup model verification proof was provided to the executor factory
 *  3. the page request carries a source claim (hex SHA-256)
 *  4. the executor's OWN hash of the exact pdfBytes equals that claim
 *     (byte-identity of source; page lineage is the --pages selector)
 *  5. live free memory still meets the configured floor
 * A refusal demotes the page to the pinned flash tier — never an error, never
 * a silent standard run.
 */
export function assessMineruStandardExecution(input: {
  admissionConfig: MineruStandardAdmissionConfig | null;
  modelsVerified: boolean;
  sourceClaim: string | null;
  actualSourceSha256: string | null;
  availableMemoryBytes: number;
}): MineruStandardExecutionRecheck {
  if (!input.admissionConfig) return { admitted: false, reason: "STANDARD_NOT_REQUESTED", manifestSha256: null };
  const manifestSha256 = input.admissionConfig.manifestSha256;
  if (!input.modelsVerified) return { admitted: false, reason: "MODELS_UNVERIFIED", manifestSha256 };
  if (input.sourceClaim === null) return { admitted: false, reason: "SOURCE_CLAIM_ABSENT", manifestSha256 };
  if (!isSha256(input.sourceClaim)) return { admitted: false, reason: "SOURCE_CLAIM_INVALID", manifestSha256 };
  if (input.actualSourceSha256 === null || input.actualSourceSha256 !== input.sourceClaim) return { admitted: false, reason: "SOURCE_HASH_MISMATCH", manifestSha256 };
  if (input.availableMemoryBytes < input.admissionConfig.minFreeMemoryBytes) return { admitted: false, reason: "MEMORY_INSUFFICIENT", manifestSha256 };
  return { admitted: true, reason: "ADMITTED", manifestSha256 };
}

/** SHA-256 over raw bytes (the source-identity digest used by both sides). */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
