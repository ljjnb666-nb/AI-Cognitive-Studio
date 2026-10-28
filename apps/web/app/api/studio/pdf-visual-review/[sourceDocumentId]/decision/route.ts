import { NextResponse } from "next/server";
import { z } from "zod";
import { sourceDetail } from "@/lib/product";
import { resolveWebIdentity } from "@/lib/identity";
import { isSameOriginPdfVisualRequest } from "@/lib/pdf-visual-request-policy";
import { pdfHumanReviewActionSchema, submitPdfHumanReview } from "@/lib/pdf-human-review";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sourceDocumentId: string }> },
) {
  if (!isSameOriginPdfVisualRequest(request.url, request.headers.get("origin")))
    return NextResponse.json({ error: "PDF_HUMAN_REVIEW_ORIGIN_DENIED" }, { status: 403 });
  try {
    const { sourceDocumentId } = await params;
    if (!/^[a-z0-9]{10,32}$/.test(sourceDocumentId))
      return NextResponse.json({ error: "PDF_HUMAN_REVIEW_ACCESS_DENIED" }, { status: 404 });
    const payload = pdfHumanReviewActionSchema.parse(await request.json());
    const identity = await resolveWebIdentity();
    const source = await sourceDetail(sourceDocumentId, identity);
    if (source.mediaType !== "application/pdf")
      return NextResponse.json({ error: "PDF_HUMAN_REVIEW_ACCESS_DENIED" }, { status: 404 });
    const result = await submitPdfHumanReview({
      workspaceId: identity.workspaceId, sourceDocumentId: source.id,
      reviewerUserId: identity.userId, submission: payload,
    });
    return NextResponse.json(
      { ...result, authority: "HUMAN_STRUCTURE_REVIEW_ONLY", approvedForPodcast: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "PDF_HUMAN_REVIEW_INVALID_REQUEST" }, { status: 400 });
    const conflict = ["PDF_HUMAN_REVIEW_CONFLICT","PDF_HUMAN_REVIEW_WITHDRAW_FIRST",
      "PDF_HUMAN_REVIEW_TRANSITION_INVALID","PDF_HUMAN_REVIEW_CANDIDATE_STALE",
      "PDF_HUMAN_REVIEW_RUN_STALE","PDF_HUMAN_REVIEW_SOURCE_STALE"].includes(code);
    return NextResponse.json({ error: conflict ? "PDF_HUMAN_REVIEW_CONFLICT" : "PDF_HUMAN_REVIEW_DENIED" },
      { status: conflict ? 409 : 403 });
  }
}
