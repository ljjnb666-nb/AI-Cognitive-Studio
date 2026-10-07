import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { buildEpubProductIdentityCandidate } from "@ai-cognitive/domain";
import { promoteCurrentProductIdentityForUser } from "../src/product-identity-promotion.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];

async function fixture(input: {
  title?: string | null;
  language?: string | null;
  identifier?: string | null;
  bind?: { title: string; language?: string | null; isbn10?: string | null; isbn13?: string | null };
} = {}) {
  const user = await prisma.user.create({ data: { email: `identity-${crypto.randomUUID()}@test`, name: "Identity" } });
  const workspace = await prisma.workspace.create({ data: { name: `identity-${crypto.randomUUID()}` } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });

  let editionId: string | undefined;
  if (input.bind) {
    const work = await prisma.work.create({ data: { workspaceId: workspace.id, title: input.bind.title } });
    const edition = await prisma.edition.create({
      data: {
        workspaceId: workspace.id,
        workId: work.id,
        language: input.bind.language ?? undefined,
        isbn10: input.bind.isbn10 ?? undefined,
        isbn13: input.bind.isbn13 ?? undefined,
      },
    });
    editionId = edition.id;
  }

  const blob = await prisma.sourceBlob.create({
    data: { workspaceId: workspace.id, sha256: crypto.randomUUID().replaceAll("-", ""), sizeBytes: 1, mediaType: "application/epub+zip", storageKey: `identity/${crypto.randomUUID()}` },
  });
  const source = await prisma.source.create({
    data: { workspaceId: workspace.id, kind: "FILE", displayName: "book.epub", editionId },
  });
  const document = await prisma.sourceDocument.create({
    data: {
      workspaceId: workspace.id,
      sourceId: source.id,
      sourceBlobId: blob.id,
      version: 1,
      sha256: blob.sha256,
      sizeBytes: 1,
      mediaType: "application/epub+zip",
      storageKey: blob.storageKey,
    },
  });
  const job = await prisma.job.create({
    data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id }, idempotencyKey: `identity:${crypto.randomUUID()}` },
  });
  const run = await prisma.ingestionRun.create({
    data: { workspaceId: workspace.id, sourceDocumentId: document.id, jobId: job.id, parserVersion: "epub-parser-v2", normalizationVersion: "canonical-text-v1", status: "SUCCEEDED" },
  });
  const candidate = buildEpubProductIdentityCandidate({
    kind: "epub",
    epubVersion: "3.0",
    packagePath: "OEBPS/content.opf",
    renditionLayout: "REFLOWABLE",
    spineItemCount: 1,
    navigationSource: "NONE",
    navigation: [],
    dcTitle: input.title ?? null,
    dcLanguage: input.language ?? null,
    dcIdentifier: input.identifier ?? null,
  });
  const extraction = await prisma.documentExtraction.create({
    data: {
      ingestionRunId: run.id,
      sourceDocumentId: document.id,
      workspaceId: workspace.id,
      status: "SUCCEEDED",
      parserName: "builtin-epub",
      parserVersion: "epub-parser-v2",
      normalizationVersion: "canonical-text-v1",
      canonicalSchemaVersion: "canonical-book-v1",
      qualityStatus: "ACCEPTED",
      qualityMetadata: { warnings: [] },
      formatMetadata: {
        kind: "epub",
        epubVersion: "3.0",
        packagePath: "OEBPS/content.opf",
        renditionLayout: "REFLOWABLE",
        spineItemCount: 1,
        navigationSource: "NONE",
        navigation: [],
        dcTitle: input.title ?? null,
        dcLanguage: input.language ?? null,
        dcIdentifier: input.identifier ?? null,
      },
      productIdentityCandidate: candidate,
    },
  });
  await prisma.currentDocumentExtraction.create({
    data: { sourceDocumentId: document.id, workspaceId: workspace.id, extractionId: extraction.id },
  });
  return { user, workspace, source, document, extraction };
}

