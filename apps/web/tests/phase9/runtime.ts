import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@ai-cognitive/db";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { startWorkerRuntime } from "../../../worker/src/runtime.js";

function wav(seed: number) { const rate = 8_000, samples = 20_000, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true); bytes.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, samples * 2, true); for (let index = 0; index < samples; index++) view.setInt16(44 + index * 2, Math.round(Math.sin(index * (seed + 1) / 19) * 2_000), true); return bytes; }

function podcastResponse(input: any) {
  const stage = input.metadata?.stage, hosts = input.hosts ?? [], memory = input.context?.find((item: any) => item.sourceBlockEvidenceSpans?.length)?.memoryItemId ?? input.context?.[0]?.memoryItemId ?? input.availableMemoryIds?.[0];
  if (stage === "EPISODE_PLANNING") return { centralQuestion: "How does evidence make AI useful?", listenerStartingPoint: "curious", listenerTakeaway: "verify evidence", coreThesis: "Grounded systems retain provenance.", tensions: ["speed and trust"], surprisingIdeas: ["citations are executable context"], misconceptions: ["a model answer is proof"], keyConcepts: ["provenance"], candidateStories: [], candidateExamples: ["a source quote"], openQuestions: ["what should be checked?"] };
  if (stage === "NARRATIVE_DESIGN") return { arcType: "evidence", intellectualProgression: ["question", "evidence", "synthesis"], openingMove: "question", closingMove: "evidence" };
  if (stage === "SEGMENT_OUTLINE") return { segments: [{ ordinal: 1, purpose: "grounded conversation", internalLabel: "evidence", targetDurationSeconds: 30, narrativeFunction: "explain", keyQuestions: ["why verify?"], requiredMemoryIds: memory ? [memory] : [], optionalMemoryIds: [] }] };
  if (stage === "SEGMENT_DRAFTING") return { utterances: [{ ordinal: 1, speakerHostId: hosts[0]?.id, text: "Evidence is the starting point for a reliable AI conclusion.", utteranceType: "STATEMENT", substantive: true, isDirectQuote: false, evidence: memory ? [{ memoryItemId: memory }] : [] }, { ordinal: 2, speakerHostId: hosts[1]?.id, text: "How can a listener check that?", utteranceType: "QUESTION", substantive: false, isDirectQuote: false, evidence: [] }] };
  return { utterances: (input.dialogue?.utterances ?? []).map((item: any) => ({ ordinal: item.ordinal, text: item.text })) };
}
function videoResponse(input: any) {
  const stage = input.metadata?.stage, evidence = input.context?.[0]?.evidence?.[0];
  if (stage === "VIDEO_PLANNING") return { centralQuestion: "Why evidence matters", viewerAssumption: "AI answers are enough", coreInsight: "Verify provenance", cognitiveShift: "from answer to evidence", hook: "Ask for the source", supportingIdeas: ["evidence", "provenance"], evidenceStrategy: "show the cited source", ending: "check the evidence", targetDurationSeconds: 15, tone: "grounded" };
  if (stage === "SCENE_PLANNING") return { scenes: ["HOOK", "QUESTION", "EVIDENCE", "CONCEPT", "REFRAME", "ENDING"].map((sceneType, index) => ({ ordinal: index + 1, sceneType, targetDurationMs: 2_500, narrationText: index === 2 ? "Evidence is the starting point for a reliable AI conclusion." : `Grounded video scene ${index + 1}.`, visualIntent: "editorial card", primaryText: ["Ask why", "Check claims", "Evidence", "Context", "Verify", "Start here"][index], secondaryText: "AI Cognitive Studio", keywords: ["AI", "evidence"], layoutTemplate: ["QUESTION_CARD", "CONTRAST", "EVIDENCE_CARD", "CONCEPT_CARD", "CLAIM_CARD", "ENDING_CARD"][index], motionPreset: "REVEAL", transitionIntent: "FADE", evidence: index === 2 && evidence ? [{ sourceBlockId: evidence.sourceBlockId, startOffset: evidence.startOffset, endOffset: evidence.endOffset }] : [] })) };
  return {};
}

