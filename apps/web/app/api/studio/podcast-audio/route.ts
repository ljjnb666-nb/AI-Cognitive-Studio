import { prisma } from "@ai-cognitive/db";
import { createEpisodeAudioConfig, createVoiceProfile, requestPodcastAudioGeneration } from "@ai-cognitive/podcast-generation";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebIdentity, trustedRequestContext } from "@/lib/identity";
import { resolvePodcastAudioRoute } from "@/lib/provider-product";

const schema = z.object({ episodeId: z.string().cuid() });

export async function POST(request: Request) {
  try {
    const { episodeId } = schema.parse(await request.json());
    const context = await resolveWebIdentity();
    const principal = trustedRequestContext(context);
    const route = await resolvePodcastAudioRoute(context.workspaceId);
    const episode = await prisma.podcastEpisode.findFirstOrThrow({
      where: { id: episodeId, workspaceId: context.workspaceId },
      include: { generationRuns: { orderBy: { createdAt: "desc" }, take: 1 }, currentScript: true, currentAudio: true, project: { include: { hosts: { orderBy: { ordinal: "asc" } } } } },
    });
    if (episode.currentAudio) return NextResponse.json({ status: "SUCCEEDED" });
    if (episode.generationRuns[0]?.status !== "SUCCEEDED" || !episode.currentScript) throw new Error("PODCAST_SCRIPT_NOT_SUCCEEDED");
    const voiceIds: Record<string, string> = {};
    for (const host of episode.project.hosts) {
      const configured = route.voices.find(voice => voice.ordinal === host.ordinal);
      if (!configured) throw new Error("PODCAST_TTS_CONFIGURATION_REQUIRED");
      if (configured.outputFormat !== "wav") throw new Error("PODCAST_TTS_CONFIGURATION_REQUIRED");
      const existing = await prisma.podcastVoiceProfile.findFirst({ where: { workspaceId: context.workspaceId, podcastProjectId: episode.podcastProjectId, provider: route.provider, model: route.model, modelVersion: route.modelVersion, providerVoiceId: configured.providerVoiceId, voiceVersion: configured.voiceVersion }, orderBy: { createdAt: "desc" } });
      const voice = existing ?? await createVoiceProfile(principal, { podcastProjectId: episode.podcastProjectId, displayName: host.displayName, language: configured.language ?? episode.language, provider: route.provider, providerVoiceId: configured.providerVoiceId, voiceVersion: configured.voiceVersion, model: route.model, modelVersion: route.modelVersion, speakingRate: configured.speakingRate, pitch: configured.pitch, style: configured.style });
      voiceIds[host.id] = voice.id;
    }
    const config = await prisma.podcastEpisodeAudioConfig.findFirst({ where: { workspaceId: context.workspaceId, episodeId: episode.id }, orderBy: { version: "desc" } }) ?? await createEpisodeAudioConfig(principal, { episodeId: episode.id, outputFormat: "wav", sampleRate: 8_000, channels: 1 });
    const requested = await requestPodcastAudioGeneration(principal, { episodeId: episode.id, audioConfigId: config.id, provider: route.provider, model: route.model, modelVersion: route.modelVersion, pipelineVersion: "phase9-web-v1", speechPreparationVersion: "phase9-web-v1", assemblyVersion: "phase9-web-v1", normalizationVersion: "phase9-web-v1", hostVoiceProfileIds: voiceIds, outboxTopic: process.env.PHASE9_AUDIO_TOPIC?.trim() || undefined });
    return NextResponse.json({ audioGenerationRunId: requested.run.id, status: requested.run.status });
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "PODCAST_AUDIO_REQUEST_FAILED";
    return NextResponse.json({ error: code }, { status: code.includes("ACCESS_DENIED") || code === "WEB_IDENTITY_REQUIRED" ? 403 : code === "PODCAST_SCRIPT_NOT_SUCCEEDED" ? 409 : 400 });
  }
}
