import { PrismaClient } from "@ai-cognitive/db";
import { materializeDocumentChunkEmbeddings } from "../../book-intelligence/src/gateway-materialization.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ProviderExecutionRepository, testCipher } from "../src/index.js";

const execute = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrations = resolve(root, "packages/db/prisma/migrations");
const real2BMigration = join(migrations, "20260819010000_phase_8c_atomic_embedding_materialization");
const post2BMigration = "20260822010000_phase_8c_durable_text_handoff";
const require = createRequire(import.meta.url);
const prismaConfigModule = pathToFileURL(require.resolve("prisma/config", { paths: [resolve(root, "packages/db")] })).href;

function upgradeUrl() { const url = new URL(process.env.DATABASE_URL_TEST!); url.pathname = "/ai_cognitive_studio_phase8c2b_upgrade_test"; return url.toString(); }
async function prisma(command: string, databaseUrl: string, cwd = resolve(root, "packages/db")) { const cli = require.resolve("prisma/build/index.js", { paths: [resolve(root, "packages/db")] }); await execute(process.execPath, [cli, ...command.split(" "), "--config", "prisma.config.ts"], { cwd, env: { ...process.env, DATABASE_URL: databaseUrl }, windowsHide: true }); }
function stage(name: string) { process.stdout.write(`${name}\n`); }
function migrationCount(db: PrismaClient) { return db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"`; }

async function recover2AReceipt(db: PrismaClient, cipher: ReturnType<typeof testCipher>, input: { workspaceId: string; invocationId: string; snapshotId: string; attemptId: string; modelId: string }) {
  const rows = await db.$queryRawUnsafe<Array<{ ciphertext: string; iv: string; authTag: string; keyVersion: string; vectorCount: number; dimensions: number }>>('SELECT "ciphertext", "iv", "authTag", "keyVersion", "vectorCount", "dimensions" FROM "ProviderEmbeddingResult" WHERE "workspaceId" = $1 AND "invocationId" = $2', input.workspaceId, input.invocationId);
  expect(rows).toHaveLength(1); const row = rows[0]!;
  const response = JSON.parse(cipher.decryptEmbeddingResult(row, { workspaceId: input.workspaceId, invocationId: input.invocationId, attemptId: input.attemptId, snapshotId: input.snapshotId, providerKey: "openai", modelId: input.modelId })) as { vectors: number[][]; dimensions: number };
  expect(response.vectors).toHaveLength(row.vectorCount); expect(response.dimensions).toBe(row.dimensions);
  return { kind: "RECOVERABLE" as const, response };
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function createThirtyMigrationFixture() {
  stage("UPGRADE_STAGE_03A_MKDTEMP_BEGIN"); const fixture = mkdtempSync(join(tmpdir(), "ai-cognitive-phase8c-2a-")); stage("UPGRADE_STAGE_03A_MKDTEMP_DONE");
  const fixtureMigrations = join(fixture, "migrations");
  stage("UPGRADE_STAGE_03B_CREATE_DIRS_BEGIN"); mkdirSync(fixtureMigrations); stage("UPGRADE_STAGE_03B_CREATE_DIRS_DONE");
  stage("UPGRADE_STAGE_03C_COPY_SCHEMA_BEGIN"); copyFileSync(resolve(root, "packages/db/prisma/schema.prisma"), join(fixture, "schema.prisma")); stage("UPGRADE_STAGE_03C_COPY_SCHEMA_DONE");
  stage("UPGRADE_STAGE_03D_ENUMERATE_MIGRATIONS_BEGIN");
  const firstThirty = readdirSync(migrations, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== "20260819010000_phase_8c_atomic_embedding_materialization" && entry.name !== post2BMigration).map(entry => entry.name).sort().slice(0, 30);
  expect(firstThirty).toHaveLength(30);
  stage("UPGRADE_STAGE_03D_ENUMERATE_MIGRATIONS_DONE");
  for (const [index, name] of firstThirty.entries()) { const label = String(index + 1).padStart(2, "0"); stage(`UPGRADE_STAGE_03E_COPY_MIGRATION_${label}_BEGIN`); copyDirectory(join(migrations, name), join(fixtureMigrations, name)); stage(`UPGRADE_STAGE_03E_COPY_MIGRATION_${label}_DONE`); }
  stage("UPGRADE_STAGE_03F_WRITE_TEMP_CONFIG_BEGIN"); writeFileSync(join(fixture, "prisma.config.ts"), `import { defineConfig, env } from ${JSON.stringify(prismaConfigModule)}; export default defineConfig({ engine: "classic", schema: "schema.prisma", migrations: { path: "migrations" }, datasource: { url: env("DATABASE_URL") } });\n`); stage("UPGRADE_STAGE_03F_WRITE_TEMP_CONFIG_DONE");
  stage("UPGRADE_STAGE_03G_VERIFY_TREE_BEGIN"); expect(readdirSync(fixtureMigrations, { withFileTypes: true }).filter(entry => entry.isDirectory())).toHaveLength(30); expect(existsSync(join(fixture, "schema.prisma"))).toBe(true); stage("UPGRADE_STAGE_03G_VERIFY_TREE_DONE");
  return fixture;
}

async function createDocumentTargets(db: PrismaClient, workspaceId: string) {
  const source = await db.source.create({ data: { workspaceId, kind: "FILE", displayName: "upgrade.md" } });
  const blob = await db.sourceBlob.create({ data: { workspaceId, sha256: randomUUID(), sizeBytes: 1, mediaType: "text/markdown", storageKey: `upgrade/${randomUUID()}` } });
  const document = await db.sourceDocument.create({ data: { workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: randomUUID(), sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } });
  const job = await db.job.create({ data: { workspaceId, type: "source.ingest", payload: {}, idempotencyKey: `upgrade:${randomUUID()}` } });
  const ingestion = await db.ingestionRun.create({ data: { workspaceId, sourceDocumentId: document.id, jobId: job.id, parserVersion: "upgrade", normalizationVersion: "upgrade" } });
  const extraction = await db.documentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "upgrade", parserVersion: "upgrade", normalizationVersion: "upgrade" } });
  const chunkSet = await db.chunkSet.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "upgrade", configuration: {}, configurationHash: randomUUID(), status: "SUCCEEDED", completedAt: new Date() } });
  const chunks = await Promise.all(["first", "second"].map((content, ordinal) => db.documentChunk.create({ data: { workspaceId, chunkSetId: chunkSet.id, extractionId: extraction.id, structureVersion: "upgrade", ordinal, content, contentHash: `upgrade-${ordinal}`, characterCount: content.length, tokenEstimate: 1 } })));
  return { extractionId: extraction.id, targets: chunks.map(chunk => ({ id: chunk.id, extractionId: extraction.id, contentHash: chunk.contentHash })) };
}

