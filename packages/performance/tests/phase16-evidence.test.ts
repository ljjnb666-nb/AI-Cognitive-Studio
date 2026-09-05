import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "../../ingestion/src/index.js";
import { normalizeCanonicalText } from "../../ingestion/src/canonical-text.js";
import { calculatePhase16Scenarios, estimateProviderCost, p50p95, phase16PricingCatalog, summarizeProviderEfficiency } from "../src/index.js";

const output = new URL("../../../output/phase16/", import.meta.url);
type DuplicateScenario = { expectedPaidOperations: number; observedPaidOperations: number; duplicatePaidOperations: number };
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";
const source = (units: number) => Array.from({ length: units }, (_, index) => `# Section ${index}\r\n\r\nDeterministic Phase 16 source material ${index}.`).join("\r\n\r\n");
const productEvidence = <T>(name: string): T | undefined => { const path = process.env[`PHASE16_${name}_EVIDENCE_PATH`]; if (!path) return undefined; return JSON.parse(readFileSync(path, "utf8")) as T; };
async function documentBenchmark(name: string, units: number) { const text = source(units), bytes = Buffer.from(text), start = performance.now(), parsed = await parseDocument(bytes, "text/markdown"), parsedAt = performance.now(), normalized = parsed.pages.flatMap(page => page.blocks).map(block => normalizeCanonicalText(block.text)).filter(Boolean), normalizedAt = performance.now(); return { name, bytes: bytes.byteLength, normalizedBlockCount: normalized.length, parseDurationMs: parsedAt - start, normalizationDurationMs: normalizedAt - parsedAt, endToEndDurationMs: normalizedAt - start, memoryHighWaterMarkBytes: process.memoryUsage().heapUsed, path: "parseDocument+normalizeCanonicalText" }; }

describe("Phase 16 computed evidence", () => {
  it("uses one calculator-backed scenario source and writes self-consistent evidence", async () => {
    const scenarios = calculatePhase16Scenarios();
    for (const scenario of scenarios) expect(estimateProviderCost(phase16PricingCatalog, scenario).estimatedCostMicros).toBe(scenario.estimatedCostMicros);
    const measuredCalls = scenarios.map((scenario, index) => ({ ...scenario, workspaceId: "phase16-benchmark", correlationId: `scenario-${index}`, routeSlot: "BENCHMARK", invocationId: `scenario-${index}`, attemptNumber: 1, status: "SUCCEEDED" as const, createdAt: new Date("2026-09-01T00:00:00.000Z"), logicalOperationId: `scenario-${index}` }));
    const providerUsage = summarizeProviderEfficiency(phase16PricingCatalog, measuredCalls, { workspaceId: "phase16-benchmark", from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-09-01T00:01:00.000Z") });
    const documents = await Promise.all([documentBenchmark("SMALL", 50), documentBenchmark("MEDIUM", 500), documentBenchmark("LARGE", 2_000)]), phase4 = productEvidence<{ ingestion: unknown; audio: { replayBefore: number; replayAfter: number } }>("PHASE4"), phase5 = productEvidence<unknown>("PHASE5"), gateway = productEvidence<{ source: string; providerLatencyMs: number[]; duplicatePaidEvidence: { gatewayRedelivery: DuplicateScenario; postRemoteRecovery: DuplicateScenario } }>("GATEWAY"), workerQueue = productEvidence<unknown>("QUEUE_WORKER"), outboxQueue = productEvidence<unknown>("QUEUE_OUTBOX");
    if (process.env.PHASE16_REQUIRE_PRODUCT_EVIDENCE && (!phase4 || !phase5 || !gateway || !workerQueue || !outboxQueue)) throw new Error("PHASE16_PRODUCT_EVIDENCE_MISSING");
    const gitSha = process.env.PHASE16_ARTIFACT_GIT_SHA ?? process.env.GITHUB_SHA ?? "LOCAL";
    rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
    const audioReplay: DuplicateScenario | undefined = phase4 ? { expectedPaidOperations: phase4.audio.replayBefore, observedPaidOperations: phase4.audio.replayAfter, duplicatePaidOperations: Math.max(0, phase4.audio.replayAfter - phase4.audio.replayBefore) } : undefined;
    const duplicateScenarios = gateway && audioReplay ? [{ name: "GATEWAY_REDELIVERY", ...gateway.duplicatePaidEvidence.gatewayRedelivery }, { name: "POST_REMOTE_RECOVERY", ...gateway.duplicatePaidEvidence.postRemoteRecovery }, { name: "AUDIO_REPLAY", ...audioReplay }] : [];
    const eligibleObservedPaidOperations = duplicateScenarios.reduce((sum, scenario) => sum + scenario.observedPaidOperations, 0), duplicatePaidOperationCount = duplicateScenarios.reduce((sum, scenario) => sum + scenario.duplicatePaidOperations, 0), duplicatePaidOperationRate = eligibleObservedPaidOperations ? duplicatePaidOperationCount / eligibleObservedPaidOperations : 0;
    const duplicatePaidEvidence = { scenarios: duplicateScenarios, eligibleObservedPaidOperations, duplicatePaidOperationCount, duplicatePaidOperationRate, qualityRedraftClassification: { status: "INTENTIONAL_EXCLUDED", evidence: "Phase15 bounded generationAttempt 1→2 regression" } };
    const benchmark = { gitSha, benchmarkVersion: "phase16-v5", pricingCatalogVersion: phase16PricingCatalog.version, generatedBy: "Phase 16 computed evidence plus product-path execution", scenarios, scenarioSelfConsistency: "EXACT", largeDocumentBenchmarks: documents, productIngestionBenchmark: phase4?.ingestion, audioPerformanceBenchmark: phase4?.audio, shortVideoPerformanceBenchmark: phase5, providerLatency: gateway?.providerLatencyMs ? p50p95(gateway.providerLatencyMs) : null, providerLatencySource: gateway?.source, duplicatePaidEvidence };
    const queue = { workerConcurrencyConfiguredRange: [1, 32], worker: workerQueue, outbox: outboxQueue };
    writeFileSync(new URL("performance-cost-benchmark.json", output), json(benchmark));
    writeFileSync(new URL("provider-usage-report.json", output), json({ ...providerUsage, syntheticDuplicateFixtureCount: providerUsage.duplicatePaidOperationCount, syntheticDuplicateFixtureRate: providerUsage.duplicatePaidOperationRate, duplicatePaidOperationCount, duplicatePaidOperationRate, duplicateMetricSource: "observed-provider-call-deltas", duplicatePaidEvidence }));
    writeFileSync(new URL("queue-concurrency-report.json", output), json(queue));
    writeFileSync(new URL("performance-cost-benchmark.md", output), `# Phase 16 performance benchmark\n\nGit SHA: ${gitSha}\n\nAll scenario prices are recalculated from deterministic usage profiles with the Phase 16 calculator.\n`);
    expect(scenarios).toHaveLength(6); expect(duplicateScenarios).toHaveLength(3); expect(duplicatePaidOperationCount).toBe(0);
  });
});
