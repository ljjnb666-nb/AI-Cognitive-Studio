import { createHash } from "node:crypto";

type AudioSemanticInputs = { episodeId: string; scriptRevisionId: string; audioConfig: { version: number }; hostVoices: Array<{ voiceIdentityHash: string }>; provider: string; model: string; modelVersion?: string | null; pipelineVersion: string; speechPreparationVersion: string; assemblyVersion: string; normalizationVersion: string; outputFormat: string };

const stable = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Canonical paid-operation identity; deliberately excludes retry ordinal and tracing metadata. */
export const podcastAudioSemanticIdentity = (value: AudioSemanticInputs) => createHash("sha256").update(stable([value.episodeId, value.scriptRevisionId, value.audioConfig.version, value.hostVoices.map(voice => voice.voiceIdentityHash).sort(), value.provider, value.model, value.modelVersion ?? "", value.pipelineVersion, value.speechPreparationVersion, value.assemblyVersion, value.normalizationVersion, value.outputFormat])).digest("hex");
