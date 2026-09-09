import { NextResponse } from "next/server";
import { createIngestionService } from "@ai-cognitive/ingestion";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { resolveWebIdentity } from "@/lib/identity";

export async function POST(_: Request, { params }: { params: Promise<{ sourceDocumentId: string }> }) {
  try {
    const environment = readEnvironment(), identity = await resolveWebIdentity();
    const storage = new S3CompatibleStorageProvider({ endpoint: environment.S3_ENDPOINT, region: environment.S3_REGION, bucket: environment.S3_BUCKET, accessKey: environment.S3_ACCESS_KEY, secretKey: environment.S3_SECRET_KEY, forcePathStyle: environment.S3_FORCE_PATH_STYLE });
    const result = await createIngestionService(storage).recoverIngestionForUser(identity, (await params).sourceDocumentId, process.env.PHASE9_SOURCE_TOPIC ? { outboxTopic: process.env.PHASE9_SOURCE_TOPIC } : undefined);
    return NextResponse.json({ ingestionRunId: result.run.id, created: result.created });
  } catch (error) { const code = error instanceof Error ? error.message.split(":")[0] : "PROCESSING_RECOVERY_FAILED"; return NextResponse.json({ error: code }, { status: code.includes("ACCESS_DENIED") ? 403 : 400 }); }
}
