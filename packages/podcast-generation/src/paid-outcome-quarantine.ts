import { prisma } from "@ai-cognitive/db";
import { podcastAudioSemanticIdentity } from "./audio-semantic-identity.js";

export type QuarantineResolution = "DEFINITIVE_REMOTE_FAILURE" | "ABANDON_AND_ALLOW_RETRY";

/** Opens the only active paid-outcome gate for an Audio semantic operation. */
type QuarantineFaultInjector = (point: "open.after-create" | "resolve.after-authorization-lock" | "resolve.after-update") => void | Promise<void>;
export async function openPodcastAudioPaidOutcomeQuarantine(input: { workspaceId: string; audioGenerationRunId: string; providerInvocationId: string; providerInvocationAttemptId: string; faultInjector?: QuarantineFaultInjector }) {
  return prisma.$transaction(async tx => {
    const run = await tx.audioGenerationRun.findFirst({ where: { id: input.audioGenerationRunId, workspaceId: input.workspaceId }, include: { audioConfig: true, hostVoices: true } });
    if (!run) throw new Error("AUDIO_PAID_OUTCOME_NOT_AMBIGUOUS");
    const semanticIdentityHash = podcastAudioSemanticIdentity(run);
    const invocation = await tx.providerInvocation.findFirst({ where: { id: input.providerInvocationId, workspaceId: input.workspaceId, idempotencyKey: { startsWith: `podcast-tts:${run.id}:` }, routeSlot: "PODCAST_TTS", status: "RECONCILIATION_REQUIRED", snapshot: { outcomeRecoveryCapability: "NONE" }, speechResult: null, attempts: { some: { id: input.providerInvocationAttemptId, status: "REMOTE_OUTCOME_UNKNOWN" } } } });
    if (!invocation) throw new Error("AUDIO_PAID_OUTCOME_NOT_AMBIGUOUS");
    // PostgreSQL marks a transaction aborted after a unique-violation, so do
    // not use catch-and-query as a concurrency primitive.  The advisory lock
    // makes the following lookup/create sequence serial for this tenant key.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.workspaceId}:${semanticIdentityHash}`}))`;
    const existing = await tx.podcastAudioPaidOutcomeQuarantine.findFirst({ where: { workspaceId: input.workspaceId, semanticIdentityHash, status: "OPEN" } });
    if (existing) return existing;
    const created = await tx.podcastAudioPaidOutcomeQuarantine.create({ data: { workspaceId: input.workspaceId, audioGenerationRunId: input.audioGenerationRunId, semanticIdentityHash, providerInvocationId: input.providerInvocationId, providerInvocationAttemptId: input.providerInvocationAttemptId, reasonCode: "REMOTE_OUTCOME_UNKNOWN" } });
    await input.faultInjector?.("open.after-create");
    return created;
  });
}

/** Internal-only operator action. No web route calls this service. */
export async function resolvePodcastAudioPaidOutcomeQuarantine(input: { workspaceId: string; quarantineId: string; actorId: string; resolution: QuarantineResolution; reason: string; riskAcknowledged?: boolean; faultInjector?: QuarantineFaultInjector }) {
  if (!input.reason.trim()) throw new Error("AUDIO_PAID_OUTCOME_RESOLUTION_REASON_REQUIRED");
  if (input.resolution === "ABANDON_AND_ALLOW_RETRY" && input.riskAcknowledged !== true) throw new Error("AUDIO_PAID_OUTCOME_RISK_ACKNOWLEDGEMENT_REQUIRED");
  return prisma.$transaction(async tx => {
    // Lock the membership row before the quarantine row. FOR UPDATE blocks
    // non-key role downgrades and deletion until this privileged mutation ends.
    const members = await tx.$queryRaw<Array<{ role: string }>>`SELECT "role"::text AS "role" FROM "WorkspaceMember" WHERE "workspaceId"=${input.workspaceId} AND "userId"=${input.actorId} FOR UPDATE`;
    if (members[0]?.role !== "OWNER") throw new Error("AUDIO_PAID_OUTCOME_OPERATOR_ACCESS_DENIED");
    await input.faultInjector?.("resolve.after-authorization-lock");
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "PodcastAudioPaidOutcomeQuarantine" WHERE "id"=${input.quarantineId} AND "workspaceId"=${input.workspaceId} FOR UPDATE`;
    if (rows.length !== 1) throw new Error("AUDIO_PAID_OUTCOME_QUARANTINE_NOT_FOUND");
    const current = await tx.podcastAudioPaidOutcomeQuarantine.findUniqueOrThrow({ where: { id: input.quarantineId } });
    if (current.status === "RESOLVED") {
      if (current.resolution === input.resolution && current.resolutionActorId === input.actorId && current.resolutionReason === input.reason.trim() && current.riskAcknowledged === (input.resolution === "ABANDON_AND_ALLOW_RETRY")) return current;
      throw new Error("AUDIO_PAID_OUTCOME_CONTRADICTORY_RESOLUTION");
    }
    const resolved = await tx.podcastAudioPaidOutcomeQuarantine.update({ where: { id: current.id }, data: { status: "RESOLVED", resolution: input.resolution, resolutionActorId: input.actorId, resolutionReason: input.reason.trim(), riskAcknowledged: input.resolution === "ABANDON_AND_ALLOW_RETRY", resolvedAt: new Date() } });
    await input.faultInjector?.("resolve.after-update");
    return resolved;
  });
}
