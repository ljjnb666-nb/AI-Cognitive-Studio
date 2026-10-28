import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { DEFAULT_PARSER_LIMITS, extractNativePdf } from "@ai-cognitive/ingestion";
import { ProviderGatewayRepository, parseKeyring } from "@ai-cognitive/provider-gateway";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { createBookProductionGatewayRuntime } from "../src/provider-gateway-runtime.js";
import { executeOnDemandPdfVisualReview } from "../src/pdf-visual-review.js";

const environment = readEnvironment();
const keyring = JSON.stringify({
  activeVersion: "v1",
  keys: { v1: Buffer.alloc(32, 7).toString("base64") },
});
const manifest = JSON.stringify({ providers: [{
  providerKey: "zhipu", displayName: "Zhipu synthetic fixture",
  protocol: "OPENAI_COMPATIBLE", adapterVersion: "builtin-v1",
  models: [{
    modelId: "glm-4.6v", families: ["TEXT_GENERATION"], confidence: "EXPERIMENTAL",
    structuredOutput: "JSON_MODE", visionInput: true,
  }],
}] });
const controlledSource = {
  ...process.env,
  NODE_ENV: "test",
  PROVIDER_GATEWAY_KEYRING: keyring,
  PROVIDER_GATEWAY_MODEL_MANIFEST: manifest,
};
const controls = {
  circuit: {
    admit: async () => undefined,
    recordSuccess: async () => undefined,
    recordRetryableFailure: async () => undefined,
  },
  rate: { admit: async () => undefined },
  concurrency: {
    acquire: async (key: string) => ({ key, token: "fixture-only" }),
    release: async () => true,
  },
  validateEndpoint: async () => undefined,
};
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const graph = {
  schemaVersion: 1,
  figures: [{
    id: "figure", kind: "DIAGRAM", bbox: [10, 20, 200, 220],
    caption: "synthetic graph",
    nodes: [{ id: "a", label: "input" }, { id: "b", label: "output" }],
    edges: [{ from: "a", to: "b", label: "flow", direction: "DIRECTED" }],
  }],
};
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const owned: Array<{ workspaceId: string; userId: string; objectKey: string }> = [];
const storage = new S3CompatibleStorageProvider({
  endpoint: environment.S3_ENDPOINT, region: environment.S3_REGION,
  bucket: environment.S3_BUCKET, accessKey: environment.S3_ACCESS_KEY,
  secretKey: environment.S3_SECRET_KEY,
  forcePathStyle: environment.S3_FORCE_PATH_STYLE,
});

async function makePdf(): Promise<Uint8Array> {
  const document = new PDFDocument({ autoFirstPage: false });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Uint8Array>(resolve =>
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)))));
  document.pipe(stream);
  document.addPage();
  document.text("Source-bound diagram review proof", 48, 48);
  document.image(pixel, 80, 100, { width: 70, height: 70 });
  document.addPage();
  document.text("Text-only PDF page, no visual provider request", 48, 48);
  document.end();
  return finished;
}
async function fixture() {
  const bytes = await makePdf(), checksum = sha256(bytes), suffix = randomUUID();
  const user = await prisma.user.create({ data: { email: `${suffix}@pdf-visual-proof.test` } });
  const workspace = await prisma.workspace.create({ data: { name: suffix } });
  const key = `private/pdf-visual-proof/${suffix}.pdf`;
  owned.push({ workspaceId: workspace.id, userId: user.id, objectKey: key });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" },
  });
  await storage.putObject({ key, body: bytes, contentType: "application/pdf" });
  const source = await prisma.source.create({
    data: { workspaceId: workspace.id, kind: "FILE", displayName: "synthetic.pdf" },
  });
  const blob = await prisma.sourceBlob.create({
    data: {
      workspaceId: workspace.id, sha256: checksum, sizeBytes: BigInt(bytes.length),
      mediaType: "application/pdf", storageKey: key,
    },
  });
  const document = await prisma.sourceDocument.create({
    data: {
      workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id,
      version: 1, sha256: checksum, sizeBytes: BigInt(bytes.length),
      mediaType: "application/pdf", storageKey: key,
    },
  });
  const job = await prisma.job.create({
    data: {
      workspaceId: workspace.id, userId: user.id,
      type: "source.ingest", status: "SUCCEEDED", payload: {},
    },
  });
  const native = await extractNativePdf(bytes, DEFAULT_PARSER_LIMITS);
  const run = await prisma.ingestionRun.create({
    data: {
      workspaceId: workspace.id, sourceDocumentId: document.id, jobId: job.id,
      status: "SUCCEEDED", parserVersion: "synthetic-proof-v1",
      normalizationVersion: "synthetic-proof-v1", routingGeneration: 1,
      routingPlan: JSON.parse(JSON.stringify(native.routingPlan)),
    },
  });
  const context = { workspaceId: workspace.id, userId: user.id };
  const gatewayStore = new ProviderGatewayRepository(prisma, parseKeyring(keyring)!);
  const connection = await gatewayStore.createConnection(context, {
    providerKey: "zhipu", protocol: "OPENAI_COMPATIBLE", displayName: "Synthetic vision only",
  });
  await gatewayStore.rotateCredential(context, connection.id, "mock-credential-never-sent");
  await gatewayStore.setRoute(context, {
    routeSlot: "PDF_VISUAL_STRUCTURE", connectionId: connection.id, modelId: "glm-4.6v",
  });
  return {
    bytes, key, workspaceId: workspace.id, userId: user.id,
    sourceDocumentId: document.id, ingestionRunId: run.id,
  };
}