describe("Phase 8C 2A to 2B upgrade acceptance", () => {
  it("UPGRADE_REAL_MATERIALIZATION applies an isolated 30-migration fixture and materializes real document chunks", async () => {
    stage("UPGRADE_STAGE_01_CREATE_ADMIN_CLIENT");
    const databaseUrl = upgradeUrl(), admin = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL_TEST } } });
    const workspaceId = randomUUID(), snapshotId = randomUUID(), invocationId = randomUUID(), attemptId = randomUUID(), cipher = testCipher(), vectors = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]];
    let db: PrismaClient | undefined, fixture: string | undefined;
    try {
      stage("UPGRADE_STAGE_02_CREATE_DATABASE");
      expect(existsSync(real2BMigration)).toBe(true);
      await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS "ai_cognitive_studio_phase8c2b_upgrade_test"'); await admin.$executeRawUnsafe('CREATE DATABASE "ai_cognitive_studio_phase8c2b_upgrade_test"');
      await admin.$disconnect();
      stage("UPGRADE_STAGE_03_CREATE_TEMP_MIGRATION_TREE"); fixture = createThirtyMigrationFixture();
      stage("UPGRADE_STAGE_04_DEPLOY_30");
      await prisma("migrate deploy", databaseUrl, fixture);
      db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      expect(existsSync(real2BMigration)).toBe(true);
      expect((await migrationCount(db))[0]?.count).toBe(30n);
      stage("UPGRADE_STAGE_05_CREATE_2A_FIXTURE");
      await db.workspace.create({ data: { id: workspaceId, name: "upgrade" } });
      await db.providerExecutionSnapshot.create({ data: { id: snapshotId, workspaceId, routeSlot: "EMBEDDING", providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", modelId: "upgrade", capability: { modelId: "upgrade", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 3 }, configuration: {}, configurationHash: "upgrade", adapterVersion: "2a", correlationId: invocationId } });
      await db.providerInvocation.create({ data: { id: invocationId, workspaceId, snapshotId, providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", modelId: "upgrade", routeSlot: "EMBEDDING", idempotencyKey: invocationId, requestFingerprint: "a".repeat(64), correlationId: invocationId, status: "SUCCEEDED", completedAt: new Date() } });
      await db.providerInvocationAttempt.create({ data: { id: attemptId, workspaceId, invocationId, attemptNumber: 1, status: "SUCCEEDED", completedAt: new Date() } });
      const encrypted = cipher.encryptEmbeddingResult(JSON.stringify({ vectors, dimensions: 3 }), { workspaceId, invocationId, attemptId, snapshotId, providerKey: "openai", modelId: "upgrade" });
      await db.$executeRawUnsafe('INSERT INTO "ProviderEmbeddingResult" ("id","workspaceId","invocationId","attemptId","snapshotId","ciphertext","iv","authTag","keyVersion","vectorCount","dimensions") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', randomUUID(), workspaceId, invocationId, attemptId, snapshotId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion, 2, 3);
      await db.providerUsageEvent.create({ data: { workspaceId, invocationId, attemptId, attemptNumber: 1, providerKey: "openai", modelId: "upgrade", capability: "EMBEDDING", routeSlot: "EMBEDDING", status: "SUCCEEDED", embeddingInputTokens: 2 } });
      stage("UPGRADE_STAGE_06_RECOVER_PRE_UPGRADE");
      expect(await recover2AReceipt(db, cipher, { workspaceId, invocationId, snapshotId, attemptId, modelId: "upgrade" })).toMatchObject({ kind: "RECOVERABLE", response: { vectors } });
      await db.$disconnect(); db = undefined;
      stage("UPGRADE_STAGE_07_DEPLOY_2B");
      await prisma("migrate deploy", databaseUrl);
      db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      expect((await migrationCount(db))[0]?.count).toBe(34n);
      const postUpgradeRepository = new ProviderExecutionRepository(db as never, cipher);
      expect(await postUpgradeRepository.recoverEmbeddingHandoff(workspaceId, invocationId)).toMatchObject({ kind: "RECOVERABLE", response: { vectors } });
      stage("UPGRADE_STAGE_08_CREATE_DOCUMENT_LINEAGE");
      const targets = await createDocumentTargets(db, workspaceId);
      expect(await db.documentChunkEmbedding.count({ where: { workspaceId } })).toBe(0);
      stage("UPGRADE_STAGE_09_REAL_MATERIALIZE");
      await expect(materializeDocumentChunkEmbeddings(postUpgradeRepository, { workspaceId, invocationId, snapshotId, embeddingVersion: "upgrade-v1", targets: targets.targets })).resolves.toMatchObject({ status: "CONSUMED" });
      const rows = await db.documentChunkEmbedding.findMany({ where: { workspaceId }, orderBy: { chunk: { ordinal: "asc" } } }); expect(rows).toHaveLength(2); expect(rows.map(row => row.vector)).toEqual(vectors);
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "openai", model: "upgrade", embeddingVersion: "upgrade-v1", dimensions: 3, workspaceId, extractionId: targets.extractionId })]));
      expect(await db.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId } })).toMatchObject({ consumedAt: expect.any(Date), purgedAt: expect.any(Date), consumerKind: "DOCUMENT_CHUNK", consumerFingerprint: expect.any(String), ciphertext: null, iv: null, authTag: null, keyVersion: null });
      stage("UPGRADE_STAGE_10_RETRY");
      await db.$disconnect(); db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      await expect(materializeDocumentChunkEmbeddings(new ProviderExecutionRepository(db as never, cipher), { workspaceId, invocationId, snapshotId, embeddingVersion: "upgrade-v1", targets: targets.targets })).resolves.toMatchObject({ status: "ALREADY_CONSUMED" });
      expect(await db.documentChunkEmbedding.count({ where: { workspaceId } })).toBe(2); expect(await db.providerInvocation.count({ where: { workspaceId } })).toBe(1); expect(await db.providerInvocationAttempt.count({ where: { workspaceId } })).toBe(1); expect(await db.providerUsageEvent.count({ where: { workspaceId } })).toBe(1);
    } finally { stage("UPGRADE_STAGE_11_CLEANUP"); await db?.$disconnect(); await admin.$disconnect(); const cleanup = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL_TEST } } }); await cleanup.$executeRawUnsafe('DROP DATABASE IF EXISTS "ai_cognitive_studio_phase8c2b_upgrade_test"'); await cleanup.$disconnect(); if (fixture) rmSync(fixture, { recursive: true, force: true }); expect(existsSync(real2BMigration)).toBe(true); }
  }, 120_000);
});
