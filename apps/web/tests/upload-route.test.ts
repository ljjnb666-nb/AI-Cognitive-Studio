import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), storage: vi.fn(), intent: vi.fn(), complete: vi.fn() }));
vi.mock("../lib/identity", () => ({ resolveWebMutationIdentity: mocks.identity, trustedRequestContext: (identity: unknown) => identity }));
vi.mock("../lib/storage", () => ({ storage: mocks.storage }));
vi.mock("@ai-cognitive/ingestion", () => ({ createIngestionService: () => ({ createUploadIntent: mocks.intent, completeUpload: mocks.complete }) }));
import { POST } from "../app/api/studio/upload/route";
const request = (body: unknown) => new Request("http://localhost/api/studio/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
afterEach(() => vi.resetAllMocks());
describe("upload HTTP contract", () => {
  it("denies a viewer before storage or signing with a 403", async () => {
    mocks.identity.mockRejectedValue(new Error("WORKSPACE_WRITE_DENIED"));
    const response = await POST(request({ filename: "book.txt", mediaType: "text/plain", sizeBytes: 10 }));
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "WORKSPACE_WRITE_DENIED" });
    expect(mocks.storage).not.toHaveBeenCalled(); expect(mocks.intent).not.toHaveBeenCalled();
  });
  it("exposes a working POST handler and returns the signed upload contract", async () => {
    mocks.identity.mockResolvedValue({ workspaceId: "workspace", userId: "user" });
    mocks.intent.mockResolvedValue({ session: { id: "session" }, upload: { url: "https://storage.example/upload", method: "PUT" } });
    const response = await POST(request({ filename: "book.txt", mediaType: "text/plain", sizeBytes: 10 }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ sessionId: "session", upload: { method: "PUT" } });
    expect(mocks.intent).toHaveBeenCalledWith({ workspaceId: "workspace", userId: "user" }, { filename: "book.txt", mediaType: "text/plain", sizeBytes: 10 });
  });
  it("does not expose database or storage error details", async () => {
    mocks.identity.mockRejectedValue(new Error("Database connection failed: password=secret"));
    const response = await POST(request({}));
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "UPLOAD_REQUEST_FAILED" });
  });
});
