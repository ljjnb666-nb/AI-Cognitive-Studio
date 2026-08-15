import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FfmpegVideoRenderer } from "../src/index.js";
import { captureFfmpegInvocation, diagnosticOutputDirectory, phase5ProductRenderInput, type CapturedFfmpegInvocation } from "./ffmpeg-diagnostic.js";

const execute = promisify(execFile);
const root = diagnosticOutputDirectory();
const diagnosticIt = root ? it : it.skip;
const excerpt = (value: unknown) => String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(-3_000);
type Result = { name: string; result: "PASS" | "ordinary FFmpeg error" | "SIGSEGV" | "timeout"; exitCode: number | null; signal: string | null; elapsedMs: number; stderrExcerpt: string };

function remap(captured: CapturedFfmpegInvocation, args: readonly string[]) {
  const from = captured.directory.replace(/\\/g, "/"); const to = captured.fixtureDirectory.replace(/\\/g, "/");
  return args.map((arg) => arg.replaceAll(captured.directory, captured.fixtureDirectory).replaceAll(from, to));
}
async function run(name: string, args: string[], timeout = 120_000): Promise<Result> {
  const started = performance.now();
  try {
    await execute("ffmpeg", ["-loglevel", "debug", ...args], { cwd: root, timeout, maxBuffer: 1_000_000, windowsHide: true });
    return { name, result: "PASS", exitCode: 0, signal: null, elapsedMs: Math.round(performance.now() - started), stderrExcerpt: "" };
  } catch (error: any) {
    const signal = typeof error?.signal === "string" ? error.signal : null;
    const timeoutHit = error?.killed === true && signal === "SIGTERM";
    const result = signal === "SIGSEGV" ? "SIGSEGV" : timeoutHit ? "timeout" : "ordinary FFmpeg error";
    return { name, result, exitCode: typeof error?.code === "number" ? error.code : null, signal, elapsedMs: Math.round(performance.now() - started), stderrExcerpt: excerpt(error?.stderr) };
  }
}

