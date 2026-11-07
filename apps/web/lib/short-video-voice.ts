/** Shared by configuration saving and the product execution gate. */
export function assertShortVideoVoice(provider: string, configuration: Record<string, unknown>): void {
  const { providerVoiceId, voiceVersion, outputFormat, speakingRate, pitch, style } = configuration;
  const minimum = provider === "zhipu" ? 0.5 : 0.25;
  const maximum = provider === "zhipu" ? 2 : 4;
  if (typeof providerVoiceId !== "string" || !providerVoiceId.trim() || providerVoiceId.length > 160 || typeof voiceVersion !== "string" || !voiceVersion.trim() || typeof outputFormat !== "string" || !outputFormat.trim() || typeof speakingRate !== "number" || !Number.isFinite(speakingRate) || speakingRate < minimum || speakingRate > maximum || typeof pitch !== "number" || !Number.isFinite(pitch)) throw new Error("SHORT_VIDEO_TTS_VOICE_CONFIGURATION_REQUIRED");
  if (provider === "zhipu" && (!["tongtong", "xiaochen", "chuichui", "jam", "kazi", "douji", "luodo"].includes(providerVoiceId) || outputFormat !== "wav" || pitch !== 0 || style)) throw new Error("SHORT_VIDEO_TTS_VOICE_CONFIGURATION_REQUIRED");
  if (provider === "openai" && pitch !== 0) throw new Error("SHORT_VIDEO_TTS_VOICE_CONFIGURATION_REQUIRED");
}
