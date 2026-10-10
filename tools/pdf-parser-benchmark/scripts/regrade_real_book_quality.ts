/** Manual-only private GT gate; NEVER parse or print real books here. */
import { regradePrivateNativeEvidence, writePrivateQualityReport } from "../src/real-book-quality-gate.js";

async function main(): Promise<void> {
  try {
    const result = await regradePrivateNativeEvidence();
    await writePrivateQualityReport(result);
    const summary = {
      policy: "ACS_REAL_BOOK_QUALITY_V1",
      source_github_run: result.sourceGithubRun,
      status: result.qualityStatus,
      ground_truth_review: result.groundTruthStatus,
      evaluator: result.evaluatorVersion,
      planned: result.planned,
      evaluated: result.evaluated,
      expected_capability_rejections: result.expectedCapabilityRejections,
      parser_ranking: "NOT_AUTHORIZED",
      numeric_quality_scores_published: false,
      private_report_local_only: true,
    };
    process.stdout.write("ACS_PDF_QUALITY_SUMMARY=" + JSON.stringify(summary) + "\n");
    process.stdout.write("ACS_PDF_QUALITY_EVIDENCE_READY\n");
  } catch {
    // Private GT/paths/text/errors may be in the underlying exception.
    process.stdout.write("ACS_PDF_QUALITY_GATE_BLOCKED\n");
    process.exitCode = 2;
  }
}
void main();
