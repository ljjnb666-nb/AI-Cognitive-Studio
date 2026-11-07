import type { ProviderErrorCode } from "./errors.js";
import { routeSlotCapabilities, validateRouteManifestSelection, type ProviderModelManifest } from "./model-manifest.js";
import type { ResolvedRoute, RouteSlot } from "./types.js";

/**
 * Cross-workflow failover admission policy. This is a pure, fail-closed decision:
 * it does NOT create Provider invocations, change a persisted run's model,
 * replace an execution snapshot, or request paid resources.
 *
 * A durable owner must first seal/authorize the route chain, settle the previous
 * execution receipt, and create a distinct, lineage-linked retry invocation.
 */
export type SettledProviderOutcome =
  | "NOT_SENT"
  | "PROVIDER_CONFIRMED_UNBILLED"
  | "PAID_AND_RECONCILED"
  | "UNKNOWN";

export type FailoverHoldReason =
  | "NOT_ENABLED"
  | "UNSEALED_PLAN"
  | "UNAUTHORIZED_TARGET"
  | "IN_FLIGHT"
  | "UNKNOWN_BILLING"
  | "NO_PAID_CALL_AUTHORIZATION"
  | "BUDGET_EXHAUSTED"
  | "ATTEMPT_LIMIT_REACHED"
  | "NO_BACKUP"
  | "REPEATED_MODEL"
  | "UNPINNED_ROUTE"
  | "INCOMPATIBLE_CAPABILITY"
  | "UNSAFE_FAILURE_CLASS"
  | "CONTENT_POLICY_REVIEW_REQUIRED"
  | "EMBEDDING_REINDEX_REQUIRED"
  | "SPEECH_VOICE_MAPPING_REQUIRED"
  | "VISION_PROVIDER_CONSENT_REQUIRED"
  | "INDEPENDENT_REVIEW_REQUIRED";

export type FailoverCandidate = Pick<
  ResolvedRoute,
  "source" | "providerKey" | "protocol" | "modelId" | "connectionId" |
  "credentialVersionId" | "configuration"
>;

/**
 * Inputs named *verified* MUST originate from server-side DB/receipt gates.
 * Never derive these booleans from untrusted browser requests.
 */
export type FailoverAssessmentInput = {
  routeSlot: RouteSlot;
  manifest: ProviderModelManifest;
  /** Ordered candidates, frozen at task creation. No live route lookup here. */
  candidates: readonly FailoverCandidate[];
  currentCandidateIndex: number;
  errorCode: ProviderErrorCode;
  settledOutcome: SettledProviderOutcome;
  verified: {
    workspaceAuthority: boolean;
    sealedPlan: boolean;
    userEnabledFailover: boolean;
    priorInvocationTerminal: boolean;
    noActiveExecutionClaim: boolean;
    newPaidCallAuthorized: boolean;
    budgetAvailable: boolean;
    speechVoiceMapping?: boolean;
    /** Must attest backup reviewer differs from the original analysis model. */
    independentReviewer?: boolean;
  };
  /** Number of prior cross-provider/model switches; bounded and persisted by caller. */
  switchesUsed: number;
  /** Caller may allow 1-2; zero disables automatic switching. */
  maxSwitches: 0 | 1 | 2;
};

export type FailoverAssessment =
  | { action: "HOLD"; reason: FailoverHoldReason }
  | { action: "SWITCH"; nextCandidateIndex: number; candidate: FailoverCandidate };

/** Review/Gateway execution paths share the same explicit denial rules. */
const noAutomaticFallbackAfter = new Set<ProviderErrorCode>([
  "CONTENT_REJECTED",
  "CANCELLED",
  "BUDGET_EXCEEDED",
  "AUTHORIZATION_FAILED",
  "CREDENTIAL_REVOKED",
  "NETWORK_POLICY_REJECTED",
  "IDEMPOTENCY_CONFLICT",
  "PROVIDER_CONNECTION_CHANGED",
  "PROVIDER_CONNECTION_NAME_CONFLICT",
]);

const noChargeCandidateErrors = new Set<ProviderErrorCode>([
  "QUOTA_EXCEEDED", "RATE_LIMITED", "CIRCUIT_OPEN",
  "TRANSIENT_UPSTREAM", "TIMEOUT",
]);

const settledPaidCandidateErrors = new Set<ProviderErrorCode>([
  "OUTPUT_TRUNCATED", "INVALID_PROVIDER_RESPONSE",
]);

function hold(reason: FailoverHoldReason): FailoverAssessment { return { action: "HOLD", reason }; }

