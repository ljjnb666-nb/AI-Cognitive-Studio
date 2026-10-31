import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStep62aConfig } from "../../src/ocr-step6-2a.js";
import { parseOcrTierPolicyConfig, OCR_TIER_STANDARD_EXPERIMENTAL_ENV } from "../../src/ocr-tier-policy.js";
import { OCR_STANDARD_EXECUTION_ADMISSION_ENV } from "../../src/ocr-step6-2a.js";
import { MINERU_PINNED_TIER, MINERU_PINNED_VERSION } from "../../src/mineru/mineru-commands.js";
import { createMineruPdfOcrExecutor } from "../../src/mineru/mineru-executor.js";
import { resolveMineruExecutorConfig, type MineruExecutorConfig } from "../../src/mineru/mineru-config.js";
import {
  assessMineruStandardExecution,
  MINERU_STANDARD_MANIFEST_ENV,
  MINERU_STANDARD_MIN_FREE_MEMORY_BYTES_ENV,
  MINERU_STANDARD_TIMEOUT_MS_ENV,
  parseMineruStandardAdmissionConfig,
  parseMineruStandardManifest,
  sha256Bytes,
  verifyMineruStandardModels,
  type MineruStandardAdmissionConfig,
} from "../../src/mineru/mineru-standard-admission.js";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mineru-std-admission-"));
  tempRoots.push(dir);
  return dir;
}

const hex64 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function manifestJson(files: Array<{ path: string; sha256?: string; sizeBytes?: number }>, mineruVersion = MINERU_PINNED_VERSION): string {
  return JSON.stringify({
    schemaVersion: "mineru-standard-manifest-v1",
    mineruVersion,
    files: files.map((file) => ({ path: file.path, sha256: file.sha256 ?? hex64(file.path), sizeBytes: file.sizeBytes ?? 100 })),
  });
}

describe("mineru standard manifest strictness (untrusted content)", () => {
  it("accepts a well-formed manifest", () => {
    const manifest = parseMineruStandardManifest(manifestJson([{ path: "OCR/det.onnx" }, { path: "VLM/model.gguf", sizeBytes: 1_000 }]));
    expect(manifest).not.toBeNull();
    expect(manifest!.files).toHaveLength(2);
  });

  it("rejects traversal, absolute, and backslash paths structurally", () => {
    for (const bad of ["../escape.onnx", "a/../../b.onnx", "/abs.onnx", "C:\\abs.onnx", "a\\b.onnx", "./rel.onnx", "a//b.onnx", "a/", ""]) {
      expect(parseMineruStandardManifest(manifestJson([{ path: bad }]))).toBeNull();
    }
  });

  it("rejects wrong schema, wrong version, bad hashes, bad sizes, duplicates, and empties", () => {
    expect(parseMineruStandardManifest(manifestJson([{ path: "a.onnx" }], "4.0.4"))).toBeNull();
    expect(parseMineruStandardManifest('{"schemaVersion":"mineru-standard-manifest-v1","mineruVersion":"4.0.3","files":[]}')).toBeNull();
    expect(parseMineruStandardManifest(manifestJson([{ path: "a.onnx", sha256: "zz" }]))).toBeNull();
    expect(parseMineruStandardManifest(manifestJson([{ path: "a.onnx", sizeBytes: 0 }]))).toBeNull();
    expect(parseMineruStandardManifest(manifestJson([{ path: "a.onnx", sizeBytes: 2_147_483_649 }]))).toBeNull();
    expect(parseMineruStandardManifest(manifestJson([{ path: "a.onnx" }, { path: "a.onnx" }]))).toBeNull();
    expect(parseMineruStandardManifest("not json")).toBeNull();
  });
});

