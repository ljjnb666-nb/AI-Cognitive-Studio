import { NextResponse } from "next/server";
import { z } from "zod";
import { correctProductIdentityForUser } from "@ai-cognitive/ingestion";
import { resolveWebIdentity, trustedRequestContext } from "@/lib/identity";
import { productIdentityApiError, productIdentityMutationOriginAllowed } from "@/lib/product-identity-api-policy";

type Params = { params: Promise<{ sourceDocumentId: string }> };
const noStore = { "Cache-Control": "private, no-store" };
const revision = z.string().datetime();
const storedValues = z.strictObject({
  title: z.string(),
  language: z.string().nullable(),
  isbn10: z.string().nullable(),
  isbn13: z.string().nullable(),
});
const changes = z.strictObject({
  title: z.string().optional(),
  language: z.string().optional(),
  isbn10: z.string().optional(),
  isbn13: z.string().optional(),
}).refine((v) => Object.keys(v).length > 0);
const bodySchema = z.strictObject({
  expectedExtractionId: z.string().cuid(),
  expectedWorkId: z.string().cuid(),
  expectedEditionId: z.string().cuid(),
  expectedWorkUpdatedAt: revision,
  expectedEditionUpdatedAt: revision,
  expectedValues: storedValues,
  values: changes,
  reason: z.string().trim().min(3).max(500),
});

export async function POST(request: Request, { params }: Params) {
  // This is deliberately a distinct mutation authority, never an alternate
  // code path through ingestion/automatic promotion.
  if (!productIdentityMutationOriginAllowed(request.headers.get("origin"), process.env.BETTER_AUTH_URL)) {
    return NextResponse.json({ error: "PRODUCT_IDENTITY_ORIGIN_DENIED" }, { status: 403, headers: noStore });
  }
  const id = z.string().cuid().safeParse((await params).sourceDocumentId);
  if (!id.success) return NextResponse.json({ error: "PRODUCT_IDENTITY_INVALID_REQUEST" }, { status: 400, headers: noStore });
  let payload: z.infer<typeof bodySchema>;
  try {
    payload = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "PRODUCT_IDENTITY_INVALID_REQUEST" }, { status: 400, headers: noStore });
  }
  try {
    const identity = trustedRequestContext(await resolveWebIdentity());
    const result = await correctProductIdentityForUser(identity, { sourceDocumentId: id.data, ...payload });
    return NextResponse.json(result, {
      status: result.status === "APPLIED" || result.status === "NOOP" ? 200 : 409,
      headers: noStore,
    });
  } catch (error) {
    const failure = productIdentityApiError(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status, headers: noStore });
  }
}
