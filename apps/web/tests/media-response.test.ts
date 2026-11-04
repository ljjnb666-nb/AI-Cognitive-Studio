import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "@ai-cognitive/storage";
import { mediaResponse } from "../lib/media-response";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), audio: vi.fn(), video: vi.fn(), storage: vi.fn() }));
vi.mock("../lib/identity", () => ({ resolveWebIdentity: mocks.identity }));
vi.mock("../lib/storage", () => ({ storage: mocks.storage }));
vi.mock("@ai-cognitive/db", () => ({ prisma: { podcastAudioRevision: { findFirst: mocks.audio }, shortVideoRevision: { findFirst: mocks.video } } }));
import { GET } from "../app/api/studio/media/[kind]/[id]/route";
const bytes = new TextEncoder().encode("0123456789");
function fixture() {
  const headObject = vi.fn(async () => ({ key: "media", size: bytes.length }));
  const getObjectStream = vi.fn<StorageProvider["getObjectStream"]>(async (_key, options) => (async function* () { yield options?.range ? bytes.slice(options.range.start, options.range.end + 1) : bytes; })());
  return { provider: { headObject, getObjectStream } as unknown as StorageProvider, headObject, getObjectStream };
}
function request(range?: string, method = "GET") { return new Request("http://localhost/api/studio/media/video/revision", { method, headers: range ? { range } : {} }); }
beforeEach(() => vi.resetAllMocks());
describe("private streaming media responses", () => {
  it.each([["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=7-", "789", "bytes 7-9/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=7-999", "789", "bytes 7-9/10"]])("streams %s from the storage byte range", async (range, value, contentRange) => {
    const { provider, getObjectStream } = fixture(); const response = await mediaResponse(request(range), provider, "media", "video/mp4");
    expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(String(value.length)); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe(value); expect(getObjectStream).toHaveBeenCalledWith("media", expect.objectContaining({ range: expect.any(Object), signal: expect.any(AbortSignal) }));
  });
  it.each(["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4", "bytes=-", "bytes=9007199254740992-", "invalid"])("rejects unsatisfiable or unsupported range %s before opening storage", async range => {
    const { provider, getObjectStream } = fixture(); const response = await mediaResponse(request(range), provider, "media", "audio/wav");
    expect(response.status).toBe(416); expect(response.headers.get("content-range")).toBe("bytes */10"); expect(getObjectStream).not.toHaveBeenCalled();
  });
  it("returns full streams and serves HEAD without downloading the object", async () => {
    const { provider, getObjectStream } = fixture(); const full = await mediaResponse(request(), provider, "media", "video/mp4");
    expect(full.status).toBe(200); expect(await full.text()).toBe("0123456789"); getObjectStream.mockClear();
    const head = await mediaResponse(request("bytes=0-2", "HEAD"), provider, "media", "video/mp4");
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("10"); expect(await head.text()).toBe(""); expect(getObjectStream).not.toHaveBeenCalled();
  });
  it("does not apply a range whose If-Range validator cannot be confirmed", async () => {
    const { provider } = fixture(); const req = request("bytes=0-2"); req.headers.set("if-range", '"old"');
    const response = await mediaResponse(req, provider, "media", "video/mp4"); expect(response.status).toBe(200); expect(await response.text()).toBe("0123456789");
  });
  it("aborts the storage request when the client stops reading", async () => {
    const { provider, getObjectStream } = fixture(); const response = await mediaResponse(request(), provider, "media", "video/mp4");
    await response.body!.cancel(); expect(getObjectStream.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it("rejects a truncated storage stream instead of returning silently incomplete bytes", async () => {
    const { provider, headObject } = fixture(); headObject.mockResolvedValue({ key: "media", size: 11 });
    const response = await mediaResponse(request(), provider, "media", "video/mp4"); await expect(response.text()).rejects.toThrow("MEDIA_TRUNCATED_OBJECT");
  });
  it("checks workspace ownership before creating any storage client", async () => {
    mocks.identity.mockResolvedValue({ workspaceId: "workspace-a", userId: "user-a" }); mocks.video.mockResolvedValue(null);
    const response = await GET(request("bytes=0-2"), { params: Promise.resolve({ kind: "video", id: "other-revision" }) });
    expect(response.status).toBe(404); expect(mocks.video).toHaveBeenCalledWith({ where: { id: "other-revision", workspaceId: "workspace-a" }, select: { storageKey: true } }); expect(mocks.storage).not.toHaveBeenCalled();
  });
  it("does not reveal session or database failures", async () => {
    mocks.identity.mockRejectedValue(new Error("private SQL and credentials"));
    const response = await GET(request(), { params: Promise.resolve({ kind: "video", id: "id" }) }); expect(response.status).toBe(403); expect(await response.text()).not.toContain("credentials"); expect(mocks.storage).not.toHaveBeenCalled();
  });
});
