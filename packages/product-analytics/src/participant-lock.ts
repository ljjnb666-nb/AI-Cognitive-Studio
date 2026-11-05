import { prisma, type Prisma } from "@ai-cognitive/db";

/** All participant-scoped telemetry writes and withdrawal share this row lock. */
export async function withParticipantLock<T>(userId: string, active: boolean, work: (tx: Prisma.TransactionClient, participant: { id: string }) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT "id", "status" FROM "BetaParticipant" WHERE "userId" = ${userId} FOR UPDATE`;
    const participant = rows[0];
    if (!participant || (active && participant.status !== "ACTIVE")) throw new Error("BETA_ACCESS_REQUIRED");
    return work(tx, participant);
  });
}
