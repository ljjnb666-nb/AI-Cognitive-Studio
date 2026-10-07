// Generator-of-record for scanned-mixed-real.pdf (BOOK-INGESTION-04B-3 real
// acceptance fixture): page 0 native text, page 1 raster-only (the PIL-rendered
// scan-page.png — no text layer), page 2 native text. Regenerate scan-page.png
// first via generate-scan-page.py, then run this from packages/ingestion.
import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = createWriteStream(join(here, "scanned-mixed-real.pdf"));
const document = new PDFDocument({ autoFirstPage: false, size: "A4" });
document.pipe(out);
document.addPage();
document.text("Native frontier page ALPHA for the 04B-3 real acceptance fixture.");
document.addPage();
document.image(join(here, "scan-page.png"), { width: 595 });
document.addPage();
document.text("Second native page OMEGA closes the 04B-3 real acceptance fixture.");
document.end();
