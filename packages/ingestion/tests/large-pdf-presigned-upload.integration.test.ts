import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { createIngestionService } from "../src/index.js";

/**
 * Opt-in CI only. Uses real private MinIO, PostgreSQL and an actual presigned
 * HTTP PUT of B03-sized SYNTHETIC bytes. It never reads a private book, calls
 * a parser, or creates a Gold / podcast assertion.
 */
describe.skipIf(process.env.PDF_LARGE_UPLOAD_STORAGE_PROOF !== "true")(
  "B03-size real MinIO presigned PUT, streamed SHA and canonical copy",
  () => {
    it("promotes exactly 151,495,200 synthetic bytes without buffering them in the HTTP test client", async () => {
      if (process.env.NODE_ENV !== "test" ||
          !process.env.DATABASE_URL?.includes("ai_cognitive_studio_test") ||
          process.env.S3_BUCKET !== "ai-cognitive-studio-dev" ||
          !["http://127.0.0.1:9000", "http://localhost:9000"].includes(process.env.S3_ENDPOINT ?? "") ||
          process.env.S3_ACCESS_KEY !== "local-development-only") {
        throw new Error("LARGE_PDF_STORAGE_PROOF_ISOLATION_REQUIRED");
      }

      const storage = new S3CompatibleStorageProvider({
        endpoint: process.env.S3_ENDPOINT!,
        publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT!,
        region: process.env.S3_REGION ?? "us-east-1",
        bucket: process.env.S3_BUCKET!,
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
        forcePathStyle: true,
      });
      const bytesTotal = 151_495_200;
      const user = await prisma.user.create({ data: { email: `synthetic-pdf-${randomUUID()}@test`, name: "Large PDF synthetic" } });
      let workspaceId: string | undefined;
      let tempKey: string | undefined;
      let canonicalKey: string | undefined;
      try {
        const workspace = await prisma.workspace.create({ data: { name: `synthetic-pdf-${randomUUID()}` } });
        workspaceId = workspace.id;
        await prisma.workspaceMember.create({ data: { userId: user.id, workspaceId, role: "OWNER" } });
        const context = { userId: user.id, workspaceId };
        const service = createIngestionService(storage);
        const { session, upload } = await service.createUploadIntent(context, {
          filename: "B03-sized-synthetic-not-a-valid-book.pdf",
          mediaType: "application/pdf",
          sizeBytes: bytesTotal,
        });
        tempKey = session.temporaryStorageKey;
        const url = new URL(upload.url);
        if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "9000" || url.protocol !== "http:") {
          throw new Error("LARGE_PDF_PRESIGNED_ENDPOINT_NOT_LOCAL");
        }

        // Reuse 1 MiB buffers; never assemble the 151.5 MB upload into a
        // Node Buffer. The PDF signature is enough for the ingestion sniff
        // gate, but this fixture is NOT a parseable PDF and MUST NOT be parsed.
        const firstChunk = Buffer.alloc(1024 * 1024, 0x20);
        firstChunk.write("%PDF-1.7\n", 0, "ascii");
        const bodyChunk = Buffer.alloc(1024 * 1024, 0x20);
        const hash = createHash("sha256");
        let sentBytes = 0;
        const body = Readable.from((async function* () {
          while (sentBytes < bytesTotal) {
            const chunk = (sentBytes === 0 ? firstChunk : bodyChunk)
              .subarray(0, Math.min(1024 * 1024, bytesTotal - sentBytes));
            hash.update(chunk);
            sentBytes += chunk.byteLength;
            yield chunk;
          }
        })());
        const response = await fetch(upload.url, {
          method: "PUT",
          headers: { ...upload.headers, "content-length": String(bytesTotal) },
          // Node's fetch accepts Readable streams with duplex: "half";
          // TypeScript's DOM BodyInit declaration does not include Node Readable.
          body: body as unknown as BodyInit,
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        if (!response.ok) throw new Error(`SYNTHETIC_MINIO_PUT_FAILED_${response.status}`);
        expect(sentBytes).toBe(bytesTotal);
        const expectedSha256 = hash.digest("hex");

        const document = await service.completeUpload(context, session.id);
        canonicalKey = document.storageKey;
        expect(document.sizeBytes).toBe(BigInt(bytesTotal));
        expect(document.sha256).toBe(expectedSha256);
        expect(document.mediaType).toBe("application/pdf");
        expect((await storage.headObject(canonicalKey))?.size).toBe(bytesTotal);
        expect(await storage.headObject(tempKey)).toBeNull();
        expect(await prisma.sourceBlob.count({ where: { workspaceId } })).toBe(1);
        expect(await prisma.sourceDocument.count({ where: { workspaceId } })).toBe(1);
        expect(await prisma.ingestionRun.count({ where: { workspaceId } })).toBe(1);
      } finally {
        if (workspaceId) {
          const runs = await prisma.ingestionRun.findMany({ where: { workspaceId }, select: { id: true } });
          if (runs.length) await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: runs.map(run => run.id) } } });
          await prisma.ingestionRun.deleteMany({ where: { workspaceId } });
          await prisma.uploadCompletion.deleteMany({ where: { workspaceId } });
          await prisma.uploadSession.deleteMany({ where: { workspaceId } });
          await prisma.job.deleteMany({ where: { workspaceId } });
          await prisma.sourceDocument.deleteMany({ where: { workspaceId } });
          await prisma.source.deleteMany({ where: { workspaceId } });
          await prisma.sourceBlob.deleteMany({ where: { workspaceId } });
          await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
          await prisma.workspace.delete({ where: { id: workspaceId } });
        }
        await prisma.user.delete({ where: { id: user.id } });
        if (tempKey) await storage.deleteObject(tempKey);
        if (canonicalKey) await storage.deleteObject(canonicalKey);
        storage.close();
      }
    }, 210_000);
  },
);

afterAll(async () => {
  await prisma.$disconnect();
});