async function addDocumentVersion(value: Awaited<ReturnType<typeof fixture>>, input: { title?: string | null; language?: string | null; identifier?: string | null }) {
  const document = await prisma.sourceDocument.create({
    data: {
      workspaceId: value.workspace.id,
      sourceId: value.source.id,
      sourceBlobId: value.document.sourceBlobId,
      version: 2,
      sha256: value.document.sha256,
      sizeBytes: value.document.sizeBytes,
      mediaType: "application/epub+zip",
      storageKey: value.document.storageKey,
    },
  });
  const job = await prisma.job.create({
    data: { userId: value.user.id, workspaceId: value.workspace.id, type: "source.ingest", payload: { sourceDocumentId: document.id }, idempotencyKey: `identity:${crypto.randomUUID()}` },
  });
  const run = await prisma.ingestionRun.create({
    data: { workspaceId: value.workspace.id, sourceDocumentId: document.id, jobId: job.id, parserVersion: "epub-parser-v2", normalizationVersion: "canonical-text-v1", status: "SUCCEEDED" },
  });
  const candidate = buildEpubProductIdentityCandidate({
    kind: "epub", epubVersion: "3.0", packagePath: "OEBPS/content.opf", renditionLayout: "REFLOWABLE",
    spineItemCount: 1, navigationSource: "NONE", navigation: [],
    dcTitle: input.title ?? null, dcLanguage: input.language ?? null, dcIdentifier: input.identifier ?? null,
  });
  const extraction = await prisma.documentExtraction.create({
    data: {
      ingestionRunId: run.id, sourceDocumentId: document.id, workspaceId: value.workspace.id,
      status: "SUCCEEDED", parserName: "builtin-epub", parserVersion: "epub-parser-v2",
      normalizationVersion: "canonical-text-v1", canonicalSchemaVersion: "canonical-book-v1",
      qualityStatus: "ACCEPTED", qualityMetadata: { warnings: [] }, productIdentityCandidate: candidate,
    },
  });
  await prisma.currentDocumentExtraction.create({ data: { sourceDocumentId: document.id, workspaceId: value.workspace.id, extractionId: extraction.id } });
  return { document, extraction };
}

async function addExtraction(value: Awaited<ReturnType<typeof fixture>>, input: { title?: string | null; language?: string | null; identifier?: string | null }) {
  const job = await prisma.job.create({
    data: { userId: value.user.id, workspaceId: value.workspace.id, type: "source.ingest", payload: { sourceDocumentId: value.document.id }, idempotencyKey: `identity:${crypto.randomUUID()}` },
  });
  const run = await prisma.ingestionRun.create({
    data: { workspaceId: value.workspace.id, sourceDocumentId: value.document.id, jobId: job.id, parserVersion: "epub-parser-v2", normalizationVersion: "canonical-text-v1", status: "SUCCEEDED" },
  });
  const candidate = buildEpubProductIdentityCandidate({
    kind: "epub", epubVersion: "3.0", packagePath: "OEBPS/content.opf", renditionLayout: "REFLOWABLE",
    spineItemCount: 1, navigationSource: "NONE", navigation: [],
    dcTitle: input.title ?? null, dcLanguage: input.language ?? null, dcIdentifier: input.identifier ?? null,
  });
  const extraction = await prisma.documentExtraction.create({
    data: {
      ingestionRunId: run.id, sourceDocumentId: value.document.id, workspaceId: value.workspace.id,
      status: "SUCCEEDED", parserName: "builtin-epub", parserVersion: "epub-parser-v2",
      normalizationVersion: "canonical-text-v1", canonicalSchemaVersion: "canonical-book-v1",
      qualityStatus: "ACCEPTED", qualityMetadata: { warnings: [] }, productIdentityCandidate: candidate,
    },
  });
  await prisma.currentDocumentExtraction.update({
    where: { sourceDocumentId_workspaceId: { sourceDocumentId: value.document.id, workspaceId: value.workspace.id } },
    data: { extractionId: extraction.id },
  });
  return extraction;
}