/**
 * All slots use the same admission rule. Vector cross-model switching requires
 * rebuilding the linked index, images require fresh per-provider consent, and
 * TTS requires an explicitly mapped voice. Those are NOT generic text routes.
 */
export function assessProviderFailover(input: FailoverAssessmentInput): FailoverAssessment {
  const { verified, candidates, currentCandidateIndex, routeSlot, errorCode } = input;
  if (!verified.userEnabledFailover || input.maxSwitches === 0) return hold("NOT_ENABLED");
  if (!verified.workspaceAuthority || !verified.sealedPlan) return hold("UNSEALED_PLAN");
  if (!verified.priorInvocationTerminal || !verified.noActiveExecutionClaim) return hold("IN_FLIGHT");
  if (errorCode === "CONTENT_REJECTED") return hold("CONTENT_POLICY_REVIEW_REQUIRED");
  if (noAutomaticFallbackAfter.has(errorCode)) return hold("UNSAFE_FAILURE_CLASS");
  if (input.settledOutcome === "UNKNOWN") return hold("UNKNOWN_BILLING");
  if (!verified.newPaidCallAuthorized) return hold("NO_PAID_CALL_AUTHORIZATION");
  if (!verified.budgetAvailable) return hold("BUDGET_EXHAUSTED");
  if (!Number.isSafeInteger(input.switchesUsed) || input.switchesUsed < 0 ||
      !Number.isSafeInteger(input.maxSwitches) || input.maxSwitches > 2 || input.maxSwitches < 0 ||
      input.switchesUsed >= input.maxSwitches) return hold("ATTEMPT_LIMIT_REACHED");
  if (!Number.isSafeInteger(currentCandidateIndex) || currentCandidateIndex < 0 ||
      currentCandidateIndex >= candidates.length - 1) return hold("NO_BACKUP");
  // The candidate chain advances exactly one step per recorded cross-model
  // switch. A divergent index/counter is an invalid recovery state, not a
  // license to reset the switch budget after a crash or queue redelivery.
  if (currentCandidateIndex !== input.switchesUsed) return hold("ATTEMPT_LIMIT_REACHED");

  const current = candidates[currentCandidateIndex];
  const candidate = candidates[currentCandidateIndex + 1];
  if (!candidate || !current) return hold("NO_BACKUP");
  if (candidates.slice(0, currentCandidateIndex + 1).some(prior =>
    prior.providerKey === candidate.providerKey && prior.modelId === candidate.modelId))
    return hold("REPEATED_MODEL");
  if (!candidate.connectionId || !candidate.credentialVersionId || candidate.source !== "WORKSPACE")
    return hold("UNPINNED_ROUTE");

  // Unknown remote outcomes can be charged. Even a known paid response must
  // be reconciled before issuing a separately authorized fallback invocation.
  const outcomeAllowed = input.settledOutcome === "PAID_AND_RECONCILED"
    ? settledPaidCandidateErrors.has(errorCode)
    : (input.settledOutcome === "NOT_SENT" || input.settledOutcome === "PROVIDER_CONFIRMED_UNBILLED")
      && noChargeCandidateErrors.has(errorCode);
  if (!outcomeAllowed) return hold("UNSAFE_FAILURE_CLASS");

  if (routeSlot === "EMBEDDING") return hold("EMBEDDING_REINDEX_REQUIRED");
  if (routeSlot === "PDF_VISUAL_STRUCTURE") return hold("VISION_PROVIDER_CONSENT_REQUIRED");
  if (routeSlot === "BOOK_SEMANTIC_REVIEW" && verified.independentReviewer !== true)
    return hold("INDEPENDENT_REVIEW_REQUIRED");
  if (routeSlotCapabilities[routeSlot] === "SPEECH" && verified.speechVoiceMapping !== true)
    return hold("SPEECH_VOICE_MAPPING_REQUIRED");

  try {
    const model = validateRouteManifestSelection(input.manifest, {
      routeSlot, providerKey: candidate.providerKey, protocol: candidate.protocol,
      modelId: candidate.modelId, configuration: candidate.configuration,
    });
    // These application stages parse structured JSON, not free-form text.
    if (["PODCAST_SCRIPT", "SHORT_VIDEO_SCRIPT", "THINKING_SESSION", "BOOK_SEMANTIC_REVIEW"].includes(routeSlot)
      && model.structuredOutput !== "JSON_MODE" && model.structuredOutput !== "STRICT_JSON_SCHEMA")
      return hold("INCOMPATIBLE_CAPABILITY");
  } catch {
    return hold("INCOMPATIBLE_CAPABILITY");
  }
  return { action: "SWITCH", nextCandidateIndex: currentCandidateIndex + 1, candidate };
}
