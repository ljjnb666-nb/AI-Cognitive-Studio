import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";
import { createS3CompatibleStorageProvider } from "@ai-cognitive/storage";
// Playwright Node fixtures must not load the PDF engine (which uses import.meta).
// Canonical JSON key order matches the production source-bound digest contract.
function fixtureGraphSha(value: unknown): string {
  const orderedJson = JSON.stringify(value, (_key, object: unknown) => {
    if (!object || typeof object !== "object" || Array.isArray(object)) return object;
    const record = object as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  });
  return createHash("sha256").update(orderedJson).digest("hex");
}

/** Generated within this test: no private source material or real provider. */
function syntheticTwoPagePdf(): Uint8Array {
  const lines = ["FIRST PDF PHYSICAL PAGE", "SECOND PDF PHYSICAL PAGE"];
  const streams = lines.map(t => "BT /F1 16 Tf 65 715 Td (" + t + ") Tj ET\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + Buffer.byteLength(streams[0]!, "ascii") + " >>\nstream\n" + streams[0] + "endstream",
    "<< /Length " + Buffer.byteLength(streams[1]!, "ascii") + " >>\nstream\n" + streams[1] + "endstream",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += (i + 1) + " 0 obj\n" + objs[i] + "\nendobj\n";
  }
  const xref = Buffer.byteLength(source, "ascii");
  source += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
  for (const off of offsets.slice(1)) source += String(off).padStart(10, "0") + " 00000 n \n";
  source += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\n";
  source += "startxref\n" + xref + "\n%%EOF\n";
  return new Uint8Array(Buffer.from(source, "ascii"));
}
const digest = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const storage = () => createS3CompatibleStorageProvider({
  endpoint: process.env.S3_ENDPOINT!, publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
  region: process.env.S3_REGION!, bucket: process.env.S3_BUCKET!,
  accessKey: process.env.S3_ACCESS_KEY!, secretKey: process.env.S3_SECRET_KEY!,
  forcePathStyle: true,
});

async function createFixture(userId: string, workspaceId: string) {
  const bytes = syntheticTwoPagePdf(), suffix = randomUUID(), sourceSha = digest(bytes);
  const key = "synthetic-browser-pdf-review/" + workspaceId + "/" + suffix + ".pdf";
  await storage().putObject({ key, body: bytes, contentType: "application/pdf" });
  const source = await prisma.source.create({
    data: { workspaceId, kind: "FILE", displayName: "synthetic-human-review.pdf" },
  });
  const blob = await prisma.sourceBlob.create({ data: {
    workspaceId, sha256: sourceSha, sizeBytes: BigInt(bytes.length),
    mediaType: "application/pdf", storageKey: key,
  }});
  const doc = await prisma.sourceDocument.create({ data: {
    workspaceId, sourceId: source.id, sourceBlobId: blob.id,
    version: 1, sha256: sourceSha, sizeBytes: BigInt(bytes.length),
    mediaType: "application/pdf", storageKey: key,
  }});
  const job = await prisma.job.create({ data: {
    userId, workspaceId, type: "pdf-human-browser-e2e", status: "SUCCEEDED", payload: {},
  }});
  const run = await prisma.ingestionRun.create({ data: {
    workspaceId, sourceDocumentId: doc.id, jobId: job.id,
    status: "SUCCEEDED", routingGeneration: 1,
    parserVersion: "synthetic-browser", normalizationVersion: "synthetic-browser",
    routingPlan: { pages: [
      { physicalPageIndex: 0, route: "NATIVE_TEXT" },
      { physicalPageIndex: 1, route: "NATIVE_TEXT" },
    ] },
  }});
  const extraction = await prisma.documentExtraction.create({ data: {
    workspaceId, sourceDocumentId: doc.id, ingestionRunId: run.id,
    status: "SUCCEEDED", parserName: "PDFJS_NATIVE",
    parserVersion: "browser-fixture-v1", normalizationVersion: "browser-fixture-v1",
  }});
  await prisma.currentDocumentExtraction.create({ data: {
    workspaceId, sourceDocumentId: doc.id, extractionId: extraction.id,
  }});
  for (let index = 0; index < 2; index++) {
    const page = await prisma.sourcePage.create({ data: {
      extractionId: extraction.id, ordinal: index, physicalPageIndex: index,
      printedPageLabel: String(20 + index),
    }});
    const text = "Physical page " + (index + 1) + " synthetic extracted evidence";
    await prisma.sourceBlock.create({ data: {
      extractionId: extraction.id, sourcePageId: page.id, ordinal: index,
      kind: "PARAGRAPH", text, contentHash: digest(text),
    }});
  }
  const graph = { schemaVersion: 1, figures: [{
    id: "figure1", kind: "DIAGRAM", bbox: [20, 30, 400, 330],
    caption: "Synthetic source-only diagram",
    nodes: [{ id: "left", label: "Source" }, { id: "right", label: "Target" }],
    edges: [{ from: "left", to: "right", label: "flow", direction: "DIRECTED" }],
  }] };
  const candidate = await prisma.pdfVisualReviewCandidate.create({ data: {
    workspaceId, sourceDocumentId: doc.id, ingestionRunId: run.id,
    physicalPageIndex: 1, routingGeneration: 1,
    sourcePdfSha256: sourceSha, sourcePngSha256: digest("synthetic-second-page-png"),
    candidateJson: graph, candidateSha256: fixtureGraphSha(graph),
    expiresAt: new Date(Date.now() + 3600_000),
  }});
  return { doc, candidate, bytes, key };
}

