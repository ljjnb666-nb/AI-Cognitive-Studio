import { NextResponse } from "next/server";
import { sourceDetail } from "@/lib/product";
import { storage } from "@/lib/storage";
import { boundedPdfResponseBody, prepareVerifiedPdfReviewResponse } from "@/lib/pdf-human-range-source";

export const runtime = "nodejs";

const noStore = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Cross-Origin-Resource-Policy": "same-origin",
};
type Params = { params: Promise<{ sourceDocumentId: string }> };

async function servePdf(request: Request, { params }: Params, headOnly: boolean): Promise<Response> {
  let total: number | undefined;
  try {
    const { sourceDocumentId } = await params;
    if (!/^[a-z0-9]{10,32}$/.test(sourceDocumentId))
      return NextResponse.json({ error: "PDF_SOURCE_PREVIEW_UNAVAILABLE" },
        { status: 404, headers: noStore });
    const source = await sourceDetail(sourceDocumentId);
    const pending=source.ingestionRuns[0];
    const expectedSha=new URL(request.url).searchParams.get("sha");
    if (source.mediaType !== "application/pdf" ||
        (expectedSha!==null && expectedSha!==source.sha256) ||
        (!source.currentExtraction && !(pending?.status==="OCR_REQUIRED" && pending.errorCode==="SOURCE_OCR_REVIEW_REQUIRED")))
      return NextResponse.json({ error: "PDF_SOURCE_PREVIEW_UNAVAILABLE" },
        { status: 404, headers: noStore });
    total = Number(source.sizeBytes);
    const prepared = await prepareVerifiedPdfReviewResponse(storage(), {
      storageKey: source.storageKey,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      mediaType: source.mediaType,
    }, request.headers.get("range"));
    const headers = new Headers({
      ...noStore,
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="source-for-review.pdf"',
      "Accept-Ranges": "bytes",
      "Content-Length": String(prepared.length),
    });
    if (prepared.range) {
      headers.set("Content-Range",
        "bytes " + prepared.range.start + "-" + prepared.range.end + "/" + prepared.total);
    }
    if (headOnly) {
      // Never leave a private S3 stream open after returning headers.
      await prepared.stream[Symbol.asyncIterator]().return?.();
      return new Response(null, { status: prepared.status, headers });
    }
    return new Response(boundedPdfResponseBody(prepared.stream, prepared.length), {
      status: prepared.status, headers,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "PDF_REVIEW_RANGE_UNSATISFIABLE" &&
        total && Number.isSafeInteger(total) && total > 0)
      return new Response(null, {
        status: 416,
        headers: { ...noStore, "Accept-Ranges": "bytes", "Content-Range": "bytes */" + total },
      });
    // Cross-tenant/invalid SHA/source storage details are deliberately hidden.
    return NextResponse.json({ error: "PDF_SOURCE_PREVIEW_UNAVAILABLE" },
      { status: 404, headers: noStore });
  }
}

/** Private PDF; validated once per immutable ETag, then streamed or byte-ranged. */
export async function GET(request: Request, params: Params) { return servePdf(request, params, false); }
export async function HEAD(request: Request, params: Params) { return servePdf(request, params, true); }
