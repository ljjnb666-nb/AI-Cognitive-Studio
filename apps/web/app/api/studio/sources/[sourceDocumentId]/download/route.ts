import { prisma } from "@ai-cognitive/db";
import { resolveWebIdentity } from "@/lib/identity";
import { storage } from "@/lib/storage";
import { mediaResponse } from "@/lib/media-response";

type Context = { params: Promise<{ sourceDocumentId: string }> };
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: Context) {
  try {
    const identity = await resolveWebIdentity();
    const { sourceDocumentId } = await params;
    const document = await prisma.sourceDocument.findFirst({
      where: { id: sourceDocumentId, workspaceId: identity.workspaceId },
      select: { storageKey: true, source: { select: { displayName: true } } },
    });
    if (!document) return Response.json({ error: "SOURCE_NOT_FOUND" }, { status: 404, headers: { "cache-control": "private, no-store" } });
    // Always download as an attachment: an uploaded HTML/SVG must never execute
    // in the application's authenticated origin. Object keys stay server-side.
    const response = await mediaResponse(request, storage(), document.storageKey, "application/octet-stream");
    const name = Array.from(document.source.displayName).slice(0, 180).map(character => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff) || character === "/" || character === "\\" ? "_" : character;
    }).join("") || "source";
    const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    response.headers.set("content-disposition", `attachment; filename="source"; filename*=UTF-8''${encoded}`);
    response.headers.set("content-security-policy", "sandbox; default-src 'none'");
    return response;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "WEB_IDENTITY_REQUIRED" ? 401 : ["WORKSPACE_ACCESS_DENIED", "BETA_ACCESS_REQUIRED"].includes(code) ? 403 : 503;
    return Response.json({ error: status === 401 ? "AUTHENTICATION_REQUIRED" : status === 403 ? "SOURCE_ACCESS_DENIED" : "SOURCE_DOWNLOAD_UNAVAILABLE" }, { status, headers: { "cache-control": "private, no-store" } });
  }
}
export async function HEAD(request: Request, context: Context) { return GET(request, context); }
