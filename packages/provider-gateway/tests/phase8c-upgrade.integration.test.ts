import { prisma as sharedPrisma } from "@ai-cognitive/db";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { ProviderExecutionRepository, testCipher } from "../src/index.js";

const execute = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migration = resolve(root, "packages/db/prisma/migrations/20260819010000_phase_8c_atomic_embedding_materialization");
const parked = resolve(root, "output", "phase8c-upgrade-parked-migration");
const require = createRequire(import.meta.url);

function upgradeUrl() { const source = process.env.DATABASE_URL_TEST!; const url = new URL(source); url.pathname = `/ai_cognitive_studio_phase8c2b_upgrade_test`; return url.toString(); }
async function prisma(command: string, databaseUrl: string) { const cli = require.resolve("prisma/build/index.js", { paths: [resolve(root, "packages/db")] }); await execute(process.execPath, [cli, ...command.split(" "), "--config", "prisma.config.ts"], { cwd: resolve(root, "packages/db"), env: { ...process.env, DATABASE_URL: databaseUrl }, windowsHide: true }); }

describe("Phase 8C 2A to 2B upgrade acceptance", () => {
  it("PHASE8C_2A_TO_2B_UPGRADE preserves a valid encrypted 2A receipt and consumes it after the 2B deploy", async () => {
    const Client = sharedPrisma.constructor as new (options: unknown) => typeof sharedPrisma;
    const databaseUrl = upgradeUrl(), admin = new Client({ datasources: { db: { url: process.env.DATABASE_URL_TEST } } }), db = new Client({ datasources: { db: { url: databaseUrl } } });
    const workspaceId = randomUUID(), snapshotId = randomUUID(), invocationId = randomUUID(), attemptId = randomUUID(), cipher = testCipher(), vectors = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]];
    try {
      await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS "ai_cognitive_studio_phase8c2b_upgrade_test"'); await admin.$executeRawUnsafe('CREATE DATABASE "ai_cognitive_studio_phase8c2b_upgrade_test"');
      mkdirSync(dirname(parked), { recursive: true }); renameSync(migration, parked); await prisma("migrate deploy", databaseUrl); renameSync(parked, migration);
      expect((await db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"`)[0]?.count).toBe(30n);
      await db.workspace.create({ data: { id: workspaceId, name: "upgrade" } });
      await db.providerExecutionSnapshot.create({ data: { id: snapshotId, workspaceId, routeSlot: "EMBEDDING", providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", modelId: "upgrade", capability: { modelId: "upgrade", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 3 }, configuration: {}, configurationHash: "upgrade", adapterVersion: "2a", correlationId: invocationId } });
      await db.providerInvocation.create({ data: { id: invocationId, workspaceId, snapshotId, providerKey: "openai", protocol: "OPENAI_EMBEDDINGS", modelId: "upgrade", routeSlot: "EMBEDDING", idempotencyKey: invocationId, requestFingerprint: "a".repeat(64), correlationId: invocationId, status: "SUCCEEDED", completedAt: new Date() } });
      await db.providerInvocationAttempt.create({ data: { id: attemptId, workspaceId, invocationId, attemptNumber: 1, status: "SUCCEEDED", completedAt: new Date() } });
      const encrypted = cipher.encryptEmbeddingResult(JSON.stringify({ vectors, dimensions: 3 }), { workspaceId, invocationId, attemptId, snapshotId, providerKey: "openai", modelId: "upgrade" });
      await db.$executeRawUnsafe('INSERT INTO "ProviderEmbeddingResult" ("id","workspaceId","invocationId","attemptId","snapshotId","ciphertext","iv","authTag","keyVersion","vectorCount","dimensions") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', randomUUID(), workspaceId, invocationId, attemptId, snapshotId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion, 2, 3);
      await db.providerUsageEvent.create({ data: { workspaceId, invocationId, attemptId, attemptNumber: 1, providerKey: "openai", modelId: "upgrade", capability: "EMBEDDING", routeSlot: "EMBEDDING", status: "SUCCEEDED", embeddingInputTokens: 2 } });
      const repository = new ProviderExecutionRepository(db as never, cipher);
      await prisma("migrate deploy", databaseUrl); const before = await db.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId } }); expect(before).toMatchObject({ ciphertext: expect.any(String), consumedAt: null, consumerFingerprint: null });
      expect(await repository.recoverEmbeddingHandoff(workspaceId, invocationId)).toMatchObject({ kind: "RECOVERABLE", response: { vectors } });
      await expect(repository.consumeEmbeddingResult({ workspaceId, invocationId, snapshotId, consumerKind: "UPGRADE", consumerKey: "targets", consumerFingerprint: "b".repeat(64) }, async () => undefined)).resolves.toMatchObject({ status: "CONSUMED" });
      await expect(repository.consumeEmbeddingResult({ workspaceId, invocationId, snapshotId, consumerKind: "UPGRADE", consumerKey: "targets", consumerFingerprint: "b".repeat(64) }, async () => undefined)).resolves.toMatchObject({ status: "ALREADY_CONSUMED" });
      expect(await db.providerUsageEvent.count({ where: { workspaceId } })).toBe(1);
    } finally { if (existsSync(parked) && !existsSync(migration)) renameSync(parked, migration); await db.$disconnect(); await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS "ai_cognitive_studio_phase8c2b_upgrade_test"'); await admin.$disconnect(); }
  }, 120_000);
});

afterAll(() => { if (existsSync(parked) && !existsSync(migration)) renameSync(parked, migration); });
