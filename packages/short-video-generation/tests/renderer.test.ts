import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { FfmpegVideoRenderer } from "../src/index.js";

const execute = promisify(execFile);
const rendered: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => { await Promise.all(rendered.map((item) => item.cleanup())); });

describe("FfmpegVideoRenderer", () => {
  it("creates a decodable H.264/AAC portrait MP4", async () => {
    const output = await new FfmpegVideoRenderer().render({ durationMs: 1_000, width: 360, height: 640, fps: 30 });
    rendered.push(output);
    const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_name,codec_type,width,height,r_frame_rate", "-of", "json", output.path], { windowsHide: true });
    const probe = JSON.parse(stdout) as { format: { format_name: string; duration: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> };
    expect(probe.format.format_name).toContain("mp4");
    expect(Number(probe.format.duration)).toBeGreaterThan(0);
    expect(probe.streams).toEqual(expect.arrayContaining([expect.objectContaining({ codec_type: "video", codec_name: "h264", width: 360, height: 640 }), expect.objectContaining({ codec_type: "audio", codec_name: "aac" })]));
  });
});
