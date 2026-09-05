import { prisma } from "@ai-cognitive/db";
import type { WebIdentityContext } from "./identity";

export async function betaOnboardingChecklist(identity: WebIdentityContext) {
  const participant = await prisma.betaParticipant.findFirst({ where: { userId: identity.userId, status: "ACTIVE" }, select: { id: true } });
  if (!participant) return null;
  const [source, intelligence, listened, cognition, teachBack, feedback] = await Promise.all([
    prisma.sourceDocument.count({ where: { workspaceId: identity.workspaceId } }),
    prisma.bookAnalysisRun.count({ where: { workspaceId: identity.workspaceId, status: "SUCCEEDED", job: { userId: identity.userId } } }),
    prisma.productEvent.count({ where: { participantId: participant.id, eventName: "PODCAST_PLAYBACK_25" } }),
    prisma.userCognitionState.count({ where: { workspaceId: identity.workspaceId, userId: identity.userId, state: "SAVED" } }),
    prisma.teachBackAttempt.count({ where: { workspaceId: identity.workspaceId, userId: identity.userId, assessedAt: { not: null } } }),
    prisma.betaFeedback.count({ where: { participantId: participant.id } }),
  ]);
  return [
    ["添加一本书", source > 0], ["等待认知解析完成", intelligence > 0], ["听一段播客", listened > 0], ["保存一个认知", cognition > 0], ["尝试一次 Teach Back", teachBack > 0], ["提交反馈", feedback > 0],
  ] as const;
}
