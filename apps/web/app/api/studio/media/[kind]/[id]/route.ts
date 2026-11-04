import { NextResponse } from "next/server";
import { prisma } from "@ai-cognitive/db";
import { resolveWebIdentity } from "@/lib/identity";
import { storage } from "@/lib/storage";
import { mediaResponse } from "@/lib/media-response";

type Context = { params: Promise<{ kind: string; id: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    const { kind, id } = await params;
    const identity = await resolveWebIdentity();
    const where = { id, workspaceId: identity.workspaceId };
    const revision = kind === "audio"
      ? await prisma.podcastAudioRevision.findFirst({ where, select: { storageKey: true } })
      : kind === "video" ? await prisma.shortVideoRevision.findFirst({ where, select: { storageKey: true } }) : null;
    if (!revision) return NextResponse.json({ error: "MEDIA_ACCESS_DENIED" }, { status: 404, headers: { "cache-control": "private, no-store" } });
    return await mediaResponse(request, storage(), revision.storageKey, kind === "audio" ? "audio/wav" : "video/mp4");
  } catch {
    return NextResponse.json({ error: "MEDIA_ACCESS_DENIED" }, { status: 403, headers: { "cache-control": "private, no-store" } });
  }
}
export async function HEAD(request: Request, context: Context) { return GET(request, context); }