afterEach(async () => {
  for (const row of owned.splice(0)) {
    await storage.deleteObject(row.objectKey);
    const where = { workspaceId: row.workspaceId };
    await prisma.providerTextResult.deleteMany({ where });
    await prisma.providerUsageEvent.deleteMany({ where });
    await prisma.providerInvocationAttempt.deleteMany({ where });
    await prisma.providerInvocation.deleteMany({ where });
    await prisma.providerExecutionSnapshot.deleteMany({ where });
    await prisma.providerRouteBinding.deleteMany({ where });
    await prisma.providerCredentialVersion.deleteMany({ where });
    await prisma.providerConnection.deleteMany({ where });
    await prisma.providerAuditEvent.deleteMany({ where });
    await prisma.ingestionRun.deleteMany({ where });
    await prisma.job.deleteMany({ where });
    await prisma.sourceDocument.deleteMany({ where });
    await prisma.sourceBlob.deleteMany({ where });
    await prisma.source.deleteMany({ where });
    await prisma.workspaceMember.deleteMany({ where });
    await prisma.workspace.delete({ where: { id: row.workspaceId } });
    await prisma.user.delete({ where: { id: row.userId } });
  }
});
afterAll(async () => { storage.close(); });

describe("real PostgreSQL + MinIO PDF vision Gateway receipt proof", () => {
  it("reads authentic S3 bytes, writes an encrypted durable receipt and replays idempotently", async () => {
    const f = await fixture();
    let modelCalls = 0;
    const runtime = createBookProductionGatewayRuntime(controlledSource, {
      ...controls,
      adapterResolver: () => ({
        execute: async ({ request }) => {
          expect(request.text?.messages[0]?.image?.sourceSha256).toBe(sha256(f.bytes));
          modelCalls++;
          return {
            response: { type: "STRUCTURED" as const, structured: graph },
            usage: { inputTokens: 18, outputTokens: 19 },
          };
        },
      }),
    });
    const task = {
      enabled: true as const, allowExternalVisualModel: true as const,
      workspaceId: f.workspaceId, userId: f.userId,
      sourceDocumentId: f.sourceDocumentId, ingestionRunId: f.ingestionRunId,
      maxReviewPages: 1 as const,
    };
    const deps = {
      authorize: async (userId: string, workspaceId: string) => {
        const active = await prisma.workspaceMember.findFirst({
          where: { userId, workspaceId },
        });
        if (!active) throw Error("ACCESS_DENIED");
      },
      loadRun: async ({ workspaceId, ingestionRunId }: { workspaceId: string; ingestionRunId: string }) =>
        prisma.ingestionRun.findFirst({
          where: { id: ingestionRunId, workspaceId }, include: { sourceDocument: true },
        }),
      storage, gateway: runtime.gateway,
    };
    try {
      const first = await executeOnDemandPdfVisualReview(task, deps);
      expect(first).toMatchObject({
        examinedPageCount: 1, mixedPageCount: 1,
        reviewRequired: true, canonicalTextUpdated: false, persistedVisualContent: false,
      });
      expect(first.pages[0]?.figures[0]?.edges[0]?.direction).toBe("DIRECTED");
      expect(modelCalls).toBe(1);
      const invocation = await prisma.providerInvocation.findFirstOrThrow({
        where: { workspaceId: f.workspaceId },
        include: { textResult: true, snapshot: true },
      });
      expect(invocation).toMatchObject({ status: "SUCCEEDED", routeSlot: "PDF_VISUAL_STRUCTURE" });
      expect(invocation.snapshot.routeSlot).toBe("PDF_VISUAL_STRUCTURE");
      expect(invocation.textResult?.ciphertext).toBeTruthy();
      expect(invocation.textResult?.iv).toBeTruthy();
      expect(invocation.textResult?.authTag).toBeTruthy();
      expect(invocation.textResult?.consumedAt).toBeNull();
      expect(await prisma.providerUsageEvent.count({ where: { workspaceId: f.workspaceId } })).toBe(1);

      const repeated = await executeOnDemandPdfVisualReview(task, deps);
      expect(repeated.pages[0]?.figures[0]?.id).toBe(first.pages[0]?.figures[0]?.id);
      expect(modelCalls).toBe(1);
      expect(await prisma.providerInvocation.count({ where: { workspaceId: f.workspaceId } })).toBe(1);

      await storage.putObject({
        key: f.key, body: Buffer.from("corrupt source"), contentType: "application/pdf",
      });
      await expect(executeOnDemandPdfVisualReview(task, deps))
        .rejects.toThrow(/PDF_VISUAL_WORKER_SOURCE_SIZE_MISMATCH|PDF_VISUAL_WORKER_SOURCE_SHA_MISMATCH/);
      expect(modelCalls).toBe(1);
    } finally {
      await runtime.close();
    }
  }, 90_000);
});
