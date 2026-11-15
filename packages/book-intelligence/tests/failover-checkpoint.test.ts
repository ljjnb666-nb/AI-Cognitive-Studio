import { describe, expect, it } from "vitest";
import { classifyBookFailoverEvidence } from "../src/failover-checkpoint.js";

describe("Book fallback billing evidence never guesses that remote work was free", () => {
  it("labels a missing durable invocation NOT_SENT, never eligible for automatic charging", () => {
    expect(classifyBookFailoverEvidence("QUOTA_EXCEEDED", null)).toEqual({
      settledOutcome: "NOT_SENT",
      holdReason: "NOT_ENABLED",
      invocationId: null,
      attemptId: null,
    });
  });

  it.each(["REMOTE_FAILURE", "TIMEOUT", "REMOTE_OUTCOME_UNKNOWN", "SUCCEEDED"] as const)(
    "treats a persisted %s remote attempt as potentially billable",
    (status) => {
      expect(classifyBookFailoverEvidence("TIMEOUT", {
        id: "inv-one", providerKey: "test", modelId: "model",
        routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: "connection", credentialVersionId: "credential",
        attempts: [{ id: "attempt-one", status }],
      })).toEqual({
        settledOutcome: "UNKNOWN", holdReason: "UNKNOWN_BILLING",
        invocationId: "inv-one", attemptId: "attempt-one",
      });
    },
  );

  it("content rejection stays blocked even when no remote invocation was recorded", () => {
    const observed = classifyBookFailoverEvidence("CONTENT_REJECTED", null);
    expect(observed).toMatchObject({
      settledOutcome: "NOT_SENT",
      holdReason: "CONTENT_POLICY_REVIEW_REQUIRED",
    });
  });

  it("an invocation without a started remote attempt remains NOT_SENT", () => {
    const observed = classifyBookFailoverEvidence("RATE_LIMITED", {
      id: "preflight-claim", providerKey: "test", modelId: "model",
      routeSlot: "BOOK_CHUNK_ANALYSIS", connectionId: "connection", credentialVersionId: "credential",
      attempts: [],
    });
    expect(observed).toMatchObject({
      settledOutcome: "NOT_SENT", holdReason: "NOT_ENABLED",
      invocationId: "preflight-claim", attemptId: null,
    });
  });
});
