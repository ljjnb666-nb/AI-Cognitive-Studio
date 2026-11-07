import { describe, expect, it } from "vitest";
import { assessProviderFailover, resolveProviderCatalog, type FailoverAssessmentInput } from "../src/index.js";

const manifest = resolveProviderCatalog(undefined);
const candidate = (providerKey: string, modelId: string, protocol = "OPENAI_COMPATIBLE") => ({
  source: "WORKSPACE" as const, providerKey, modelId, protocol: protocol as "OPENAI_COMPATIBLE",
  connectionId: "c-" + providerKey, credentialVersionId: "v-" + providerKey,
  configuration: {},
});
const chain = [
  candidate("zhipu", "glm-4.7-flashx"),
  candidate("minimax", "MiniMax-M3"),
  candidate("deepseek", "deepseek-v4-flash"),
];

function input(overrides: Partial<FailoverAssessmentInput> = {}): FailoverAssessmentInput {
  return {
    routeSlot: "BOOK_CHUNK_ANALYSIS",
    manifest,
    candidates: chain,
    currentCandidateIndex: 0,
    errorCode: "QUOTA_EXCEEDED",
    settledOutcome: "PROVIDER_CONFIRMED_UNBILLED",
    switchesUsed: 0,
    maxSwitches: 2,
    verified: {
      workspaceAuthority: true,
      sealedPlan: true,
      userEnabledFailover: true,
      priorInvocationTerminal: true,
      noActiveExecutionClaim: true,
      newPaidCallAuthorized: true,
      budgetAvailable: true,
    },
    ...overrides,
  };
}

