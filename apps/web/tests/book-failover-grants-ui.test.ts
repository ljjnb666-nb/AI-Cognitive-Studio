import { describe, expect, it } from "vitest";
import {
  prepareBookBackupConsent,
  type BookBackupOperation,
} from "../components/book-failover-grants";

const operation: BookBackupOperation = {
  analysisRunId: "clx-test-run-001",
  routeSlot: "BOOK_CHUNK_ANALYSIS",
  operationHash: "a".repeat(64),
  planHash: "b".repeat(64),
  expectedRevision: 3,
  lastFailureCode: "PROVIDER_RATE_LIMIT",
  holdReason: "AWAITING_MANUAL_REVIEW",
  settledOutcome: "NOT_SENT",
  updatedAt: "2026-11-15T00:00:00Z",
};

describe("Book backup one-call consent UI safety", () => {
  it("cannot create a signed request without an explicitly selected operation and checkbox", () => {
    expect(prepareBookBackupConsent(null, "5000", "15", true)).toBeNull();
    expect(prepareBookBackupConsent(operation, "5000", "15", false)).toBeNull();
  });

  it("requires a manually entered safe integer resource cap and bounded TTL", () => {
    for (const units of ["", "0", "-1", "2.5", "1e4", " 5000", "1000001", "9007199254740992"]) {
      expect(prepareBookBackupConsent(operation, units, "15", true)).toBeNull();
    }
    for (const minutes of ["0", "-1", "61", "2.5", "1e2", ""]) {
      expect(prepareBookBackupConsent(operation, "5000", minutes, true)).toBeNull();
    }
  });

  it("builds only an operation- and revision-bound one-call authorization, never an execution request", () => {
    expect(prepareBookBackupConsent(operation, "5000", "15", true)).toEqual({
      analysisRunId: operation.analysisRunId,
      routeSlot: operation.routeSlot,
      operationHash: operation.operationHash,
      planHash: operation.planHash,
      expectedRevision: operation.expectedRevision,
      maxAdditionalUnits: 5000,
      expiresInMinutes: 15,
      approval: "AUTHORIZE_ONE_ADDITIONAL_MODEL_CALL",
    });
  });
});
