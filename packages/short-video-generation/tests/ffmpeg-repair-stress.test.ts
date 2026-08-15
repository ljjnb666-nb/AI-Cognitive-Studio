import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FfmpegVideoRenderer, videoRenderFailureDetails } from "../src/index.js";
import { diagnosticOutputDirectory, phase5ProductRenderInput } from "./ffmpeg-diagnostic.js";

const root = diagnosticOutputDirectory(), diagnosticIt = root ? it : it.skip;
const sceneAttempts = Number(process.env.PHASE5_SCENE_LOCAL_ATTEMPTS ?? 100);
const fullAttempts = Number(process.env.PHASE5_REPAIRED_FULL_ATTEMPTS ?? 50);
type Result = { variant: "SCENE_LOCAL" | "FULL_REPAIRED"; attempt: number; classification: "SUCCESS" | "SIGSEGV" | "SIGABRT" | "OTHER_SIGNAL" | "FFMPEG_ERROR" | "UNKNOWN"; signal: string | null; stderr: string; elapsedMs: number; finalDrawtextCount: number | null };

function classify(error: unknown): Result["classification"] {
  const diagnostic = videoRenderFailureDetails(error);
  if (diagnostic?.signal === "SIGSEGV") return "SIGSEGV";
  if (diagnostic?.signal === "SIGABRT") return "SIGABRT";
  if (diagnostic?.signal) return "OTHER_SIGNAL";
  if (diagnostic) return "FFMPEG_ERROR";
  return "UNKNOWN";
}
function summary(results: Result[]) { const count = (classification: Result["classification"]) => results.filter((result) => result.classification === classification).length; return { attempts: results.length, success: count("SUCCESS"), sigsegv: count("SIGSEGV"), sigabrt: count("SIGABRT"), otherSignal: count("OTHER_SIGNAL"), ffmpegError: count("FFMPEG_ERROR"), unknown: count("UNKNOWN") }; }

describe("Phase 5 repaired drawtext renderer stress", () => diagnosticIt("isolates scene font lifecycles and leaves final composition drawtext-free", async () => {
  await mkdir(root!, { recursive: true });
  const results: Result[] = [];
  const execute = async (variant: Result["variant"], attempt: number, input: ReturnType<typeof phase5ProductRenderInput>) => {
    let finalDrawtextCount: number | null = null, started = performance.now();
    try {
      const output = await new FfmpegVideoRenderer({ onInvocation: (value) => {
        if (value.renderStep !== "FINAL_COMPOSITION") return;
        finalDrawtextCount = value.args.join(" ").match(/drawtext=/g)?.length ?? 0;
        expect(finalDrawtextCount).toBe(0);
        expect(value.args.join(" ")).toContain("subtitles=");
      } }).render(input);
      await output.cleanup();
      results.push({ variant, attempt, classification: "SUCCESS", signal: null, stderr: "", elapsedMs: Math.round(performance.now() - started), finalDrawtextCount });
    } catch (error) {
      const diagnostic = videoRenderFailureDetails(error);
      results.push({ variant, attempt, classification: classify(error), signal: diagnostic?.signal ?? null, stderr: diagnostic?.stderrExcerpt ?? String(error), elapsedMs: Math.round(performance.now() - started), finalDrawtextCount });
    }
    await appendFile(join(root!, "repair-attempts.jsonl"), `${JSON.stringify(results.at(-1))}\n`);
  };
  for (let attempt = 1; attempt <= sceneAttempts; attempt++) {
    const fixture = phase5ProductRenderInput();
    await execute("SCENE_LOCAL", attempt, { ...fixture, durationMs: 2_500, scenes: [fixture.scenes[0]!], captions: [fixture.captions[0]!], narrationAudio: [fixture.narrationAudio[0]!] });
  }
  for (let attempt = 1; attempt <= fullAttempts; attempt++) await execute("FULL_REPAIRED", attempt, phase5ProductRenderInput());
  const report = { sceneLocal: summary(results.filter((result) => result.variant === "SCENE_LOCAL")), fullRepaired: summary(results.filter((result) => result.variant === "FULL_REPAIRED")) };
  await writeFile(join(root!, "repair-stress-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PHASE5_REPAIR_STRESS ${JSON.stringify(report)}`);
  expect(report.sceneLocal).toEqual({ attempts: sceneAttempts, success: sceneAttempts, sigsegv: 0, sigabrt: 0, otherSignal: 0, ffmpegError: 0, unknown: 0 });
  expect(report.fullRepaired).toEqual({ attempts: fullAttempts, success: fullAttempts, sigsegv: 0, sigabrt: 0, otherSignal: 0, ffmpegError: 0, unknown: 0 });
}, 1_800_000));
