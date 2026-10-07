import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@ai-cognitive/db";
import { readEnvironment, type Environment } from "@ai-cognitive/shared/server";
import { startWorkerRuntime } from "../src/runtime.js";
import { recordedProcessAlive } from "../../../packages/ingestion/src/mineru/mineru-process.js";

/**
 * RF03 P1-01 STARTUP BARRIER (real composition): a stale RUNNING server row
 * with a LIVE fake process exists BEFORE startWorkerRuntime; a source-ingestion
 * job is queued before start. The runtime must converge the stale server FIRST
 * (barrier) and only then let the worker consume the job — so at no instant
 * are two claim-scoped MinerU servers alive for the host because of startup
 * ordering. The barrier's reconciler also cleans the retained claim data
 * (RF03 P1-04).
 */

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const fakeMineruPath = fileURLToPath(new URL("../../../packages/ingestion/tests/helpers/mineru/fake-mineru.mjs", import.meta.url));
const fixtureBytes = () => new Uint8Array(readFileSync(fileURLToPath(new URL("../../../packages/ingestion/tests/fixtures/mineru/scanned-mixed-real.pdf", import.meta.url))));

const cleanup = { workspaceIds: [] as string[], userIds: [] as string[], runIds: [] as string[] };
let tempRoot: string | null = null;
const spawnedPids: number[] = [];

afterAll(async () => {
  if (cleanup.runIds.length) {
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: cleanup.runIds } } });
    await prisma.bookAnalysisBootstrap.deleteMany({ where: { ingestionRunId: { in: cleanup.runIds } } });
  }
  if (cleanup.workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.ocrServerInstance.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: cleanup.workspaceIds } } });
  }
  if (cleanup.userIds.length) await prisma.user.deleteMany({ where: { id: { in: cleanup.userIds } } });
  if (cleanup.workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: cleanup.workspaceIds } } });
  for (const pid of spawnedPids) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.MINERU_FAKE_MODE;
  delete process.env.MINERU_FAKE_TEXT;
  await prisma.$disconnect();
});

function spawnLongLivedNode(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    setTimeout(() => resolve(child.pid!), 150);
  });
}