describe("cross-workflow failover admission: fail closed by default", () => {
  it.each([
    ["userEnabledFailover", "NOT_ENABLED"],
    ["sealedPlan", "UNSEALED_PLAN"],
    ["workspaceAuthority", "UNSEALED_PLAN"],
    ["priorInvocationTerminal", "IN_FLIGHT"],
    ["noActiveExecutionClaim", "IN_FLIGHT"],
    ["newPaidCallAuthorized", "NO_PAID_CALL_AUTHORIZATION"],
    ["budgetAvailable", "BUDGET_EXHAUSTED"],
  ] as const)("holds unless server attests %s", (field, reason) => {
    const base = input();
    expect(assessProviderFailover(input({ verified: { ...base.verified, [field]: false } })))
      .toEqual({ action: "HOLD", reason });
  });

  it("does not bypass provider content moderation", () => {
    expect(assessProviderFailover(input({ errorCode: "CONTENT_REJECTED" })))
      .toEqual({ action: "HOLD", reason: "CONTENT_POLICY_REVIEW_REQUIRED" });
  });

  it.each(["CANCELLED", "BUDGET_EXCEEDED", "AUTHORIZATION_FAILED",
    "CREDENTIAL_REVOKED", "NETWORK_POLICY_REJECTED", "IDEMPOTENCY_CONFLICT"] as const)(
    "does not fallback after %s", errorCode => {
      expect(assessProviderFailover(input({ errorCode })))
        .toEqual({ action: "HOLD", reason: "UNSAFE_FAILURE_CLASS" });
    },
  );

  it.each(["QUOTA_EXCEEDED", "RATE_LIMITED", "CIRCUIT_OPEN", "TRANSIENT_UPSTREAM", "TIMEOUT"] as const)(
    "allows verified unbilled %s to next explicitly authorized text model", errorCode => {
      expect(assessProviderFailover(input({ errorCode }))).toEqual({
        action: "SWITCH", nextCandidateIndex: 1, candidate: chain[1],
      });
    },
  );

  it("never trusts an unrecognized billing state as evidence that no charge occurred", () => {
    expect(assessProviderFailover(input({ settledOutcome: "UNKNOWN_BUT_OK" as "NOT_SENT" })))
      .toEqual({ action: "HOLD", reason: "UNSAFE_FAILURE_CLASS" });
  });

  it("never treats a timeout with unknown remote charging as free", () => {
    expect(assessProviderFailover(input({ errorCode: "TIMEOUT", settledOutcome: "UNKNOWN" })))
      .toEqual({ action: "HOLD", reason: "UNKNOWN_BILLING" });
  });

  it.each(["OUTPUT_TRUNCATED", "INVALID_PROVIDER_RESPONSE"] as const)(
    "permits a separate, explicitly budgeted attempt after reconciled paid %s", errorCode => {
      expect(assessProviderFailover(input({ errorCode, settledOutcome: "PAID_AND_RECONCILED" })).action).toBe("SWITCH");
      expect(assessProviderFailover(input({ errorCode, settledOutcome: "PROVIDER_CONFIRMED_UNBILLED" })))
        .toEqual({ action: "HOLD", reason: "UNSAFE_FAILURE_CLASS" });
    },
  );

  it("cannot silently cycle models, extend the candidate chain, or exceed attempt ceiling", () => {
    expect(assessProviderFailover(input({ switchesUsed: -1 }))).toEqual({ action: "HOLD", reason: "ATTEMPT_LIMIT_REACHED" });
    expect(assessProviderFailover(input({ switchesUsed: 0, maxSwitches: 3 as 2 }))).toEqual({ action: "HOLD", reason: "ATTEMPT_LIMIT_REACHED" });
    expect(assessProviderFailover(input({ currentCandidateIndex: 1, candidates: [chain[0]!, chain[1]!, chain[0]!] })))
      .toEqual({ action: "HOLD", reason: "REPEATED_MODEL" });
    expect(assessProviderFailover(input({ currentCandidateIndex: 2 }))).toEqual({ action: "HOLD", reason: "NO_BACKUP" });
    expect(assessProviderFailover(input({ switchesUsed: 2 }))).toEqual({ action: "HOLD", reason: "ATTEMPT_LIMIT_REACHED" });
    expect(assessProviderFailover(input({ candidates: [chain[0]!, chain[0]!] })))
      .toEqual({ action: "HOLD", reason: "REPEATED_MODEL" });
    expect(assessProviderFailover(input({ candidates: [chain[0]!, { ...chain[1]!, credentialVersionId: undefined }] })))
      .toEqual({ action: "HOLD", reason: "UNPINNED_ROUTE" });
  });

  it.each(["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS",
    "PODCAST_SCRIPT", "SHORT_VIDEO_SCRIPT", "THINKING_SESSION"] as const)(
    "applies shared text policy to %s without changing the frozen caller's route", routeSlot => {
      const original = input({ routeSlot });
      expect(assessProviderFailover(original).action).toBe("SWITCH");
      expect(original.candidates[0]).toBe(chain[0]);
    },
  );

  it("Teach Back excludes JSON-mode providers without strict schema support", () => {
    expect(assessProviderFailover(input({ routeSlot: "TEACH_BACK_ASSESSMENT" })))
      .toEqual({ action: "HOLD", reason: "INCOMPATIBLE_CAPABILITY" });
  });

  it("Book semantic review requires independent model proof, not just a different route", () => {
    expect(assessProviderFailover(input({ routeSlot: "BOOK_SEMANTIC_REVIEW" })))
      .toEqual({ action: "HOLD", reason: "INDEPENDENT_REVIEW_REQUIRED" });
    const base = input({ routeSlot: "BOOK_SEMANTIC_REVIEW" });
    expect(assessProviderFailover({ ...base, verified: { ...base.verified, independentReviewer: true } }).action)
      .toBe("SWITCH");
  });

  it("never mixes embedding spaces by switching individual vectors", () => {
    expect(assessProviderFailover(input({ routeSlot: "EMBEDDING" })))
      .toEqual({ action: "HOLD", reason: "EMBEDDING_REINDEX_REQUIRED" });
  });

  it("requires independently validated TTS voice mapping for both speech routes", () => {
    for (const routeSlot of ["PODCAST_TTS", "SHORT_VIDEO_TTS"] as const) {
      expect(assessProviderFailover(input({ routeSlot })))
        .toEqual({ action: "HOLD", reason: "SPEECH_VOICE_MAPPING_REQUIRED" });
      const b = input({ routeSlot, candidates: [
        candidate("zhipu", "glm-tts", "CUSTOM_SPEECH"),
        candidate("openai", "gpt-4o-mini-tts", "CUSTOM_SPEECH"),
      ] });
      expect(assessProviderFailover({ ...b, verified: { ...b.verified, speechVoiceMapping: true } }).action)
        .toBe("SWITCH");
      const unsupported = input({ routeSlot, candidates: [chain[0]!, candidate("deepseek", "deepseek-v4-flash")] });
      expect(assessProviderFailover({ ...unsupported, verified: { ...unsupported.verified, speechVoiceMapping: true } }))
        .toEqual({ action: "HOLD", reason: "INCOMPATIBLE_CAPABILITY" });
    }
  });

  it("requires new external-image consent rather than reusing PDF vision authorization", () => {
    expect(assessProviderFailover(input({ routeSlot: "PDF_VISUAL_STRUCTURE" })))
      .toEqual({ action: "HOLD", reason: "VISION_PROVIDER_CONSENT_REQUIRED" });
  });

  it("does not skip an incompatible provider to try a third one without recorded lineage", () => {
    const bad = { ...chain[1]!, modelId: "imaginary-model" };
    expect(assessProviderFailover(input({ candidates: [chain[0]!, bad, chain[2]!] })))
      .toEqual({ action: "HOLD", reason: "INCOMPATIBLE_CAPABILITY" });
  });
});
