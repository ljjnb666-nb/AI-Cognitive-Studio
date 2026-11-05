import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { libraryDeletionPreview, deleteFromLibrary } from "../lib/library-deletion";
import { sources, sourceDetail } from "../lib/product";
import { GET, DELETE } from "../app/api/studio/library/[sourceDocumentId]/route";
import { POST as generate } from "../app/api/studio/generate/route";
import { POST as analyze } from "../app/api/studio/book-intelligence/route";
import type { WebIdentityContext } from "../lib/identity";
let actor: WebIdentityContext;
vi.mock("@/lib/identity", () => ({ resolveWebIdentity: async () => actor, resolveWebMutationIdentity: async () => actor, trustedRequestContext: (value: WebIdentityContext) => ({ userId: value.userId, workspaceId: value.workspaceId }) }));
const workspaces: string[] = [], users: string[] = [];
async function fixture(role: "OWNER" | "EDITOR" | "VIEWER" = "OWNER") {
  const user = await prisma.user.create({ data: { email: `${crypto.randomUUID()}@library-delete.test` } }); users.push(user.id);
  const workspace = await prisma.workspace.create({ data: { name: "library-delete-fixture" } }); workspaces.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role } });
  const context: WebIdentityContext = { workspaceId: workspace.id, userId: user.id, userName: null, email: user.email, workspaces: [{ id: workspace.id, name: workspace.name }] };
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "删除验收原稿.txt" } });
  const docs = [];
  for (let version = 1; version <= 2; version++) {
    const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: crypto.randomUUID(), sizeBytes: 1, mediaType: "text/plain", storageKey: `fixture/${crypto.randomUUID()}` } });
    docs.push(await prisma.sourceDocument.create({ data: { workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version, sha256: blob.sha256, sizeBytes: blob.sizeBytes, mediaType: blob.mediaType, storageKey: blob.storageKey } }));
  }
  return { context, source, docs };
}
afterEach(async () => {
  const where = { workspaceId: { in: workspaces } };
  await prisma.ingestionRun.deleteMany({ where }); await prisma.job.deleteMany({ where });
  await prisma.sourceDocument.deleteMany({ where }); await prisma.source.deleteMany({ where }); await prisma.sourceBlob.deleteMany({ where });
  await prisma.workspaceMember.deleteMany({ where }); await prisma.workspace.deleteMany({ where: { id: { in: workspaces.splice(0) } } }); await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
describe("workspace library removal using the existing Source archive authority", () => {
  it("removes all versions from library reads while retaining blobs, documents and historical tasks", async () => {
    const f = await fixture(); actor = f.context;
    const job = await prisma.job.create({ data: { workspaceId: actor.workspaceId, userId: actor.userId, type: "fixture", payload: {}, idempotencyKey: crypto.randomUUID() } });
    const run = await prisma.ingestionRun.create({ data: { workspaceId: actor.workspaceId, sourceDocumentId: f.docs[0]!.id, jobId: job.id, status: "FAILED", errorCode: "SOURCE_PARSE_ERROR", parserVersion: "fixture", normalizationVersion: "fixture" } });
    const expected = await libraryDeletionPreview(actor, f.docs[0]!.id);
    expect(expected.versionCount).toBe(2);
    expect(await sources(actor)).toHaveLength(2);
    const result = await deleteFromLibrary(actor, f.docs[0]!.id, expected);
    expect(result.documentIds).toEqual(expect.arrayContaining(f.docs.map(doc => doc.id)));
    expect(await sources(actor)).toHaveLength(0);
    await expect(sourceDetail(f.docs[1]!.id, actor)).rejects.toThrow("SOURCE_DOCUMENT_ACCESS_DENIED");
    expect(await prisma.sourceDocument.count({ where: { workspaceId: actor.workspaceId } })).toBe(2);
    expect(await prisma.sourceBlob.count({ where: { workspaceId: actor.workspaceId } })).toBe(2);
    expect(await prisma.ingestionRun.findUnique({ where: { id: run.id } })).toEqual(run);
    expect(await prisma.job.findUnique({ where: { id: job.id } })).toEqual(job);
    expect((await prisma.source.findUniqueOrThrow({ where: { id: f.source.id } })).archivedAt).toBeInstanceOf(Date);
  });
  it("rejects viewer and foreign workspace deletion and stale confirmation without mutation", async () => {
    const f = await fixture("VIEWER"); actor = f.context;
    const expected = await libraryDeletionPreview(actor, f.docs[0]!.id);
    await expect(deleteFromLibrary(actor, f.docs[0]!.id, expected)).rejects.toThrow("SOURCE_DELETE_FORBIDDEN");
    const foreign = await fixture();
    await expect(deleteFromLibrary(foreign.context, f.docs[0]!.id, expected)).rejects.toThrow("SOURCE_DOCUMENT_ACCESS_DENIED");
    await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } }, data: { role: "EDITOR" } });
    await prisma.source.update({ where: { id: f.source.id }, data: { displayName: "changed" } });
    await expect(deleteFromLibrary(actor, f.docs[0]!.id, expected)).rejects.toThrow("SOURCE_DELETE_CHANGED");
    expect((await prisma.source.findUniqueOrThrow({ where: { id: f.source.id } })).archivedAt).toBeNull();
  });
  it("exposes an idempotent delete API and rejects archived books before any new generation or analysis", async () => {
    const f = await fixture("EDITOR"); actor = f.context;
    const params = { params: Promise.resolve({ sourceDocumentId: f.docs[0]!.id }) };
    const preview = await (await GET(new Request("http://localhost"), params)).json();
    const request = () => new Request("http://localhost", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: preview.sourceId, updatedAt: preview.updatedAt, versionCount: preview.versionCount }) });
    const responses = await Promise.all([DELETE(request(), params), DELETE(request(), params)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect((await (await DELETE(request(), params)).json()).documentIds).toHaveLength(2);
    const generated = await generate(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "video", title: "fixture", sourceDocumentIds: [f.docs[0]!.id], duration: 60, tone: "fixture" }) }));
    expect(generated.status).toBe(403);
    expect(await generated.json()).toEqual({ error: "SOURCE_DOCUMENT_ACCESS_DENIED" });
    const analysis = await analyze(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceDocumentId: f.docs[0]!.id }) }));
    expect(analysis.status).toBe(403);
    expect(await prisma.providerInvocation.count({ where: { workspaceId: actor.workspaceId } })).toBe(0);
  });
});
