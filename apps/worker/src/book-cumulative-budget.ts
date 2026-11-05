import { BOOK_PAID_GRANT_TYPE, type BookAuthorityTransaction } from "@ai-cognitive/book-intelligence";
import { ProviderGatewayError, stableHash } from "@ai-cognitive/provider-gateway";
import type { BookPaidGrant } from "./book-paid-authorization.js";

export const BOOK_CUMULATIVE_CNY_CAP_MICRO = 10_000_000;

export type BookCumulativeBudget = {
  version: 1;
  limitMicroCny: typeof BOOK_CUMULATIVE_CNY_CAP_MICRO;
  /** ALL previously reserved paid grants for the SAME source document, even across extraction revisions. */
  carryForward: Array<{ grantId: string; payloadDigest: string; reservedMicroCny: number }>;
};

const invalid = () => { throw new Error("BOOK_PAID_CUMULATIVE_BUDGET_INVALID"); };
const denied = () => { throw new ProviderGatewayError("AUTHORIZATION_FAILED"); };
const exceeded = () => { throw new ProviderGatewayError("BUDGET_EXCEEDED"); };

/** No usage-based discounts: unknown, failed, or cancelled remote outcomes
 * retain 100% of each original gross reservation. */
export function assertBookCumulativeBudgetShape(grant: BookPaidGrant) {
  const budget = grant.cumulativeBudget;
  if (budget === undefined) return;
  if (!budget || typeof budget !== "object" || Array.isArray(budget) ||
      Object.keys(budget).some(k => !["version", "limitMicroCny", "carryForward"].includes(k)) ||
      budget.version !== 1 || budget.limitMicroCny !== BOOK_CUMULATIVE_CNY_CAP_MICRO ||
      !Array.isArray(budget.carryForward) || budget.carryForward.length > 200) invalid();
  const ids = new Set<string>();
  let carried = 0;
  for (const item of budget.carryForward) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).some(k => !["grantId", "payloadDigest", "reservedMicroCny"].includes(k)) ||
        typeof item.grantId !== "string" || item.grantId.length < 1 ||
        typeof item.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.payloadDigest) ||
        !Number.isSafeInteger(item.reservedMicroCny) || item.reservedMicroCny < 0 ||
        ids.has(item.grantId)) invalid();
    ids.add(item.grantId);
    carried += item.reservedMicroCny;
    if (!Number.isSafeInteger(carried)) invalid();
  }
  if (carried + grant.maxMicroCny > BOOK_CUMULATIVE_CNY_CAP_MICRO) invalid();
  if (grant.reservedMicroCny !== grant.entries.reduce((sum, entry) => sum + entry.reservedMicroCny, 0) ||
      grant.textCalls !== grant.entries.filter(e => e.kind === "TEXT").length ||
      grant.embeddingCalls !== grant.entries.filter(e => e.kind === "EMBEDDING").length) invalid();
}

/** Fail closed on omitted peers or changed historic receipts. Runs inside the
 * same SQL transaction that binds/activates/reserves the current grant. */
export async function assertBookCumulativeBudget(
  tx: BookAuthorityTransaction,
  job: { id: string; workspaceId: string | null; userId: string | null },
  grant: BookPaidGrant,
) {
  const budget = grant.cumulativeBudget;
  if (budget) try { assertBookCumulativeBudgetShape(grant); } catch { return denied(); }
  if (!job.workspaceId || !job.userId) return denied();
  const all = await tx.job.findMany({
    where: { workspaceId: job.workspaceId, type: BOOK_PAID_GRANT_TYPE },
    select: { id: true, workspaceId: true, userId: true, type: true, status: true, payload: true },
  });
  const sameBook = all.filter(entry => {
    const payload = entry.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload) &&
      "sourceDocumentId" in payload && payload.sourceDocumentId === grant.sourceDocumentId;
  });
  // Once any continuation envelope exists, old-style unpinned grants for this
  // document cannot resume and silently spend outside the cumulative ceiling.
  if (!budget) {
    if (sameBook.some(row => row.id !== job.id && row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) && "cumulativeBudget" in row.payload && row.payload.cumulativeBudget !== undefined)) return denied();
    return;
  }
  if (sameBook.length !== budget.carryForward.length + 1 ||
      !sameBook.some(row => row.id === job.id) ||
      budget.carryForward.some(row => row.grantId === job.id)) return denied();
  const byId = new Map(sameBook.map(row => [row.id, row]));
  let gross = 0;
  for (const historical of budget.carryForward) {
    const old = byId.get(historical.grantId);
    if (!old || old.workspaceId !== job.workspaceId || old.userId !== job.userId ||
        !["SUCCEEDED", "FAILED", "CANCELLED"].includes(old.status) ||
        stableHash(old.payload) !== historical.payloadDigest) return denied();
    const payload = old.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        !("version" in payload) || payload.version !== 1 ||
        !("sha256" in payload) || payload.sha256 !== grant.sha256 ||
        !("reservedMicroCny" in payload) || payload.reservedMicroCny !== historical.reservedMicroCny ||
        !("entries" in payload) || !Array.isArray(payload.entries)) return denied();
    // A pinned receipt with a fabricated/missing extraction cannot support
    // a new budget even when the Job payload digest is internally consistent.
    const originalExtractionId = "extractionId" in payload ? payload.extractionId : null;
    if (typeof originalExtractionId !== "string" || !await tx.documentExtraction.findFirst({ where: { id: originalExtractionId, workspaceId: job.workspaceId, sourceDocumentId: grant.sourceDocumentId }, select: { id: true } })) return denied();
    const entries = payload.entries as Array<{ reservedMicroCny?: unknown; kind?: unknown }>;
    if (entries.some(e => !e || !Number.isSafeInteger(e.reservedMicroCny) || (e.reservedMicroCny as number) < 0 ||
      !["TEXT", "EMBEDDING"].includes(String(e.kind))) ||
        entries.reduce((sum, entry) => sum + (entry.reservedMicroCny as number), 0) !== historical.reservedMicroCny) return denied();
    gross += historical.reservedMicroCny;
  }
  // The current grant's full allowed envelope is protected, not merely the
  // next API call. This prevents under-reserving the next continuation.
  if (!Number.isSafeInteger(gross) || gross + grant.maxMicroCny > budget.limitMicroCny) return exceeded();
}
