import { mkdirSync, writeFileSync } from "node:fs";
import { BETA_CONSENT_VERSION, CLIENT_EVENT_NAMES, computeClosedBetaMetrics, EVENT_TAXONOMY_VERSION, METRICS_VERSION, PHASE17_SYNTHETIC_AS_OF, PHASE17_SYNTHETIC_PARTICIPANT_COUNT, seedSyntheticClosedBetaCohort } from "../packages/product-analytics/src/index.ts";

async function main() {
  const gitSha = process.env.PHASE17_ARTIFACT_GIT_SHA ?? process.env.GITHUB_SHA ?? "LOCAL_UNBOUND";
  const asOf = process.env.PHASE17_METRICS_AS_OF ? new Date(process.env.PHASE17_METRICS_AS_OF) : PHASE17_SYNTHETIC_AS_OF;
  if (Number.isNaN(asOf.getTime())) throw new Error("PHASE17_METRICS_AS_OF_INVALID");
  const fixture = await seedSyntheticClosedBetaCohort(asOf);
  if (fixture.participantCount !== PHASE17_SYNTHETIC_PARTICIPANT_COUNT) throw new Error("PHASE17_SYNTHETIC_COHORT_SIZE_INVALID");
  const metrics = await computeClosedBetaMetrics(asOf);
  const assertions = [
    fixture.participantCount === 18, metrics.activatedParticipants > 0,
    metrics.activationWithin24hEligible > 0, metrics.activationWithin24hCount <= metrics.activationWithin24hEligible,
    metrics.d1.eligible > 0, metrics.d7.eligible > 0, metrics.meaningfulD1.eligible > 0, metrics.meaningfulD7.eligible > 0,
    metrics.podcast.startedPairs > 0, metrics.podcast.completedPairs > 0, metrics.cognition.saveUsers > 0,
    metrics.thinking.completedUsers > 0, metrics.teachBack.assessedUsers > 0,
    metrics.podcast.naturalness.sampleCount > 0, metrics.podcast.value.sampleCount > 0,
    metrics.timeToActivationMilliseconds.negativeCount === 0,
  ];
  if (assertions.some((value) => !value)) throw new Error("PHASE17_ARTIFACT_RELEASE_ASSERTION_FAILED");
  const header = { gitSha, metricsVersion: METRICS_VERSION, eventTaxonomyVersion: EVENT_TAXONOMY_VERSION, consentVersion: BETA_CONSENT_VERSION, fixtureType: "SYNTHETIC_COHORT", participantCount: PHASE17_SYNTHETIC_PARTICIPANT_COUNT, asOf: asOf.toISOString(), notRealUserData: true };
  const privacyContract = { version: BETA_CONSENT_VERSION, storage: "first-party PostgreSQL only", eventProperties: "strict allowlist; 2 KiB maximum", inviteTokens: "SHA-256 digest only; raw code is response-only", withdrawal: "ProductEvent and BetaFeedback deleted; core product data retained" };
  const eventTaxonomy = { version: EVENT_TAXONOMY_VERSION, events: CLIENT_EVENT_NAMES.map((eventName) => ({ eventName, entityRequired: eventName.startsWith("PODCAST_PLAYBACK_"), entityType: eventName.startsWith("PODCAST_PLAYBACK_") ? "PODCAST_AUDIO_REVISION" : null })) };
  mkdirSync("output/phase17", { recursive: true });
  writeFileSync("output/phase17/closed-beta-metrics.json", `${JSON.stringify({ ...header, metrics }, null, 2)}\n`);
  writeFileSync("output/phase17/closed-beta-metrics.md", `# Phase 17 Closed Beta Metrics\n\n- Git SHA: ${gitSha}\n- Fixture: SYNTHETIC_COHORT (${PHASE17_SYNTHETIC_PARTICIPANT_COUNT} participants)\n- As of: ${metrics.asOf}\n- Enrolled / activated: ${metrics.enrolledParticipants} / ${metrics.activatedParticipants}\n- Activation within 24h: ${metrics.activationWithin24hCount}/${metrics.activationWithin24hEligible}\n- D1 / meaningful D1: ${metrics.d1.retained}/${metrics.d1.eligible} / ${metrics.meaningfulD1.retained}/${metrics.meaningfulD1.eligible}\n- D7 / meaningful D7: ${metrics.d7.retained}/${metrics.d7.eligible} / ${metrics.meaningfulD7.retained}/${metrics.meaningfulD7.eligible}\n\nThis is deterministic synthetic-cohort evidence, never real-user data.\n`);
  writeFileSync("output/phase17/event-taxonomy.json", `${JSON.stringify({ ...header, eventTaxonomy }, null, 2)}\n`);
  writeFileSync("output/phase17/privacy-contract.json", `${JSON.stringify({ ...header, privacyContract }, null, 2)}\n`);
}

void main();
