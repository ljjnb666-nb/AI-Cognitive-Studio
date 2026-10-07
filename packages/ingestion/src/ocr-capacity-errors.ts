import type { OcrCapacityDeferralInput } from "./ingestion-run-claim.js";

/**
 * RF05 P1-02: the TWO distinct OCR capacity-deferral states.
 *
 * OcrCapacityDeferralError — PRE-COMMIT. Carries the durable claim identity
 * and may only travel pdf-run → ingestion service, where the ONE atomic
 * PostgreSQL deferral transaction runs. The worker MUST NOT recognize this
 * type: no durable deferral has committed yet, so deferring in Redis would
 * violate "PostgreSQL first, Redis second".
 *
 * OcrCapacityDeferredError — POST-COMMIT scheduler signal. Created ONLY after
 * transitionOcrCapacityDeferred(...) returned true (the page/run/Job budget
 * restoration committed). The worker recognizes ONLY this type and defers the
 * BullMQ delivery for it. It is never derived from message text or error
 * codes.
 */

export class OcrCapacityDeferralError extends Error {
  readonly deferral: OcrCapacityDeferralInput;
  constructor(deferral: OcrCapacityDeferralInput) {
    super("SOURCE_OCR_HOST_CAPACITY");
    this.name = "OcrCapacityDeferralError";
    this.deferral = deferral;
  }
}

export class OcrCapacityDeferredError extends Error {
  constructor() {
    super("SOURCE_OCR_HOST_CAPACITY_DEFERRED");
    this.name = "OcrCapacityDeferredError";
  }
}
