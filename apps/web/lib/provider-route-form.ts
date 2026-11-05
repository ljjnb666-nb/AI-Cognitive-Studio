/** A collapsed control is absent from FormData; it is not a request to clear persisted settings. */
export function routeFormConfiguration(value: FormDataEntryValue | null, existing: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === null) return { ...existing };
  if (typeof value !== "string") throw new Error("INVALID_CONFIGURATION_JSON");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_CONFIGURATION_JSON");
  return parsed as Record<string, unknown>;
}

export function podcastConfigurationFromForm(form: FormData, existing: Record<string, unknown>): Record<string, unknown> {
  const voices = Array.isArray(existing.hostVoices) ? existing.hostVoices.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  const updated = [1, 2].map(ordinal => {
    const previous = voices.find(voice => voice.ordinal === ordinal) ?? {};
    return { ...previous, ordinal, providerVoiceId: String(form.get(`hostVoice${ordinal}`) ?? "").trim(), voiceVersion: previous.voiceVersion ?? "1", speakingRate: Number(form.get(`hostRate${ordinal}`)), pitch: previous.pitch ?? 0, outputFormat: "wav" };
  });
  return { ...existing, outputFormat: "wav", hostVoices: [...updated, ...voices.filter(voice => voice.ordinal !== 1 && voice.ordinal !== 2)] };
}
