import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@ai-cognitive/db";
import type { Environment } from "@ai-cognitive/shared/server";
import { createMineruPdfOcrExecutor, PDF_ROUTING_GENERATION, resolveMineruExecutorConfig, sha256Bytes, verifyMineruRuntime, verifyMineruStandardModels, type MineruExecutorConfig } from "../../src/index.js";

/**
 * MACHINE-LOCAL REAL MinerU STANDARD tier acceptance gate (STEP6-2B-1).
 *
 * Same policy as mineru-real.integration.test.ts: runs ONLY where a pinned
 * local MinerU 4.0.3 runtime is provisioned:
 *   MINERU_REAL_EXECUTABLE=<absolute mineru executable>
 *   MINERU_REAL_MODEL_PATH=<shared local model root>
 * Optional:
 *   MINERU_REAL_STANDARD_PDF=<absolute path of a private scanned single-page
 *   PDF> — the standard-admitted case is skipped silently when absent (the
 *   private fixture is NEVER committed to this repository).
 *
 * Proven here, against the REAL production executor path:
 *  1. standard admission: verified manifest -> actual tier "standard" with
 *     the verified manifest digest recorded in the execution facts;
 *  2. runtime demotion: an impossible memory floor refuses the standard
 *     proposal and the SAME invocation executes flash (pre-slice behaviour);
 *  3. source byte-identity: a mismatched source claim refuses standard.
 */

const realExecutable = process.env.MINERU_REAL_EXECUTABLE;
const realModelPath = process.env.MINERU_REAL_MODEL_PATH;
const realStandardPdf = process.env.MINERU_REAL_STANDARD_PDF;
const gateActive = Boolean(realExecutable && realModelPath);

const describeReal = gateActive ? describe : describe.skip;

const workspaceIds: string[] = [];
const userIds: string[] = [];
const runIds: string[] = [];
const tempRoots: string[] = [];
const hostCounter = { value: 0 };

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest("hex");
}

/** Builds a REAL manifest from the actual local model root (*.onnx + *.gguf, .cache excluded). */
async function buildManifestFromRoot(root: string): Promise<string> {
  const files: Array<{ path: string; sha256: string; sizeBytes: number }> = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".cache") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`);
      else if (entry.name.endsWith(".onnx") || entry.name.endsWith(".gguf")) {
        const info = statSync(path);
        files.push({ path: prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`, sha256: await hashFile(path), sizeBytes: info.size });
      }
    }
  };
  await walk(root, "");
  if (files.length === 0) throw new Error("NO_MODEL_FILES_UNDER_REAL_ROOT");
  const tempRoot = mkdtempSync(join(tmpdir(), "mineru-std-manifest-"));
  tempRoots.push(tempRoot);
  const manifestPath = join(tempRoot, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: "mineru-standard-manifest-v1", mineruVersion: "4.0.3", files }));
  return manifestPath;
}

async function realStandardConfig(overrides: Record<string, string> = {}): Promise<MineruExecutorConfig> {
  const tempRoot = mkdtempSync(join(process.env.MINERU_REAL_PRIVATE_ROOT ?? tmpdir(), "mineru-std-real-"));
  tempRoots.push(tempRoot);
  const manifestPath = await buildManifestFromRoot(realModelPath!);
  const environment = {
    OCR_PROVIDER: "mineru",
    MINERU_MODEL_SOURCE: "local",
    MINERU_MODEL_PATH: realModelPath,
    MINERU_EXECUTABLE: realExecutable,
    MINERU_HOME_ROOT: join(tempRoot, "homes"),
    MINERU_MAX_OUTPUT_BYTES: "8000000",
    OCR_HOST_ID: `mineru-std-real-${(hostCounter.value += 1)}`,
    OCR_TIER_STANDARD_EXPERIMENTAL_ENABLED: "true",
    OCR_TIER_STANDARD_EXECUTION_ADMISSION_ENABLED: "true",
    MINERU_STANDARD_MODEL_MANIFEST: manifestPath,
    // Local-acceptance knob ONLY for the memory floor (the default 2.5 GiB
    // stays the production contract): a host that concurrently runs another
    // session's Docker stack may legitimately fall below the default floor at
    // execution time, and lowering the floor for THIS gate must be an explicit
    // operator decision recorded in the run log — never a code default.
    ...(process.env.MINERU_STANDARD_MIN_FREE_MEMORY_BYTES ? { MINERU_STANDARD_MIN_FREE_MEMORY_BYTES: process.env.MINERU_STANDARD_MIN_FREE_MEMORY_BYTES } : {}),
    ...overrides,
  } as unknown as Environment;
  const config = resolveMineruExecutorConfig(environment)!;
  expect(config.standard).toBeDefined();
  return config;
}

async function createRunFixture(): Promise<{ runId: string; workspaceId: string; sourceDocumentId: string; executionToken: string }> {
  const user = await prisma.user.create({ data: { email: `mineru-std-${randomUUID()}@test`, name: "MinerU Std Real" } });
  userIds.push(user.id);
  const workspace = await prisma.workspace.create({ data: { name: `mineru-std-${randomUUID()}` } });
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const storageKey = `test/${randomUUID()}`;
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(storageKey), sizeBytes: 1000, mediaType: "application/pdf", storageKey } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "standard-real.pdf" } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: 1000, mediaType: "application/pdf", storageKey } });
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "pdf-router-v1", normalizationVersion: "canonical-text-v1" } });
  runIds.push(run.id);
  return { runId: run.id, workspaceId: workspace.id, sourceDocumentId: document.id, executionToken: `exec-${randomUUID()}` };
}

