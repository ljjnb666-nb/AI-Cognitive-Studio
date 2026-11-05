/** One identity policy for browser requests and durable bootstrap recovery. */
export function resolveBookAnalysisVersions(source: NodeJS.ProcessEnv = process.env) {
  return {
    pipelineVersion: source.BOOK_ANALYSIS_PIPELINE_VERSION?.trim() || "product-v2-evidence",
    promptVersion: source.BOOK_ANALYSIS_PROMPT_VERSION?.trim() || "product-v2-evidence",
  };
}
