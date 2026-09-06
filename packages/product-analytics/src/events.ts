import { prisma } from "@ai-cognitive/db";
import { z } from "zod";
import { CLIENT_EVENT_NAMES, MAX_EVENT_PROPERTIES_BYTES, type ClientEventName } from "./constants.js";

const propertySchema = z.object({ playbackPositionSeconds: z.number().nonnegative().max(86_400).optional(), durationSeconds: z.number().positive().max(86_400).optional() }).strict().superRefine((properties, ctx) => {
  if (Buffer.byteLength(JSON.stringify(properties), "utf8") > MAX_EVENT_PROPERTIES_BYTES) ctx.addIssue({ code: "custom", message: "EVENT_PROPERTIES_TOO_LARGE" });
});
export const clientEventSchema = z.object({ eventName: z.enum(CLIENT_EVENT_NAMES), clientEventId: z.string().uuid(), sessionId: z.string().uuid().optional(), entityType: z.enum(["PODCAST_AUDIO_REVISION"]).optional(), entityId: z.string().cuid().optional(), route: z.string().startsWith("/studio").max(200).optional(), properties: propertySchema.default({}) }).strict().superRefine((value, ctx) => {
  const playback = value.eventName.startsWith("PODCAST_PLAYBACK_");
  const hasEntity = Boolean(value.entityType) || Boolean(value.entityId);
  if (Boolean(value.entityType) !== Boolean(value.entityId)) ctx.addIssue({ code: "custom", message: "EVENT_ENTITY_PAIR_REQUIRED" });
  if (playback && (!value.entityType || !value.entityId)) ctx.addIssue({ code: "custom", message: "PLAYBACK_ENTITY_REQUIRED" });
  if (!playback && hasEntity) ctx.addIssue({ code: "custom", message: "EVENT_ENTITY_NOT_ALLOWED" });
});
export type ClientEventInput = z.infer<typeof clientEventSchema>;

async function assertEntityOwnership(workspaceId: string, input: ClientEventInput) {
  if (!input.entityType || !input.entityId) return;
  if (input.entityType === "PODCAST_AUDIO_REVISION") {
    const exists = await prisma.podcastAudioRevision.findFirst({ where: { id: input.entityId, workspaceId }, select: { id: true } });
    if (!exists) throw new Error("EVENT_ENTITY_ACCESS_DENIED");
  }
}

export async function recordClientEvent(input: ClientEventInput, identity: { userId: string; workspaceId: string }) {
  const participant = await prisma.betaParticipant.findFirst({ where: { userId: identity.userId, status: "ACTIVE" } });
  if (!participant) throw new Error("BETA_ACCESS_REQUIRED");
  await assertEntityOwnership(identity.workspaceId, input);
  const existing = await prisma.productEvent.findUnique({ where: { participantId_clientEventId: { participantId: participant.id, clientEventId: input.clientEventId } }, select: { id: true } });
  if (existing) return { id: existing.id, duplicate: true };
  try {
    const event = await prisma.productEvent.create({ data: { participantId: participant.id, userId: identity.userId, workspaceId: identity.workspaceId, ...input } });
    return { id: event.id, duplicate: false };
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return { id: "", duplicate: true };
    throw error;
  }
}

export const isCompletionEvent = (eventName: ClientEventName) => eventName === "PODCAST_PLAYBACK_90" || eventName === "PODCAST_PLAYBACK_ENDED";
