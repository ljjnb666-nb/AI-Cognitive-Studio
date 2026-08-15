import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FfmpegVideoRenderer } from "../src/index.js";
import { captureFfmpegInvocation, diagnosticOutputDirectory, phase5ProductRenderInput, type CapturedFfmpegInvocation } from "./ffmpeg-diagnostic.js";

const execute = promisify(execFile), root = diagnosticOutputDirectory(), diagnosticIt = root ? it : it.skip;
const attempts = Number(process.env.PHASE5_FFMPEG_MATRIX_ATTEMPTS ?? 30), fontlessAttempts = Number(process.env.PHASE5_FFMPEG_FONTLESS_ATTEMPTS ?? 50);
const expectedFingerprint = "5d5a6fbdfdfb631aefb8ccb50efa88d0ef6c245993f9c8762bcaaa1ba28d4c48";
type Outcome = "PASS" | "SIGSEGV" | "TIMEOUT" | "OTHER_ERROR";
type Result = { outcome: Outcome; exitCode: number | null; signal: string | null; elapsedMs: number; stderrExcerpt: string; errorFingerprint?: string };
type Summary = { name: string; attempts: number; success: number; sigsegv: number; timeout: number; otherError: number; crashRate: number; otherErrors: Array<{ fingerprint: string; count: number; representative: Result }>; results: Result[] };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const count = (value: string, expression: RegExp) => (value.match(expression) ?? []).length;
const excerpt = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(-1_500);
const escapePath = (value: string) => value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

