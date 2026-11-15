import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@ai-cognitive/db";
import { authorizeOneBookBackupCall } from "@ai-cognitive/book-intelligence";
import { resolveSessionUserId, resolveWebIdentity } from "@/lib/identity";

const input = z.object({
  analysisRunId: z.string().cuid(),
  routeSlot: z.enum(["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"]),
  operationHash: z.string().regex(/^[a-f0-9]{64}$/),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: z.number().int().min(1),
  maxAdditionalUnits: z.number().int().min(1).max(1_000_000),
  expiresInMinutes: z.number().int().min(1).max(60),
  approval: z.literal("AUTHORIZE_ONE_ADDITIONAL_MODEL_CALL"),
}).strict();

async function authenticatedOwner() {
  // Paid consent cannot be issued from a development bootstrap identity.
  const sessionUserId = await resolveSessionUserId();
  const selected = await resolveWebIdentity();
  if (sessionUserId !== selected.userId)
    throw new Error("BOOK_FAILOVER_GRANT_ACCESS_DENIED");
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: {
      workspaceId: selected.workspaceId, userId: sessionUserId,
    } },
    select: { role: true },
  });
  if (member?.role !== "OWNER") throw new Error("BOOK_FAILOVER_GRANT_OWNER_REQUIRED");
  return { workspaceId: selected.workspaceId, userId: sessionUserId };
}

function safeFailure(error: unknown) {
  const reason = error instanceof Error ? error.message : "";
  const denied = ["BOOK_FAILOVER_GRANT_ACCESS_DENIED",
    "BOOK_FAILOVER_GRANT_OWNER_REQUIRED", "WEB_IDENTITY_REQUIRED"].includes(reason);
  const conflict = reason.startsWith("BOOK_FAILOVER_GRANT_") && !denied &&
    reason !== "BOOK_FAILOVER_GRANT_INVALID_REQUEST";
  return NextResponse.json({
    error: denied ? "BOOK_FAILOVER_GRANT_ACCESS_DENIED"
      : conflict ? reason : "BOOK_FAILOVER_GRANT_REQUEST_REJECTED",
  }, { status: denied ? 403 : conflict ? 409 : 400,
    headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  try {
    const actor = await authenticatedOwner();
    const checkpoints = await prisma.bookFailoverCheckpoint.findMany({
      where: { workspaceId: actor.workspaceId, state: "HOLD",
        candidateIndex: 0, paidGrantId: null, lastFailureCode: { not: null } },
      take: 50, orderBy: { updatedAt: "desc" },
      select: {
        analysisRunId: true, routeSlot: true, operationHash: true,
        planHash: true, revision: true, lastFailureCode: true,
        holdReason: true, settledOutcome: true, updatedAt: true,
        analysisRun: { select: { status: true } },
      },
    });
    // Preview only. A GET never authorizes payment, sends a call or
    // asserts that billing is settled; POST independently rechecks all facts.
    return NextResponse.json({
      executable: false,
      unit: "TOKENS_OR_CHARACTERS",
      currencyEstimate: null,
      operations: checkpoints.filter(item => item.analysisRun.status === "RUNNING").map(item => ({
        analysisRunId: item.analysisRunId, routeSlot: item.routeSlot,
        operationHash: item.operationHash, planHash: item.planHash,
        expectedRevision: item.revision, lastFailureCode: item.lastFailureCode,
        holdReason: item.holdReason, settledOutcome: item.settledOutcome,
        updatedAt: item.updatedAt,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return safeFailure(error); }
}

export async function POST(request: Request) {
  try {
    // Reject missing/mismatched browser Origin for a credentialed paid-consent
    // mutation. No cookie-only cross-site POST may issue an approval.
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin)
      throw new Error("BOOK_FAILOVER_GRANT_ACCESS_DENIED");
    const actor = await authenticatedOwner();
    const body = input.parse(await request.json());
    const result = await authorizeOneBookBackupCall(actor, body);
    return NextResponse.json({
      ...result, status: "CONSENT_RECORDED_NO_PROVIDER_CALL",
      unit: "TOKENS_OR_CHARACTERS", currencyEstimate: null,
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return safeFailure(error); }
}
