import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FfmpegVideoRenderer } from "../src/index.js";
import { captureFfmpegInvocation, diagnosticOutputDirectory, phase5ProductRenderInput, type CapturedFfmpegInvocation } from "./ffmpeg-diagnostic.js";

const root = diagnosticOutputDirectory(), diagnosticIt = root ? it : it.skip;
const expectedFingerprint = "5d5a6fbdfdfb631aefb8ccb50efa88d0ef6c245993f9c8762bcaaa1ba28d4c48";
const drawtextAttempts = Number(process.env.PHASE5_DRAWTEXT_ATTEMPTS ?? 50), minimalAttempts = Number(process.env.PHASE5_MINIMAL_DRAWTEXT_ATTEMPTS ?? 30);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const tail = (value: string) => value.replace(/[\r\n]+/g, " ").slice(-1_500);
const escaped = (value: string) => value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
type Classification = "SUCCESS" | "SIGSEGV" | "TIMEOUT" | "FFMPEG_ERROR" | "OTHER_SIGNAL" | "SPAWN_ERROR" | "UNKNOWN";
type Attempt = { variant: string; attempt: number; pid: number | null; exitCode: number | null; signal: string | null; classification: Classification; elapsedMs: number; coreDump: boolean; stderrTail: string; stderrFingerprint?: string; commandFile: string; filterComplex?: string };

function remap(captured: CapturedFfmpegInvocation) { const from = captured.directory.replace(/\\/g, "/"), to = captured.fixtureDirectory.replace(/\\/g, "/"); return captured.args.map((arg) => arg.replaceAll(captured.directory, captured.fixtureDirectory).replaceAll(from.replace(/:/g, "\\:"), to.replace(/:/g, "\\:")).replaceAll(from, to)); }
function drawtextOnly(captured: CapturedFfmpegInvocation, output: string) { const args = remap(captured), at = args.indexOf("-filter_complex"); args[at + 1] = args[at + 1]!.replace(/;\[v\]subtitles='[^']+'\[captioned\]/, ";[v]null[captioned]"); args[args.length - 1] = output; return args; }
function classify(code: number | null, signal: string | null, timedOut: boolean): Classification { if (signal === "SIGSEGV" || code === 139) return "SIGSEGV"; if (timedOut) return "TIMEOUT"; if (signal) return "OTHER_SIGNAL"; if (code === 0) return "SUCCESS"; if (typeof code === "number") return "FFMPEG_ERROR"; return "UNKNOWN"; }
async function invoke(command: string, args: string[], timeoutMs = 120_000) {
  return await new Promise<{ pid: number | null; code: number | null; signal: string | null; stderr: string; timedOut: boolean }>((resolve) => {
    let stderr = "", timedOut = false; const child = spawn(command, args, { cwd: root, windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ pid: child.pid ?? null, code: null, signal: null, stderr: `${stderr}\n${error.message}`, timedOut }); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ pid: child.pid ?? null, code, signal, stderr, timedOut }); });
  });
}
async function execute(captured: CapturedFfmpegInvocation, variant: string, attempt: number, args: string[], filterComplex?: string): Promise<Attempt> {
  const commandFile = join(root!, `command-${variant}-${attempt}.json`), started = performance.now(); await writeFile(commandFile, `${JSON.stringify({ argv: args, filterComplex }, null, 2)}\n`);
  const result = await invoke("ffmpeg", ["-loglevel", "error", ...args]), output = args.at(-1)!, classification = classify(result.code, result.signal, result.timedOut);
  let final = classification, stderrTail = tail(result.stderr); if (classification === "SUCCESS") { const probe = await invoke("ffprobe", ["-v", "error", "-show_entries", "format=format_name", "-of", "json", output], 30_000); if (probe.code === 0) await rm(output, { force: true }); else { final = "UNKNOWN"; stderrTail = `ffprobe failed: ${tail(probe.stderr)}`; } }
  const core = result.pid !== null && existsSync(join(process.env.PHASE5_FFMPEG_CORE_DIRECTORY ?? root!, `core.ffmpeg.${result.pid}`));
  const metadata: Attempt = { variant, attempt, pid: result.pid ?? null, exitCode: result.code, signal: result.signal, classification: final, elapsedMs: Math.round(performance.now() - started), coreDump: core, stderrTail, stderrFingerprint: final === "SUCCESS" ? undefined : sha(stderrTail.replaceAll(captured.fixtureDirectory, "<fixture>").replace(/0x[0-9a-f]+/gi, "<address>")), commandFile: commandFile.split(/[\\/]/).at(-1)!, filterComplex };
  await appendFile(join(root!, "attempts.jsonl"), `${JSON.stringify(metadata)}\n`); return metadata;
}
function summarize(items: Attempt[]) { const by = (kind: Classification) => items.filter((x) => x.classification === kind).length; return { attempts: items.length, success: by("SUCCESS"), sigsegv: by("SIGSEGV"), ffmpegError: by("FFMPEG_ERROR"), timeout: by("TIMEOUT"), otherSignal: by("OTHER_SIGNAL"), unknown: by("UNKNOWN"), errors: [...new Map(items.filter((x) => x.classification !== "SUCCESS").map((x) => [x.stderrFingerprint!, x])).entries()].map(([fingerprint, item]) => ({ fingerprint, classification: item.classification, stderr: item.stderrTail })) }; }

