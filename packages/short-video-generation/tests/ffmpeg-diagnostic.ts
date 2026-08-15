import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FfmpegInvocationDiagnostic } from "../src/index.js";

export const phase5ProductNarration = (index: number) =>
  index === 2
    ? "A grounded direct quote explains that evidence matters."
    : `第 ${index + 1} 幕：AI API GPT-5 needs evidence.`;
export const phase5ProductPrimary = ["GPT-5", "问题不是答案", "evidence matters", "AI API", "重新提问", "先问证据"];
export const phase5ProductSceneTypes = ["HOOK", "QUESTION", "EVIDENCE", "CONCEPT", "REFRAME", "ENDING"];

export function phase5ProductWav() {
  const rate = 8_000, samples = 20_000, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true); bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++) view.setInt16(44 + index * 2, Math.sin(index / 11) * 3000, true);
  return bytes;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const replaceDirectory = (value: string, directory: string) => value.replaceAll(directory.replace(/\\/g, "/"), "<tmp>").replaceAll(directory, "<tmp>");

export type CapturedFfmpegInvocation = {
  directory: string;
  args: string[];
  outputPath: string;
  input: { durationMs: number; width: number; height: number; fps: number; sceneCount: number; captionCount: number };
  fixtureDirectory: string;
  fingerprint: string;
};

export async function captureFfmpegInvocation(root: string, label: string, invocation: Parameters<NonNullable<FfmpegInvocationDiagnostic["onInvocation"]>>[0]): Promise<CapturedFfmpegInvocation> {
  const fixtureDirectory = join(root, label);
  await rm(fixtureDirectory, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await cp(invocation.directory, fixtureDirectory, { recursive: true });
  const files = (await readdir(fixtureDirectory)).sort();
  const fileDetails = await Promise.all(files.map(async (name) => {
    const bytes = await readFile(join(fixtureDirectory, name));
    return { name, byteLength: bytes.length, sha256: sha256(bytes), mediaType: name.endsWith(".wav") ? "audio/wav" : name.endsWith(".srt") ? "application/x-subrip" : "text/plain" };
  }));
  const fingerprintPayload = {
    ...invocation.input,
    files: fileDetails.filter((file) => file.name.endsWith(".wav")),
    captionsSha256: fileDetails.find((file) => file.name === "captions.srt")?.sha256,
  };
  const fingerprint = sha256(new TextEncoder().encode(JSON.stringify(fingerprintPayload)));
  await writeFile(join(fixtureDirectory, "diagnostic-manifest.json"), `${JSON.stringify({
    label,
    input: invocation.input,
    fingerprint,
    files: fileDetails,
    args: invocation.args.map((arg) => replaceDirectory(arg, invocation.directory)),
  }, null, 2)}\n`, "utf8");
  return { directory: invocation.directory, args: [...invocation.args], outputPath: invocation.outputPath, input: invocation.input, fixtureDirectory, fingerprint };
}

export function phase5ProductRenderInput() {
  const wav = phase5ProductWav();
  return {
    durationMs: 15_000,
    width: 360,
    height: 640,
    fps: 15,
    scenes: phase5ProductSceneTypes.map((sceneType, index) => ({ id: `scene-${index + 1}`, ordinal: index + 1, sceneType, startMs: index * 2500, endMs: (index + 1) * 2500, primaryText: phase5ProductPrimary[index]!, secondaryText: "中文 English", keywords: ["AI", "GPT-5"], layoutTemplate: ["QUESTION_CARD", "CONTRAST", "EVIDENCE_CARD", "CONCEPT_CARD", "CLAIM_CARD", "ENDING_CARD"][index]!, transitionIntent: "FADE" })),
    captions: phase5ProductSceneTypes.map((_, index) => ({ startMs: index * 2500, endMs: (index + 1) * 2500, text: phase5ProductNarration(index) })),
    narrationAudio: phase5ProductSceneTypes.map((_, index) => ({ sceneId: `scene-${index + 1}`, bytes: wav, mediaType: "audio/wav", durationMs: 2500 })),
  };
}

export const diagnosticOutputDirectory = () => process.env.PHASE5_FFMPEG_DIAGNOSTIC_DIR?.trim();
export const diagnosticLabel = (value: string) => value.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
export const copiedPath = (captured: CapturedFfmpegInvocation, name: string) => join(captured.fixtureDirectory, basename(name));