describe("mineru standard admission config parsing", () => {
  const readFileOk = () => manifestJson([{ path: "a.onnx", sha256: hex64("body-a"), sizeBytes: 5 }]);

  it("returns null when standard is not requested", () => {
    expect(parseMineruStandardAdmissionConfig({}, readFileOk)).toBeNull();
  });

  it("parses a valid manifest with defaults and records its digest", () => {
    const config = parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "manifest.json" }, () => manifestJson([{ path: "a.onnx" }]));
    expect(config).not.toBeNull();
    expect(config!.manifest.files).toHaveLength(1);
    expect(config!.manifestSha256).toBe(hex64(manifestJson([{ path: "a.onnx" }])));
    expect(config!.minFreeMemoryBytes).toBe(2_684_354_560);
    expect(config!.timeoutMs).toBe(600_000);
  });

  it("fails fast on empty path, unreadable file, invalid manifest, and bad numerics", () => {
    expect(() => parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "  " }, readFileOk)).toThrowError(/OCR_STANDARD_MANIFEST_INVALID/);
    expect(() => parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "x.json" }, () => { throw new Error("missing"); })).toThrowError(/OCR_STANDARD_MANIFEST_UNREADABLE/);
    expect(() => parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "x.json" }, () => "nope")).toThrowError(/OCR_STANDARD_MANIFEST_INVALID/);
    for (const bad of ["0", "-5", "1.5", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "x.json", [MINERU_STANDARD_MIN_FREE_MEMORY_BYTES_ENV]: bad }, readFileOk)).toThrowError(/OCR_STANDARD_CONFIG_INVALID/);
      expect(() => parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "x.json", [MINERU_STANDARD_TIMEOUT_MS_ENV]: bad }, readFileOk)).toThrowError(/OCR_STANDARD_CONFIG_INVALID/);
    }
  });
});

describe("mineru standard model verification (real files)", () => {
  function buildRoot(): { root: string; manifestText: string } {
    const root = tempDir();
    mkdirSync(join(root, "OCR"), { recursive: true });
    writeFileSync(join(root, "OCR", "det.onnx"), "detection-model-bytes");
    writeFileSync(join(root, "model.gguf"), "vlm-model-bytes");
    const hash = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
    const det = "detection-model-bytes";
    const vlm = "vlm-model-bytes";
    const manifestText = JSON.stringify({
      schemaVersion: "mineru-standard-manifest-v1",
      mineruVersion: MINERU_PINNED_VERSION,
      files: [
        { path: "OCR/det.onnx", sha256: hash(det), sizeBytes: Buffer.byteLength(det) },
        { path: "model.gguf", sha256: hash(vlm), sizeBytes: Buffer.byteLength(vlm) },
      ],
    });
    return { root, manifestText };
  }

  it("verifies containment, size, and full sha256 for every file", async () => {
    const { root, manifestText } = buildRoot();
    const admission = parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "m.json" }, () => manifestText)!;
    const verification = await verifyMineruStandardModels(root, admission);
    expect(verification).toEqual({ ok: true, filesChecked: 2, totalBytes: Buffer.byteLength("detection-model-bytes") + Buffer.byteLength("vlm-model-bytes") });
  });

  it.skipIf(process.platform === "win32")("rejects an identical-hash symlinked model file outside the configured root", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "real.onnx"), "verified-model-bytes");
    symlinkSync(join(outside, "real.onnx"), join(root, "linked.onnx"));
    const admission = parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "m.json" }, () =>
      manifestJson([{ path: "linked.onnx", sha256: hex64("verified-model-bytes"), sizeBytes: Buffer.byteLength("verified-model-bytes") }]))!;
    const result = await verifyMineruStandardModels(root, admission);
    expect(result).toEqual({ ok: false, failures: [{ path: "linked.onnx", reason: "SYMLINK_OR_ROOT_ESCAPE" }] });
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked intermediate directory escaping the model root", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "real.onnx"), "verified-model-bytes");
    symlinkSync(outside, join(root, "external"));
    const admission = parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "m.json" }, () =>
      manifestJson([{ path: "external/real.onnx", sha256: hex64("verified-model-bytes"), sizeBytes: Buffer.byteLength("verified-model-bytes") }]))!;
    const result = await verifyMineruStandardModels(root, admission);
    expect(result).toEqual({ ok: false, failures: [{ path: "external/real.onnx", reason: "SYMLINK_OR_ROOT_ESCAPE" }] });
  });

  it("reports MISSING / SIZE_MISMATCH with paths", async () => {
    const { root, manifestText } = buildRoot();
    writeFileSync(join(root, "model.gguf"), "tampered");
    const admission = parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "m.json" }, () => manifestText)!;
    const verification = await verifyMineruStandardModels(root, admission);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.failures.map((failure) => failure.reason)).toEqual([`SIZE_MISMATCH:8!=${Buffer.byteLength("vlm-model-bytes")}`]);
    }
    const missingAdmission = parseMineruStandardAdmissionConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "m.json" }, () => manifestJson([{ path: "gone.onnx" }]))!;
    const missing = await verifyMineruStandardModels(root, missingAdmission);
    expect(missing.ok).toBe(false);
  });
});

