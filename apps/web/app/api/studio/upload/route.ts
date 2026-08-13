import { NextResponse } from "next/server";
import { z } from "zod";
import { createIngestionService } from "@ai-cognitive/ingestion";
import { resolveWebIdentity } from "@/lib/identity";
import { storage } from "@/lib/storage";

const createSchema = z.object({ filename: z.string().trim().min(1).max(180), mediaType: z.enum(["text/plain", "text/markdown", "application/pdf", "application/epub+zip"]), sizeBytes: z.number().int().positive().max(100 * 1024 * 1024) });
const completeSchema = z.object({ sessionId: z.string().uuid() });

function errorResponse(error: unknown) { const code = error instanceof Error ? error.message : "REQUEST_FAILED"; const status = code.includes("ACCESS_DENIED") || code === "WEB_IDENTITY_REQUIRED" ? 403 : 400; return NextResponse.json({ error: code }, { status }); }

export async function POST(request: Request) {
  try { const body = await request.json() as unknown; const identity = await resolveWebIdentity(); const service = createIngestionService(storage());
    if (typeof body === "object" && body !== null && "sessionId" in body) { const { sessionId } = completeSchema.parse(body); const document = await service.completeUpload(identity, sessionId); return NextResponse.json({ sourceDocumentId: document.id }); }
    const input = createSchema.parse(body); const intent = await service.createUploadIntent(identity, input); return NextResponse.json({ sessionId: intent.session.id, upload: intent.upload });
  } catch (error) { return errorResponse(error); }
}
