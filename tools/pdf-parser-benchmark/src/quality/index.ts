import type { NormalizedOutput } from "../schema.js";
import { loadGroundTruth, type GroundTruth } from "../ground-truth.js";
import { evaluateQuality, type EvaluateInput } from "./evaluate.js";
import { parseQualityReport, type OcrMetadata, type QualityReport } from "./schema.js";

export { parseQualityReport, type QualityReport, type OcrMetadata } from "./schema.js";
export { evaluateQuality, type EvaluateInput } from "./evaluate.js";

export type QualityEvaluationContext = {
  runId: string;
  fixtureId: string;
  parserKey: string;
  parserMode: string;
  normalized: NormalizedOutput | null;
  ocrMetadata: OcrMetadata | null;
  /** Injected for tests; production loads the fixture sidecar from D:. */
  loadGroundTruthFn?: typeof loadGroundTruth;
  evaluateFn?: typeof evaluateQuality;
};

/**
 * Run-scoped quality evaluation with explicit failure semantics (spec #16):
 * a missing ground truth is "not measurable", an invalid sidecar is never
 * silently scored, and an evaluator crash becomes QUALITY_EVALUATION_FAILED —
 * it can never corrupt or replace the parser run evidence.
 */
export async function runQualityEvaluation(context: QualityEvaluationContext): Promise<QualityReport> {
  const base = {
    evaluatorVersion: "pdf-quality-eval-v2" as const,
    runId: context.runId,
    fixtureId: context.fixtureId,
    parserKey: context.parserKey,
    parserMode: context.parserMode,
    error: null,
    text: null,
    readingOrder: null,
    structure: null,
    pages: null,
    table: null,
    formula: null,
    ocr: null,
    contamination: null,
  };

  if (!context.normalized) {
    return { ...base, status: "SKIPPED_NO_NORMALIZED_OUTPUT", evaluatedAt: new Date().toISOString() };
  }

  const loader = context.loadGroundTruthFn ?? loadGroundTruth;
  let groundTruth: GroundTruth | null = null;
  try {
    const loaded = await loader(context.fixtureId);
    if (loaded.status === "MISSING") {
      return { ...base, status: "SKIPPED_GROUND_TRUTH_MISSING", evaluatedAt: new Date().toISOString() };
    }
    if (loaded.status === "INVALID") {
      return { ...base, status: "SKIPPED_GROUND_TRUTH_INVALID", error: loaded.error, evaluatedAt: new Date().toISOString() };
    }
    groundTruth = loaded.groundTruth;
  } catch (error) {
    return {
      ...base,
      status: "SKIPPED_GROUND_TRUTH_INVALID",
      error: error instanceof Error ? error.message : String(error),
      evaluatedAt: new Date().toISOString(),
    };
  }

  try {
    const evaluate = context.evaluateFn ?? evaluateQuality;
    const report = evaluate({
      runId: context.runId,
      fixtureId: context.fixtureId,
      parserKey: context.parserKey,
      parserMode: context.parserMode,
      groundTruth: groundTruth!,
      normalized: context.normalized,
      ocrMetadata: context.ocrMetadata,
    });
    return parseQualityReport(report);
  } catch (error) {
    return {
      ...base,
      status: "QUALITY_EVALUATION_FAILED",
      error: error instanceof Error ? error.message : String(error),
      evaluatedAt: new Date().toISOString(),
    };
  }
}
