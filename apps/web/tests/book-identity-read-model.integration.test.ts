import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { projectBookDisplay } from "../lib/book-display";
import { sourceDetail, sources } from "../lib/product";
import type { WebIdentityContext } from "../lib/identity";

const workspaceIds: string[] = [];
const userIds: string[] = [];

async function createWorkspace() {
  const user = await prisma.user.create({
    data: { email: "book-read-" + crypto.randomUUID() + "@test.invalid", name: "Read Model" },
  });
  const workspace = await prisma.workspace.create({
    data: { name: "book-read-" + crypto.randomUUID() },
  });
  userIds.push(user.id);
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({
    data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" },
  });
  const identity: WebIdentityContext = {
    userId: user.id,
    workspaceId: workspace.id,
    userName: user.name,
    email: user.email,
    workspaces: [{ id: workspace.id, name: workspace.name }],
  };
  return identity;
}

async function makeSource(workspaceId: string, fileName: string, versionCount: number, mediaType = "application/epub+zip") {
  const source = await prisma.source.create({
    data: { workspaceId, kind: "FILE", displayName: fileName },
  });
  const documents: Array<{ id: string; version: number }> = [];
  for (let version = 1; version <= versionCount; version++) {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const blob = await prisma.sourceBlob.create({
      data: {
        workspaceId,
        sha256: nonce,
        sizeBytes: 1,
        mediaType,
        storageKey: "book-read/" + nonce,
      },
    });
    const document = await prisma.sourceDocument.create({
      data: {
        workspaceId, sourceId: source.id, sourceBlobId: blob.id, version,
        sha256: blob.sha256, sizeBytes: blob.sizeBytes,
        mediaType, storageKey: blob.storageKey,
      },
    });
    documents.push({ id: document.id, version: document.version });
  }
  return { source, documents };
}

afterEach(async () => {
  if (workspaceIds.length) {
    const where = { workspaceId: { in: workspaceIds } };
    await prisma.sourceDocument.deleteMany({ where });
    await prisma.source.deleteMany({ where });
    await prisma.edition.deleteMany({ where });
    await prisma.work.deleteMany({ where });
    await prisma.sourceBlob.deleteMany({ where });
    await prisma.workspaceMember.deleteMany({ where });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (workspaceIds.length) await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  workspaceIds.length = 0;
  userIds.length = 0;
});

describe("04C-4C3 authoritative Source/Work read model (real PostgreSQL)", () => {
  it("never displays unconfirmed EPUB metadata as a book title", async () => {
    const identity = await createWorkspace();
    const sample = await makeSource(identity.workspaceId, "original-unpromoted.epub", 1);
    const list = await sources(identity);
    const item = list.find((entry) => entry.id === sample.documents[0]!.id);
    expect(item).toMatchObject({
      title: "original-unpromoted.epub",
      titleOrigin: "FILENAME",
      fileName: "original-unpromoted.epub",
      version: 1,
      isLatestVersion: true,
    });
    const detail = await sourceDetail(sample.documents[0]!.id, identity);
    expect(projectBookDisplay({
      fileName: detail.source.displayName,
      workTitle: detail.source.edition?.work.title,
      version: detail.version,
      isLatestVersion: detail.source.documents[0]?.id === detail.id,
    }).title).toBe("original-unpromoted.epub");
  });

  it("uses the Source-linked Work.title for every document version while marking old versions", async () => {
    const identity = await createWorkspace();
    const sample = await makeSource(identity.workspaceId, "edition-original.epub", 2);
    const work = await prisma.work.create({ data: { workspaceId: identity.workspaceId, title: "经过确认的中文书名" } });
    const edition = await prisma.edition.create({ data: { workspaceId: identity.workspaceId, workId: work.id, language: "zh-CN" } });
    await prisma.source.update({
      where: { id_workspaceId: { id: sample.source.id, workspaceId: identity.workspaceId } },
      data: { editionId: edition.id },
    });

    const list = await sources(identity);
    const first = list.find((item) => item.id === sample.documents[0]!.id)!;
    const second = list.find((item) => item.id === sample.documents[1]!.id)!;
    expect(first).toMatchObject({
      title: "经过确认的中文书名", titleOrigin: "WORK",
      fileName: "edition-original.epub", version: 1, isLatestVersion: false,
    });
    expect(second).toMatchObject({
      title: "经过确认的中文书名", titleOrigin: "WORK",
      fileName: "edition-original.epub", version: 2, isLatestVersion: true,
    });

    const oldDetail = await sourceDetail(sample.documents[0]!.id, identity);
    const newDetail = await sourceDetail(sample.documents[1]!.id, identity);
    for (const item of [oldDetail, newDetail]) {
      expect(item.source.edition?.work.title).toBe("经过确认的中文书名");
      expect(item.source.displayName).toBe("edition-original.epub");
    }
    expect(oldDetail.source.documents[0]?.id).toBe(newDetail.id);

    // Read-after-write: manual authoritative changes become visible without
    // re-ingestion, rewriting SourceDocument or promoting old EPUB evidence.
    await prisma.work.update({ where: { id: work.id }, data: { title: "人工修订后的正式书名" } });
    const after = await sources(identity);
    expect(after.filter((item) => sample.documents.some((doc) => doc.id === item.id)).map((item) => item.title))
      .toEqual(["人工修订后的正式书名", "人工修订后的正式书名"]);
  });

  it("preserves strict workspace isolation, including Work title and detail lookup", async () => {
    const own = await createWorkspace();
    const other = await createWorkspace();
    const ownSource = await makeSource(own.workspaceId, "ours.pdf", 1, "application/pdf");
    const privateSource = await makeSource(other.workspaceId, "their-private.epub", 1);
    const foreignWork = await prisma.work.create({ data: { workspaceId: other.workspaceId, title: "不能泄露的正式书名" } });
    const foreignEdition = await prisma.edition.create({ data: { workspaceId: other.workspaceId, workId: foreignWork.id } });
    await prisma.source.update({
      where: { id_workspaceId: { id: privateSource.source.id, workspaceId: other.workspaceId } },
      data: { editionId: foreignEdition.id },
    });

    const list = await sources(own);
    expect(list.map((item) => item.id)).toEqual([ownSource.documents[0]!.id]);
    expect(list[0]).toMatchObject({ title: "ours.pdf", titleOrigin: "FILENAME" });
    await expect(sourceDetail(privateSource.documents[0]!.id, own)).rejects.toThrow("SOURCE_DOCUMENT_ACCESS_DENIED");
  });
});
