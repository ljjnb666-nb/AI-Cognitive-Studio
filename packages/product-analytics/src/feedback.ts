import { prisma } from "@ai-cognitive/db";
import { z } from "zod";
export const feedbackSchema = z.object({ category: z.enum(["BUG", "CONFUSION", "QUALITY", "FEATURE", "OTHER"]), dimension: z.enum(["OVERALL", "PODCAST_NATURALNESS", "PODCAST_VALUE", "COGNITION_VALUE", "USABILITY"]).optional(), rating: z.number().int().min(1).max(5).optional(), message: z.string().trim().min(1).max(2000).optional(), entityType: z.enum(["PODCAST_AUDIO_REVISION"]).optional(), entityId: z.string().cuid().optional(), route: z.string().startsWith("/studio").max(200).optional() }).strict().refine((value) => Boolean(value.rating || value.message), "FEEDBACK_CONTENT_REQUIRED");
export async function submitBetaFeedback(input: z.infer<typeof feedbackSchema>, identity: { userId: string; workspaceId: string }) {
  const participant = await prisma.betaParticipant.findFirst({ where: { userId: identity.userId, status: "ACTIVE" } });
  if (!participant) throw new Error("BETA_ACCESS_REQUIRED");
  if (input.entityType === "PODCAST_AUDIO_REVISION") {
    const entity = await prisma.podcastAudioRevision.findFirst({ where: { id: input.entityId, workspaceId: identity.workspaceId }, select: { id: true } });
    if (!entity) throw new Error("FEEDBACK_ENTITY_ACCESS_DENIED");
  }
  return prisma.betaFeedback.create({ data: { ...input, participantId: participant.id, workspaceId: identity.workspaceId } });
}
