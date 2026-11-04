import { describe, expect, it, vi, beforeEach } from "vitest";
const state = vi.hoisted(() => ({ rows: 0, bytes: 0, content: "", reads: vi.fn() }));
vi.mock("@ai-cognitive/db", async () => ({ Prisma: (await vi.importActual<typeof import("@ai-cognitive/db")>("@ai-cognitive/db")).Prisma, prisma: { $transaction: async (action: (tx: unknown) => unknown) => {
  const model = { count: async () => 0, findMany: async () => { state.reads(); return []; } };
  return action({
    $queryRaw: async () => [{ acquired: true, bytes: String(state.bytes) }],
    user: { findUnique: async () => ({ id: "owner" }) },
    workspaceMember: { ...model, count: async () => state.rows },
    userCognitionState: model, userCognitionReviewState: model, userCognitionReviewEvent: model,
    thinkingSession: model, thinkingSessionMessage: { ...model, findMany: async () => [{ content: state.content }] },
    teachBackAttempt: model, teachBackAssessment: model,
  });
} } }));
import { exportPersonalRecords } from "../lib/personal-export";
beforeEach(() => { state.rows = 0; state.bytes = 0; state.content = ""; state.reads.mockClear(); });
describe("export limits fail without returning truncated archives", () => {
  it("rejects oversized payloads before transferring records from the database", async () => {
    state.bytes = 20 * 1024 * 1024 + 1;
    await expect(exportPersonalRecords("owner")).rejects.toThrow("PERSONAL_EXPORT_TOO_LARGE");
    expect(state.reads).not.toHaveBeenCalled();
  });
  it("rejects excess records before loading data", async () => {
    state.rows = 10001;
    await expect(exportPersonalRecords("owner")).rejects.toThrow("PERSONAL_EXPORT_TOO_LARGE");
    expect(state.reads).not.toHaveBeenCalled();
  });
  it("bounds encoded UTF-8 bytes rather than character count", async () => {
    state.content = "中".repeat(7 * 1024 * 1024);
    await expect(exportPersonalRecords("owner")).rejects.toThrow("PERSONAL_EXPORT_TOO_LARGE");
  });
});
