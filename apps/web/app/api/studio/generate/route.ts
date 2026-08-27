import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@ai-cognitive/db";
import { createPodcastProject, configureStyle, createEpisode, requestPodcastGeneration } from "@ai-cognitive/podcast-generation";
import { createShortVideoProject, configureShortVideoStyle, requestShortVideoGeneration } from "@ai-cognitive/short-video-generation";
import { resolveWebIdentity } from "@/lib/identity";
import { resolvePodcastProductExecution, resolveShortVideoProductExecution } from "@/lib/provider-product";

const sourceIds = z.array(z.string().cuid()).min(1).max(8).refine(ids => new Set(ids).size === ids.length, "SOURCE_DOCUMENT_IDS_DUPLICATE");
const podcast = z.object({ kind: z.literal("podcast"), title: z.string().trim().min(1).max(160), sourceDocumentIds: sourceIds, duration: z.number().int().min(1).max(120).default(10), tone: z.string().trim().min(1).max(160).default("clear, curious, grounded") });
const video = z.object({ kind: z.literal("video"), title: z.string().trim().min(1).max(160), sourceDocumentIds: sourceIds, duration: z.number().int().min(15).max(180).default(60), tone: z.string().trim().min(1).max(160).default("clear, curious, grounded") });
const bodySchema = z.discriminatedUnion("kind", [podcast, video]);

async function assertGenerationSources(workspaceId: string, ids: string[]) {
  const sources = await prisma.sourceDocument.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, currentIntelligence: { select: { id: true } } } });
  if (sources.length !== ids.length) throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  if (sources.some(source => !source.currentIntelligence)) throw new Error("SOURCE_DOCUMENT_INTELLIGENCE_REQUIRED");
}

export async function POST(request: Request) {
  try {
    const input = bodySchema.parse(await request.json());
    const context = await resolveWebIdentity();
    await assertGenerationSources(context.workspaceId, input.sourceDocumentIds);
    if (input.kind === "podcast") {
      const identity = await resolvePodcastProductExecution(context.workspaceId);
      const project = await createPodcastProject(context, { name: input.title, sourceDocumentIds: input.sourceDocumentIds });
      await configureStyle(context, project.id, { targetDurationMinutes: input.duration, tone: input.tone });
      const episode = await createEpisode(context, { podcastProjectId: project.id, title: input.title, targetDurationMinutes: input.duration });
      await requestPodcastGeneration(context, { episodeId: episode.id, pipelineVersion: "phase6-web-v1", promptVersion: "phase6-web-v1", provider: identity.provider, model: identity.model, modelVersion: identity.modelVersion, outboxTopic: process.env.PHASE9_PODCAST_TOPIC?.trim() || undefined });
      return NextResponse.json({ id: episode.id, href: `/studio/podcasts/${episode.id}` });
    }
    const identity = await resolveShortVideoProductExecution(context.workspaceId);
    const project = await createShortVideoProject(context, { name: input.title, sourceDocumentIds: input.sourceDocumentIds });
    await configureShortVideoStyle(context, project.id, { targetDurationSeconds: input.duration, tone: input.tone });
    await requestShortVideoGeneration(context, { shortVideoProjectId: project.id, pipelineVersion: "phase6-web-v1", promptVersion: "phase6-web-v1", retrievalVersion: "phase6-web-v1", scenePlannerVersion: "phase6-web-v1", captionVersion: "phase6-web-v1", audioVersion: "phase6-web-v1", renderVersion: "phase6-web-v1", provider: identity.provider, model: identity.model, modelVersion: identity.modelVersion, outboxTopic: process.env.PHASE9_VIDEO_TOPIC?.trim() || undefined });
    return NextResponse.json({ id: project.id, href: `/studio/videos/${project.id}` });
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "GENERATION_FAILED";
    return NextResponse.json({ error: code }, { status: code.includes("ACCESS_DENIED") || code === "WEB_IDENTITY_REQUIRED" ? 403 : 400 });
  }
}