function remap(captured: CapturedFfmpegInvocation, args: readonly string[]) {
  const from = captured.directory.replace(/\\/g, "/"), to = captured.fixtureDirectory.replace(/\\/g, "/"), escapedFrom = from.replace(/:/g, "\\:"), escapedTo = to.replace(/:/g, "\\:");
  return args.map((arg) => arg.replaceAll(captured.directory, captured.fixtureDirectory).replaceAll(escapedFrom, escapedTo).replaceAll(from, to));
}
function splitInputs(args: string[], sceneCount: number) {
  const complex = args.indexOf("-filter_complex"), prefix = args.slice(0, 1), before = args.slice(1, complex), suffix = args.slice(complex + 2);
  const video = Array.from({ length: sceneCount }, (_, index) => before.slice(index * 4, index * 4 + 4));
  const audio = Array.from({ length: sceneCount }, (_, index) => before.slice(sceneCount * 4 + index * 2, sceneCount * 4 + index * 2 + 2));
  return { prefix, video, audio, suffix };
}
function removeDrawtext(value: string) {
  return value.replace(/,drawtext=textfile='[^']+':fontcolor=white:fontsize=[^:]+:x=\(w-text_w\)\/2:y=h\*0\.32:line_spacing=12:enable='between\(t,0\.15,[^)]+\)'/g, "").replace(/,drawtext=textfile='[^']+':fontcolor=0x94a3b8:fontsize=[^:]+:x=\(w-text_w\)\/2:y=h\*0\.52:line_spacing=8/g, "");
}
function graph(videoCount: number, audioCount: number, subtitles: boolean, videoConcat: boolean, audioConcat: boolean) {
  const videoInputs = Array.from({ length: videoCount }, (_, index) => `[${index}:v]`).join("");
  const audioInputs = Array.from({ length: audioCount }, (_, index) => `[${index + videoCount}:a]`).join("");
  const video = videoCount === 1 || !videoConcat ? `[0:v]null[v]` : `${videoInputs}concat=n=${videoCount}:v=1:a=0[v]`;
  const audio = audioCount === 0 ? "" : audioCount === 1 || !audioConcat ? `[${videoCount}:a]anull[a]` : `${audioInputs}concat=n=${audioCount}:v=0:a=1[a]`;
  const captionPath = escapePath(join(root!, "direct-exact", "captions.srt"));
  const finalVideo = subtitles ? `[v]subtitles='${captionPath}'[captioned]` : `[v]null[captioned]`;
  return [video, audio, finalVideo].filter(Boolean).join(";");
}
function command(captured: CapturedFfmpegInvocation, name: string, options: { videoCount?: number; audioCount?: number; drawtext?: boolean; subtitles?: boolean; videoConcat?: boolean; audioConcat?: boolean; videoOnly?: boolean } = {}) {
  const parts = splitInputs(remap(captured, captured.args), captured.input.sceneCount), videoCount = options.videoCount ?? 6, audioCount = options.videoOnly ? 0 : (options.audioCount ?? 6), drawtext = options.drawtext ?? true, subtitles = options.subtitles ?? true;
  const video = parts.video.slice(0, videoCount).map((input) => drawtext ? input : input.map((value, index) => index === 3 ? removeDrawtext(value) : value));
  const audio = parts.audio.slice(0, audioCount);
  const filter = graph(videoCount, audioCount, subtitles, options.videoConcat ?? true, options.audioConcat ?? true);
  const maps = audioCount ? ["-map", "[captioned]", "-map", "[a]", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"] : ["-map", "[captioned]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  return [...parts.prefix, ...video.flat(), ...audio.flat(), "-filter_complex", filter, ...maps, join(captured.fixtureDirectory, `${name}.mp4`)];
}
function structuralCheck(name: string, args: string[], expectations: { drawtext: number; subtitles: number }) {
  const filter = args[args.indexOf("-filter_complex") + 1]!, all = args.join("\n");
  expect(count(all, /drawtext=/g), `${name} drawtext count`).toBe(expectations.drawtext);
  expect(count(all, /subtitles=/g), `${name} subtitles count`).toBe(expectations.subtitles);
  expect(filter).toContain("[captioned]");
  return filter;
}
function normalize(stderr: string, captured: CapturedFfmpegInvocation) { return stderr.replaceAll(captured.fixtureDirectory.replace(/\\/g, "/"), "<fixture>").replaceAll(captured.fixtureDirectory, "<fixture>").replace(/0x[0-9a-f]+/gi, "<address>").replace(/\b\d{4,}\b/g, "<number>"); }
async function run(captured: CapturedFfmpegInvocation, args: string[]): Promise<Result> {
  const started = performance.now(), output = args.at(-1)!;
  try {
    await execute("ffmpeg", ["-loglevel", "error", ...args], { cwd: root, timeout: 120_000, maxBuffer: 1_000_000, windowsHide: true });
    const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "format=format_name:stream=codec_type,codec_name", "-of", "json", output], { cwd: root, timeout: 30_000, maxBuffer: 100_000, windowsHide: true });
    expect(String(JSON.parse(stdout).format?.format_name ?? "")).toContain("mp4");
    await rm(output, { force: true });
    return { outcome: "PASS", exitCode: 0, signal: null, elapsedMs: Math.round(performance.now() - started), stderrExcerpt: "" };
  } catch (error: any) {
    const signal = typeof error?.signal === "string" ? error.signal : null, stderr = excerpt(error?.stderr), timeout = error?.killed === true && signal === "SIGTERM";
    const outcome: Outcome = signal === "SIGSEGV" ? "SIGSEGV" : timeout ? "TIMEOUT" : "OTHER_ERROR";
    return { outcome, exitCode: typeof error?.code === "number" ? error.code : null, signal, elapsedMs: Math.round(performance.now() - started), stderrExcerpt: stderr, errorFingerprint: outcome === "OTHER_ERROR" ? sha(normalize(stderr, captured)) : undefined };
  }
}
async function sample(captured: CapturedFfmpegInvocation, name: string, total: number, make: (attempt: number) => string[]) {
  const results: Result[] = [];
  for (let attempt = 1; attempt <= total; attempt++) results.push(await run(captured, make(attempt)));
  const group = new Map<string, Result[]>(); for (const result of results.filter((x) => x.outcome === "OTHER_ERROR")) group.set(result.errorFingerprint!, [...(group.get(result.errorFingerprint!) ?? []), result]);
  const successes = results.filter((x) => x.outcome === "PASS").length, sigsegv = results.filter((x) => x.outcome === "SIGSEGV").length, timeout = results.filter((x) => x.outcome === "TIMEOUT").length;
  return { name, attempts: total, success: successes, sigsegv, timeout, otherError: total - successes - sigsegv - timeout, crashRate: sigsegv / total, otherErrors: [...group.entries()].map(([fingerprint, values]) => ({ fingerprint, count: values.length, representative: values[0]! })), results } satisfies Summary;
}

