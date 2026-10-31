import { describe, expect, it } from "vitest";
import { FfmpegAudioProcessor } from "../src/audio-processor.js";
import { MAX_SPEECH_CHUNK_CHARS, pauseFor, prepareSpokenText, splitSpeechChunks } from "../src/audio.js";

function wav(): Uint8Array { const samples = 4_000, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true); bytes.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8_000, true); view.setUint32(28, 16_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, samples * 2, true); for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, i < 300 || i > samples - 300 ? 0 : 2_000, true); return bytes; }

describe("Phase 4 deterministic speech and media boundaries", () => {
  it.each([[false, false, 3000], [true, false, 2500], [false, true, 2500], [true, true, 2000]] as const)("trims only selected edges and retains interior pauses (%s, %s)", async (trimLeadingSilence, trimTrailingSilence, expectedMs) => {
    const rate = 8000, samples = rate * 3, input = new Uint8Array(44 + samples * 2), header = new DataView(input.buffer);
    input.set(new TextEncoder().encode("RIFF")); header.setUint32(4, input.length - 8, true); input.set(new TextEncoder().encode("WAVEfmt "), 8); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true); header.setUint32(24, rate, true); header.setUint32(28, rate * 2, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true); input.set(new TextEncoder().encode("data"), 36); header.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) { const t = i / rate; if ((t >= .5 && t < .9) || (t >= 2.1 && t < 2.5)) header.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000), true); }
    const output = await new FfmpegAudioProcessor().canonicalize(input, { sampleRate: rate, channels: 1, targetLufs: -16, truePeakLimitDb: -1, normalizeLoudness: false, trimLeadingSilence, trimTrailingSilence });
    const view = new DataView(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength);
    let dataStart = 0, dataBytes = 0;
    for (let offset = 12; offset + 8 <= output.bytes.length;) { const size = view.getUint32(offset + 4, true); if (new TextDecoder().decode(output.bytes.slice(offset, offset + 4)) === "data") { dataStart = offset + 8; dataBytes = size; break; } offset += 8 + size + (size % 2); }
    expect(dataBytes).toBeGreaterThan(0);
    expect(Math.abs(dataBytes / (rate * 2) * 1000 - expectedMs)).toBeLessThan(50);
    let silent = 0, longestSilence = 0, tailPeak = 0;
    for (let i = 0; i < dataBytes / 2; i++) { const sample = Math.abs(view.getInt16(dataStart + i * 2, true)); silent = sample === 0 ? silent + 1 : 0; longestSilence = Math.max(longestSilence, silent); if (i > dataBytes / 2 * .66) tailPeak = Math.max(tailPeak, sample); }
    expect(longestSilence).toBeGreaterThan(9000);
    expect(tailPeak).toBeGreaterThan(1000);
  }, 35000);

  it("bounds chunks without splitting Unicode code points or changing text order", () => { const text = `${"中文 AI GPT-5 😀 API。".repeat(100)}结束`; const chunks = splitSpeechChunks(text); expect(chunks.length).toBeGreaterThan(1); expect(chunks.join("")).toBe(text); expect(chunks.every(chunk => Array.from(chunk).length <= MAX_SPEECH_CHUNK_CHARS)).toBe(true); expect(prepareSpokenText("<break/> AI GPT-5").spokenText).toContain("A I"); });
  it("keeps reaction and interruption pauses shorter than normal handoffs", () => { const config = { defaultPauseMs: 420, shortReactionPauseMs: 120, interruptionPauseMs: 80 }; expect(pauseFor("REACTION", config).after).toBeLessThan(pauseFor("STATEMENT", config).after); expect(pauseFor("CHALLENGE", config).before).toBeLessThan(pauseFor("STATEMENT", config).before); });
  it("uses the real FFmpeg process to resample, mix channels, trim, and normalize", async () => { const output = await new FfmpegAudioProcessor().canonicalize(wav(), { sampleRate: 16_000, channels: 2, targetLufs: -16, truePeakLimitDb: -1, normalizeLoudness: true, trimLeadingSilence: true, trimTrailingSilence: true }); const view = new DataView(output.bytes.buffer, output.bytes.byteOffset, output.bytes.byteLength); expect(new TextDecoder().decode(output.bytes.slice(0, 4))).toBe("RIFF"); expect(view.getUint16(22, true)).toBe(2); expect(view.getUint32(24, true)).toBe(16_000); expect(output.bytes.length).toBeGreaterThan(44); }, 35_000);
});
