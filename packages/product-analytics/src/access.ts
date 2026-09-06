import { prisma } from "@ai-cognitive/db";

export type BetaAccessMode = "OFF" | "ENFORCED";
export function betaAccessMode(source: NodeJS.ProcessEnv = process.env): BetaAccessMode {
  const value = source.BETA_ACCESS_MODE?.trim() || "OFF";
  if (value !== "OFF" && value !== "ENFORCED") throw new Error("BETA_ACCESS_MODE_INVALID");
  return value;
}

export async function activeBetaParticipant(userId: string) {
  return prisma.betaParticipant.findFirst({ where: { userId, status: "ACTIVE" } });
}

/** Authoritative gate; call before workspace provisioning and every Studio mutation. */
export async function assertStudioBetaAccess(userId: string) {
  if (betaAccessMode() === "OFF") return null;
  const participant = await activeBetaParticipant(userId);
  if (!participant) throw new Error("BETA_ACCESS_REQUIRED");
  return participant;
}

export async function assertBetaOperator(userId: string) {
  const participant = await activeBetaParticipant(userId);
  if (!participant || participant.role !== "OPERATOR") throw new Error("BETA_OPERATOR_REQUIRED");
  return participant;
}

/** Used by server-rendered Studio chrome so telemetry UI is never mounted for
 * ordinary Phase 1–16 users while beta enforcement is disabled. */
export async function betaTelemetryEnabledForUser(userId: string) {
  if (betaAccessMode() !== "ENFORCED") return false;
  return Boolean(await activeBetaParticipant(userId));
}

export async function withdrawBetaParticipant(userId: string) {
  const now = new Date();
  const result = await prisma.betaParticipant.updateMany({ where: { userId, status: "ACTIVE" }, data: { status: "WITHDRAWN", withdrawnAt: now } });
  if (!result.count) throw new Error("BETA_PARTICIPANT_NOT_ACTIVE");
  // Product telemetry and explicit beta feedback are the deletion scope; core product data remains intact.
  const participant = await prisma.betaParticipant.findUniqueOrThrow({ where: { userId } });
  await prisma.$transaction([prisma.productEvent.deleteMany({ where: { participantId: participant.id } }), prisma.betaFeedback.deleteMany({ where: { participantId: participant.id } })]);
}