describe("Phase 5 renderer graph lifecycle diagnostic", () => diagnosticIt("maps graph topology with bounded native-speed samples", async () => {
  await mkdir(root!, { recursive: true });
  let captured: CapturedFfmpegInvocation | undefined;
  const renderer = new FfmpegVideoRenderer({ onInvocation: async (invocation) => { captured = await captureFfmpegInvocation(root!, "direct-exact", invocation); } });
  try { const output = await renderer.render(phase5ProductRenderInput()); await output.cleanup(); } catch { /* Exact renderer capture is sufficient for native-crash diagnostics. */ }
  expect(captured).toBeDefined(); const invocation = captured!;
  expect(invocation.fingerprint).toBe(expectedFingerprint);
  const full = command(invocation, "full", { drawtext: true, subtitles: true });
  structuralCheck("full", full, { drawtext: 12, subtitles: 1 });
  const exactArgs = remap(invocation, invocation.args), fullFilter = exactArgs[exactArgs.indexOf("-filter_complex") + 1]!;
  const variants = [
    ["FULL_PRODUCTION_GRAPH", attempts, () => full, { drawtext: 12, subtitles: 1 }],
    ["FONTLESS_FULL_GRAPH", fontlessAttempts, () => command(invocation, "fontless", { drawtext: false, subtitles: false }), { drawtext: 0, subtitles: 0 }],
    ["DRAWTEXT_ONLY_ON_FULL_GRAPH", attempts, () => command(invocation, "drawtext-full", { drawtext: true, subtitles: false }), { drawtext: 12, subtitles: 0 }],
    ["SUBTITLES_ONLY_ON_FULL_GRAPH", attempts, () => command(invocation, "subtitles-full", { drawtext: false, subtitles: true }), { drawtext: 0, subtitles: 1 }],
    ["NO_TEXT_FILTERS_VIDEO_CONCAT_ONLY", attempts, () => command(invocation, "video-concat-only", { drawtext: false, subtitles: false, videoOnly: true }), { drawtext: 0, subtitles: 0 }],
    ["NO_TEXT_FILTERS_AUDIO_VIDEO_CONCAT", attempts, () => command(invocation, "audio-video-concat", { drawtext: false, subtitles: false }), { drawtext: 0, subtitles: 0 }],
    ["SINGLE_VIDEO_INPUT_PLUS_AUDIO_CONCAT", attempts, () => command(invocation, "single-video-audio-concat", { videoCount: 1, drawtext: false, subtitles: false }), { drawtext: 0, subtitles: 0 }],
    ["VIDEO_CONCAT_PLUS_SINGLE_AUDIO", attempts, () => command(invocation, "video-concat-single-audio", { audioCount: 1, drawtext: false, subtitles: false }), { drawtext: 0, subtitles: 0 }],
    ["SINGLE_VIDEO_SINGLE_AUDIO", attempts, () => command(invocation, "single-video-single-audio", { videoCount: 1, audioCount: 1, drawtext: false, subtitles: false }), { drawtext: 0, subtitles: 0 }],
  ] as const;
  const summaries: Summary[] = [];
  for (const [name, total, create, assertion] of variants) { const probe = create(); structuralCheck(name, probe, assertion); summaries.push(await sample(invocation, name, total, (n) => { const args = create(); args[args.length - 1] = join(invocation.fixtureDirectory, `${name.toLowerCase()}-${n}.mp4`); return args; })); }
  for (const scenes of [1, 2, 3, 4, 6]) { const name = `SCENE_COUNT_${scenes}`; const probe = command(invocation, name, { videoCount: scenes, audioCount: scenes, drawtext: false, subtitles: false }); structuralCheck(name, probe, { drawtext: 0, subtitles: 0 }); summaries.push(await sample(invocation, name, attempts, (n) => { const args = command(invocation, `${name}-${n}`, { videoCount: scenes, audioCount: scenes, drawtext: false, subtitles: false }); return args; })); }
  const report = { fixture: { fingerprint: invocation.fingerprint, ...invocation.input, videoInputCount: 6, audioInputCount: 6, filterComplexSha256: sha(fullFilter) }, attempts, fontlessAttempts, summaries };
  await writeFile(join(root!, "renderer-graph-lifecycle-matrix.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const summary of summaries) console.log(`PHASE5_GRAPH ${summary.name} attempts=${summary.attempts} success=${summary.success} sigsegv=${summary.sigsegv} timeout=${summary.timeout} other_error=${summary.otherError} crash_rate=${summary.crashRate}`);
}, 2_700_000));
