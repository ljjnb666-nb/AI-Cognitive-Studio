import { mkdirSync, writeFileSync } from "node:fs";
// This script runs from the repository root, which intentionally has no
// runtime dependency on the package. Resolve through the workspace source so
// pnpm's strict root dependency graph remains intact.
import { computeClosedBetaMetrics, EVENT_TAXONOMY_VERSION, METRICS_VERSION } from "../packages/product-analytics/src/index.ts";

async function main() {
const expectedGitSha = process.env.PHASE17_ARTIFACT_GIT_SHA ?? process.env.GITHUB_SHA ?? "LOCAL_UNBOUND";
const asOf = process.env.PHASE17_METRICS_AS_OF ? new Date(process.env.PHASE17_METRICS_AS_OF) : new Date();
if (Number.isNaN(asOf.getTime())) throw new Error("PHASE17_METRICS_AS_OF_INVALID");
const metrics = await computeClosedBetaMetrics(asOf);
const artifact = {
  artifactVersion: "phase17-closed-beta-artifact-v1",
  generatedAt: new Date().toISOString(),
  artifactGitSha: expectedGitSha,
  metricsVersion: METRICS_VERSION,
  eventTaxonomyVersion: EVENT_TAXONOMY_VERSION,
  privacyContract: {
    storage: "first-party PostgreSQL only",
    eventProperties: "strict allowlist; 2 KiB maximum",
    inviteTokens: "SHA-256 digest only; raw code is response-only",
    withdrawal: "ProductEvent and BetaFeedback deleted; core product data retained",
  },
  metrics,
};
mkdirSync("output/phase17", { recursive: true });
writeFileSync("output/phase17/closed-beta-metrics.json", `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync("output/phase17/closed-beta-metrics.md", `# Phase 17 Closed Beta Metrics\n\n- Artifact SHA: ${expectedGitSha}\n- Metrics version: ${METRICS_VERSION}\n- Taxonomy version: ${EVENT_TAXONOMY_VERSION}\n- As of: ${metrics.asOf}\n- Enrolled / activated: ${metrics.enrolledParticipants} / ${metrics.activatedParticipants}\n- D1: ${metrics.d1.retained}/${metrics.d1.eligible}\n- D7: ${metrics.d7.retained}/${metrics.d7.eligible}\n\nThis artifact reports real database rows at an explicit cutoff. Empty or small denominators are evidence of insufficient sample, not success.\n`);
}

void main();
