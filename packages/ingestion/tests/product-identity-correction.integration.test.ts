import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { correctProductIdentityForUser } from "../src/product-identity-correction.js";
import { promoteCurrentProductIdentityForUser } from "../src/product-identity-promotion.js";
import { readProductIdentityPreviewForUser } from "../src/product-identity-preview.js";

const workspaceIds: string[] = [];
const userIds: string[] = [];

async function fixture() {
  const user = await prisma.user.create({ data: { email: "human-edit-" + crypto.randomUUID() + "@test.invalid" } });
  const workspace = await prisma.workspace.create({ data: { name: "manual edit test" } });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const work = await prisma.work.create({ data: { workspaceId: workspace.id, title: "Original Title" } });
  const edition = await prisma.edition.create({ data: { workspaceId: workspace.id, workId: work.id, language: "en" } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "source.epub", editionId: edition.id } });
  const key = crypto.randomUUID().replaceAll("-", "");
  const blob = await prisma.sourceBlob.create({
    data: { workspaceId: workspace.id, sha256: key, sizeBytes: 1, mediaType: "application/epub+zip", storageKey: "human-edit/" + key },
  });
  const doc = await prisma.sourceDocument.create({
    data: {
      workspaceId: workspace.id, sourceId: source.id, sourceBlobId: blob.id, version: 1,
      sha256: blob.sha256, sizeBytes: 1, mediaType: "application/epub+zip", storageKey: blob.storageKey,
    },
  });
  const job = await prisma.job.create({ data: {
    workspaceId: workspace.id, userId: user.id, type: "source.ingest", status: "SUCCEEDED", payload: {},
  } });
  const run = await prisma.ingestionRun.create({ data: {
    workspaceId: workspace.id, sourceDocumentId: doc.id, jobId: job.id, status: "SUCCEEDED",
    parserVersion: "epub-parser-v2", normalizationVersion: "canonical-text-v1",
  } });
  const extraction = await prisma.documentExtraction.create({ data: {
    workspaceId: workspace.id, sourceDocumentId: doc.id, ingestionRunId: run.id,
    status: "SUCCEEDED", qualityStatus: "ACCEPTED", parserName: "builtin-epub",
    parserVersion: "epub-parser-v2", normalizationVersion: "canonical-text-v1",
    productIdentityCandidate: {
      kind: "epub", schemaVersion: "product-identity-candidate-v1",
      source: "EPUB_PACKAGE_METADATA", authority: "EVIDENCE_ONLY",
      title: { sourceField: "dc:title", value: "Original Title" },
      language: { sourceField: "dc:language", value: "fr" },
      identifier: null,
    },
  } });
  await prisma.currentDocumentExtraction.create({
    data: { workspaceId: workspace.id, sourceDocumentId: doc.id, extractionId: extraction.id },
  });
  const context = { workspaceId: workspace.id, userId: user.id };
  return { context, user, workspace, work, edition, source, blob, doc, extraction };
}

async function correctionInput(value: Awaited<ReturnType<typeof fixture>>, values: Record<string, string> = { title: "Corrected Title" }) {
  const preview = await readProductIdentityPreviewForUser(value.context, value.doc.id);
  const product = preview.product!;
  return {
    sourceDocumentId: value.doc.id,
    expectedExtractionId: preview.currentExtractionId!,
    expectedWorkId: product.workId,
    expectedEditionId: product.editionId,
    expectedWorkUpdatedAt: product.workUpdatedAt,
    expectedEditionUpdatedAt: product.editionUpdatedAt,
    expectedValues: {
      title: product.title, language: product.language, isbn10: product.isbn10, isbn13: product.isbn13,
    },
    values,
    reason: "Verified against the physical book",
  };
}