describe("startup OCR reconciliation barrier (RF03 P1-01)", () => {
  it("STARTUP_BARRIER: the stale same-host server is converged and its claim data cleaned BEFORE the worker consumes the pre-existing OCR job", { timeout: 180_000 }, async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "worker-startup-barrier-"));
    const modelsDir = join(tempRoot, "models");
    const homeRoot = join(tempRoot, "homes");
    mkdirSync(modelsDir, { recursive: true });
    const hostId = `mineru-barrier-${crypto.randomUUID()}`;
    const bullmqPrefix = `worker-barrier-${crypto.randomUUID()}`;
    const ingestionTopic = `worker-barrier-topic-${crypto.randomUUID()}`;

    // THE STALE CRASH STATE (before the runtime exists): a RUNNING row with a
    // LIVE fake server process, durable DB identity, endpoint file, retained
    // claim input — exactly a hard-crash leftover.
    const oldPid = await spawnLongLivedNode();
    spawnedPids.push(oldPid);
    const claimDir = join(homeRoot, "stale-run", "generation-1", "page-1", "claim-stale");
    const oldHome = join(claimDir, "home");
    mkdirSync(oldHome, { recursive: true });
    mkdirSync(join(claimDir, "input"), { recursive: true });
    writeFileSync(join(claimDir, "input", "input.pdf"), "%PDF-stale source bytes");
    writeFileSync(join(oldHome, "doclib.endpoint.json"), JSON.stringify({ pid: oldPid, server_id: "stale-server-identity", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1" }], version: 2 }));

    const user = await prisma.user.create({ data: { email: `barrier-${crypto.randomUUID()}@test`, name: "Barrier" } });
    const workspace = await prisma.workspace.create({ data: { name: `barrier-${crypto.randomUUID()}` } });
    cleanup.userIds.push(user.id);
    cleanup.workspaceIds.push(workspace.id);
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256("barrier-blob"), sizeBytes: 12, mediaType: "application/pdf", storageKey: `test/${crypto.randomUUID()}` } });
    const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "barrier.pdf" } });
    const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: 12, mediaType: "application/pdf", storageKey: blob.storageKey } });
    const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id } } });
    const staleRun = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "pdf-router-v1", normalizationVersion: "canonical-text-v1" } });
    cleanup.runIds.push(staleRun.id);
    await prisma.ocrServerInstance.create({ data: { workspaceId: workspace.id, sourceDocumentId: document.id, ingestionRunId: staleRun.id, hostId, hostClaimToken: "stale-claim-token", runExecutionToken: "stale-run-token", mineruHome: oldHome, pid: oldPid, serverId: "stale-server-identity", transports: [{ type: "tcp" }] as object, status: "RUNNING", startedAt: new Date() } });

    // THE PRE-EXISTING OCR JOB (real bytes, real OCR-required PDF).
    const bytes = fixtureBytes();
    const storageKey = `test/${crypto.randomUUID()}`;
    const { S3CompatibleStorageProvider } = await import("@ai-cognitive/storage");
    const storage = new S3CompatibleStorageProvider({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000", region: "us-east-1", bucket: process.env.S3_BUCKET ?? "ai-cognitive-studio-dev", accessKey: process.env.S3_ACCESS_KEY ?? "local-development-only", secretKey: process.env.S3_SECRET_KEY ?? "local-development-only", forcePathStyle: true });
    await storage.putObject({ key: storageKey, body: bytes, contentType: "application/pdf" });
    const blob2 = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256(storageKey), sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
    const source2 = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "barrier-ocr.pdf" } });
    const document2 = await prisma.sourceDocument.create({ data: { sourceId: source2.id, sourceBlobId: blob2.id, workspaceId: workspace.id, version: 1, sha256: blob2.sha256, sizeBytes: bytes.length, mediaType: "application/pdf", storageKey } });
    const job2 = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document2.id } } });
    const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document2.id, workspaceId: workspace.id, jobId: job2.id, parserVersion: "pdf-router-v1", normalizationVersion: "canonical-text-v1" } });
    cleanup.runIds.push(run.id);
    await prisma.outboxEvent.create({ data: { topic: ingestionTopic, aggregateId: run.id, payload: { ingestionRunId: run.id } } });

    const environment = {
      ...readEnvironment(process.env),
      OCR_PROVIDER: "mineru",
      MINERU_MODEL_SOURCE: "local",
      MINERU_MODEL_PATH: modelsDir,
      MINERU_EXECUTABLE: process.execPath,
      MINERU_EXECUTABLE_ARGS: JSON.stringify([fakeMineruPath]),
      MINERU_TIER: "flash",
      MINERU_TIMEOUT_MS: 30_000,
      MINERU_SERVER_START_TIMEOUT_MS: 15_000,
      MINERU_SERVER_STOP_TIMEOUT_MS: 10_000,
      MINERU_HOME_ROOT: homeRoot,
      MINERU_MAX_OUTPUT_BYTES: 1_000_000,
      OCR_HOST_ID: hostId,
    } as Environment;

    process.env.MINERU_FAKE_TEXT = "post barrier scan text";
    const runtime = await startWorkerRuntime(environment, { bullmqPrefix, outboxTopics: { sourceIngestion: ingestionTopic } });
    try {
      // THE BARRIER ALREADY COMPLETED by the time startWorkerRuntime resolves:
      // the stale row is STOPPED, its process dead, its retained claim data
      // (with the source PDF) cleaned.
      const oldRow = await prisma.ocrServerInstance.findUniqueOrThrow({ where: { hostClaimToken: "stale-claim-token" } });
      expect(oldRow.status).toBe("STOPPED");
      expect(oldRow.terminationReason).toContain("RECONCILER");
      expect(await recordedProcessAlive(oldPid, /node|python/i)).toBe(false);
      expect(existsSync(claimDir)).toBe(false);

      // The pre-existing job then ran: the NEW claim-scoped server (if it
      // started) can only have started AFTER the old one was proven stopped.
      const newServerRows = await prisma.ocrServerInstance.findMany({ where: { ingestionRunId: run.id } });
      for (const newRow of newServerRows) {
        expect(newRow.startedAt!.getTime()).toBeGreaterThanOrEqual(oldRow.stoppedAt!.getTime() - 1_000);
      }

      // The run itself succeeded end-to-end on the freed capacity.
      const deadline = Date.now() + 60_000;
      let finalRun = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      while (finalRun.status !== "SUCCEEDED" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        finalRun = await prisma.ingestionRun.findUniqueOrThrow({ where: { id: run.id } });
      }
      expect(finalRun.status).toBe("SUCCEEDED");
      expect(await prisma.documentExtraction.count({ where: { ingestionRunId: run.id } })).toBe(1);
      expect(await prisma.bookAnalysisBootstrap.count({ where: { ingestionRunId: run.id } })).toBe(1);
      expect((await prisma.ocrHostLease.findUniqueOrThrow({ where: { hostId } })).claimToken).toBeNull();
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });
});