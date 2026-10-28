import { NextResponse } from "next/server";
import { sourceDetail } from "@/lib/product";
import { storage } from "@/lib/storage";
import { loadVerifiedPdfForHumanReview } from "@/lib/pdf-human-original-source";

/** Source PDF only. No presigned public object URL and no cached book content. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sourceDocumentId: string }> },
) {
  try {
    const { sourceDocumentId } = await params;
    if (!/^[a-z0-9]{10,32}$/.test(sourceDocumentId))
      return NextResponse.json({ error: "PDF_SOURCE_PREVIEW_UNAVAILABLE" }, { status: 404 });
    // Use the EXACT tenant-scoped source read policy of the existing book UI.
    const source = await sourceDetail(sourceDocumentId);
    if (source.mediaType !== "application/pdf" || !source.currentExtraction)
      return NextResponse.json({ error: "PDF_SOURCE_PREVIEW_UNAVAILABLE" }, { status: 404 });
    const bytes = await loadVerifiedPdfForHumanReview(storage(), {
      storageKey: source.storageKey,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      mediaType: source.mediaType,
    });
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=\"source-for-review.pdf\"",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Accept-Ranges": "none",
        "Content-Length": String(bytes.length),
      },
    });
  } catch {
    // Never leak whether another tenant's source / storage key exists.
    return NextResponse.json({ error: "PDF_SOURCE_PREVIEW_UNAVAILABLE" }, { status: 404 });
  }
}
