import { describe, expect, it } from "vitest";
import { podcastConfigurationFromForm, routeFormConfiguration } from "../lib/provider-route-form";

describe("collapsed route configuration preservation", () => {
  it("retains persisted configuration when the JSON control is absent, and distinguishes an explicit empty object", () => {
    const saved = { hostVoices: [{ ordinal: 1, providerVoiceId: "tongtong" }], outputFormat: "wav", marker: "retained" };
    expect(routeFormConfiguration(null, saved)).toEqual(saved);
    expect(routeFormConfiguration("{}", saved)).toEqual({});
    expect(saved.marker).toBe("retained");
  });
  it.each(["{", "null", "[]", '"string"'])("rejects malformed or non-object JSON %s without silently clearing configuration", value => {
    expect(() => routeFormConfiguration(value, { marker: "retained" })).toThrow();
  });
  it("updates visible voice fields while preserving voice versions, extra hosts and unrelated settings", () => {
    const saved = { marker: "retained", hostVoices: [{ ordinal: 1, providerVoiceId: "old", voiceVersion: "approved-v2", language: "zh-CN", pitch: 0 }, { ordinal: 3, providerVoiceId: "third", voiceVersion: "v3", speakingRate: 1, pitch: 0, outputFormat: "wav" }] };
    const form = new FormData(); for (const [key, value] of Object.entries({ hostVoice1: "tongtong", hostRate1: "1", hostVoice2: "xiaochen", hostRate2: "1.25" })) form.set(key, value);
    expect(podcastConfigurationFromForm(form, saved)).toMatchObject({ marker: "retained", outputFormat: "wav", hostVoices: [{ ordinal: 1, providerVoiceId: "tongtong", voiceVersion: "approved-v2", language: "zh-CN", speakingRate: 1 }, { ordinal: 2, providerVoiceId: "xiaochen", voiceVersion: "1", speakingRate: 1.25 }, { ordinal: 3, providerVoiceId: "third", voiceVersion: "v3" }] });
  });
});
