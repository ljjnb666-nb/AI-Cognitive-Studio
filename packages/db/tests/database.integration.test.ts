import { afterAll, afterEach, describe, expect, it } from "vitest";
import { JobStatus, prisma } from "../src/index.js";

afterEach(async () => {
  await prisma.job.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("database integration", () => {
  it("creates, updates, and reads a User with its Job", async () => {
    const user = await prisma.user.create({
      data: { email: "phase0@example.test", name: "Phase Zero" },
    });
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        type: "system.health-check",
        payload: { message: "phase-0" },
      },
    });

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { status: JobStatus.SUCCEEDED, progress: 100, result: { ok: true } },
      include: { user: true },
    });

    expect(updated.status).toBe(JobStatus.SUCCEEDED);
    expect(updated.user.email).toBe("phase0@example.test");
    expect(updated.result).toEqual({ ok: true });
  });
});
