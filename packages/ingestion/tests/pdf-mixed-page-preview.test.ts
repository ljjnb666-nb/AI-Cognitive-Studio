import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARSER_LIMITS, extractNativePdf } from "../src/document-parsers.js";
import { renderPdfMixedPageSourcePreviews, PDF_MIXED_PREVIEW_AUTHORITY } from "../src/pdf-mixed-page-preview.js";

const testPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function pdf(mixed: boolean): Promise<Uint8Array> {
  const document = new PDFDocument({ autoFirstPage: false });
  const stream = new PassThrough(), chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Uint8Array>((resolve) =>
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)))));
  document.pipe(stream);
  document.addPage();
  document.text("A paragraph of canonical native source text",50,50);
  if (mixed) document.image(testPng,70,110,{width:90,height:60});
  document.addPage();
  document.text("A second native only page",50,50);
  document.end();
  return await done;
}

describe("opt-in mixed PDF page image preview — real isolated child", () => {
  it("renders a real source-bound mixed PDF into PNG without changing publication or routing", async () => {
    const input = await pdf(true);
    const previous = await extractNativePdf(input,DEFAULT_PARSER_LIMITS);
    const previousPlan = JSON.stringify(previous.routingPlan);
    expect(previous.routingPlan.pages.map(p=>p.route)).toEqual(["NATIVE_TEXT","NATIVE_TEXT"]);
    const r = await renderPdfMixedPageSourcePreviews(input,DEFAULT_PARSER_LIMITS,{
      enabled:true,maxPreviewPages:2,maxPixels:4_000_000,timeoutMs:45_000,
    });
    expect(r).toMatchObject({
      pageCount:2,mixedPageCount:1,previewCount:1,
      productionRoutingChanged:false,goldApproved:false,
    });
    const item = r.previews[0]!;
    expect(item).toMatchObject({
      authority:PDF_MIXED_PREVIEW_AUTHORITY,physicalPageIndex:0,
      sourceSha256:digest(input),figureSemantics:"UNVERIFIED",
      canonicalTextChanged:false,
    });
    expect(item.width*item.height).toBeGreaterThan(100_000);
    expect(item.pngBytes.subarray(0,8)).toEqual(
      new Uint8Array([137,80,78,71,13,10,26,10]));
    expect(item.pngSha256).toBe(digest(item.pngBytes));
    expect(JSON.stringify(previous.routingPlan)).toBe(previousPlan);
  }, 60_000);

  it("does not manufacture an image for an ordinary native-text PDF", async () => {
    const r = await renderPdfMixedPageSourcePreviews(await pdf(false),DEFAULT_PARSER_LIMITS,{enabled:true});
    expect(r.mixedPageCount).toBe(0);
    expect(r.previewCount).toBe(0);
    expect(r.previews).toEqual([]);
  },30_000);

  it("fail-closes on disabled/oversized preview settings before spawning a child", async () => {
    const data = await pdf(true);
    await expect(renderPdfMixedPageSourcePreviews(data,DEFAULT_PARSER_LIMITS,{
      enabled:false as true,
    })).rejects.toThrow("PDF_MIXED_PREVIEW_OPTIONS_INVALID");
    await expect(renderPdfMixedPageSourcePreviews(data,DEFAULT_PARSER_LIMITS,{
      enabled:true,maxPixels:50,
    })).rejects.toThrow("PDF_MIXED_PREVIEW_OPTIONS_INVALID");
    await expect(renderPdfMixedPageSourcePreviews(data,DEFAULT_PARSER_LIMITS,{
      enabled:true,maxPreviewPages:40,
    })).rejects.toThrow("PDF_MIXED_PREVIEW_OPTIONS_INVALID");
  });

  it("rejects a real rendered mixed page exceeding its hard pixel budget", async () => {
    const input = await pdf(true);
    await expect(renderPdfMixedPageSourcePreviews(input,DEFAULT_PARSER_LIMITS,{
      enabled:true,maxPixels:100_000,timeoutMs:45_000,
    })).rejects.toThrow("PDF_MIXED_PREVIEW_CHILD_REJECTED");
  },60_000);
});
