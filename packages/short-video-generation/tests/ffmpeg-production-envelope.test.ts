import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FfmpegVideoRenderer } from "../src/index.js";
import { diagnosticOutputDirectory, phase5ProductRenderInput } from "./ffmpeg-diagnostic.js";

const root = diagnosticOutputDirectory(), diagnosticIt = root ? it : it.skip;
function wav(durationMs: number) { const rate = 8_000, samples = rate * durationMs / 1_000, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true); bytes.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, samples * 2, true); return bytes; }

describe("Phase 7 production renderer envelope", () => diagnosticIt("measures real production resolution and frame rate", async () => {
  await mkdir(root!, { recursive: true }); const measurements: unknown[] = [];
  for (const durationMs of [15_000, 60_000]) {
    const fixture = phase5ProductRenderInput(), sceneDuration = durationMs / fixture.scenes.length, audio = wav(sceneDuration);
    const input = { ...fixture, durationMs, width: 1080, height: 1920, fps: 30, scenes: fixture.scenes.map((scene, index) => ({ ...scene, startMs: index * sceneDuration, endMs: (index + 1) * sceneDuration })), captions: fixture.captions.map((cue, index) => ({ ...cue, startMs: index * sceneDuration, endMs: (index + 1) * sceneDuration })), narrationAudio: fixture.narrationAudio.map((item) => ({ ...item, bytes: audio, durationMs: sceneDuration })) };
    const starts: Array<{ step: string; at: number; output: string }> = []; const began = performance.now();
    const output = await new FfmpegVideoRenderer({ onInvocation: (value) => { starts.push({ step: value.renderStep, at: performance.now(), output: value.outputPath }); if (value.renderStep === "FINAL_COMPOSITION") expect(value.args.join(" ")).not.toContain("drawtext="); } }).render(input);
    try {
      const intermediates = starts.filter((item) => item.step === "SCENE_VISUAL_RENDER").map((item) => item.output);
      const totalIntermediateBytes = (await Promise.all(intermediates.map((path) => stat(path)))).reduce((total, value) => total + value.size, 0);
      const finalBytes = (await stat(output.path)).size, finalStart = starts.find((item) => item.step === "FINAL_COMPOSITION")!.at;
      const sceneStarts = starts.filter((item) => item.step === "SCENE_VISUAL_RENDER");
      const slowestSceneVisualMs = Math.round(Math.max(...sceneStarts.map((item, index) => (index + 1 < sceneStarts.length ? sceneStarts[index + 1]!.at : finalStart) - item.at)));
      const finalCompositionMs = Math.round(performance.now() - finalStart);
      measurements.push({ durationMs, width: input.width, height: input.height, fps: input.fps, wallMs: Math.round(performance.now() - began), scenePreRenderMs: Math.round(finalStart - starts[0]!.at), slowestSceneVisualMs, finalCompositionMs, slowestSubprocessMs: Math.max(slowestSceneVisualMs, finalCompositionMs), totalIntermediateBytes, finalBytes, drawtextCount: 0, sceneCount: intermediates.length });
    } finally { await output.cleanup(); }
  }
  await writeFile(join(root!, "production-envelope-summary.json"), `${JSON.stringify(measurements, null, 2)}\n`);
  expect(measurements).toHaveLength(2);
}, 1_800_000));