describe("claim doclib base URL guard (SSRF)", () => {
  it("accepts only plain-http IPv4 loopback transport URLs", async () => {
    const { parseServerBaseUrl } = await import("../../src/mineru/mineru-standard-server-setup.js");
    expect(parseServerBaseUrl([{ type: "tcp", base_url: "http://127.0.0.1:16580" }])).toBe("http://127.0.0.1:16580");
    expect(parseServerBaseUrl([{ type: "tcp", base_url: "http://127.0.0.1:16580/" }])).toBe("http://127.0.0.1:16580/");
    for (const evil of ["http://169.254.169.254:80", "http://localhost:16580", "https://127.0.0.1:16580", "http://127.0.0.1:99999", "http://127.0.0.1", "file:///etc/passwd", "http://mineru.example:80"]) {
      expect(parseServerBaseUrl([{ type: "tcp", base_url: evil }])).toBeNull();
    }
    expect(parseServerBaseUrl([{ type: "uds", base_url: "http://127.0.0.1:16580" }])).toBeNull();
  });

  it("requires a positive standard tier signal instead of treating absent metadata as ready", async () => {
    const { isStandardReady } = await import("../../src/mineru/mineru-standard-server-setup.js");
    const healthy = { healthy: true, managed_running: true };
    expect(isStandardReady(healthy)).toBe(false);
    expect(isStandardReady({ ...healthy, supported_tiers: ["flash"] })).toBe(false);
    expect(isStandardReady({ ...healthy, managed_tier: "flash", supported_tiers: ["standard"] })).toBe(false);
    expect(isStandardReady({ ...healthy, managed_tier: "standard" })).toBe(true);
    expect(isStandardReady({ ...healthy, supported_tiers: ["standard"] })).toBe(true);
    expect(isStandardReady({ ...healthy, managed_tier: "standard", healthy: false })).toBe(false);
  });

  it("revalidates arbitrary exported configuration/readiness callers at the network boundary", async () => {
    const { setParseServerModeManaged, waitForStandardParseServerReady } = await import("../../src/mineru/mineru-standard-server-setup.js");
    for (const url of ["http://169.254.169.254:80", "http://localhost:80", "http://127.0.0.1:99999", "http://127.0.0.1:5000@evil.example:80"]) {
      expect(await setParseServerModeManaged(url, 500)).toMatchObject({ kind: "CONFIG_SET_FAILED", detail: "INVALID_LOOPBACK_ENDPOINT" });
      expect(await waitForStandardParseServerReady(url, 500)).toMatchObject({ kind: "STATUS_UNAVAILABLE", detail: "INVALID_LOOPBACK_ENDPOINT" });
    }
  });
});