test("real Chromium: logged-in PDF original page, graph, confirm/withdraw/reject and permissions", async ({
  page, browser,
}, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const email = "pdf-human-browser-" + randomUUID() + "@ai-cognitive-studio.test";
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Human PDF Reviewer");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill("PdfHumanReview!2026");
  await page.locator('input[name="confirmPassword"]').fill("PdfHumanReview!2026");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/studio$/,{timeout:30_000});
  const user = await prisma.user.findUniqueOrThrow({
    where: { email }, include: { memberships: true },
  });
  expect(user.memberships).toHaveLength(1);
  const workspaceId = user.memberships[0]!.workspaceId;
  const f = await createFixture(user.id, workspaceId);
  const route = "/studio/library/" + f.doc.id + "/review?page=1";

  try {
    // No graph candidate on physical page 1: reading the original must still
    // work without paid visual calls, and non-contiguous source pages can be
    // reached by physical page number rather than dozens of Next clicks.
    await page.goto("/studio/library/" + f.doc.id + "/review?physicalPage=1");
    await expect(page.getByRole("heading", {name:"原始 PDF · 第 1 物理页"})).toBeVisible();
    await expect(page.locator('iframe[title*="原始 PDF"]'))
      .toHaveAttribute("src", /source-pdf#page=1$/);
    await expect(page.getByText("Physical page 1 synthetic extracted evidence")).toBeVisible();
    await expect(page.getByText(/此页没有可读取的有效候选/)).toBeVisible();
    await page.getByLabel("跳转到物理页").fill("2");
    await page.getByRole("button", {name:"跳转"}).click();
    await expect(page).toHaveURL(/physicalPage=2/);
    await expect(page.getByRole("heading", {name:"原始 PDF · 第 2 物理页"})).toBeVisible();

    await page.goto(route);
    await expect(page.getByRole("heading", { name: "原始 PDF · 第 2 物理页" })).toBeVisible();
    await expect(page.getByText("Physical page 2 synthetic extracted evidence")).toBeVisible();
    await expect(page.getByText("Synthetic source-only diagram")).toBeVisible();
    await expect(page.getByText("left：Source")).toBeVisible();
    await expect(page.getByText("DIRECTED")).toBeVisible();
    const preview = page.locator('iframe[title*="原始 PDF"]');
    await expect(preview).toHaveAttribute("src", /source-pdf#page=2$/);

    // This tests the actual authenticated browser request for original PDF bytes,
    // not just the presence of an iframe URL. The viewer's rendered pixels are
    // outside the automatic assertion and need manual cross-browser verification.
    const result = await page.request.get(
      "/api/studio/pdf-visual-review/" + f.doc.id + "/source-pdf",
    );
    expect(result.status()).toBe(200);
    expect(result.headers()["content-type"]).toContain("application/pdf");
    expect(result.headers()["cache-control"]).toContain("no-store");
    expect(digest(await result.body())).toBe(digest(f.bytes));
    // Browser sends native byte-range requests when seeking around a long PDF.
    // These must be 206 with accurate Content-Range/Length, not full buffering.
    const firstRange = await page.request.get(
      "/api/studio/pdf-visual-review/" + f.doc.id + "/source-pdf",
      { headers: { Range: "bytes=0-127" } },
    );
    expect(firstRange.status()).toBe(206);
    expect(firstRange.headers()["content-range"]).toBe("bytes 0-127/" + f.bytes.length);
    expect(firstRange.headers()["content-length"]).toBe("128");
    expect(new Uint8Array(await firstRange.body()))
      .toEqual(f.bytes.slice(0,128));
    const tailRange = await page.request.get(
      "/api/studio/pdf-visual-review/" + f.doc.id + "/source-pdf",
      { headers: { Range: "bytes=-32" } },
    );
    expect(tailRange.status()).toBe(206);
    expect(tailRange.headers()["content-range"])
      .toBe("bytes " + (f.bytes.length-32) + "-" + (f.bytes.length-1) + "/" + f.bytes.length);
    expect(new Uint8Array(await tailRange.body()))
      .toEqual(f.bytes.slice(-32));
    const invalidRange = await page.request.get(
      "/api/studio/pdf-visual-review/" + f.doc.id + "/source-pdf",
      { headers: { Range: "bytes=999999999-" } },
    );
    expect(invalidRange.status()).toBe(416);
    const head = await page.request.head(
      "/api/studio/pdf-visual-review/" + f.doc.id + "/source-pdf",
    );
    expect(head.status()).toBe(200);
    expect(head.headers()["content-length"]).toBe(String(f.bytes.length));

    const anonymous = await browser.newContext();
    try {
      const forbidden = await anonymous.request.get(
        "/api/studio/pdf-visual-review/" + f.doc.id + "/source-pdf",
      );
      expect(forbidden.status()).toBe(404);
    } finally { await anonymous.close(); }
    await page.screenshot({path:info.outputPath("review-unverified.png"),fullPage:true});
    const checkbox = page.getByRole("checkbox", {name:/我已实际对照该物理页/});
    await checkbox.check();
    await page.getByRole("button",{name:"确认图结构与原页一致"}).click();
    await expect.poll(() => prisma.pdfVisualHumanReviewEvent.count({
      where:{candidateId:f.candidate.id},
    })).toBe(1);
    await expect(page.getByText("人工已确认结构 · 仍不得直接进入播客")).toBeVisible();
    await expect(page.getByRole("button",{name:"撤回本次结论"})).toBeVisible();
    await checkbox.check();
    await expect(page.getByRole("button",{name:"撤回本次结论"})).toBeEnabled();
    await page.getByRole("button",{name:"撤回本次结论"}).click();
    await expect.poll(() => prisma.pdfVisualHumanReviewEvent.count({
      where:{candidateId:f.candidate.id},
    })).toBe(2);
    await expect(page.getByRole("button",{name:"驳回：图结构不准确"})).toBeVisible();
    await checkbox.check();
    await expect(page.getByRole("button",{name:"驳回：图结构不准确"})).toBeEnabled();
    await page.getByRole("button",{name:"驳回：图结构不准确"}).click();
    await expect.poll(() => prisma.pdfVisualHumanReviewEvent.count({
      where:{candidateId:f.candidate.id},
    })).toBe(3);
    await expect(page.getByText("人工已驳回结构 · 不得进入播客")).toBeVisible();
    const actions = await prisma.pdfVisualHumanReviewEvent.findMany({
      where:{candidateId:f.candidate.id},orderBy:[{createdAt:"asc"},{id:"asc"}],
    });
    expect(actions.map(x=>x.action)).toEqual([
      "CONFIRM_STRUCTURE","WITHDRAW","REJECT_STRUCTURE",
    ]);
    const intact = await prisma.pdfVisualReviewCandidate.findUniqueOrThrow({
      where:{id:f.candidate.id},
    });
    expect(intact.candidateSha256).toBe(f.candidate.candidateSha256);
    expect(await prisma.podcastGenerationRun.count({where:{workspaceId}})).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({path:info.outputPath("review-rejected.png"),fullPage:true});

    // Role downgrade is respected in the browser; no more review writes.
    await prisma.workspaceMember.update({
      where:{workspaceId_userId:{workspaceId,userId:user.id}},data:{role:"VIEWER"},
    });
    await page.reload();
    await expect(page.getByText(/此工作区账号为只读权限/)).toBeVisible();
    expect(await prisma.pdfVisualHumanReviewEvent.count({where:{candidateId:f.candidate.id}})).toBe(3);
  } finally {
    await storage().deleteObject(f.key);
  }
});
