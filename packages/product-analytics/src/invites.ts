import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { BETA_CONSENT_VERSION, GENERIC_INVITE_ERROR } from "./constants.js";

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const createInviteToken = () => randomBytes(32).toString("base64url");

export async function createBetaInvite(input: { cohort: string; expiresAt: Date }) {
  const token = createInviteToken();
  const invite = await prisma.betaInvite.create({ data: { tokenHash: hashInviteToken(token), cohort: input.cohort, expiresAt: input.expiresAt } });
  return { invite, token }; // caller displays once and must never log or persist it.
}

export async function redeemBetaInvite(input: { token: string; userId: string; consent: boolean; now?: Date }) {
  if (!input.consent) throw new Error("BETA_CONSENT_REQUIRED");
  const now = input.now ?? new Date();
  const tokenHash = hashInviteToken(input.token);
  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.betaInvite.updateMany({ where: { tokenHash, redeemedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { redeemedAt: now, redeemedByUserId: input.userId } });
      if (claimed.count !== 1) throw new Error(GENERIC_INVITE_ERROR);
      const invite = await tx.betaInvite.findUniqueOrThrow({ where: { tokenHash }, select: { cohort: true } });
      await tx.betaParticipant.create({ data: { userId: input.userId, cohort: invite.cohort, consentVersion: BETA_CONSENT_VERSION, consentedAt: now, enrolledAt: now } });
      return { cohort: invite.cohort, enrolledAt: now };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "BETA_CONSENT_REQUIRED") throw error;
    throw new Error(GENERIC_INVITE_ERROR);
  }
}

export async function revokeBetaInvite(id: string) {
  const changed = await prisma.betaInvite.updateMany({ where: { id, redeemedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!changed.count) throw new Error("BETA_INVITE_NOT_REVOCABLE");
}
