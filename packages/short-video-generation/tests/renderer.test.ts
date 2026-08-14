import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { FfmpegVideoRenderer } from "../src/index.js";

const execute = promisify(execFile);
const rendered: Array<{ cleanup(): Promise<void> }> = [];
let audio = new Uint8Array(); let directory = "";

afterAll(async () => { await Promise.all(rendered.map((item) => item.cleanup())); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
beforeAll(async () => { directory = await mkdtemp("ai-cognitive-short-video-test-"); const path = join(directory, "narration.m4a"); await execute("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", path], { windowsHide: true }); audio = await readFile(path); });

describe("FfmpegVideoRenderer", () => {
  it("creates a decodable H.264/AAC portrait MP4", async () => {
    const output = await new FfmpegVideoRenderer().render({ durationMs: 2_000, width: 360, height: 640, fps: 30,
      scenes: [{ id: "scene-1", ordinal: 1, sceneType: "HOOK", startMs: 0, endMs: 2_000, primaryText: "GPT-5 changes the question", secondaryText: "Evidence, not hype", keywords: ["GPT-5"], layoutTemplate: "QUESTION_CARD", transitionIntent: "FADE" }],
      captions: [{ startMs: 0, endMs: 1_800, text: "GPT-5 changes the question" }],
      narrationAudio: [{ sceneId: "scene-1", bytes: audio, mediaType: "audio/mp4", durationMs: 2_000 }],
    });
    rendered.push(output);
    const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_name,codec_type,width,height,r_frame_rate", "-of", "json", output.path], { windowsHide: true });
    const probe = JSON.parse(stdout) as { format: { format_name: string; duration: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> };
    expect(probe.format.format_name).toContain("mp4");
    expect(Number(probe.format.duration)).toBeGreaterThan(0);
    expect(probe.streams).toEqual(expect.arrayContaining([expect.objectContaining({ codec_type: "video", codec_name: "h264", width: 360, height: 640 }), expect.objectContaining({ codec_type: "audio", codec_name: "aac" })]));
    expect(await readFile(output.path)).not.toEqual(audio);
  }, 15_000);
});