async function main() {
  const environment = readEnvironment();
  let calls = 0;
  const controls = { circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async (key: string) => ({ key, token: "phase9" }), release: async () => true }, validateEndpoint: async () => undefined };
  const runtime = await startWorkerRuntime(environment, { source: process.env, bookProductionGatewayOverrides: { ...controls, adapterResolver: () => ({ execute: async ({ request }: any) => {
    if (request.embedding) return { response: { vectors: request.embedding.texts.map(() => [1, 0, 0, 0]), dimensions: 4 }, usage: { embeddingInputTokens: request.embedding.texts.length }, remoteRequestId: `phase9-embed-${++calls}` };
    if (request.speech) return { response: { bytes: wav(++calls), mediaType: "audio/wav", format: "wav", sampleRate: 8_000, channels: 1 }, usage: { speechInputCharacters: request.speech.text.length }, remoteRequestId: `phase9-speech-${calls}` };
    const content = request.text?.messages?.[0]?.content ?? "";
    let input: any;
    try { input = JSON.parse(content); } catch { input = undefined; }
    const schemaName = request.text?.structuredOutput?.schemaName;
    if (schemaName === "short_video_plan") return { response: { type: "STRUCTURED", structured: videoResponse({ ...input, metadata: { stage: "VIDEO_PLANNING" } }) }, usage: { inputTokens: 1, outputTokens: 1 }, remoteRequestId: `phase9-text-${++calls}` };
    if (schemaName === "short_video_scenes") return { response: { type: "STRUCTURED", structured: videoResponse({ ...input, metadata: { stage: "SCENE_PLANNING" } }) }, usage: { inputTokens: 1, outputTokens: 1 }, remoteRequestId: `phase9-text-${++calls}` };
    if (input?.metadata?.stage) return { response: { type: "STRUCTURED", structured: podcastResponse(input) }, usage: { inputTokens: 1, outputTokens: 1 }, remoteRequestId: `phase9-text-${++calls}` };
    const block = await prisma.sourceBlock.findFirst({ where: { extraction: { sourceDocument: { workspaceId: request.workspaceId } } }, orderBy: { createdAt: "asc" } });
    const knownEvidence = "Evidence is the starting point for reliable AI conclusions.";
    const candidateOffset = block?.text.indexOf(knownEvidence) ?? -1;
    const startOffset = candidateOffset >= 0 ? candidateOffset : 0;
    const quoteText = block?.text.slice(startOffset, startOffset + (candidateOffset >= 0 ? knownEvidence.length : Math.min(20, block.text.length))) ?? "";
    return { response: { type: "STRUCTURED", structured: { summary: "Bounded intelligence from the workspace route.", memory: block ? [{ type: "QUOTE", content: quoteText, evidence: [{ sourceBlockId: block.id, startOffset, endOffset: startOffset + quoteText.length, quoteText }] }, { type: "CLAIM", content: "Reliable AI outcomes remain grounded in evidence." }] : [{ type: "SUMMARY", content: "Bounded intelligence" }] } }, usage: { inputTokens: 1, outputTokens: 1 }, remoteRequestId: `phase9-book-${++calls}` };
  } }) }, dispatchIntervalMs: 200, bullmqPrefix: process.env.PHASE9_BULLMQ_PREFIX, outboxTopics: { sourceIngestion: process.env.PHASE9_SOURCE_TOPIC, bookAnalysis: process.env.PHASE9_BOOK_TOPIC, podcastGeneration: process.env.PHASE9_PODCAST_TOPIC, podcastAudio: process.env.PHASE9_AUDIO_TOPIC, shortVideo: process.env.PHASE9_VIDEO_TOPIC } });
  await Promise.all([runtime.ingestionWorker.waitUntilReady(), runtime.bookWorker?.waitUntilReady(), runtime.podcastWorker?.waitUntilReady(), runtime.audioWorker?.waitUntilReady(), runtime.shortVideoWorker?.waitUntilReady()]);
  const readyFile = process.env.PHASE9_RUNTIME_READY_FILE;
  if (!readyFile) throw new Error("PHASE9_RUNTIME_READY_FILE_REQUIRED");
  await mkdir(join(readyFile, ".."), { recursive: true }); await writeFile(readyFile, "ready", "utf8");
  const close = async () => { await runtime.close("phase9-runtime"); process.exit(0); };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
}
void main().catch(error => { console.error(error); process.exit(1); });
