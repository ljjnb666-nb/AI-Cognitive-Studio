import { describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "@ai-cognitive/storage";

const mocks = vi.hoisted(() => ({
  prisma: {
    workspaceMember: { findUnique: vi.fn() },
    uploadSession: { findFirstOrThrow: vi.fn() },
    uploadCompletion: { findUniqueOrThrow: vi.fn() },
  },
}));

vi.mock("@ai-cognitive/db", () => ({
  prisma: mocks.prisma,
  JobStatus: { RUNNING: "RUNNING", SUCCEEDED: "SUCCEEDED", FAILED: "FAILED" },
}));

vi.mock("@ai-cognitive/shared", () => ({ logger: { error: vi.fn() } }));

import { createIngestionService } from "../src/index.js";

describe("completeUpload", () => {
  it("reads a completed upload from its workspace-scoped UploadCompletion", async () => {
    const context = { userId: "user-a", workspaceId: "workspace-a" };
    const sourceDocument = { id: "document-a", workspaceId: context.workspaceId };
    mocks.prisma.workspaceMember.findUnique.mockResolvedValue({ workspaceId: context.workspaceId, userId: context.userId });
    mocks.prisma.uploadSession.findFirstOrThrow.mockResolvedValue({ id: "session-a", workspaceId: context.workspaceId, status: "COMPLETED" });
    mocks.prisma.uploadCompletion.findUniqueOrThrow.mockResolvedValue({ sourceDocument });

    const service = createIngestionService({} as StorageProvider);
    await expect(service.completeUpload(context, "session-a")).resolves.toEqual(sourceDocument);
    expect(mocks.prisma.uploadCompletion.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { uploadSessionId_workspaceId: { uploadSessionId: "session-a", workspaceId: context.workspaceId } },
      include: { sourceDocument: true },
    });
  });
});
