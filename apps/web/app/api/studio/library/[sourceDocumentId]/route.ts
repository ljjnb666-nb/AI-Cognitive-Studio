import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveWebMutationIdentity, resolveWebIdentity } from "@/lib/identity";
import { libraryDeletionPreview, deleteFromLibrary } from "@/lib/library-deletion";
const command = z.object({ sourceId: z.string().cuid(), versionCount: z.number().int().min(1), updatedAt: z.string().datetime() }).strict();
type Params = { params: Promise<{ sourceDocumentId: string }> };
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "SOURCE_DELETE_FAILED";
  const status = code === "WEB_IDENTITY_REQUIRED" ? 401 : code === "SOURCE_DELETE_CHANGED" ? 409 : ["SOURCE_DOCUMENT_ACCESS_DENIED", "SOURCE_DELETE_FORBIDDEN"].includes(code) ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? "SOURCE_DELETE_FAILED" : code }, { status });
}
export async function GET(_: Request, { params }: Params) {
  try { return NextResponse.json(await libraryDeletionPreview(await resolveWebIdentity(), (await params).sourceDocumentId)); } catch (error) { return failure(error); }
}
export async function DELETE(request: Request, { params }: Params) {
  try {
    const identity = await resolveWebMutationIdentity(), parsed = command.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "SOURCE_DELETE_INPUT_INVALID" }, { status: 400 });
    return NextResponse.json(await deleteFromLibrary(identity, (await params).sourceDocumentId, parsed.data));
  } catch (error) { return failure(error); }
}
