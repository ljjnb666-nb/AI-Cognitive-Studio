import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FfmpegVideoRenderer } from "../src/index.js";
import { diagnosticOutputDirectory, phase5ProductRenderInput } from "./ffmpeg-diagnostic.js";

const execute = promisify(execFile);
const root = diagnosticOutputDirectory(), diagnosticIt = root ? it : it.skip;

describe("Phase 5 legacy versus repaired visual equivalence", () => diagnosticIt("matches decoded scene frames from a successful legacy reference", async () => {
  await mkdir(root!, { recursive: true });
  const input = phase5ProductRenderInput(), sceneFilters: string[] = [];
  let finalArgs: readonly string[] = [];
  const repaired = await new FfmpegVideoRenderer({ onInvocation: (value) => {
    if (value.renderStep === "SCENE_VISUAL_RENDER") sceneFilters.push(value.args[value.args.indexOf("-i") + 1]!);
    if (value.renderStep === "FINAL_COMPOSITION") finalArgs = value.args;
  } }).render(input);
  try {
    expect(sceneFilters).toHaveLength(6);
    const inputPaths = [...finalArgs].flatMap((arg, index) => arg === "-i" ? [finalArgs[index + 1]!] : []);
    const audioPaths = inputPaths.slice(sceneFilters.length);
    const captionsFilter = finalArgs[finalArgs.indexOf("-filter_complex") + 1]!.match(/\[v\]subtitles='[^']+'\[captioned\]/)?.[0];
    expect(audioPaths).toHaveLength(6); expect(captionsFilter).toBeTruthy();
    const videos = sceneFilters.map((_filter, index) => `[${index}:v]`).join(""), audios = audioPaths.map((_path, index) => `[${index + sceneFilters.length}:a]`).join("");
    const legacy = join(root!, "legacy-reference.mp4");
    const legacyArgs = ["-y", ...sceneFilters.flatMap((filter) => ["-f", "lavfi", "-i", filter]), ...audioPaths.flatMap((path) => ["-i", path]), "-filter_complex", `${videos}concat=n=${sceneFilters.length}:v=1:a=0[v];${audios}concat=n=${sceneFilters.length}:v=0:a=1[a];${captionsFilter}`, "-map", "[captioned]", "-map", "[a]", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", legacy];
    let succeeded = false;
    for (let attempt = 0; attempt < 10 && !succeeded; attempt++) { try { await execute("ffmpeg", legacyArgs, { windowsHide: true, timeout: 120_000, maxBuffer: 1_000_000 }); succeeded = true; } catch { await rm(legacy, { force: true }); } }
    expect(succeeded).toBe(true);
    const frame = async (path: string, seconds: number) => (await execute("ffmpeg", ["-v", "error", "-ss", seconds.toFixed(3), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"], { encoding: "buffer", windowsHide: true })).stdout as Buffer;
    for (let scene = 0; scene < 6; scene++) for (const offset of [0, 2 / input.fps, 3 / input.fps, 1.25, 2.4]) expect(await frame(repaired.path, scene * 2.5 + offset)).toEqual(await frame(legacy, scene * 2.5 + offset));
  } finally { await repaired.cleanup(); }
}, 180_000));