describe("Phase 5 drawtext graph lifecycle confirmation", () => diagnosticIt("captures and classifies the exact drawtext-only topology", async () => {
  await mkdir(root!, { recursive: true }); let captured: CapturedFfmpegInvocation | undefined;
  const renderer = new FfmpegVideoRenderer({ onInvocation: async (value) => { captured = await captureFfmpegInvocation(root!, "direct-exact", value); } }); try { const output = await renderer.render(phase5ProductRenderInput()); await output.cleanup(); } catch { /* Native failure is the target condition. */ }
  expect(captured).toBeDefined(); const fixture = captured!; expect(fixture.fingerprint).toBe(expectedFingerprint);
  const full = remap(fixture), fullFilter = full[full.indexOf("-filter_complex") + 1]!, draw = drawtextOnly(fixture, join(fixture.fixtureDirectory, "drawtext-probe.mp4")), drawFilter = draw[draw.indexOf("-filter_complex") + 1]!;
  expect(full.join("\n").match(/drawtext=/g)?.length).toBe(12); expect(fullFilter).toMatch(/subtitles=/); expect(draw.join("\n").match(/drawtext=/g)?.length).toBe(12); expect(drawFilter).not.toMatch(/subtitles=/);
  await writeFile(join(root!, "graph-equivalence.json"), `${JSON.stringify({ fixture: { fingerprint: fixture.fingerprint, sceneCount: 6, videoInputs: 6, audioInputs: 6, captions: 6, durationMs: 15000, resolution: "360x640", fps: 15, fullFilterHash: sha(fullFilter), drawtextOnlyFilterHash: sha(drawFilter), fullFilter, drawtextOnlyFilter: drawFilter }, differences: ["subtitles filter removed", "final video label uses null pass-through"], unchanged: ["six color/drawtext video inputs", "six WAV inputs", "video concat", "audio concat", "H.264/AAC MP4", "-shortest", "fps and source durations", "drawtext textfile/fontcolor/fontsize/escaping/enable expressions"] }, null, 2)}\n`);
  const attempts: Attempt[] = []; for (let index = 1; index <= drawtextAttempts; index++) attempts.push(await execute(fixture, "DRAWTEXT_ONLY_ON_FULL_GRAPH", index, drawtextOnly(fixture, join(fixture.fixtureDirectory, `drawtext-only-${index}.mp4`)), drawFilter));
  const primary = join(fixture.fixtureDirectory, "scene-0-primary.txt"); for (let index = 1; index <= minimalAttempts; index++) { const args = ["-y", "-f", "lavfi", "-i", `color=c=#0f172a:s=360x640:r=15:d=2.5,drawtext=textfile='${escaped(primary)}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=h*0.32`, "-c:v", "libx264", "-pix_fmt", "yuv420p", join(fixture.fixtureDirectory, `minimal-drawtext-${index}.mp4`)]; attempts.push(await execute(fixture, "MINIMAL_DRAWTEXT_GRAPH", index, args)); }
  const report = { drawtextOnly: summarize(attempts.filter((x) => x.variant === "DRAWTEXT_ONLY_ON_FULL_GRAPH")), minimalDrawtext: summarize(attempts.filter((x) => x.variant === "MINIMAL_DRAWTEXT_GRAPH")) }; await writeFile(join(root!, "drawtext-lifecycle-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PHASE5_DRAWTEXT drawtext=${JSON.stringify(report.drawtextOnly)} minimal=${JSON.stringify(report.minimalDrawtext)}`);
}, 1_200_000));