afterEach(async () => {
  if (workspaceIds.length) {
    await prisma.currentDocumentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.documentExtraction.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.edition.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.work.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  workspaceIds.length = 0;
  userIds.length = 0;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("controlled product identity promotion authority", () => {
  it("denies VIEWER identity mutation with zero durable side effects", async () => {
    const value = await fixture({ title: "Protected Book" });
    await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: value.workspace.id, userId: value.user.id } },
      data: { role: "VIEWER" },
    });
    await expect(promoteCurrentProductIdentityForUser(
      { userId: value.user.id, workspaceId: value.workspace.id },
      { sourceDocumentId: value.document.id, expectedExtractionId: value.extraction.id },
    )).rejects.toThrow("WORKSPACE_WRITE_ACCESS_DENIED");
    await expect(prisma.productIdentityPromotion.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
    await expect(prisma.work.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
    await expect(prisma.edition.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
  });

  it("creates and binds one Work/Edition from the current candidate and is exact-extraction idempotent", async () => {
    const value = await fixture({ title: "Fixture Book", language: "en", identifier: "urn:isbn:978-0-306-40615-7" });
    const context = { userId: value.user.id, workspaceId: value.workspace.id };
    const input = { sourceDocumentId: value.document.id, expectedExtractionId: value.extraction.id };

    const first = await promoteCurrentProductIdentityForUser(context, input);
    expect(first.status).toBe("APPLIED");

    const source = await prisma.source.findUniqueOrThrow({ where: { id_workspaceId: { id: value.source.id, workspaceId: value.workspace.id } }, include: { edition: { include: { work: true } } } });
    expect(source.edition?.work.title).toBe("Fixture Book");
    expect(source.edition?.language).toBe("en");
    expect(source.edition?.isbn13).toBe("9780306406157");
    expect(source.edition?.isbn10).toBeNull();

    const second = await promoteCurrentProductIdentityForUser(context, input);
    expect(second.status).toBe("APPLIED");
    if (first.status !== "STALE" && second.status !== "STALE") expect(second.promotion.id).toBe(first.promotion.id);
    await expect(prisma.work.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(1);
    await expect(prisma.edition.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(1);
    await expect(prisma.productIdentityPromotion.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(1);
  });

  it("treats any conflicting existing product value as all-or-nothing and preserves user/legacy authority", async () => {
    const value = await fixture({
      title: "Candidate Title",
      language: "fr",
      identifier: "urn:isbn:978-0-306-40615-7",
      bind: { title: "Protected Title", language: "en", isbn13: "9783161484100" },
    });
    const result = await promoteCurrentProductIdentityForUser(
      { userId: value.user.id, workspaceId: value.workspace.id },
      { sourceDocumentId: value.document.id, expectedExtractionId: value.extraction.id },
    );
    expect(result.status).toBe("CONFLICT");
    if (result.status !== "STALE") {
      expect(result.promotion.conflicts).toEqual([
        { field: "work.title", existing: "Protected Title", candidate: "Candidate Title" },
        { field: "edition.language", existing: "en", candidate: "fr" },
        { field: "edition.isbn13", existing: "9783161484100", candidate: "9780306406157" },
      ]);
    }
    const source = await prisma.source.findUniqueOrThrow({ where: { id_workspaceId: { id: value.source.id, workspaceId: value.workspace.id } }, include: { edition: { include: { work: true } } } });
    expect(source.edition?.work.title).toBe("Protected Title");
    expect(source.edition?.language).toBe("en");
    expect(source.edition?.isbn13).toBe("9783161484100");
  });

  it("fills only empty Edition fields when the existing Work title agrees", async () => {
    const value = await fixture({
      title: "Same Book",
      language: "zh-CN",
      identifier: "ISBN 0-306-40615-2",
      bind: { title: "Same   Book", language: null, isbn10: null },
    });
    const result = await promoteCurrentProductIdentityForUser(
      { userId: value.user.id, workspaceId: value.workspace.id },
      { sourceDocumentId: value.document.id, expectedExtractionId: value.extraction.id },
    );
    expect(result.status).toBe("APPLIED");
    const source = await prisma.source.findUniqueOrThrow({ where: { id_workspaceId: { id: value.source.id, workspaceId: value.workspace.id } }, include: { edition: true } });
    expect(source.edition?.language).toBe("zh-CN");
    expect(source.edition?.isbn10).toBe("0306406152");
  });

  it("refuses stale extraction promotion after CurrentDocumentExtraction moves", async () => {
    const value = await fixture({ title: "Old Book" });
    const newer = await addExtraction(value, { title: "New Book" });
    const result = await promoteCurrentProductIdentityForUser(
      { userId: value.user.id, workspaceId: value.workspace.id },
      { sourceDocumentId: value.document.id, expectedExtractionId: value.extraction.id },
    );
    expect(result).toEqual({ status: "STALE", expectedExtractionId: value.extraction.id, currentExtractionId: newer.id });
    await expect(prisma.productIdentityPromotion.count({ where: { extractionId: value.extraction.id } })).resolves.toBe(0);
    await expect(prisma.source.findUniqueOrThrow({ where: { id_workspaceId: { id: value.source.id, workspaceId: value.workspace.id } } })).resolves.toMatchObject({ editionId: null });
  });

  it("serializes concurrent promotions across two SourceDocument versions of the same Source", async () => {
    const value = await fixture({ title: "Version One" });
    const second = await addDocumentVersion(value, { title: "Version Two" });
    const context = { userId: value.user.id, workspaceId: value.workspace.id };

    const results = await Promise.all([
      promoteCurrentProductIdentityForUser(context, { sourceDocumentId: value.document.id, expectedExtractionId: value.extraction.id }),
      promoteCurrentProductIdentityForUser(context, { sourceDocumentId: second.document.id, expectedExtractionId: second.extraction.id }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["APPLIED", "CONFLICT"]);
    await expect(prisma.work.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(1);
    await expect(prisma.edition.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(1);
    const bound = await prisma.source.findUniqueOrThrow({ where: { id_workspaceId: { id: value.source.id, workspaceId: value.workspace.id } } });
    expect(bound.editionId).not.toBeNull();
  });

  it("blocks unbound promotion without a title and never guesses ISBN from bare digits", async () => {
    const value = await fixture({ language: "en", identifier: "9780306406157" });
    const result = await promoteCurrentProductIdentityForUser(
      { userId: value.user.id, workspaceId: value.workspace.id },
      { sourceDocumentId: value.document.id, expectedExtractionId: value.extraction.id },
    );
    expect(result.status).toBe("BLOCKED");
    if (result.status !== "STALE") {
      expect(result.promotion.reasonCode).toBe("MISSING_TITLE_FOR_UNBOUND_SOURCE");
      expect(result.promotion.ignoredFields).toContainEqual({ field: "identifier", reason: "UNCLASSIFIED_IDENTIFIER" });
    }
    await expect(prisma.work.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
    await expect(prisma.edition.count({ where: { workspaceId: value.workspace.id } })).resolves.toBe(0);
  });
});
