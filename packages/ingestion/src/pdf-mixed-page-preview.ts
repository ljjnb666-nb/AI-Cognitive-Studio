import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractNativePdf, type ParserLimits } from "./document-parsers.js";
import { inspectPdfMixedContentShadow } from "./pdf-mixed-content-shadow.js";
import { spawnBounded } from "./mineru/mineru-process.js";

export const PDF_MIXED_PREVIEW_AUTHORITY = "NON_AUTHORITATIVE_SOURCE_IMAGE_ONLY" as const;
const MAX_SOURCE_BYTES = 110_000_000;
const MAX_PNG_BYTES = 8_000_000;
const PNG_MAGIC = Buffer.from([137,80,78,71,13,10,26,10]);
const sha256 = (input: Uint8Array): string => createHash("sha256").update(input).digest("hex");

export type PdfMixedPageSourcePreview = {
  authority: typeof PDF_MIXED_PREVIEW_AUTHORITY;
  physicalPageIndex: number;
  sourceSha256: string;
  pngSha256: string;
  pngBytes: Uint8Array;
  width: number;
  height: number;
  figureSemantics: "UNVERIFIED";
  canonicalTextChanged: false;
};
export type PdfMixedPageSourcePreviewResult = {
  pageCount: number;
  mixedPageCount: number;
  previewCount: number;
  previews: PdfMixedPageSourcePreview[];
  productionRoutingChanged: false;
  goldApproved: false;
};

export type PdfMixedPreviewOptions = {
  /** Required deliberate opt-in. This helper is not called by production ingestion. */
  enabled: true;
  maxPreviewPages?: number;
  maxPixels?: number;
  timeoutMs?: number;
};

function verifyPng(bytes: Buffer, expectedWidth: number, expectedHeight: number, maxPixels: number): void {
  if (bytes.length < 45 || bytes.length > MAX_PNG_BYTES ||
      !bytes.subarray(0, 8).equals(PNG_MAGIC) ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== expectedWidth || bytes.readUInt32BE(20) !== expectedHeight ||
      expectedWidth < 1 || expectedHeight < 1 ||
      expectedWidth * expectedHeight > maxPixels) {
    throw new Error("PDF_MIXED_PREVIEW_PNG_INVALID");
  }
}
function validatedReply(stdout: string, physicalPageIndex: number,
                        sourceSha256: string, bytes: Buffer, maxPixels: number): {width:number;height:number} {
  let value: Record<string,unknown>;
  try {
    if (Buffer.byteLength(stdout,"utf8") > 1000 || stdout.trim().split("\n").length !== 1) throw Error();
    const candidate: unknown = JSON.parse(stdout.trim());
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw Error();
    value = candidate as Record<string,unknown>;
  } catch {
    throw new Error("PDF_MIXED_PREVIEW_REPLY_INVALID");
  }
  if (Object.keys(value).sort().join(",") !==
      ["height","physicalPageIndex","pngBytes","pngSha256","schemaVersion",
       "sourceSha256","status","width"].sort().join(",") ||
      value.schemaVersion !== 1 || value.status !== "PREVIEW_ONLY" ||
      value.physicalPageIndex !== physicalPageIndex ||
      value.sourceSha256 !== sourceSha256 ||
      !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
      value.pngBytes !== bytes.length || value.pngSha256 !== sha256(bytes)) {
    throw new Error("PDF_MIXED_PREVIEW_REPLY_INVALID");
  }
  const width = value.width as number;
  const height = value.height as number;
  verifyPng(bytes,width,height,maxPixels);
  return {width,height};
}

/**
 * Real, isolated PDF.js source-page rendering for image/vector + native-text
 * mixed pages. Captures pixels for downstream *future* visual review without
 * changing text authority, durable routing, OCR attempts, or publication.
 * No DB / object-store writes. The caller holds the returned private bytes.
 */
