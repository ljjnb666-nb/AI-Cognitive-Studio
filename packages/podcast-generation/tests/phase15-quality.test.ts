import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPodcastSystemInstruction, evaluatePodcastScriptData, evaluateNaturalness, pauseFor, prepareSpokenText } from "../src/index.js";
import { fixtureByName, promptInjectionContext, qualityBenchmarkFixtures, renderTranscript } from "./quality-benchmark/fixtures.js";

const evaluateFixture = (fixture: typeof qualityBenchmarkFixtures[number]) => evaluatePodcastScriptData(fixture.utterances, { style: fixture.style, sourceTexts: fixture.sourceTexts });
const canonical = (value: unknown) => JSON.stringify(value);
function benchmark() { return { evaluatorVersion: "phase15-deterministic-v1", fixtures: qualityBenchmarkFixtures.map(fixture => ({ name: fixture.name, ...evaluateFixture(fixture) })) }; }
function writeBenchmark() {
  const report = benchmark(), output = "output/phase15";
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/podcast-quality-benchmark.json`, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(`${output}/podcast-quality-benchmark.md`, "| Fixture | Naturalness | Grounding | AI feel | Hard failures |\n|---|---:|---:|---:|---|\n" + report.fixtures.map(fixture => `| ${fixture.name} | ${fixture.naturalnessScore} | ${fixture.groundingScore} | ${fixture.aiFeelScore} | ${fixture.hardFailures.join(", ")} |`).join("\n") + "\n");
  writeFileSync(`${output}/good-transcript.txt`, renderTranscript(fixtureByName("01-natural-asymmetric-dialogue")));
  writeFileSync(`${output}/bad-transcript.txt`, renderTranscript(fixtureByName("02-perfect-ai-ping-pong")));
  return report;
}

describe("Phase 15 quality", () => {
  it("computes the canonical benchmark and writes self-consistent evidence", () => {
    const first = benchmark(), second = benchmark(); expect(canonical(first)).toBe(canonical(second));
    const written = writeBenchmark(), stored = JSON.parse(readFileSync("output/phase15/podcast-quality-benchmark.json", "utf8")); expect(stored).toEqual(written);
    for (const fixture of qualityBenchmarkFixtures) { const reported = stored.fixtures.find((item: { name: string }) => item.name === fixture.name); expect(reported).toEqual({ name: fixture.name, ...evaluateFixture(fixture) }); for (const warning of fixture.expectedWarnings ?? []) expect(reported.warnings).toContain(warning); for (const failure of fixture.expectedHardFailures ?? []) expect(reported.hardFailures).toContain(failure); }
    expect(qualityBenchmarkFixtures).toHaveLength(18); expect(renderTranscript(fixtureByName("01-natural-asymmetric-dialogue")).trim().split("\n")).toHaveLength(10); expect(renderTranscript(fixtureByName("02-perfect-ai-ping-pong")).trim().split("\n")).toHaveLength(10);
  });

  it("enforces real evaluator ranking and calculated quality floors", () => {
    const good = evaluateFixture(fixtureByName("01-natural-asymmetric-dialogue")), ping = evaluateFixture(fixtureByName("02-perfect-ai-ping-pong")), generic = evaluateFixture(fixtureByName("03-generic-agreement-heavy")), repetition = evaluateFixture(fixtureByName("06-repetitive-paraphrase")), followed = evaluateFixture(fixtureByName("14-challenge-with-followthrough")), abandoned = evaluateFixture(fixtureByName("15-abandoned-challenges"));
    expect(good.groundingScore).toBe(100); expect(good.fabricationBoundaryScore).toBe(100); expect(good.sourceCopyRiskScore).toBeGreaterThan(80); expect(good.naturalnessScore).toBeGreaterThanOrEqual(70); expect(good.hostDifferentiationScore).toBeGreaterThanOrEqual(45); expect(good.aiFeelScore).toBeGreaterThanOrEqual(70); expect(good.cognitiveValueScore).toBeGreaterThanOrEqual(70);
    expect(good.aiFeelScore).toBeGreaterThan(ping.aiFeelScore + 20); expect(good.naturalnessScore).toBeGreaterThan(generic.naturalnessScore + 20); expect(good.cognitiveValueScore).toBeGreaterThan(repetition.cognitiveValueScore); expect(followed.metrics.challengeFollowThroughRate).toBeGreaterThan(abandoned.metrics.challengeFollowThroughRate);
  });

  it("uses all hosts and respects style-aware callback and challenge behavior", () => {
    const three = evaluateFixture(fixtureByName("16-three-host-natural")), fakeCallback = evaluateFixture(fixtureByName("17-fake-callback")), realCallback = evaluateFixture(fixtureByName("01-natural-asymmetric-dialogue"));
    expect(Object.keys(three.metrics.speakerTurnShare)).toHaveLength(3); expect(Object.keys(three.metrics.questionRateByHost)).toHaveLength(3); expect(three.hostDifferentiationScore).toBeGreaterThan(0); expect(fakeCallback.metrics.callbackCoverage).toBeLessThan(realCallback.metrics.callbackCoverage);
    expect(evaluateNaturalness([{ speakerHostId: "a", text: "首先，边界需要说清。", utteranceType: "STATEMENT" }], { hostCount: 1, formality: 9 }).hostDifferentiationScore).toBe(100); expect(evaluateFixture(fixtureByName("09-natural-low-debate")).warnings).not.toContain("CHALLENGES_MISSING"); expect(evaluateFixture(fixtureByName("18-adversarial-random-fillers")).naturalnessScore).toBeLessThan(70);
  });

  it("preserves prompt security, duration contracts, and audio rhythm", () => {
    for (const stage of ["EPISODE_PLANNING", "NARRATIVE_DESIGN", "SEGMENT_OUTLINE", "SEGMENT_DRAFTING", "HUMANIZATION"] as const) expect(buildPodcastSystemInstruction(stage, { hosts: [] })).toMatch(/untrusted|Never fabricate/i);
    expect(buildPodcastSystemInstruction("SEGMENT_DRAFTING", { hosts: [], repairReasons: ["STRICT_ALTERNATION_HIGH"] })).toMatch(/asymmetry|grounding|STRICT_ALTERNATION_HIGH/i); expect(buildPodcastSystemInstruction("HUMANIZATION")).toMatch(/Do not change substantive claims/); expect(promptInjectionContext).toMatch(/Ignore previous instructions/); expect(buildPodcastSystemInstruction("EPISODE_PLANNING", { hosts: [] })).toMatch(/tension|question/i);
    expect(prepareSpokenText("[说明](https://x.test) <break/> AI").spokenText).toContain("A I"); const c = { defaultPauseMs: 420, shortReactionPauseMs: 120, interruptionPauseMs: 80 }; expect(pauseFor("REACTION", c).after).toBeLessThan(pauseFor("QUESTION", c).after); expect(pauseFor("TRANSITION", c).after).toBeGreaterThan(pauseFor("QUESTION", c).after);
  });
});
