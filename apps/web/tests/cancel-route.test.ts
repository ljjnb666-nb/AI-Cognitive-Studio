import { afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ identity: vi.fn(), cancel: vi.fn() }));
vi.mock("@ai-cognitive/db", () => ({ cancelWorkspaceJob: calls.cancel }));
vi.mock("../lib/identity", () => ({ resolveWebMutationIdentity: calls.identity, trustedRequestContext: (value: unknown) => value }));
import { POST } from "../app/api/studio/jobs/[jobId]/cancel/route";
afterEach(() => vi.resetAllMocks());
const request = () => POST(new Request("http://localhost/api/studio/jobs/job/cancel", { method: "POST" }), { params: Promise.resolve({ jobId: "job" }) });
it("rejects unauthenticated cancellation before invoking the service", async () => {
  calls.identity.mockRejectedValue(new Error("WEB_IDENTITY_REQUIRED"));
  expect((await request()).status).toBe(401);
  expect(calls.cancel).not.toHaveBeenCalled();
});
it.each([
  ["WORKSPACE_WRITE_DENIED", 403],
  ["CANCELLABLE_OPERATION_NOT_FOUND", 404],
  ["OPERATION_ALREADY_TERMINAL", 409],
  ["database password=secret", 503],
] as const)("maps %s without exposing backend details", async (error, status) => {
  calls.identity.mockResolvedValue({ workspaceId: "workspace", userId: "user" });
  calls.cancel.mockRejectedValue(new Error(error));
  const response = await request();
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({ error: status === 503 ? "CANCEL_UNAVAILABLE" : error });
});
