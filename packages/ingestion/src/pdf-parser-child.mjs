import { readFile } from "node:fs/promises";
import process from "node:process";
import { getDocument, PasswordResponses, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const [input, pagesText, outputChars] = process.argv.slice(2);
const maxPages = Number(pagesText), maxOutputChars = Number(outputChars);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// Content-painting operators that prove raster content without native text
// (BOOK-INGESTION-04B-2 page evidence). constructPath occurrences prove
// vector content; its operator args are intentionally not destructured.
const imageOps = [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].filter((value) => value !== undefined);
try {
  const bytes = new Uint8Array(await readFile(input));
  const loadingTask = getDocument({ data: bytes, disableWorker: true, isEvalSupported: false, useSystemFonts: false });
  loadingTask.onPassword = (_update, reason) => { throw Object.assign(new Error("password"), { code: reason === PasswordResponses.NEED_PASSWORD ? "PASSWORD_REQUIRED" : "PASSWORD_REQUIRED" }); };
  const pdf = await loadingTask.promise;
  if (pdf.numPages > maxPages) { send({ type: "error", code: "SOURCE_TOO_LARGE" }); process.exitCode = 2; }
  else { let total = 0; send({ type: "meta", pages: pdf.numPages }); for (let number = 1; number <= pdf.numPages; number++) { const page = await pdf.getPage(number); const content = await page.getTextContent(); const text = content.items.map((item) => ("str" in item ? item.str : "")).join(""); total += text.length; if (total > maxOutputChars) { send({ type: "error", code: "SOURCE_TOO_LARGE" }); process.exitCode = 2; break; } const operators = await page.getOperatorList(); let imageCount = 0, vectorPathCount = 0; for (const fn of operators.fnArray) { if (imageOps.includes(fn)) imageCount++; else if (fn === OPS.constructPath) vectorPathCount++; } const annotations = await page.getAnnotations({ intent: "display" }); send({ type: "page", physicalPageIndex: number - 1, text, evidence: { rawTextLength: text.length, significantTextLength: text.replace(/\s+/g, "").length, imageCount, vectorPathCount, annotationCount: annotations.length } }); } if (!process.exitCode) send({ type: "done" }); }
} catch (error) { const name = error && typeof error === "object" && "name" in error ? String(error.name) : ""; const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""; send({ type: "error", code: code === "PASSWORD_REQUIRED" || /Password/i.test(name) ? "SOURCE_PASSWORD_REQUIRED" : /InvalidPDF|MissingPDF/i.test(name) ? "SOURCE_CORRUPTED" : "SOURCE_PARSE_ERROR" }); process.exitCode = 2; }