describe("per-page runtime admission recheck", () => {
  const base = { modelsVerified: true, availableMemoryBytes: 8_589_934_592 };
  const validClaim = hex64("source");
  const admission: MineruStandardAdmissionConfig = {
    manifestPath: "m.json",
    manifest: parseMineruStandardManifest(manifestJson([{ path: "a.onnx" }]))!,
    manifestSha256: hex64("m"),
    minFreeMemoryBytes: 2_684_354_560,
    timeoutMs: 600_000,
  };

  it("walks the full reason matrix deterministically", () => {
    expect(assessMineruStandardExecution({ ...base, admissionConfig: null, sourceClaim: validClaim, actualSourceSha256: validClaim })).toMatchObject({ admitted: false, reason: "STANDARD_NOT_REQUESTED" });
    expect(assessMineruStandardExecution({ ...base, admissionConfig: admission, modelsVerified: false, sourceClaim: validClaim, actualSourceSha256: validClaim })).toMatchObject({ admitted: false, reason: "MODELS_UNVERIFIED" });
    expect(assessMineruStandardExecution({ ...base, admissionConfig: admission, sourceClaim: null, actualSourceSha256: null })).toMatchObject({ admitted: false, reason: "SOURCE_CLAIM_ABSENT" });
    expect(assessMineruStandardExecution({ ...base, admissionConfig: admission, sourceClaim: "zz", actualSourceSha256: validClaim })).toMatchObject({ admitted: false, reason: "SOURCE_CLAIM_INVALID" });
    expect(assessMineruStandardExecution({ ...base, admissionConfig: admission, sourceClaim: validClaim, actualSourceSha256: hex64("other") })).toMatchObject({ admitted: false, reason: "SOURCE_HASH_MISMATCH" });
    expect(assessMineruStandardExecution({ ...base, admissionConfig: admission, sourceClaim: validClaim, actualSourceSha256: null })).toMatchObject({ admitted: false, reason: "SOURCE_HASH_MISMATCH" });
    expect(assessMineruStandardExecution({ ...base, availableMemoryBytes: 1, admissionConfig: admission, sourceClaim: validClaim, actualSourceSha256: validClaim })).toMatchObject({ admitted: false, reason: "MEMORY_INSUFFICIENT" });
    expect(assessMineruStandardExecution({ ...base, admissionConfig: admission, sourceClaim: validClaim, actualSourceSha256: validClaim })).toEqual({ admitted: true, reason: "ADMITTED", manifestSha256: admission.manifestSha256 });
  });

  it("byte digest helper is stable", () => {
    expect(sha256Bytes(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("executor config integration: default-off equivalence and conflict handling", () => {
  function baseEnv(): Record<string, string | undefined> {
    const root = tempDir();
    mkdirSync(join(root, "mineru"), { recursive: true });
    writeFileSync(join(root, "mineru", "mineru.exe"), "stub");
    return {
      OCR_PROVIDER: "mineru",
      MINERU_MODEL_SOURCE: "local",
      MINERU_MODEL_PATH: join(root, "models"),
      MINERU_EXECUTABLE: join(root, "mineru", "mineru.exe"),
      MINERU_HOME_ROOT: join(root, "home"),
    };
  }

  it("Invariant A: no standard variables -> config.standard is absent and tier stays flash", () => {
    const config = resolveMineruExecutorConfig(baseEnv() as never, { directoryExists: () => true, fileExists: () => true });
    expect(config).not.toBeNull();
    expect(config!.standard).toBeUndefined();
    expect(config!.tier).toBe(MINERU_PINNED_TIER);
    expect(MINERU_PINNED_TIER).toBe("flash");
  });

  it("both switches + valid manifest -> standard admission present", () => {
    const environment = { ...baseEnv(), [OCR_TIER_STANDARD_EXPERIMENTAL_ENV]: "true", [OCR_STANDARD_EXECUTION_ADMISSION_ENV]: "true", [MINERU_STANDARD_MANIFEST_ENV]: "m.json" };
    const config = resolveMineruExecutorConfig(environment as never, { directoryExists: () => true, fileExists: () => true, readFile: () => manifestJson([{ path: "a.onnx" }]) });
    expect(config!.standard).toBeDefined();
    expect(config!.standard!.manifest.files).toHaveLength(1);
  });

  it("fails fast on every half-configuration", () => {
    const fs = { directoryExists: () => true, fileExists: () => true, readFile: () => manifestJson([{ path: "a.onnx" }]) };
    // manifest without both switches
    expect(() => resolveMineruExecutorConfig({ ...baseEnv(), [MINERU_STANDARD_MANIFEST_ENV]: "m.json" } as never, fs)).toThrowError(/OCR_STANDARD_MANIFEST_WITHOUT_ADMISSION/);
    // experimental switch alone is INERT planning: admission stays off, no
    // standard block, no execution — must NOT throw and must NOT enable.
    const experimentalOnly = resolveMineruExecutorConfig({ ...baseEnv(), [OCR_TIER_STANDARD_EXPERIMENTAL_ENV]: "true" } as never, fs);
    expect(experimentalOnly!.standard).toBeUndefined();
    // execution admission without experimental (2A strict parser owns this rule)
    expect(() => parseStep62aConfig({ [OCR_STANDARD_EXECUTION_ADMISSION_ENV]: "true" }, parseOcrTierPolicyConfig({}))).toThrowError(/OCR_STEP6_2A_EXPERIMENTAL_FLAG_REQUIRED/);
    // both switches without a manifest
    expect(() => resolveMineruExecutorConfig({ ...baseEnv(), [OCR_TIER_STANDARD_EXPERIMENTAL_ENV]: "true", [OCR_STANDARD_EXECUTION_ADMISSION_ENV]: "true" } as never, fs)).toThrowError(/OCR_STANDARD_MANIFEST_REQUIRED/);
    // standard variables set without OCR_PROVIDER are orphans
    expect(() => resolveMineruExecutorConfig({ [MINERU_STANDARD_MANIFEST_ENV]: "m.json" } as never, fs)).toThrowError(/OCR_PROVIDER_REQUIRED.*MINERU_STANDARD_MODEL_MANIFEST/);
  });

  it("factory refuses standard capability without the startup verification proof (Invariant E)", () => {
    const root = tempDir();
    const config: MineruExecutorConfig = {
      executable: "mineru.exe",
      executableArgs: [],
      modelPath: join(root, "models"),
      modelSource: "local",
      tier: MINERU_PINNED_TIER,
      version: MINERU_PINNED_VERSION,
      hostId: "test-host",
      homeRoot: join(root, "home"),
      timeoutMs: 1_000,
      serverStartTimeoutMs: 1_000,
      serverStopTimeoutMs: 1_000,
      maxOutputBytes: 1_000,
      capacityDeferralDelayMs: 1,
      standard: {
        manifestPath: "m.json",
        manifest: parseMineruStandardManifest(manifestJson([{ path: "a.onnx" }]))!,
        manifestSha256: hex64("m"),
        minFreeMemoryBytes: 2_684_354_560,
        timeoutMs: 600_000,
      },
    };
    expect(() => createMineruPdfOcrExecutor(config)).toThrowError(/OCR_STANDARD_MODELS_UNVERIFIED/);
    expect(() => createMineruPdfOcrExecutor(config, { standardModelsVerified: false })).toThrowError(/OCR_STANDARD_MODELS_UNVERIFIED/);
    const handle = createMineruPdfOcrExecutor(config, { standardModelsVerified: true });
    // Descriptor is persisted for flash attempts too; standard manifest cannot
    // masquerade as actual per-page model provenance before 2B-2.
    expect(handle.executor.descriptor.modelRevision).toBeNull();
    // Default path (no standard block): proof flag is irrelevant, factory succeeds.
    const plain = createMineruPdfOcrExecutor({ ...config, standard: undefined });
    expect(plain.executor.descriptor.parserMode).toBe("flash");
  });
});
