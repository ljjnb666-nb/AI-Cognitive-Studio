import { prisma } from "@ai-cognitive/db";
import { createEpisodeAudioConfig, createVoiceProfile, requestPodcastAudioGeneration } from "@ai-cognitive/podcast-generation";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity } from "@/lib/identity";

const schema = z.object({ episodeId: z.string().cuid() });

export async function POST(request: Request) {
  try {
    const { episodeId } = schema.parse(await request.json());
    const context = await resolveWebIdentity();
    const [provider, model] = [process.env.AUDIO_GENERATION_PROVIDER?.trim(), process.env.AUDIO_GENERATION_MODEL?.trim()];
    if (!provider || !model) throw new Error("AUDIO_GENERATION_PROVIDER_NOT_CONFIGURED");
    const episode = await prisma.podcastEpisode.findFirstOrThrow({
      where: { id: episodeId, workspaceId: context.workspaceId },
      include: { generationRuns: { orderBy: { createdAt: "desc" }, take: 1 }, currentScript: true, currentAudio: true, project: { include: { hosts: { orderBy: { ordinal: "asc" } } } } },
    });
    if (episode.currentAudio) return NextResponse.json({ status: "SUCCEEDED" });
    if (episode.generationRuns[0]?.status !== "SUCCEEDED" || !episode.currentScript) throw new Error("PODCAST_SCRIPT_NOT_SUCCEEDED");
    const voiceIds: Record<string, string> = {};
    for (const host of episode.project.hosts) {
      const existing = await prisma.podcastVoiceProfile.findFirst({ where: { workspaceId: context.workspaceId, podcastProjectId: episode.podcastProjectId, provider, model, providerVoiceId: `phase6-${host.ordinal}` }, orderBy: { createdAt: "desc" } });
      const voice = existing ?? await createVoiceProfile(context, { podcastProjectId: episode.podcastProjectId, displayName: host.displayName, language: episode.language, provider, providerVoiceId: `phase6-${host.ordinal}`, voiceVersion: process.env.AUDIO_GENERATION_VOICE_VERSION?.trim() || "product-v1", model, modelVersion: process.env.AUDIO_GENERATION_MODEL_VERSION?.trim() });
      voiceIds[host.id] = voice.id;
    }
    const config = await prisma.podcastEpisodeAudioConfig.findFirst({ where: { workspaceId: context.workspaceId, episodeId: episode.id }, orderBy: { version: "desc" } }) ?? await createEpisodeAudioConfig(context, { episodeId: episode.id, outputFormat: "wav", sampleRate: 8_000, channels: 1 });
    const requested = await requestPodcastAudioGeneration(context, { episodeId: episode.id, audioConfigId: config.id, provider, model, modelVersion: process.env.AUDIO_GENERATION_MODEL_VERSION?.trim(), pipelineVersion: "phase6-web-v1", speechPreparationVersion: "phase6-web-v1", assemblyVersion: "phase6-web-v1", normalizationVersion: "phase6-web-v1", hostVoiceProfileIds: voiceIds });
    return NextResponse.json({ audioGenerationRunId: requested.run.id, status: requested.run.status });
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "PODCAST_AUDIO_REQUEST_FAILED";
    return NextResponse.json({ error: code }, { status: code.includes("ACCESS_DENIED") || code === "WEB_IDENTITY_REQUIRED" ? 403 : code === "PODCAST_SCRIPT_NOT_SUCCEEDED" ? 409 : 400 });
  }
}