afterEach(async () => {
  if (workspaceIds.length) {
    await prisma.ocrServerInstance.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  workspaceIds.length = 0;
  userIds.length = 0;
  runIds.length = 0;
  for (const root of tempRoots) {
    // Windows: a just-killed doclib child can hold a directory handle for a
    // moment; cleanup is best-effort evidence hygiene, never a gate.
    try { rmSync(root, { recursive: true, force: true }); } catch { /* leave for the OS */ }
  }
  tempRoots.length = 0;
});

afterAll(async () => { await prisma.$disconnect(); });

describeReal("mineru real standard execution gate (STEP6-2B-1)", () => {
  it("verifies the real model manifest and the real runtime before anything executes", async () => {
    const config = await realStandardConfig();
    await verifyMineruRuntime(config);
    const verification = await verifyMineruStandardModels(config.modelPath, config.standard!);
    expect(verification.ok).toBe(true);
    if (verification.ok) expect(verification.filesChecked).toBeGreaterThanOrEqual(1);
  }, 600_000);

  it("executes a real scanned page with standard through the claim-scoped supervisor", async () => {
    if (!realStandardPdf) return; // private fixture absent -> skip silently, never fake
    const config = await realStandardConfig();
    const handle = createMineruPdfOcrExecutor(config, { standardModelsVerified: true });
    try {
      const fixture = await createRunFixture();
      const pdfBytes = new Uint8Array(readFileSync(realStandardPdf));
      const result = await handle.executor.extractPage({
        ingestionRunId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sourceDocumentId: fixture.sourceDocumentId,
        physicalPageIndex: 0,
        routingGeneration: PDF_ROUTING_GENERATION,
        runExecutionToken: fixture.executionToken,
        pdfBytes,
        standardExecutionRequest: { sourcePdfSha256: sha256Bytes(pdfBytes) },
      });
      expect(result.status).toBe("SUCCEEDED");
      if (result.status !== "SUCCEEDED") return;
      expect(result.execution).toMatchObject({
        engine: "mineru",
        engineVersion: "4.0.3",
        proposedTier: "standard",
        tierAdmission: "STANDARD_ADMITTED",
        tierRefusalCode: null,
        modelManifestSha256: config.standard!.manifestSha256,
      });
      expect(result.execution!.actualTier).toBe("standard");
      expect(result.text.trim().length).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  }, 600_000);

  it("demotes a standard proposal to flash on an impossible memory floor (REAL invocation)", async () => {
    const config = await realStandardConfig({ MINERU_STANDARD_MIN_FREE_MEMORY_BYTES: "68719476736" });
    const fixturePdf = new Uint8Array(readFileSync(join(import.meta.dirname, "../fixtures/mineru/scanned-mixed-real.pdf")));
    const handle = createMineruPdfOcrExecutor(config, { standardModelsVerified: true });
    try {
      const fixture = await createRunFixture();
      const result = await handle.executor.extractPage({
        ingestionRunId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sourceDocumentId: fixture.sourceDocumentId,
        physicalPageIndex: 0,
        routingGeneration: PDF_ROUTING_GENERATION,
        runExecutionToken: fixture.executionToken,
        pdfBytes: fixturePdf,
        standardExecutionRequest: { sourcePdfSha256: sha256Bytes(fixturePdf) },
      });
      expect(result.status).toBe("SUCCEEDED");
      if (result.status !== "SUCCEEDED") return;
      expect(result.execution).toMatchObject({
        actualTier: "flash",
        tierAdmission: "STANDARD_REFUSED",
        tierRefusalCode: "MEMORY_INSUFFICIENT",
      });
    } finally {
      await handle.close();
    }
  }, 600_000);

  it("refuses standard when the claimed source hash does not match the bytes", async () => {
    const config = await realStandardConfig();
    const fixturePdf = new Uint8Array(readFileSync(join(import.meta.dirname, "../fixtures/mineru/scanned-mixed-real.pdf")));
    const handle = createMineruPdfOcrExecutor(config, { standardModelsVerified: true });
    try {
      const fixture = await createRunFixture();
      const result = await handle.executor.extractPage({
        ingestionRunId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sourceDocumentId: fixture.sourceDocumentId,
        physicalPageIndex: 0,
        routingGeneration: PDF_ROUTING_GENERATION,
        runExecutionToken: fixture.executionToken,
        pdfBytes: fixturePdf,
        standardExecutionRequest: { sourcePdfSha256: sha256Bytes(new TextEncoder().encode("not-the-real-bytes")) },
      });
      expect(result.status).toBe("SUCCEEDED");
      if (result.status !== "SUCCEEDED") return;
      expect(result.execution).toMatchObject({ actualTier: "flash", tierAdmission: "STANDARD_REFUSED", tierRefusalCode: "SOURCE_HASH_MISMATCH" });
    } finally {
      await handle.close();
    }
  }, 600_000);
});
