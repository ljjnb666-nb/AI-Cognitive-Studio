/**
 * Bounded one-page raster preview child. Only invoked on explicit opt-in.
 * Reads local one-shot PDF bytes, never writes source text or contacts services.
 */
import { writeFile } from "node:fs/promises";
import {createReadStream} from "node:fs";
import {openLocalPdfRange} from "./pdf-local-range.mjs";
import process from "node:process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
// Use the exact canvas runtime resolved by this pinned PDF.js installation.
const { createCanvas } = createRequire(import.meta.resolve("pdfjs-dist/package.json"))("@napi-rs/canvas");
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const [source, indexText, output, maxPixelsText] = process.argv.slice(2);
const index = Number(indexText);
const maxPixels = Number(maxPixelsText);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let task;
let range;
let stage = "INPUT";
try {
  if (!Number.isSafeInteger(index) || index < 0 ||
      !Number.isSafeInteger(maxPixels) || maxPixels < 100_000 || maxPixels > 8_000_000) {
    throw new Error("ARGS_INVALID");
  }
  let size=0;const digest=createHash("sha256");
  for await(const bytes of createReadStream(source)){size+=bytes.length;if(size>512_000_000)throw new Error("PDF_SIZE_INVALID");digest.update(bytes);}
  if(size<5)throw new Error("PDF_SIZE_INVALID");
  const sourceSha256=digest.digest("hex");
  stage = "LOAD_PDF";
  range=await openLocalPdfRange(source,()=>{void task?.destroy();});
  task = getDocument({ range,length:range.length,disableAutoFetch:true,disableStream:true,rangeChunkSize:65536, disableWorker: true, isEvalSupported: false,
    useSystemFonts: false, stopAtErrors: true });
  const document = await task.promise;
  if (index >= document.numPages) throw new Error("PAGE_OUT_OF_RANGE");
  stage = "SELECT_PAGE";
  const page = await document.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1.5 });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (width < 1 || height < 1 || width * height > maxPixels) {
    throw new Error("PIXEL_BUDGET_EXCEEDED");
  }
  stage = "CREATE_CANVAS";
  const canvas = createCanvas(width, height);
  stage = "RENDER_PAGE";
  await page.render({ canvasContext: canvas.getContext("2d"), viewport,
    canvas, background: "rgb(255,255,255)" }).promise;
  stage = "ENCODE_PNG";
  const png = await canvas.encode("png");
  if (png.length < 40 || png.length > 8_000_000) throw new Error("PNG_BUDGET_EXCEEDED");
  stage = "WRITE_PNG";
  await writeFile(output, png, { flag: "wx", mode: 0o600 });
  stage = "CLEANUP";
  // LoadingTask owns the PDF.js worker and transport lifecycle. Avoid
  // separately destroying the page + document (double-close on Node.js).
  await task.destroy();
  task = undefined;
  await range.close();range=undefined;
  process.stdout.write(JSON.stringify({
    schemaVersion: 1, status: "PREVIEW_ONLY", physicalPageIndex: index,
    width, height, pngBytes: png.length, pngSha256: sha(png),
    sourceSha256,
  })+"\n");

} catch {
  // Only a static stage marker crosses the boundary. No source contents.
  process.stdout.write(JSON.stringify({schemaVersion:1,status:"REJECTED",stage})+"\n");
  process.exitCode = 2;
} finally {
  if (task) {
    try { await task.destroy(); } catch { /* cleanup best-effort */ }
  }
  if(range)await range.close().catch(()=>undefined);
}