export async function renderPdfMixedPageSourcePreviews(
  pdfBytes: Uint8Array,
  limits: ParserLimits,
  options: PdfMixedPreviewOptions,
): Promise<PdfMixedPageSourcePreviewResult> {
  const maxPreviewPages = options.maxPreviewPages ?? 2;
  const maxPixels = options.maxPixels ?? 4_000_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (options.enabled !== true ||
      !Number.isSafeInteger(maxPreviewPages) || maxPreviewPages < 1 || maxPreviewPages > 3 ||
      !Number.isSafeInteger(maxPixels) || maxPixels < 100_000 || maxPixels > 8_000_000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000 ||
      pdfBytes.length < 5 || pdfBytes.length > MAX_SOURCE_BYTES) {
    throw new Error("PDF_MIXED_PREVIEW_OPTIONS_INVALID");
  }
  const native = await extractNativePdf(pdfBytes, limits);
  const report = inspectPdfMixedContentShadow(native.inspections);
  const chosen = report.pages.slice(0,maxPreviewPages);
  if (!chosen.length) return {
    pageCount: native.pageCount, mixedPageCount: 0, previewCount: 0, previews: [],
    productionRoutingChanged: false, goldApproved: false,
  };
  const dir = await mkdtemp(join(tmpdir(),"acs-pdf-visual-"));
  const sourceFile = join(dir,"source.pdf");
  const sourceSha256 = sha256(pdfBytes);
  const previews: PdfMixedPageSourcePreview[] = [];
  try {
    await writeFile(sourceFile,pdfBytes,{flag:"wx",mode:0o600});
    for (const page of chosen) {
      const pngPath = join(dir,`page-${page.physicalPageIndex}.png`);
      const result = await spawnBounded(process.execPath,[
        "--max-old-space-size=384",
        fileURLToPath(new URL("./pdf-mixed-page-render-child.mjs",import.meta.url)),
        sourceFile, String(page.physicalPageIndex), pngPath, String(maxPixels),
      ],{
        env:{...process.env, HTTP_PROXY:"http://127.0.0.1:1",
          HTTPS_PROXY:"http://127.0.0.1:1", ALL_PROXY:"http://127.0.0.1:1"},
        timeoutMs,maxOutputBytes:4096,
      });
      if (result.code !== 0 || result.signal || result.timedOut || result.aborted ||
          result.outputOverflow || result.spawnErrorCode) {
        // Child diagnostics are a fixed stage enum only, never raw parser error
        // strings, stderr, source text or PDF-extracted content.
        let stage = result.stdout.trim() ? "PROTOCOL" : "NO_REPLY";
        for (const line of result.stdout.trim().split(/\\r?\\n/).slice(0, 4)) {
          try {
            const reported: unknown = JSON.parse(line);
            if (reported && typeof reported === "object" && !Array.isArray(reported)) {
              const record = reported as Record<string, unknown>;
              if (record.status === "REJECTED" &&
                  typeof record.stage === "string" &&
                  ["INPUT","LOAD_PDF","SELECT_PAGE","CREATE_CANVAS",
                   "RENDER_PAGE","ENCODE_PNG","WRITE_PNG","CLEANUP"].includes(record.stage)) {
                stage = record.stage;
              } else if (record.status === "PREVIEW_ONLY" && stage !== "UNKNOWN") {
                stage = "ACK_BEFORE_FAILED_EXIT";
              }
            }
          } catch { /* do not expose source-derived errors */ }
        }
        throw new Error("PDF_MIXED_PREVIEW_CHILD_REJECTED:"+stage);
      }
      const bytes = await readFile(pngPath);
      const {width,height} = validatedReply(result.stdout,page.physicalPageIndex,
        sourceSha256,bytes,maxPixels);
      previews.push({
        authority: PDF_MIXED_PREVIEW_AUTHORITY, physicalPageIndex:page.physicalPageIndex,
        sourceSha256,pngSha256:sha256(bytes),pngBytes:new Uint8Array(bytes),
        width,height,figureSemantics:"UNVERIFIED",canonicalTextChanged:false,
      });
    }
    return {
      pageCount:native.pageCount,mixedPageCount:report.mixedPageCount,
      previewCount:previews.length,previews,
      productionRoutingChanged:false,goldApproved:false,
    };
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
}
