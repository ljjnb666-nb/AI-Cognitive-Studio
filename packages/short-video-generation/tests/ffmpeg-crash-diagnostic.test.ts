import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FfmpegVideoRenderer } from "../src/index.js";
import { captureFfmpegInvocation, diagnosticOutputDirectory, phase5ProductRenderInput, type CapturedFfmpegInvocation } from "./ffmpeg-diagnostic.js";

const execute = promisify(execFile);
const root = diagnosticOutputDirectory();
const diagnosticIt = root ? it : it.skip;
const attempts = Number(process.env.PHASE5_FFMPEG_MATRIX_ATTEMPTS ?? 30);
type Outcome = "PASS" | "ordinary FFmpeg error" | "SIGSEGV" | "timeout";
type Result = { outcome: Outcome; exitCode: number | null; signal: string | null; elapsedMs: number; stderrExcerpt: string };
type Summary = { name: string; attempts: number; success: number; sigsegv: number; otherError: number; crashRate: number; results: Result[] };
const excerpt = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(-1_000);

function remap(captured: CapturedFfmpegInvocation, args: readonly string[]) { const from = captured.directory.replace(/\\/g, "/"), to = captured.fixtureDirectory.replace(/\\/g, "/"); const escapedFrom = from.replace(/:/g, "\\:"), escapedTo = to.replace(/:/g, "\\:"); return args.map((arg) => arg.replaceAll(captured.directory, captured.fixtureDirectory).replaceAll(escapedFrom, escapedTo).replaceAll(from, to)); }
function fullArgs(captured: CapturedFfmpegInvocation, outputName: string) { const args = remap(captured, captured.args); args[args.length - 1] = join(captured.fixtureDirectory, outputName); return args; }
function filterArg(args: string[]) { return args[args.indexOf("-filter_complex") + 1]!; }
function withFilter(args: string[], filter: string) { const copy = [...args]; copy[copy.indexOf("-filter_complex") + 1] = filter; return copy; }
function withOption(args: string[], option: "-filter_threads" | "-filter_complex_threads") { const copy = [...args], at = copy.indexOf("-filter_complex"); copy.splice(at, 0, option, "1"); return copy; }
function outputPath(args: string[]) { return args.at(-1)!; }
function noSubtitles(filter: string) { return filter.replace(/;\[v\]subtitles='[^']+'\[captioned\]/, ";[v]null[captioned]"); }
function noDrawtext(filter: string) { return filter.replace(/,drawtext=textfile='[^']+':fontcolor=white:fontsize=[^:]+:x=\(w-text_w\)\/2:y=h\*0\.32:line_spacing=12:enable='between\(t,0\.15,[^)]+\)'/g, "").replace(/,drawtext=textfile='[^']+':fontcolor=0x94a3b8:fontsize=[^:]+:x=\(w-text_w\)\/2:y=h\*0\.52:line_spacing=8/g, ""); }
async function run(args: string[], timeout = 120_000): Promise<Result> {
  const started = performance.now();
  try {
    await execute("ffmpeg", ["-loglevel", "error", ...args], { cwd: root, timeout, maxBuffer: 1_000_000, windowsHide: true });
    await execute("ffprobe", ["-v", "error", "-show_entries", "format=format_name:stream=codec_type,codec_name", "-of", "json", outputPath(args)], { cwd: root, timeout: 30_000, maxBuffer: 100_000, windowsHide: true });
    return { outcome: "PASS", exitCode: 0, signal: null, elapsedMs: Math.round(performance.now() - started), stderrExcerpt: "" };
  } catch (error: any) {
    const signal = typeof error?.signal === "string" ? error.signal : null, timeoutHit = error?.killed === true && signal === "SIGTERM";
    return { outcome: signal === "SIGSEGV" ? "SIGSEGV" : timeoutHit ? "timeout" : "ordinary FFmpeg error", exitCode: typeof error?.code === "number" ? error.code : null, signal, elapsedMs: Math.round(performance.now() - started), stderrExcerpt: excerpt(error?.stderr) };
  }
}
async function sample(name: string, build: (attempt: number) => string[]): Promise<Summary> {
  const results: Result[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) results.push(await run(build(attempt)));
  const success = results.filter((result) => result.outcome === "PASS").length, sigsegv = results.filter((result) => result.outcome === "SIGSEGV").length;
  return { name, attempts, success, sigsegv, otherError: attempts - success - sigsegv, crashRate: sigsegv / attempts, results };
}

describe("Phase 5 FFmpeg native font/filter comparison", () => diagnosticIt("runs a bounded exact-fixture matrix without changing production behavior", async () => {
  await mkdir(root!, { recursive: true });
  let captured: CapturedFfmpegInvocation | undefined;
  const renderer = new FfmpegVideoRenderer({ onInvocation: async (invocation) => { captured = await captureFfmpegInvocation(root!, "direct-exact", invocation); } });
  try { const output = await renderer.render(phase5ProductRenderInput()); await output.cleanup(); } catch { /* The captured invocation is the experiment input even when this native process crashes. */ }
  expect(captured, "renderer must expose its own final invocation").toBeDefined();
  const invocation = captured!, base = fullArgs(invocation, "baseline.mp4"), filter = filterArg(base);
  const captions = join(invocation.fixtureDirectory, "captions.srt").replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const primary = join(invocation.fixtureDirectory, "scene-0-primary.txt").replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const summaries: Summary[] = [];
  summaries.push(await sample("old-default-exact-production-command", (n) => fullArgs(invocation, `old-default-${n}.mp4`)));
  summaries.push(await sample("old-filter-threads-1", (n) => withOption(fullArgs(invocation, `old-filter-threads-1-${n}.mp4`), "-filter_threads")));
  summaries.push(await sample("old-complex-filter-threads-1", (n) => withOption(fullArgs(invocation, `old-complex-filter-threads-1-${n}.mp4`), "-filter_complex_threads")));
  summaries.push(await sample("no-drawtext", (n) => withFilter(fullArgs(invocation, `no-drawtext-${n}.mp4`), noDrawtext(filter))));
  summaries.push(await sample("no-subtitles", (n) => withFilter(fullArgs(invocation, `no-subtitles-${n}.mp4`), noSubtitles(filter))));
  summaries.push(await sample("drawtext-focused-minimal", (n) => ["-y", "-f", "lavfi", "-i", `color=c=#0f172a:s=360x640:r=15:d=15,drawtext=textfile='${primary}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=h*0.32`, "-c:v", "libx264", "-pix_fmt", "yuv420p", join(invocation.fixtureDirectory, `drawtext-minimal-${n}.mp4`)]));
  summaries.push(await sample("subtitles-focused-minimal", (n) => ["-y", "-f", "lavfi", "-i", "color=c=#0f172a:s=360x640:r=15:d=15", "-filter_complex", `[0:v]subtitles='${captions}'[v]`, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(invocation.fixtureDirectory, `subtitles-minimal-${n}.mp4`)]));
  await writeFile(join(root!, "font-filter-stack-matrix.json"), `${JSON.stringify({ fingerprint: invocation.fingerprint, attemptsPerVariant: attempts, input: invocation.input, summaries }, null, 2)}\n`, "utf8");
  for (const summary of summaries) console.log(`PHASE5_MATRIX ${summary.name} attempts=${summary.attempts} success=${summary.success} sigsegv=${summary.sigsegv} other_error=${summary.otherError} crash_rate=${summary.crashRate}`);
  expect(summaries.every((summary) => summary.otherError === 0), "every PASS is ffprobe-verified; only the native SIGSEGV is an expected experimental outcome").toBe(true);
}, 1_200_000));
