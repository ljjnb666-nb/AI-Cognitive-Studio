import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PDFDocument from "pdfkit";

/**
 * Synthetic fixture generator (Phase 1 spec #21/#22).
 * All content is generated here — no copyrighted material is read, written,
 * or committed. Real PDFs land on D:\ai-cognitive-pdf-benchmark-data\fixtures
 * (gitignored location); only the manifest is committed into the worktree.
 *
 * SYNTHETIC-only caveat: results on these fixtures may only state that parsers
 * run and the harness works — never quality conclusions.
 */

const DATA_ROOT = process.env.BENCH_DATA_ROOT ?? "D:\\ai-cognitive-pdf-benchmark-data";
const FIXTURES_DIR = join(DATA_ROOT, "fixtures");

const FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\Deng.ttf",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\simsun.ttc",
];

function cjkFont() {
  for (const candidate of FONT_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error("NO_CJK_FONT_FOUND");
}

function startDoc(path, margin = 64) {
  const doc = new PDFDocument({ size: "A4", margin, info: { Title: path } });
  const stream = createWriteStream(path);
  doc.pipe(stream);
  const done = new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return { doc, done };
}

async function endDoc(handle) {
  handle.doc.end();
  await handle.done;
}

const CN_SENTENCES = [
  "文档解析基准测试使用合成中文文本验证解析器的基本能力。",
  "这一段包含常见标点符号:顿号、逗号,以及句号和问号?还有冒号:引号“示例”。",
  "中文排版与西文混排时会出现 English words inside Chinese paragraphs 的情况。",
  "自然语言处理系统需要稳定的分块与引用定位能力,以支撑下游分析。",
  "数字与单位也需要正确抽取,例如 2026 年 9 月 19 日,温度 25.5 摄氏度,速度 3.2 m/s。",
];

function fillCnParagraphs(doc, pageIndex) {
  doc.fontSize(12).font(cjkFont());
  for (let line = 0; line < 18; line++) {
    const sentence = CN_SENTENCES[(pageIndex * 3 + line) % CN_SENTENCES.length];
    doc.text(`${sentence} (第 ${pageIndex + 1} 页,第 ${line + 1} 行)`);
    doc.moveDown(0.6);
  }
}

async function makeNativeCn() {
  const path = join(FIXTURES_DIR, "F1-native-cn.pdf");
  const handle = startDoc(path);
  for (let page = 0; page < 5; page++) {
    handle.doc.fontSize(20).text(`合成中文文档 第一章 第 ${page + 1} 节`, { align: "center" });
    handle.doc.moveDown(1);
    fillCnParagraphs(handle.doc, page);
    if (page < 4) handle.doc.addPage();
  }
  await endDoc(handle);
  return { path, pages: 5 };
}

async function makeMulticolumn() {
  const path = join(FIXTURES_DIR, "F2-multicolumn.pdf");
  const handle = startDoc(path);
  const doc = handle.doc;
  const pageWidth = 595.28 - 128;
  const columnWidth = pageWidth / 2 - 12;
  for (let page = 0; page < 4; page++) {
    doc.fontSize(16).font("Helvetica").text(`Two-Column Layout Sample — Page ${page + 1}`, { align: "center" });
    doc.moveDown(1);
    const baseY = doc.y;
    for (const column of [0, 1]) {
      doc.x = 64 + column * (columnWidth + 24);
      doc.y = baseY;
      doc.fontSize(11).text(
        `Column ${column + 1}: ` +
          "Structured extraction must preserve the reading order across side-by-side text columns. ".repeat(14) +
          `This is the end of column ${column + 1} on page ${page + 1}.`,
        { width: columnWidth },
      );
    }
    doc.x = 64;
    if (page < 3) doc.addPage();
  }
  await endDoc(handle);
  return { path, pages: 4 };
}

function renderCnTextToPng(lines, outPath) {
  // PowerShell System.Drawing renders the raster; pdfkit only embeds it.
  const psLines = lines.map((line) => line.replaceAll("'", "''"));
  const script = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(1240, 1754)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Microsoft YaHei', 26)
$brush = [System.Drawing.Brushes]::Black
$y = 60
$strings = @('${psLines.join("','")}')
foreach ($line in $strings) {
  $graphics.DrawString($line, $font, $brush, 50, $y)
  $y += 68
}
$graphics.Dispose()
$bmp.Save('${outPath.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`;
  const scriptPath = join(tmpdir(), `bench-f3-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
  // UTF-8 BOM is mandatory: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
  writeFileSync(scriptPath, "\uFEFF" + script, "utf8");
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`PNG render failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

async function makeScannedCn() {
  const path = join(FIXTURES_DIR, "F3-scanned-cn.pdf");
  const pages = 3;
  const handle = startDoc(path, 0);
  for (let page = 0; page < pages; page++) {
    const pngPath = join(tmpdir(), `bench-f3-page${page}-${Math.random().toString(16).slice(2)}.png`);
    await renderCnTextToPng(
      Array.from({ length: 16 }, (_, line) => `扫描页面模拟 ${page + 1}-${line + 1}:这是光栅化后的中文文本,不应有可提取的内嵌文字层。`),
      pngPath,
    );
    handle.doc.image(pngPath, 0, 0, { width: 595.28, height: 841.89 });
    if (page < pages - 1) handle.doc.addPage();
  }
  await endDoc(handle);
  return { path, pages };
}

async function makeTextbookComplex() {
  const path = join(FIXTURES_DIR, "F4-textbook-complex.pdf");
  const handle = startDoc(path);
  const doc = handle.doc;
  doc.fontSize(22).font("Helvetica-Bold").text("Chapter 3: Composite Layouts", { align: "left" });
  doc.moveDown(0.5);
  doc.fontSize(12).font("Helvetica").text("Textbooks combine headings, body text, ruled tables, figures and footnotes on one page.");
  doc.moveDown(1);

  doc.fontSize(14).font("Helvetica-Bold").text("3.1 A Ruled Table");
  doc.moveDown(0.5);
  const tableX = 64, tableY = doc.y, colWidth = 110, rowHeight = 24;
  const header = ["Parser", "Pages", "Notes"];
  const rows = [["alpha", "12", "synthetic"], ["beta", "7", "synthetic"], ["gamma", "19", "synthetic"]];
  doc.font("Helvetica");
  const drawRow = (cells, rowIndex) => {
    const rowY = tableY + rowIndex * rowHeight;
    cells.forEach((cell, index) => {
      doc.rect(tableX + index * colWidth, rowY, colWidth, rowHeight).stroke();
      doc.fontSize(10).text(cell, tableX + index * colWidth + 6, rowY + 6, { width: colWidth - 12 });
    });
  };
  drawRow(header, 0);
  rows.forEach((row, rowIndex) => drawRow(row, rowIndex + 1));
  doc.y = tableY + rowHeight * (rows.length + 1) + 16;

  doc.fontSize(14).font("Helvetica-Bold").text("3.2 A Synthetic Figure");
  doc.moveDown(0.5);
  const figureY = doc.y;
  doc.circle(200, figureY + 60, 40).lineWidth(1.5).stroke();
  doc.rect(300, figureY + 20, 120, 80).lineWidth(1.5).stroke();
  doc.moveTo(240, figureY + 60).lineTo(300, figureY + 60).lineWidth(1.5).stroke();
  doc.fontSize(10).text("Figure 3-1: synthetic diagram (circle, rectangle, connector).", 150, figureY + 120, { width: 300, align: "center" });
  doc.y = figureY + 150;

  doc.fontSize(12).font("Helvetica").text(
    "The body text continues after the figure. Footnote markers appear below the rule line, and the layout must not confuse them with body paragraphs.".repeat(3),
  );
  doc.moveDown(2);
  doc.moveTo(64, doc.y).lineTo(531, doc.y).lineWidth(0.75).stroke();
  doc.moveDown(0.3);
  doc.fontSize(9).text("1. Synthetic footnote one for layout testing only.");
  doc.text("2. Synthetic footnote two; no real publication is referenced.");

  await endDoc(handle);
  return { path, pages: 1 };
}

async function makeLongBook() {
  const path = join(FIXTURES_DIR, "F5-long-book.pdf");
  const handle = startDoc(path);
  const doc = handle.doc;
  const total = 520;
  for (let page = 0; page < total; page++) {
    doc.fontSize(18).font("Helvetica-Bold").text(`Synthetic Volume — Page ${page + 1}`);
    doc.moveDown(0.5);
    doc.fontSize(11).font("Helvetica").text(
      `Section ${Math.floor(page / 10) + 1}.${page % 10 + 1}. ` +
        "This synthetic long book stresses page-count handling, cross-page paragraph flow and memory behavior. " +
        "No real publication is reproduced here. ".repeat(6),
    );
    if (page < total - 1) doc.addPage();
  }
  await endDoc(handle);
  return { path, pages: total };
}

async function makeWarmup() {
  const path = join(FIXTURES_DIR, "warmup.pdf");
  const handle = startDoc(path);
  handle.doc.fontSize(14).font("Helvetica").text("Warmup document for untimed model preload runs.");
  handle.doc.addPage();
  handle.doc.text("Second page so multi-page initialization happens during preload.");
  await endDoc(handle);
  return { path, pages: 2 };
}

async function makeInvalidPdf() {
  const path = join(FIXTURES_DIR, "not-a-pdf.pdf");
  writeFileSync(path, "This is deliberately not a PDF document. It only has a .pdf extension.\n".repeat(20), "utf8");
  return { path, pages: 0 };
}

const manifest = { fixtures: [] };

async function main() {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const generators = [
    ["F1-native-cn", makeNativeCn, "native-cn"],
    ["F2-multicolumn", makeMulticolumn, "multicolumn"],
    ["F3-scanned-cn", makeScannedCn, "scanned"],
    ["F4-textbook-complex", makeTextbookComplex, "textbook"],
    ["F5-long-book", makeLongBook, "long-book"],
    ["warmup", makeWarmup, "warmup"],
    ["not-a-pdf", makeInvalidPdf, "malformed"],
  ];
  for (const [id, generator, fixtureClass] of generators) {
    process.stdout.write(`generating ${id}... `);
    const { path, pages } = await generator();
    console.log("ok");
    manifest.fixtures.push({
      id,
      filename: path.split(/[\\/]/).pop(),
      fixtureClass,
      generator: "scripts/make-fixtures.mjs (synthetic, no copyrighted content)",
      declaredPages: pages,
      notes: id === "not-a-pdf" ? "invalid input fixture for failure-isolation testing" : "synthetic",
    });
  }
  const manifestJson = JSON.stringify(manifest, null, 2);
  await writeFile(join(FIXTURES_DIR, "fixtures.manifest.json"), manifestJson, "utf8");
  // committed copy (manifest only, never the PDFs)
  const toolFixtureDir = join(import.meta.dirname, "..", "fixtures");
  mkdirSync(toolFixtureDir, { recursive: true });
  await writeFile(join(toolFixtureDir, "fixtures.manifest.json"), manifestJson, "utf8");
  console.log(`manifest written to ${FIXTURES_DIR} and tool fixtures/`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
