/**
 * Bounded one-page raster preview child. Only invoked on explicit opt-in.
 * Reads local one-shot PDF bytes, never writes source text or contacts services.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const [source, indexText, output, maxPixelsText] = process.argv.slice(2);
const index = Number(indexText);
const maxPixels = Number(maxPixelsText);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let task;
try {
  if (!Number.isSafeInteger(index) || index < 0 ||
      !Number.isSafeInteger(maxPixels) || maxPixels < 100_000 || maxPixels > 8_000_000) {
    throw new Error("ARGS_INVALID");
  }
  const bytes = new Uint8Array(await readFile(source));
  if (bytes.length < 5 || bytes.length > 110_000_000) throw new Error("PDF_SIZE_INVALID");
  task = getDocument({ data: bytes, disableWorker: true, isEvalSupported: false,
    useSystemFonts: false, stopAtErrors: true });
  const document = await task.promise;
  if (index >= document.numPages) throw new Error("PAGE_OUT_OF_RANGE");
  const page = await document.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1.5 });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (width < 1 || height < 1 || width * height > maxPixels) {
    throw new Error("PIXEL_BUDGET_EXCEEDED");
  }
  const canvas = createCanvas(width, height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport,
    canvas, background: "rgb(255,255,255)" }).promise;
  const png = await canvas.encode("png");
  if (png.length < 40 || png.length > 8_000_000) throw new Error("PNG_BUDGET_EXCEEDED");
  await writeFile(output, png, { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({
    schemaVersion: 1, status: "PREVIEW_ONLY", physicalPageIndex: index,
    width, height, pngBytes: png.length, pngSha256: sha(png),
    sourceSha256: sha(bytes),
  })+"\n");
  page.cleanup();
  await document.destroy();
  await task.destroy();
} catch {
  // Never surface parser library messages or PDF text in logs.
  process.stdout.write('{"schemaVersion":1,"status":"REJECTED"}\n');
  process.exitCode = 2;
} finally {
  if (task) {
    try { await task.destroy(); } catch { /* cleanup best-effort */ }
  }
}
