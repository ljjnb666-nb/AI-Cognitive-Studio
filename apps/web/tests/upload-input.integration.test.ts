import { beforeEach, describe, expect, it, vi } from "vitest";
import { unsupportedUploadCode, uploadMediaType } from "../lib/upload-input";
import { uploadErrorMessage } from "../lib/product-errors";
import { POST } from "../app/api/studio/upload/route";

const { createUploadIntent, completeUpload } = vi.hoisted(() => ({
  createUploadIntent: vi.fn(async () => ({ session: { id: "session-fixture" }, upload: { url: "http://storage.test/upload" } })),
  completeUpload: vi.fn(),
}));
vi.mock("@ai-cognitive/ingestion", () => ({ createIngestionService: () => ({ createUploadIntent, completeUpload }) }));
vi.mock("@/lib/identity", () => ({ resolveWebMutationIdentity: async () => ({ workspaceId: "workspace-fixture", userId: "user-fixture" }), trustedRequestContext: (identity: unknown) => identity }));
vi.mock("@/lib/storage", () => ({ storage: () => ({}) }));
const post = (body: unknown) => POST(new Request("http://localhost/api/studio/upload", { method: "POST", body: JSON.stringify(body) }));
beforeEach(() => vi.clearAllMocks());

describe("EPUB upload input compatibility", () => {
  it("identifies MOBI separately and does not upload it under an EPUB or PDF MIME", () => {
    const file = { name: "第一性原理.mobi", type: "application/pdf" };
    expect(uploadMediaType(file)).toBeNull();
    expect(uploadErrorMessage(unsupportedUploadCode(file))).toBe("暂不支持 MOBI 格式，请先转换为 EPUB 或 PDF 后上传。");
  });
  it.each(["application/epub", "application/epub+zip", "application/octet-stream", "application/x-zip-compressed", ""])("normalizes Windows and browser MIME %s using the EPUB extension", (type) => {
    expect(uploadMediaType({ name: "中文书名.EPUB", type })).toBe("application/epub+zip");
  });
  it("does not mislabel unsupported files as PDF", () => {
    expect(uploadMediaType({ name: "book.exe", type: "application/octet-stream" })).toBeNull();
    expect(uploadMediaType({ name: "book.MD", type: "text/plain" })).toBe("text/markdown");
  });
  it.each(["application/epub", "application/epub+zip"])("accepts %s at the real HTTP handler and supplies canonical MIME to ingestion", async (mediaType) => {
    const response = await post({ filename: "中文传记.epub", mediaType, sizeBytes: 755178 });
    expect(response.status).toBe(200);
    expect(createUploadIntent).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-fixture", userId: "user-fixture" }, { filename: "中文传记.epub", mediaType: "application/epub+zip", sizeBytes: 755178 });
    expect(completeUpload).not.toHaveBeenCalled();
  });
  it("keeps unknown MIME blocked and returns a safe actionable error", async () => {
    const response = await post({ filename: "book.epub", mediaType: "application/x-unknown", sizeBytes: 1 });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "UPLOAD_REQUEST_INVALID" });
    expect(uploadErrorMessage(body.error)).toBe("上传信息不完整或格式无效，请重新选择文件。");
    expect(createUploadIntent).not.toHaveBeenCalled();
  });
  it("retains size and filename limits with stable errors", async () => {
    for (const [input] of [[{ filename: "a".repeat(181) }, "UPLOAD_FILENAME_INVALID"], [{ sizeBytes: 100 * 1024 * 1024 + 1 }, "UPLOAD_SIZE_INVALID"]] as const) {
      const response = await post(Object.assign({ filename: "book.epub", mediaType: "application/epub", sizeBytes: 10 }, input));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "UPLOAD_REQUEST_INVALID" });
    }
    expect(createUploadIntent).not.toHaveBeenCalled();
  });
});
