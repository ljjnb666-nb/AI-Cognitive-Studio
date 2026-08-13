import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { createShortVideoProject } from "../src/index.js";

const workspaces: string[] = [], users: string[] = [];
async function fixture() {
  const suffix = crypto.randomUUID();
  const user = await prisma.user.create({ data: { email: `${suffix}@phase5.test` } }); users.push(user.id);
  const workspace = await prisma.workspace.create({ data: { name: suffix } }); workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: suffix } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: `phase5/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: blob.storageKey } });
  return { user, workspace, document };
}
afterEach(async () => { for (const id of workspaces.splice(0)) await prisma.workspace.delete({ where: { id } }).catch(() => undefined); for (const id of users.splice(0)) await prisma.user.delete({ where: { id } }).catch(() => undefined); });
afterAll(() => prisma.$disconnect());

describe("Phase 5 PostgreSQL lineage", () => {
  it("rejects a direct cross-workspace project source relation", async () => {
    const a = await fixture(), b = await fixture();
    const project = await createShortVideoProject({ workspaceId: a.workspace.id, userId: a.user.id }, { name: "A", sourceDocumentIds: [a.document.id] });
    await expect(prisma.shortVideoProjectSource.create({ data: { shortVideoProjectId: project.id, sourceDocumentId: b.document.id, workspaceId: a.workspace.id } })).rejects.toThrow();
  });
  it("rejects direct cross-workspace project/run and revision/run lineage writes", async () => {
    const a = await fixture(), b = await fixture();
    const project = await createShortVideoProject({ workspaceId: a.workspace.id, userId: a.user.id }, { name: "A", sourceDocumentIds: [a.document.id] });
    const foreignProject = await createShortVideoProject({ workspaceId: b.workspace.id, userId: b.user.id }, { name: "B", sourceDocumentIds: [b.document.id] });
    const job = await prisma.job.create({ data: { workspaceId: a.workspace.id, userId: a.user.id, type: "short-video.generation", payload: {} } });
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "ShortVideoGenerationRun" ("id","workspaceId","shortVideoProjectId","styleProfileId","jobId","provider","model","modelVersionKey","promptVersion","pipelineVersion","retrievalVersion","scenePlannerVersion","captionVersion","audioVersion","renderVersion","generationIdentityHash","idempotencyKey") SELECT 'bad-${crypto.randomUUID()}', '${a.workspace.id}', '${foreignProject.id}', "id", '${job.id}', 'p', 'm', '', 'v', 'v', 'v', 'v', 'v', 'v', 'v', '${crypto.randomUUID()}', '${crypto.randomUUID()}' FROM "ShortVideoStyleProfile" WHERE "shortVideoProjectId"='${project.id}' LIMIT 1`)).rejects.toThrow();
  });
});
