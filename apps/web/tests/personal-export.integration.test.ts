import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { exportPersonalRecords } from "../lib/personal-export";
const identity = vi.hoisted(() => vi.fn());
vi.mock("../lib/identity", () => ({ resolveSessionUserId: identity }));
import { GET } from "../app/api/account/export/route";
const users: string[] = [], workspaces: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); identity.mockReset();
  const where = { workspaceId: { in: workspaces } };
  await prisma.thinkingSession.deleteMany({ where });
  await prisma.bookMemoryItem.deleteMany({ where });
  await prisma.analysisArtifact.deleteMany({ where });
  await prisma.bookAnalysisRun.deleteMany({ where });
  await prisma.chunkSet.deleteMany({ where });
  await prisma.documentExtraction.deleteMany({ where });
  await prisma.ingestionRun.deleteMany({ where });
  await prisma.job.deleteMany({ where });
  await prisma.sourceDocument.deleteMany({ where });
  await prisma.source.deleteMany({ where });
  await prisma.sourceBlob.deleteMany({ where });
  await prisma.workspaceMember.deleteMany({ where });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaces.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(() => prisma.$disconnect());
async function fixture() {
  const suffix = randomUUID();
  const a = await prisma.user.create({ data: { email: `${suffix}-a@export.test`, name: "Owner" } }); users.push(a.id);
  const b = await prisma.user.create({ data: { email: `${suffix}-b@export.test`, name: "Foreign" } }); users.push(b.id);
  const workspace = await prisma.workspace.create({ data: { name: suffix } }); workspaces.push(workspace.id);
  const workspaceId = workspace.id;
  await prisma.workspaceMember.createMany({ data: users.map(userId => ({ workspaceId, userId, role: "VIEWER" })) });
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: "shared source" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: suffix } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: suffix } });
  const job = await prisma.job.create({ data: { workspaceId, type: "source.ingest", payload: {}, status: "SUCCEEDED" } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId, sourceDocumentId: document.id, jobId: job.id, parserVersion: "test", normalizationVersion: "test" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "test", parserVersion: "test", normalizationVersion: "test" } });
  const chunks = await prisma.chunkSet.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "test", configuration: {}, configurationHash: suffix, status: "SUCCEEDED" } });
  const analysisJob = await prisma.job.create({ data: { workspaceId, type: "book.analysis", payload: {}, status: "SUCCEEDED" } });
  const run = await prisma.bookAnalysisRun.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunks.id, jobId: analysisJob.id, pipelineVersion: "test", promptVersion: "test", provider: "test", model: "test", modelVersionKey: "test", idempotencyKey: suffix, analysisIdentityHash: suffix, status: "SUCCEEDED" } });
  const artifact = await prisma.analysisArtifact.create({ data: { workspaceId, analysisRunId: run.id, chunkSetId: chunks.id, extractionId: extraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } });
  const memory = await prisma.bookMemoryItem.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "SUMMARY", ordinal: 0, content: "shared cognition", contentHash: suffix, memoryKey: suffix } });
  for (const [userId, content] of [[a.id, "own private response"], [b.id, "foreign private response"]]) {
    await prisma.thinkingSession.create({ data: { workspaceId, userId: userId!, memoryItemId: memory.id, messages: { create: { role: "USER", content: content!, ordinal: 0 } } } });
  }
  return { a, b };
}
describe("personal learning export", () => {
  it("exports only the session user's records even when another user shares the same workspace and memory", async () => {
    const { a, b } = await fixture(); identity.mockResolvedValue(a.id);
    const response = await GET(); const text = await response.text(); const result = JSON.parse(text);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(result.data.profile.id).toBe(a.id);
    expect(result.data.thinkingSessions).toHaveLength(1);
    expect(result.data.thinkingMessages).toHaveLength(1);
    expect(text).toContain("own private response");
    expect(text).not.toContain("foreign private response"); expect(text).not.toContain(b.email);
    expect(Object.keys(result.data.profile).sort()).toEqual(["createdAt", "email", "emailVerified", "id", "name", "updatedAt"]);
    expect(result.excluded).toContain("authentication-and-provider-secrets");
  });
  it("rejects oversized owned content while another account still exports and retry converges", async () => {
    const { a, b } = await fixture();
    await prisma.$executeRaw`UPDATE "ThinkingSessionMessage" SET "content"=repeat('中', 7340032) WHERE "sessionId" IN (SELECT "id" FROM "ThinkingSession" WHERE "userId"=${a.id})`;
    identity.mockResolvedValue(a.id);
    expect((await GET()).status).toBe(413);
    expect(JSON.parse(await exportPersonalRecords(b.id)).data.profile.id).toBe(b.id);
    await prisma.thinkingSessionMessage.updateMany({ where: { session: { userId: a.id } }, data: { content: "restored" } });
    expect(JSON.parse(await exportPersonalRecords(a.id)).data.thinkingMessages[0].content).toBe("restored");
  });
  it("rejects unauthenticated requests and sanitizes backend failures", async () => {
    identity.mockRejectedValue(new Error("WEB_IDENTITY_REQUIRED"));
    expect((await GET()).status).toBe(401);
    identity.mockRejectedValue(new Error("password=never-return"));
    const response = await GET(); expect(response.status).toBe(503); expect(await response.text()).not.toContain("never-return");
  });
  it("fails closed when the account no longer exists", async () => {
    await expect(exportPersonalRecords(randomUUID())).rejects.toThrow("WEB_IDENTITY_REQUIRED");
  });
  it("rejects overlapping exports for the same account without blocking another account", async () => {
    const { a, b } = await fixture();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`personal-export:${a.id}`}, 0))::text`;
      identity.mockResolvedValue(a.id);
      const response = await GET();
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("10");
      expect(JSON.parse(await exportPersonalRecords(b.id)).data.profile.id).toBe(b.id);
    }, { timeout: 10000 });
    expect(JSON.parse(await exportPersonalRecords(a.id)).data.profile.id).toBe(a.id);
  });
});

