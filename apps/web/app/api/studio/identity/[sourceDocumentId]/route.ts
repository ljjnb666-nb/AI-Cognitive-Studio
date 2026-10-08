import { NextResponse } from "next/server";
import { z } from "zod";
import {
  promoteCurrentProductIdentityForUser,
  readProductIdentityPreviewForUser,
} from "@ai-cognitive/ingestion";
import { resolveWebIdentity, trustedRequestContext } from "@/lib/identity";
import {
  productIdentityApiError,
  productIdentityMutationOriginAllowed,
  productIdentityPromotionHttpStatus,
} from "@/lib/product-identity-api-policy";

type Params = { params: Promise<{ sourceDocumentId: string }> };
const sourceDocumentIdSchema = z.string().cuid();
const requestSchema = z.strictObject({ expectedExtractionId: z.string().cuid() });
const noStore = { "Cache-Control": "private, no-store" };

export async function GET(_: Request, { params }: Params) {
  const parsed = sourceDocumentIdSchema.safeParse((await params).sourceDocumentId);
  if (!parsed.success) return NextResponse.json({ error: "PRODUCT_IDENTITY_INVALID_REQUEST" }, { status: 400, headers: noStore });
  try {
    const identity = trustedRequestContext(await resolveWebIdentity());
    const preview = await readProductIdentityPreviewForUser(identity, parsed.data);
    // Advisory read only. Client must submit the observed current extraction
    // to POST, which independently revalidates all transactional fences.
    return NextResponse.json(preview, { headers: noStore });
  } catch (error) {
    const failure = productIdentityApiError(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status, headers: noStore });
  }
}

export async function POST(request: Request, { params }: Params) {
  // Mutation uses a strict same-origin browser boundary in addition to
  // authenticated workspace membership and the promotion service's role gate.
  if (!productIdentityMutationOriginAllowed(request.headers.get("origin"), process.env.BETTER_AUTH_URL)) {
    return NextResponse.json({ error: "PRODUCT_IDENTITY_ORIGIN_DENIED" }, { status: 403, headers: noStore });
  }

  const documentId = sourceDocumentIdSchema.safeParse((await params).sourceDocumentId);
  if (!documentId.success) return NextResponse.json({ error: "PRODUCT_IDENTITY_INVALID_REQUEST" }, { status: 400, headers: noStore });
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "PRODUCT_IDENTITY_INVALID_REQUEST" }, { status: 400, headers: noStore });
  }

  try {
    const identity = trustedRequestContext(await resolveWebIdentity());
    const result = await promoteCurrentProductIdentityForUser(identity, {
      sourceDocumentId: documentId.data,
      expectedExtractionId: body.expectedExtractionId,
    });
    return NextResponse.json(result, { status: productIdentityPromotionHttpStatus(result.status), headers: noStore });
  } catch (error) {
    const failure = productIdentityApiError(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status, headers: noStore });
  }
}
