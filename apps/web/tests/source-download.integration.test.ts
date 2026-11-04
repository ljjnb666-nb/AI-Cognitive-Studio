import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), storage: vi.fn(), head: vi.fn(), stream: vi.fn() }));
vi.mock("../lib/identity", () => ({ resolveWebIdentity: mocks.identity }));
vi.mock("../lib/storage", () => ({ storage: mocks.storage }));
import { GET, HEAD } from "../app/api/studio/sources/[sourceDocumentId]/download/route";
const workspaces: string[] = [];
beforeEach(() => {
  mocks.storage.mockReturnValue({ headObject: mocks.head, getObjectStream: mocks.stream });
  mocks.head.mockResolvedValue({ size: 10 });
  mocks.stream.mockImplementation(async (_key, options) => (async function* () { const bytes = Buffer.from("0123456789"); yield options?.range ? bytes.subarray(options.range.start, options.range.end + 1) : bytes; })());
});
afterEach(async () => {
  const where = { workspaceId: { in: workspaces } };
  await prisma.sourceDocument.deleteMany({ where }); await prisma.source.deleteMany({ where }); await prisma.sourceBlob.deleteMany({ where });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaces.splice(0) } } });
  vi.resetAllMocks();
});
afterAll(() => prisma.$disconnect());
async function fixture(name = "原始资料.pdf") {
  const workspace = await prisma.workspace.create({ data: { name: randomUUID() } }); workspaces.push(workspace.id);
  const workspaceId = workspace.id, key = `private/${randomUUID()}`;
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: name } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId, sha256: randomUUID(), sizeBytes: 10, mediaType: "text/html", storageKey: key } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId, sourceId: source.id, sourceBlobId: blob.id, sha256: blob.sha256, sizeBytes: 10, mediaType: blob.mediaType, storageKey: key, version: 1 } });
  return { workspaceId, key, params: Promise.resolve({ sourceDocumentId: document.id }) };
}
const request = (method = "GET", range?: string) => new Request("http://localhost/api/studio/sources/id/download", { method, headers: range ? { range } : {} });
it("streams the original as a private attachment and honors ranges and HEAD", async () => {
  const f = await fixture(); mocks.identity.mockResolvedValue({ workspaceId: f.workspaceId });
  const response = await GET(request("GET", "bytes=2-5"), f);
  expect(response.status).toBe(206); expect(await response.text()).toBe("2345");
  expect(response.headers.get("content-disposition")).toContain(encodeURIComponent("原始资料.pdf"));
  expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("cache-control")).toContain("no-store");
  mocks.stream.mockClear(); const head = await HEAD(request("HEAD"), f);
  expect(head.headers.get("content-length")).toBe("10"); expect(await head.text()).toBe(""); expect(mocks.stream).not.toHaveBeenCalled();
});
it("denies another workspace before consulting object storage", async () => {
  const f = await fixture(); mocks.identity.mockResolvedValue({ workspaceId: randomUUID() });
  const response = await GET(request(), f); expect(response.status).toBe(404); expect(mocks.storage).not.toHaveBeenCalled(); expect(await response.text()).not.toContain(f.key);
});
it("sanitizes header injection and path separators", async () => {
  const f = await fixture("中文/evil\\file\r\nX-Injected: yes'(*).html"); mocks.identity.mockResolvedValue({ workspaceId: f.workspaceId });
  const response = await GET(request(), f); expect(response.status).toBe(200); expect(response.headers.has("x-injected")).toBe(false); expect(response.headers.get("content-disposition")).toContain("%27%28%2A%29"); await response.body!.cancel();
});
it("denies unauthenticated requests and hides storage failure details", async () => {
  mocks.identity.mockRejectedValueOnce(new Error("WEB_IDENTITY_REQUIRED"));
  expect((await GET(request(), { params: Promise.resolve({ sourceDocumentId: "id" }) })).status).toBe(401);
  expect(mocks.storage).not.toHaveBeenCalled();
  const f = await fixture(); mocks.identity.mockResolvedValue({ workspaceId: f.workspaceId }); mocks.head.mockRejectedValue(new Error("private-key password=secret"));
  const response = await GET(request(), f); expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret");
});
