import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { getDocument, PasswordResponses, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { openLocalPdfRange } from "./pdf-local-range.mjs";

const [input, pagesText, outputChars] = process.argv.slice(2);
const maxPages = Number(pagesText), maxOutputChars = Number(outputChars);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// The existing small-PDF path is intentionally unchanged. Larger PDFs use
// on-demand local file ranges, rather than allocating the whole input at once
// inside an already memory-capped PDF.js subprocess.
const PDF_RANGE_THRESHOLD_BYTES = 16 * 1024 * 1024;
const PDF_RANGE_CHUNK_BYTES = 256 * 1024;
const imageOps = [
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject,
].filter((value) => value !== undefined);

let loadingTask;
let fileRange;
try {
  const { size } = await stat(input);
  if (process.env.PDF_RANGE_DIAGNOSTIC === "1") process.stderr.write("PDF_RANGE_START size=" + size + "\n");
  const options = { disableWorker: true, isEvalSupported: false, useSystemFonts: false };
  if (size >= PDF_RANGE_THRESHOLD_BYTES) {
    fileRange = await openLocalPdfRange(input, () => {
      // A failed local range must never be reported as valid PDF extraction.
      // Terminate the isolated child; the fenced parent owns retry/terminal
      // classification and always removes its staged source in finally.
      process.stderr.write("PDF_LOCAL_RANGE_READ_FAILED\n");
      process.exit(2);
    });
    loadingTask = getDocument({
      ...options,
      range: fileRange,
      rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
      disableAutoFetch: true,
      disableStream: true,
    });
  } else {
    const bytes = new Uint8Array(await readFile(input));
    loadingTask = getDocument({ ...options, data: bytes });
  }

  loadingTask.onPassword = (_update, reason) => {
    throw Object.assign(new Error("password"), {
      code: reason === PasswordResponses.NEED_PASSWORD ? "PASSWORD_REQUIRED" : "PASSWORD_REQUIRED",
    });
  };
  const pdf = await loadingTask.promise;
  if (process.env.PDF_RANGE_DIAGNOSTIC === "1") process.stderr.write("PDF_RANGE_LOADED pages=" + pdf.numPages + " requests=" + (fileRange?.diagnosticStats.requests ?? 0) + "\n");
  if (pdf.numPages > maxPages) {
    send({ type: "error", code: "SOURCE_TOO_LARGE" });
    process.exitCode = 2;
  } else {
    let total = 0;
    send({ type: "meta", pages: pdf.numPages });
    for (let number = 1; number <= pdf.numPages; number++) {
      if (process.env.PDF_RANGE_DIAGNOSTIC === "1" && (number === 1 || number % 25 === 0)) process.stderr.write("PDF_RANGE_PAGE_BEGIN=" + number + " rss=" + process.memoryUsage().rss + " requests=" + (fileRange?.diagnosticStats.requests ?? 0) + "\n");
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str : "")).join("");
      total += text.length;
      if (total > maxOutputChars) {
        send({ type: "error", code: "SOURCE_TOO_LARGE" });
        process.exitCode = 2;
        break;
      }
      const operators = await page.getOperatorList();
      let imageCount = 0, vectorPathCount = 0;
      for (const fn of operators.fnArray) {
        if (imageOps.includes(fn)) imageCount++;
        else if (fn === OPS.constructPath) vectorPathCount++;
      }
      const annotations = await page.getAnnotations({ intent: "display" });
      send({
        type: "page",
        physicalPageIndex: number - 1,
        text,
        evidence: {
          rawTextLength: text.length,
          significantTextLength: text.replace(/\s+/g, "").length,
          imageCount,
          vectorPathCount,
          annotationCount: annotations.length,
        },
      });
    }
    if (!process.exitCode) send({ type: "done" });
  }
} catch (error) {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  send({
    type: "error",
    code: code === "PASSWORD_REQUIRED" || /Password/i.test(name)
      ? "SOURCE_PASSWORD_REQUIRED"
      : /InvalidPDF|MissingPDF/i.test(name)
        ? "SOURCE_CORRUPTED"
        : "SOURCE_PARSE_ERROR",
  });
  process.exitCode = 2;
} finally {
  if (loadingTask) await loadingTask.destroy().catch(() => {});
  if (fileRange) await fileRange.close().catch(() => {});
}