afterEach(async () => {
  const ids = [...workspaceIds];
  if (ids.length) {
    const where = { workspaceId: { in: ids } };
    await prisma.productIdentityManualEdit.deleteMany({ where });
    await prisma.productIdentityPromotion.deleteMany({ where });
    await prisma.currentDocumentExtraction.deleteMany({ where });
    await prisma.documentExtraction.deleteMany({ where });
    await prisma.ingestionRun.deleteMany({ where });
    await prisma.job.deleteMany({ where });
    await prisma.sourceDocument.deleteMany({ where });
    await prisma.source.deleteMany({ where });
    await prisma.edition.deleteMany({ where });
    await prisma.work.deleteMany({ where });
    await prisma.sourceBlob.deleteMany({ where });
    await prisma.workspaceMember.deleteMany({ where });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (ids.length) await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
  workspaceIds.length = 0;
  userIds.length = 0;
});

describe("04C-4C4A manual corrections: real PostgreSQL authority and audit", () => {
  it("atomically updates authorized fields with exact before/after actor evidence", async () => {
    const value = await fixture();
    const input = await correctionInput(value, { title: "Corrected Title", isbn13: "ISBN-13: 978-0-306-40615-7" });
    const result = await correctProductIdentityForUser(value.context, input);
    expect(result.status).toBe("APPLIED");
    const work = await prisma.work.findUniqueOrThrow({ where: { id: value.work.id } });
    const edition = await prisma.edition.findUniqueOrThrow({ where: { id: value.edition.id } });
    expect(work.title).toBe("Corrected Title");
    expect(edition.isbn13).toBe("9780306406157");
    expect(edition.language).toBe("en");
    const history = await prisma.productIdentityManualEdit.findMany({ where: { sourceId: value.source.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      actorUserId: value.user.id, reason: input.reason, workId: value.work.id,
      editionId: value.edition.id, sourceDocumentId: value.doc.id,
      extractionId: value.extraction.id,
      changes: {
        "work.title": { before: "Original Title", after: "Corrected Title" },
        "edition.isbn13": { before: null, after: "9780306406157" },
      },
    });
    const preview = await readProductIdentityPreviewForUser(value.context, value.doc.id);
    expect(preview.product?.title).toBe("Corrected Title");
    expect(preview.recentCorrections).toHaveLength(1);
    expect(preview.candidate?.title?.value).toBe("Original Title");
    expect(await prisma.productIdentityPromotion.count({ where: { workspaceId: value.workspace.id } })).toBe(0);
  });

  it("guards all fields against concurrent edit based on the same observed revisions/snapshot", async () => {
    const value = await fixture();
    const observed = await correctionInput(value);
    const outcomes = await Promise.all([
      correctProductIdentityForUser(value.context, { ...observed, values: { title: "First human title" } }),
      correctProductIdentityForUser(value.context, { ...observed, values: { title: "Second human title" } }),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["APPLIED", "CONFLICT"]);
    expect(await prisma.productIdentityManualEdit.count({ where: { sourceId: value.source.id } })).toBe(1);
    expect(["First human title", "Second human title"]).toContain(
      (await prisma.work.findUniqueOrThrow({ where: { id: value.work.id } })).title,
    );
  });

  it("does not mutate on stale extraction or a superseded SourceDocument", async () => {
    const value = await fixture();
    const input = await correctionInput(value);
    expect((await correctProductIdentityForUser(value.context, { ...input, expectedExtractionId: "stale-extraction" })).status).toBe("STALE");
    const newDoc = await prisma.sourceDocument.create({ data: {
      workspaceId: value.workspace.id, sourceId: value.source.id,
      sourceBlobId: value.blob.id, version: 2, sha256: value.blob.sha256,
      sizeBytes: value.blob.sizeBytes, mediaType: value.doc.mediaType, storageKey: value.blob.storageKey,
    } });
    expect(newDoc.version).toBe(2);
    expect((await correctProductIdentityForUser(value.context, input)).status).toBe("SUPERSEDED");
    expect((await prisma.work.findUniqueOrThrow({ where: { id: value.work.id } })).title).toBe("Original Title");
    expect(await prisma.productIdentityManualEdit.count({ where: { sourceId: value.source.id } })).toBe(0);
  });

  it("denies viewers and cross-workspace mutation before any user-owned write", async () => {
    const value = await fixture();
    const other = await fixture();
    const input = await correctionInput(value);
    await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: value.workspace.id, userId: value.user.id } },
      data: { role: "VIEWER" },
    });
    await expect(correctProductIdentityForUser(value.context, input)).rejects.toThrow("WORKSPACE_WRITE_ACCESS_DENIED");
    await expect(correctProductIdentityForUser(other.context, input)).rejects.toThrow("SOURCE_DOCUMENT_ACCESS_DENIED");
    expect(await prisma.productIdentityManualEdit.count({ where: { workspaceId: value.workspace.id } })).toBe(0);
  });

  it("rejects clearing fields, malformed ISBN and empty reasons without a write or audit", async () => {
    const value = await fixture();
    const input = await correctionInput(value);
    await expect(correctProductIdentityForUser(value.context, { ...input, values: { title: "" } }))
      .rejects.toThrow("PRODUCT_IDENTITY_CORRECTION_INVALID");
    await expect(correctProductIdentityForUser(value.context, { ...input, values: { isbn13: "9780000000000" } }))
      .rejects.toThrow("PRODUCT_IDENTITY_CORRECTION_INVALID");
    await expect(correctProductIdentityForUser(value.context, { ...input, reason: "" }))
      .rejects.toThrow("PRODUCT_IDENTITY_CORRECTION_INVALID");
    expect(await prisma.productIdentityManualEdit.count({ where: { workspaceId: value.workspace.id } })).toBe(0);
  });

  it("future EPUB promotion cannot overwrite a manual title; conflict remains immutable", async () => {
    const value = await fixture();
    const input = await correctionInput(value);
    expect((await correctProductIdentityForUser(value.context, input)).status).toBe("APPLIED");
    const outcome = await promoteCurrentProductIdentityForUser(value.context, {
      sourceDocumentId: value.doc.id, expectedExtractionId: value.extraction.id,
    });
    expect(outcome.status).toBe("CONFLICT");
    expect((await prisma.work.findUniqueOrThrow({ where: { id: value.work.id } })).title).toBe("Corrected Title");
    expect(await prisma.productIdentityManualEdit.count({ where: { sourceId: value.source.id } })).toBe(1);
  });
});