function fullArgs(captured: CapturedFfmpegInvocation, outputName: string) {
  const args = remap(captured, captured.args);
  args[args.length - 1] = join(captured.fixtureDirectory, outputName);
  return args;
}
function filterArg(args: string[]) { return args[args.indexOf("-filter_complex") + 1]!; }
function withFilter(args: string[], filter: string) { const copy = [...args]; copy[copy.indexOf("-filter_complex") + 1] = filter; return copy; }
function sceneInputs(captured: CapturedFfmpegInvocation, count: number) {
  const args = remap(captured, captured.args); return args.slice(1, 1 + count * 4);
}
function audioInputs(captured: CapturedFfmpegInvocation, count: number) {
  const args = remap(captured, captured.args); const start = 1 + captured.input.sceneCount * 4; return args.slice(start, start + count * 2);
}
function withoutDrawtext(inputs: string[]) {
  return inputs.map((value, index) => index % 4 === 3 ? value.replace(/,drawtext=.*$/, "") : value);
}
function encodeArgs(output: string, map: string[]) { return [...map.flatMap((value) => ["-map", value]), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", output]; }

describe("Phase 5 FFmpeg crash diagnostic", () => diagnosticIt("runs the exact direct product fixture and reduction matrix", async () => {
  await mkdir(root!, { recursive: true });
  let captured: CapturedFfmpegInvocation | undefined;
  const renderer = new FfmpegVideoRenderer({ onInvocation: async (invocation) => { captured = await captureFfmpegInvocation(root!, "direct-exact", invocation); } });
  const directStarted = performance.now();
  let direct: Result;
  try {
    const output = await renderer.render(phase5ProductRenderInput());
    await output.cleanup();
    direct = { name: "A baseline exact production renderer", result: "PASS", exitCode: 0, signal: null, elapsedMs: Math.round(performance.now() - directStarted), stderrExcerpt: "" };
  } catch (error: any) {
    const diagnostic = error?.diagnostic;
    direct = { name: "A baseline exact production renderer", result: diagnostic?.signal === "SIGSEGV" ? "SIGSEGV" : "ordinary FFmpeg error", exitCode: diagnostic?.exitCode ?? null, signal: diagnostic?.signal ?? null, elapsedMs: Math.round(performance.now() - directStarted), stderrExcerpt: excerpt(diagnostic?.stderrExcerpt) };
  }
  expect(captured, "renderer must expose its own final invocation").toBeDefined();
  const invocation = captured!;
  const results: Result[] = [direct];
  for (let attempt = 1; attempt <= Number(process.env.PHASE5_FFMPEG_MAX_ATTEMPTS ?? 50); attempt++) {
    const replay = await run(`A standalone exact replay ${attempt}`, fullArgs(invocation, `variant-a-replay-${attempt}.mp4`));
    results.push(replay);
    if (replay.result === "SIGSEGV") break;
  }
  const base = fullArgs(invocation, "variant-a.mp4");
  const filter = filterArg(base);
  const productSrt = await readFile(join(invocation.fixtureDirectory, "captions.srt"), "utf8");
  const noSubtitles = filter.replace(/;\[v\]subtitles='[^']+'\[captioned\]/, ";[v]null[captioned]");
  results.push(await run("B subtitles removed", withFilter(fullArgs(invocation, "variant-b.mp4"), noSubtitles)));
  await writeFile(join(invocation.fixtureDirectory, "captions.srt"), "1\n00:00:00,000 --> 00:00:02,500\nminimal ASCII cue\n", "utf8");
  results.push(await run("C minimal ASCII SRT", fullArgs(invocation, "variant-c.mp4")));
  await writeFile(join(invocation.fixtureDirectory, "captions.srt"), productSrt, "utf8");
  const captionPath = join(invocation.fixtureDirectory, "captions.srt").replace(/\\/g, "/").replace(/:/g, "\\:");
  results.push(await run("D product SRT minimal video", ["-y", "-f", "lavfi", "-i", "color=c=#0f172a:s=360x640:r=15:d=15", "-filter_complex", `[0:v]subtitles='${captionPath}'[captioned]`, "-map", "[captioned]", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(invocation.fixtureDirectory, "variant-d.mp4")]));
  const noDrawtext = noSubtitles.replace(/,drawtext=textfile='[^']+':fontcolor=white[^,]*/g, "").replace(/,drawtext=textfile='[^']+':fontcolor=0x94a3b8[^,]*/g, "");
  results.push(await run("E drawtext removed", withFilter(fullArgs(invocation, "variant-e.mp4"), noDrawtext)));
  const video = Array.from({ length: 6 }, (_, index) => `[${index}:v]`).join("");
  results.push(await run("F video concat only", [...withoutDrawtext(sceneInputs(invocation, 6)), "-filter_complex", `${video}concat=n=6:v=1:a=0[v]`, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(invocation.fixtureDirectory, "variant-f.mp4")]));
  const audio = Array.from({ length: 6 }, (_, index) => `[${index}:a]`).join("");
  results.push(await run("G audio concat only", [...audioInputs(invocation, 6), "-filter_complex", `${audio}concat=n=6:v=0:a=1[a]`, "-map", "[a]", "-c:a", "aac", join(invocation.fixtureDirectory, "variant-g.m4a")]));
  for (let count = 1; count <= 6; count++) {
    const videoInput = Array.from({ length: count }, (_, index) => `[${index}:v]`).join("");
    const audioInput = Array.from({ length: count }, (_, index) => `[${index + count}:a]`).join("");
    const subtitle = count === 1 ? `[v]subtitles='${captionPath}'[captioned]` : `[v]subtitles='${captionPath}'[captioned]`;
    results.push(await run(count === 1 ? "H one exact scene" : `I scene count ${count}`, [...sceneInputs(invocation, count), ...audioInputs(invocation, count), "-filter_complex", `${videoInput}concat=n=${count}:v=1:a=0[v];${audioInput}concat=n=${count}:v=0:a=1[a];${subtitle}`, ...encodeArgs(join(invocation.fixtureDirectory, `variant-scenes-${count}.mp4`), ["[captioned]", "[a]"])]));
  }
  await writeFile(join(root!, "direct-diagnostic-results.json"), `${JSON.stringify({ exactDirectProductFixture: direct.result, fingerprint: invocation.fingerprint, input: invocation.input, timeoutConfiguredMs: 120000, results }, null, 2)}\n`);
  console.log(`EXACT_DIRECT_PRODUCT_FIXTURE=${direct.result}`);
  console.log(`DIRECT_RENDER_INPUT_FINGERPRINT=${invocation.fingerprint}`);
  for (const result of results) console.log(`PHASE5_DIAGNOSTIC ${result.name}=${result.result} exitCode=${result.exitCode} signal=${result.signal} elapsedMs=${result.elapsedMs}`);
  expect(["PASS", "SIGSEGV"]).toContain(direct.result);
}, 600_000));
