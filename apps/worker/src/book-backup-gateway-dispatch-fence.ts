import {
  bookFailoverTextSlots, bookRoutePlanHash, normalizeBookRoutePlan,
  verifyFrozenBookFailoverPlan, type BookAnalysisRoutePlan,
  type BookFailoverTextSlot,
} from "@ai-cognitive/book-intelligence";
import {
  ProviderGatewayError, stableHash, type GatewayRequest,
} from "@ai-cognitive/provider-gateway";

const fail = (): never => {
  throw new ProviderGatewayError(
    "AUTHORIZATION_FAILED",
    "Book backup execution is disabled pending independently audited dispatch admission",
  );
};

/**
 * A second enforcement boundary immediately before a production Gateway
 * attempt, independent of the Book Worker route selection and dry-run API.
 *
 * The persisted fallback plan is intent only (executionEnabled === false).
 * A caller MUST NOT turn a frozen backup into a paid request by constructing
 * a pinnedRoute and calling Gateway.execute directly. No override or test
 * flag is accepted here; future paid execution needs its own atomic,
 * authenticated send-claim protocol.
 *
 * Legacy jobs without a fallback plan are unaffected.
 */
export function assertBookBackupGatewayDispatchFenced(
  jobPayload: unknown,
  request: GatewayRequest,
): void {
  if (!bookFailoverTextSlots.some(slot => slot === request.routeSlot)) return;
  if (!jobPayload || typeof jobPayload !== "object" || Array.isArray(jobPayload))
    return;
  const payload = jobPayload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(payload, "failoverPlan")) return;

  try {
    if (!payload.routePlan || typeof payload.routePlanHash !== "string" ||
        !payload.failoverPlan) fail();
    const primary = normalizeBookRoutePlan(payload.routePlan as BookAnalysisRoutePlan);
    if (bookRoutePlanHash(primary) !== payload.routePlanHash) fail();
    const frozen = verifyFrozenBookFailoverPlan(payload.failoverPlan, primary);
    if (frozen.executionEnabled !== false) fail();

    const slot = request.routeSlot as BookFailoverTextSlot;
    if (!frozen.slots[slot]) return;
    const allowed = primary.routes[slot];
    const pinned = request.pinnedRoute;
    if (!pinned || pinned.source !== "WORKSPACE" ||
        request.capability.family !== "TEXT_GENERATION" ||
        pinned.providerKey !== allowed.providerKey ||
        pinned.protocol !== allowed.protocol ||
        pinned.modelId !== allowed.modelId ||
        pinned.adapterVersion !== allowed.adapterVersion ||
        pinned.connectionId !== allowed.connectionId ||
        pinned.credentialVersionId !== allowed.credentialVersionId ||
        pinned.endpoint !== allowed.endpoint ||
        (pinned.region ?? null) !== (allowed.region ?? null) ||
        pinned.capability.modelId !== allowed.modelId ||
        pinned.capability.structuredOutput !== allowed.structuredOutput ||
        stableHash(pinned.configuration) !== allowed.configurationHash)
      fail();
  } catch {
    fail();
  }
}
