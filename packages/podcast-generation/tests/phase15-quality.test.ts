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
    expect(qualityBenchmarkFixtures).toHaveLength(19); expect(renderTranscript(fixtureByName("01-natural-asymmetric-dialogue")).trim().split("\n")).toHaveLength(10); expect(renderTranscript(fixtureByName("02-perfect-ai-ping-pong")).trim().split("\n")).toHaveLength(10);
  });

  it("enforces real evaluator ranking and calculated quality floors", () => {
    const good = evaluateFixture(fixtureByName("01-natural-asymmetric-dialogue")), ping = evaluateFixture(fixtureByName("02-perfect-ai-ping-pong")), generic = evaluateFixture(fixtureByName("03-generic-agreement-heavy")), repetition = evaluateFixture(fixtureByName("06-repetitive-paraphrase")), followed = evaluateFixture(fixtureByName("14-challenge-with-followthrough")), abandoned = evaluateFixture(fixtureByName("15-abandoned-challenges"));
    expect(good.groundingScore).toBe(100); expect(good.fabricationBoundaryScore).toBe(100); expect(good.sourceCopyRiskScore).toBeGreaterThan(80); expect(good.naturalnessScore).toBeGreaterThanOrEqual(70); expect(good.hostDifferentiationScore).toBeGreaterThanOrEqual(45); expect(good.aiFeelScore).toBeGreaterThanOrEqual(70); expect(good.cognitiveValueScore).toBeGreaterThanOrEqual(70);
    expect(good.aiFeelScore).toBeGreaterThan(ping.aiFeelScore + 20); expect(good.naturalnessScore).toBeGreaterThan(generic.naturalnessScore + 20); expect(good.cognitiveValueScore).toBeGreaterThan(repetition.cognitiveValueScore); expect(followed.metrics.challengeFollowThroughRate).toBeGreaterThan(abandoned.metrics.challengeFollowThroughRate);
  });

  it("uses all hosts and respects style-aware callback and challenge behavior", () => {
    const three = evaluateFixture(fixtureByName("16-three-host-natural")), fakeCallback = evaluateFixture(fixtureByName("17-fake-callback")), realCallback = evaluateFixture(fixtureByName("01-natural-asymmetric-dialogue"));
    expect(Object.keys(three.metrics.speakerTurnShare)).toHaveLength(3); expect(Object.keys(three.metrics.questionRateByHost)).toHaveLength(3); expect(three.hostDifferentiationScore).toBeGreaterThan(0); expect(fakeCallback.metrics.callbackCoverage).toBeLessThan(realCallback.metrics.callbackCoverage);
    const threeHostFixture = fixtureByName("16-three-host-natural");
    const changedHostC = evaluatePodcastScriptData(threeHostFixture.utterances.map(item => item.speakerHostId === "c" ? { ...item, text: "可是证据真的支持这个结论吗？", utteranceType: "QUESTION" as const, substantive: false, evidenceCount: 0 } : item), { style: threeHostFixture.style });
    expect(changedHostC.metrics.speakerTurnShare.c).toBe(three.metrics.speakerTurnShare.c); expect(changedHostC.metrics.questionRateByHost.c).not.toBe(three.metrics.questionRateByHost.c); expect(changedHostC.hostDifferentiationScore).not.toBe(three.hostDifferentiationScore);
    const shortAbab = Array.from({ length: 4 }, (_, i) => ({ speakerHostId: i % 2 ? "b" : "a", text: `自然回合${i}`, utteranceType: "STATEMENT" })), longAbab = Array.from({ length: 10 }, (_, i) => ({ speakerHostId: i % 2 ? "b" : "a", text: `机械回合${i}`, utteranceType: "STATEMENT" })), cycle = evaluateFixture(fixtureByName("19-three-host-mechanical-cycle"));
    expect(evaluateNaturalness(shortAbab, { hostCount: 2 }).metrics.strictAlternationRate).toBe(0); expect(evaluateNaturalness(shortAbab, { hostCount: 2 }).warnings).not.toContain("STRICT_ALTERNATION_HIGH"); expect(evaluateNaturalness(longAbab, { hostCount: 2 }).warnings).toContain("STRICT_ALTERNATION_HIGH"); expect(cycle.metrics.cyclicSpeakerPatternRate).toBeGreaterThan(.7); expect(cycle.naturalnessScore).toBeLessThan(three.naturalnessScore);
    expect(evaluateNaturalness([{ speakerHostId: "a", text: "首先，边界需要说清。", utteranceType: "STATEMENT" }], { hostCount: 1, formality: 9 }).hostDifferentiationScore).toBe(100); expect(evaluateFixture(fixtureByName("09-natural-low-debate")).warnings).not.toContain("CHALLENGES_MISSING"); expect(evaluateFixture(fixtureByName("18-adversarial-random-fillers")).naturalnessScore).toBeLessThan(70);
  });

  it("preserves prompt security, explicit duration contracts, style thresholds, and audio rhythm", () => {
    for (const stage of ["EPISODE_PLANNING", "NARRATIVE_DESIGN", "SEGMENT_OUTLINE", "SEGMENT_DRAFTING", "HUMANIZATION"] as const) expect(buildPodcastSystemInstruction(stage, { hosts: [] })).toMatch(/untrusted|Never fabricate/i);
    expect(buildPodcastSystemInstruction("SEGMENT_DRAFTING", { hosts: [], repairReasons: ["STRICT_ALTERNATION_HIGH"] })).toMatch(/asymmetry|grounding|STRICT_ALTERNATION_HIGH/i); expect(buildPodcastSystemInstruction("HUMANIZATION")).toMatch(/Do not change substantive claims/); expect(promptInjectionContext).toMatch(/Ignore previous instructions/); expect(buildPodcastSystemInstruction("EPISODE_PLANNING", { hosts: [] })).toMatch(/tension|question/i);
    expect(buildPodcastSystemInstruction("SEGMENT_OUTLINE", { targetDurationMinutes: 15 })).toMatch(/15 minutes.*narrow coherent thesis.*fewer primary concepts/i); expect(buildPodcastSystemInstruction("SEGMENT_OUTLINE", { targetDurationMinutes: 30 })).toMatch(/30 minutes.*normal depth/i); expect(buildPodcastSystemInstruction("SEGMENT_OUTLINE", { targetDurationMinutes: 60 })).toMatch(/60 minutes.*greater conceptual.*never repeated recap/i);
    const recap = Array.from({ length: 4 }, (_, i) => ({ speakerHostId: "a", text: i < 2 ? `首先，总结一下，当前边界是第${i}点。` : `总结一下，当前边界是第${i}点。`, utteranceType: "STATEMENT" })), lowFormality = evaluateNaturalness(recap, { formality: 3, summaryDensity: 3 }), highFormality = evaluateNaturalness(recap, { formality: 9, summaryDensity: 3 }), highSummary = evaluateNaturalness(recap, { formality: 3, summaryDensity: 9 });
    expect(lowFormality.warnings).toContain("FORMAL_TRANSITION_DENSITY"); expect(highFormality.warnings).not.toContain("FORMAL_TRANSITION_DENSITY"); expect(highSummary.naturalnessScore).toBe(lowFormality.naturalnessScore); expect(lowFormality.warnings).toContain("SUMMARY_DENSITY_HIGH");
    const spoken = prepareSpokenText("[说明](https://x.test) <break/> AI").spokenText; expect(spoken).toContain("说明"); expect(spoken).toContain("A I"); expect(spoken).not.toMatch(/[<>]|break/i); expect(prepareSpokenText("<speak>你好</speak>").spokenText).toBe("你好");
    for (const markup of ["&lt;break/&gt;", "&lt;break time=\"500ms\"/&gt;", "&amp;lt;break/&amp;gt;", "&amp;lt;break time=&amp;quot;500ms&amp;quot;/&amp;gt;", "&amp;lt;break time=&amp;apos;1s&amp;apos;/&amp;gt;"]) expect(prepareSpokenText(`[说明](https://x.test) ${markup} AI`).spokenText).toBe("说明 A I");
    const encodedSpeak = prepareSpokenText("&amp;lt;speak&amp;gt;你好&amp;lt;/speak&amp;gt;").spokenText; expect(encodedSpeak).toBe("你好"); expect(encodedSpeak).not.toMatch(/break|speak|&(?:amp;)?(?:lt|gt|quot|apos);/i); expect(prepareSpokenText("2 &lt; 3").spokenText).toBe("2 &lt; 3"); const c = { defaultPauseMs: 420, shortReactionPauseMs: 120, interruptionPauseMs: 80 }; expect(pauseFor("REACTION", c).after).toBeLessThan(pauseFor("QUESTION", c).after); expect(pauseFor("TRANSITION", c).after).toBeGreaterThan(pauseFor("QUESTION", c).after);
  });
});
