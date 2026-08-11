export type EvaluationUtterance = { speakerHostId: string; text: string; utteranceType: string; substantive?: boolean; evidenceCount?: number };
const agreementPhrases = ["你说得非常对", "你说得对", "确实如此", "没错", "这个观点非常有意思", "这是一个非常重要的问题"];
const transitionPhrases = ["总的来说", "综上所述", "接下来让我们", "首先", "其次", "最后"];
const summaryPhrases = ["总而言之", "归根结底", "简单总结一下", "总结一下"];
const biographyPatterns = [/我去年.{0,12}(创业|工作|经历)/u, /我朋友.{0,12}(正好|曾经|就是)/u, /I once worked at/iu, /when I worked at/iu];

const occurrences = (text: string, phrases: string[]) => phrases.reduce((sum, phrase) => sum + Math.max(0, text.split(phrase).length - 1), 0);
const words = (text: string) => text.toLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? [];
const variance = (values: number[]) => { if (!values.length) return 0; const mean = values.reduce((a, b) => a + b, 0) / values.length; return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length; };
const jaccard = (a: Set<string>, b: Set<string>) => { const union = new Set([...a, ...b]); if (!union.size) return 1; return [...a].filter((item) => b.has(item)).length / union.size; };
const clamp = (value: number) => Math.max(0, Math.min(100, value));

export function evaluateNaturalness(utterances: EvaluationUtterance[]) {
  const total = Math.max(1, utterances.length), text = utterances.map((item) => item.text).join("\n");
  const byHost = new Map<string, EvaluationUtterance[]>();
  for (const item of utterances) byHost.set(item.speakerHostId, [...(byHost.get(item.speakerHostId) ?? []), item]);
  const speakerTurnShare = Object.fromEntries([...byHost].map(([host, turns]) => [host, turns.length / total]));
  const averageTurnLengthByHost = Object.fromEntries([...byHost].map(([host, turns]) => [host, turns.reduce((sum, item) => sum + item.text.length, 0) / turns.length]));
  const questionRateByHost = Object.fromEntries([...byHost].map(([host, turns]) => [host, turns.filter((item) => item.utteranceType === "QUESTION").length / turns.length]));
  const reactionRateByHost = Object.fromEntries([...byHost].map(([host, turns]) => [host, turns.filter((item) => item.utteranceType === "REACTION").length / turns.length]));
  const challengeRateByHost = Object.fromEntries([...byHost].map(([host, turns]) => [host, turns.filter((item) => item.utteranceType === "CHALLENGE").length / turns.length]));
  const hostSets = [...byHost.values()].map((turns) => new Set(turns.flatMap((item) => words(item.text))));
  const hostLexicalSimilarity = hostSets.length >= 2 ? jaccard(hostSets[0]!, hostSets[1]!) : 1;
  const lengths = utterances.map((item) => item.text.length);
  const repeatedNgrams = new Map<string, number>();
  for (const item of utterances) { const tokens = words(item.text); for (let i = 0; i + 2 < tokens.length; i++) { const gram = tokens.slice(i, i + 3).join("|"); repeatedNgrams.set(gram, (repeatedNgrams.get(gram) ?? 0) + 1); } }
  const repetitiveNGramRate = [...repeatedNgrams.values()].filter((count) => count > 1).length / Math.max(1, repeatedNgrams.size);
  const agreementPhraseFrequency = occurrences(text, agreementPhrases) / total;
  const transitionPhraseFrequency = occurrences(text, transitionPhrases) / total;
  const summaryPhraseDensity = occurrences(text, summaryPhrases) / total;
  const distributionDifference = byHost.size >= 2 ? Math.abs(Object.values(averageTurnLengthByHost)[0]! - Object.values(averageTurnLengthByHost)[1]!) / Math.max(1, ...Object.values(averageTurnLengthByHost)) : 0;
  const hostDifferentiationScore = clamp(100 * (0.45 * (1 - hostLexicalSimilarity) + 0.3 * Math.min(1, distributionDifference * 2) + 0.25 * Math.min(1, Math.max(...Object.values(questionRateByHost), ...Object.values(reactionRateByHost), ...Object.values(challengeRateByHost)) * 3)));
  const aiPenalty = agreementPhraseFrequency * 42 + transitionPhraseFrequency * 25 + summaryPhraseDensity * 20 + repetitiveNGramRate * 30;
  const naturalnessScore = clamp(88 - aiPenalty + Math.min(10, Math.sqrt(variance(lengths)) / 3) + hostDifferentiationScore * 0.12);
  return { naturalnessScore, hostDifferentiationScore, metrics: { speakerTurnShare, averageTurnLengthByHost, turnLengthVariance: variance(lengths), agreementPhraseFrequency, transitionPhraseFrequency, questionRateByHost, reactionRateByHost, challengeRateByHost, sentenceLengthVariance: variance(text.split(/[。！？.!?]/).filter(Boolean).map((part) => part.length)), hostLexicalSimilarity, summaryPhraseDensity, repetitiveNGramRate }, warnings: [agreementPhraseFrequency > 0.15 ? "GENERIC_AGREEMENT_DENSITY" : null, transitionPhraseFrequency > 0.2 ? "FORMAL_TRANSITION_DENSITY" : null, hostDifferentiationScore < 35 ? "HOSTS_TOO_SIMILAR" : null, variance(lengths) < 25 ? "TURN_LENGTHS_TOO_SYMMETRIC" : null].filter((item): item is string => !!item) };
}

export function evaluatePodcastScriptData(utterances: EvaluationUtterance[], options: { sourceTexts?: string[]; contextWithinBudget?: boolean } = {}) {
  const natural = evaluateNaturalness(utterances);
  const substantive = utterances.filter((item) => item.substantive);
  const grounded = substantive.filter((item) => (item.evidenceCount ?? 0) > 0);
  const groundingScore = substantive.length ? grounded.length / substantive.length * 100 : 100;
  const fabricated = utterances.filter((item) => biographyPatterns.some((pattern) => pattern.test(item.text)));
  const sourceTexts = options.sourceTexts ?? [];
  const copied = utterances.filter((item) => sourceTexts.some((source) => item.text.length >= 120 && source.includes(item.text))).length;
  const sourceCopyRiskScore = clamp(100 - copied * 35);
  const hardFailures = [groundingScore < 100 ? "UNSUPPORTED_SUBSTANTIVE_CLAIM" : null, fabricated.length ? "FABRICATED_BIOGRAPHY" : null, options.contextWithinBudget === false ? "CONTEXT_BUDGET_VIOLATION" : null].filter((item): item is string => !!item);
  return { naturalnessScore: natural.naturalnessScore, groundingScore, hostDifferentiationScore: natural.hostDifferentiationScore, cognitiveValueScore: 80, structuralCoherenceScore: 80, repetitionScore: clamp(100 - natural.metrics.repetitiveNGramRate * 100), aiFeelScore: clamp(natural.naturalnessScore - natural.metrics.agreementPhraseFrequency * 20), sourceCopyRiskScore, contextBudgetScore: options.contextWithinBudget === false ? 0 : 100, fabricationBoundaryScore: fabricated.length ? 0 : 100, metrics: natural.metrics, hardFailures, warnings: natural.warnings };
}
