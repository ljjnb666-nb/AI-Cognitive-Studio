import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { FfmpegVideoRenderer } from "../src/index.js";

const execute = promisify(execFile);
const rendered: Array<{ cleanup(): Promise<void> }> = [];
let audio = new Uint8Array(); let wavAudio = new Uint8Array(); let directory = "";

function wav(durationMs: number) {
  const sampleRate = 8_000, samples = Math.floor(sampleRate * durationMs / 1_000), bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true); bytes.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++) view.setInt16(44 + index * 2, Math.sin(index / 11) * 3_000, true);
  return bytes;
}

afterAll(async () => { await Promise.all(rendered.map((item) => item.cleanup())); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
beforeAll(async () => { directory = await mkdtemp("ai-cognitive-short-video-test-"); const path = join(directory, "narration.m4a"); await execute("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", path], { windowsHide: true }); audio = await readFile(path); wavAudio = wav(2_500); });

async function expectPortraitMp4(output: Awaited<ReturnType<FfmpegVideoRenderer["render"]>>) {
  rendered.push(output);
  const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_name,codec_type,width,height,r_frame_rate", "-of", "json", output.path], { windowsHide: true });
  const probe = JSON.parse(stdout) as { format: { format_name: string; duration: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> };
  expect(probe.format.format_name).toContain("mp4");
  expect(Number(probe.format.duration)).toBeGreaterThan(0);
  expect(probe.streams).toEqual(expect.arrayContaining([expect.objectContaining({ codec_type: "video", codec_name: "h264", width: 360, height: 640 }), expect.objectContaining({ codec_type: "audio", codec_name: "aac" })]));
}

describe("FfmpegVideoRenderer", () => {
  it("does not misclassify a diagnostic callback failure as an ffmpeg failure", async () => {
    await expect(new FfmpegVideoRenderer({ onInvocation: () => { throw new Error("DIAGNOSTIC_CALLBACK_FAILED"); } }).render({ durationMs: 2_000, width: 360, height: 640, fps: 30,
      scenes: [{ id: "scene-1", ordinal: 1, sceneType: "HOOK", startMs: 0, endMs: 2_000, primaryText: "GPT-5", secondaryText: "Evidence", keywords: [], layoutTemplate: "QUESTION_CARD", transitionIntent: "FADE" }],
      captions: [{ startMs: 0, endMs: 1_800, text: "GPT-5" }], narrationAudio: [{ sceneId: "scene-1", bytes: audio, mediaType: "audio/mp4", durationMs: 2_000 }],
    })).rejects.toThrow("DIAGNOSTIC_CALLBACK_FAILED");
  });
  it("creates a decodable H.264/AAC portrait MP4", async () => {
    const output = await new FfmpegVideoRenderer().render({ durationMs: 2_000, width: 360, height: 640, fps: 30,
      scenes: [{ id: "scene-1", ordinal: 1, sceneType: "HOOK", startMs: 0, endMs: 2_000, primaryText: "GPT-5 changes the question", secondaryText: "Evidence, not hype", keywords: ["GPT-5"], layoutTemplate: "QUESTION_CARD", transitionIntent: "FADE" }],
      captions: [{ startMs: 0, endMs: 1_800, text: "GPT-5 changes the question" }],
      narrationAudio: [{ sceneId: "scene-1", bytes: audio, mediaType: "audio/mp4", durationMs: 2_000 }],
    });
    await expectPortraitMp4(output);
    expect(await readFile(output.path)).not.toEqual(audio);
  }, 15_000);

  it("renders the six-scene Chinese WAV product shape", async () => {
    const sceneTypes = ["HOOK", "QUESTION", "EVIDENCE", "CONCEPT", "REFRAME", "ENDING"];
    const invocations: Array<{ args: readonly string[]; outputPath: string; renderStep: string; sceneOrdinal: number | null }> = [];
    const output = await new FfmpegVideoRenderer({ onInvocation: (value) => { invocations.push(value); } }).render({
      durationMs: 15_000,
      width: 360,
      height: 640,
      fps: 15,
      scenes: sceneTypes.map((sceneType, index) => ({ id: `scene-${index + 1}`, ordinal: index + 1, sceneType, startMs: index * 2_500, endMs: (index + 1) * 2_500, primaryText: ["GPT-5", "问题不是答案", "证据很重要", "AI API", "重新提问", "先问证据"][index]!, secondaryText: "中文 English", keywords: ["AI", "GPT-5"], layoutTemplate: ["QUESTION_CARD", "CONTRAST", "EVIDENCE_CARD", "CONCEPT_CARD", "CLAIM_CARD", "ENDING_CARD"][index]!, transitionIntent: "FADE" })),
      captions: sceneTypes.map((_, index) => ({ startMs: index * 2_500, endMs: (index + 1) * 2_500, text: `第 ${index + 1} 幕：AI 需要证据。` })),
      narrationAudio: sceneTypes.map((_, index) => ({ sceneId: `scene-${index + 1}`, bytes: wavAudio, mediaType: "audio/wav", durationMs: 2_500 })),
    });
    await expectPortraitMp4(output);
    const scenes = invocations.filter((value) => value.renderStep === "SCENE_VISUAL_RENDER"), final = invocations.find((value) => value.renderStep === "FINAL_COMPOSITION");
    expect(scenes).toHaveLength(6);
    expect(scenes.map((value) => value.sceneOrdinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(scenes.every((value) => value.args.join(" ").includes("drawtext=") && value.args.includes("ffv1") && value.outputPath.endsWith(".mkv"))).toBe(true);
    expect(final?.args.join(" ")).not.toContain("drawtext=");
    expect(final?.args.join(" ")).toContain("subtitles=");
    const intermediate = await execute("ffprobe", ["-v", "error", "-show_entries", "format=format_name:stream=codec_name,codec_type", "-of", "json", scenes[0]!.outputPath], { windowsHide: true });
    const intermediateProbe = JSON.parse(intermediate.stdout) as { format: { format_name: string }; streams: Array<{ codec_type: string; codec_name: string }> };
    expect(intermediateProbe.format.format_name).toContain("matroska");
    expect(intermediateProbe.streams).toEqual([expect.objectContaining({ codec_type: "video", codec_name: "ffv1" })]);
  }, 30_000);
});
