import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PDFDocument from "pdfkit";

/**
 * Synthetic fixture + ground-truth generator (Phase 2B spec #4/#5).
 * Each fixture's PDF and its ground-truth.json are emitted from the SAME
 * constants in one generator — ground truth is never derived from parser
 * output and never hand-guessed. All content is synthetic; no copyrighted
 * material is read, written, or committed. PDFs and ground truth land on
 * D:\ai-cognitive-pdf-benchmark-data\fixtures (gitignored location); only the
 * manifest is committed into the worktree.
 *
 * Ground truth normalization policy (fixed for every fixture): NFKC, then
 * remove all Unicode whitespace; hanzi, digits and punctuation are kept.
 */

const DATA_ROOT = process.env.BENCH_DATA_ROOT ?? "D:\\ai-cognitive-pdf-benchmark-data";
const FIXTURES_DIR = join(DATA_ROOT, "fixtures");
const PAGE_SIZE = { width: 595.28, height: 841.89 };
const NORMALIZATION_POLICY =
  "NFKC then remove all Unicode whitespace; hanzi, digits and punctuation are never removed";

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

/** Builds a ground-truth object from the canonical ordered block list. */
function buildGroundTruth({ fixtureId, pages, ocrRequired = false, ocrRequiredPages = [], blocks, headings = [], lists = [], tables = [], formulas = [], noise = [], ocrKeyPhrases = [] }) {
  const bodyBlocks = blocks.filter((block) => !["header", "footer", "page_number"].includes(block.role));
  return {
    fixtureId,
    generator: "scripts/make-fixtures.mjs (synthetic, no copyrighted content)",
    pages,
    pageSize: PAGE_SIZE,
    ocrRequired,
    ocrRequiredPages,
    normalizationPolicy: NORMALIZATION_POLICY,
    text: bodyBlocks.map((block) => block.text).join(""),
    keyMarkers: [...headings.map((heading) => heading.text), ...bodyBlocks.slice(0, 3).map((block) => block.text)],
    ocrKeyPhrases,
    blocks,
    headings,
    lists,
    tables,
    formulas,
    noise,
  };
}

let blockCounter = 0;
function block(page, column, role, text) {
  blockCounter += 1;
  return { id: `B${blockCounter}`, page, column, role, text };
}
function resetBlocks() {
  blockCounter = 0;
}

const CN_SENTENCES = [
  "文档解析基准测试使用合成中文文本验证解析器的基本能力。",
  "这一段包含常见标点符号:顿号、逗号,以及句号和问号?还有冒号:引号“示例”。",
  "中文排版与西文混排时会出现 English words inside Chinese paragraphs 的情况。",
  "自然语言处理系统需要稳定的分块与引用定位能力,以支撑下游分析。",
  "数字与单位也需要正确抽取,例如 2026 年 9 月 19 日,温度 25.5 摄氏度,速度 3.2 m/s。",
];

async function makeNativeCn() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F1-native-cn.pdf");
  const gtBlocks = [];
  const headings = [];
  const handle = startDoc(path);
  for (let page = 0; page < 5; page++) {
    const heading = `合成中文文档 第一章 第 ${page + 1} 节`;
    headings.push({ page, text: heading });
    gtBlocks.push(block(page, null, "heading", heading));
    // CJK text must ALWAYS be drawn with the CJK font — the pdfkit default
    // (Helvetica) has no CJK glyphs and would emit an unextractable heading.
    handle.doc.fontSize(20).font(cjkFont()).text(heading, { align: "center" });
    handle.doc.moveDown(1);
    handle.doc.fontSize(12).font(cjkFont());
    for (let line = 0; line < 18; line++) {
      const sentence = CN_SENTENCES[(page * 3 + line) % CN_SENTENCES.length];
      const text = `${sentence} (第 ${page + 1} 页,第 ${line + 1} 行)`;
      gtBlocks.push(block(page, null, "paragraph", text));
      handle.doc.text(text);
      handle.doc.moveDown(0.6);
    }
    if (page < 4) handle.doc.addPage();
  }
  await endDoc(handle);
  const groundTruth = buildGroundTruth({ fixtureId: "F1-native-cn", pages: 5, blocks: gtBlocks, headings });
  return { path, pages: 5, groundTruth };
}

async function makeMulticolumn() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F2-multicolumn.pdf");
  const gtBlocks = [];
  const handle = startDoc(path);
  const doc = handle.doc;
  const pageWidth = 595.28 - 128;
  const columnWidth = pageWidth / 2 - 12;
  for (let page = 0; page < 4; page++) {
    const title = `Two-Column Layout Sample — Page ${page + 1}`;
    gtBlocks.push(block(page, null, "heading", title));
    doc.fontSize(16).font("Helvetica").text(title, { align: "center" });
    doc.moveDown(1);
    const baseY = doc.y;
    for (const column of [0, 1]) {
      doc.x = 64 + column * (columnWidth + 24);
      doc.y = baseY;
      const columnText =
        `Column ${column + 1}: Structured extraction must preserve the reading order across side-by-side text columns. ` +
        "The ground truth defines the left column before the right column. ".repeat(6) +
        `Sentinel ${1000 + page * 100 + column * 10}. This is the end of column ${column + 1} on page ${page + 1}.`;
      doc.fontSize(11).text(columnText, { width: columnWidth });
      gtBlocks.push(block(page, column, "paragraph", columnText));
    }
    doc.x = 64;
    if (page < 3) doc.addPage();
  }
  await endDoc(handle);
  const groundTruth = buildGroundTruth({ fixtureId: "F2-multicolumn", pages: 4, blocks: gtBlocks });
  return { path, pages: 4, groundTruth };
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

function scannedLines(pageIndex, lineCount) {
  return Array.from(
    { length: lineCount },
    (_, line) => `扫描页面模拟 ${pageIndex + 1}-${line + 1}:这是光栅化后的中文文本,不应有可提取的内嵌文字层。`,
  );
}

async function makeScannedCn() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F3-scanned-cn.pdf");
  const pages = 3;
  const gtBlocks = [];
  const ocrKeyPhrases = [];
  const handle = startDoc(path, 0);
  for (let page = 0; page < pages; page++) {
    const lines = scannedLines(page, 16);
    const pngPath = join(tmpdir(), `bench-f3-page${page}-${Math.random().toString(16).slice(2)}.png`);
    await renderCnTextToPng(lines, pngPath);
    handle.doc.image(pngPath, 0, 0, { width: 595.28, height: 841.89 });
    for (const line of lines) gtBlocks.push(block(page, null, "paragraph", line));
    ocrKeyPhrases.push({ page, phrase: lines[0] });
    if (page < pages - 1) handle.doc.addPage();
  }
  await endDoc(handle);
  const groundTruth = buildGroundTruth({
    fixtureId: "F3-scanned-cn",
    pages,
    ocrRequired: true,
    ocrRequiredPages: [0, 1, 2],
    blocks: gtBlocks,
    ocrKeyPhrases,
  });
  return { path, pages, groundTruth };
}

function drawRuledTable(doc, { x, y, colWidths, rowHeight, cells, font }) {
  doc.font(font);
  cells.forEach((row, rowIndex) => {
    let cellX = x;
    row.forEach((cell, colIndex) => {
      const width = colWidths[colIndex];
      doc.rect(cellX, y + rowIndex * rowHeight, width, rowHeight).stroke();
      doc.fontSize(10).text(cell, cellX + 6, y + rowIndex * rowHeight + 6, { width: width - 12 });
      cellX += width;
    });
  });
  return y + cells.length * (rowHeight + 0);
}

async function makeTextbookComplex() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F4-textbook-complex.pdf");
  const handle = startDoc(path);
  const doc = handle.doc;
  const gtBlocks = [];
  const headings = [];

  const chapter = "Chapter 3: Composite Layouts";
  headings.push({ page: 0, text: chapter });
  gtBlocks.push(block(0, null, "heading", chapter));
  doc.fontSize(22).font("Helvetica-Bold").text(chapter, { align: "left" });
  doc.moveDown(0.5);

  const intro = "Textbooks combine headings, body text, ruled tables, figures and footnotes on one page.";
  gtBlocks.push(block(0, null, "paragraph", intro));
  doc.fontSize(12).font("Helvetica").text(intro);
  doc.moveDown(1);

  const h31 = "3.1 A Ruled Table";
  headings.push({ page: 0, text: h31 });
  gtBlocks.push(block(0, null, "heading", h31));
  doc.fontSize(14).font("Helvetica-Bold").text(h31);
  doc.moveDown(0.5);

  const header = ["Parser", "Pages", "Notes"];
  const rows = [["alpha", "12", "synthetic"], ["beta", "7", "synthetic"], ["gamma", "19", "synthetic"]];
  const cells = [header, ...rows];
  const tableX = 64, tableY = doc.y, colWidths = [110, 110, 110], rowHeight = 24;
  const tableText = cells.map((row) => row.join(" ")).join("\n");
  gtBlocks.push(block(0, null, "table", tableText));
  drawRuledTable(doc, { x: tableX, y: tableY, colWidths, rowHeight, cells, font: "Helvetica" });
  doc.y = tableY + rowHeight * cells.length + 16;

  const h32 = "3.2 A Synthetic Figure";
  headings.push({ page: 0, text: h32 });
  gtBlocks.push(block(0, null, "heading", h32));
  doc.fontSize(14).font("Helvetica-Bold").text(h32);
  doc.moveDown(0.5);
  const figureY = doc.y;
  doc.circle(200, figureY + 60, 40).lineWidth(1.5).stroke();
  doc.rect(300, figureY + 20, 120, 80).lineWidth(1.5).stroke();
  doc.moveTo(240, figureY + 60).lineTo(300, figureY + 60).lineWidth(1.5).stroke();
  const caption = "Figure 3-1: synthetic diagram (circle, rectangle, connector).";
  gtBlocks.push(block(0, null, "figure", caption));
  doc.fontSize(10).text(caption, 150, figureY + 120, { width: 300, align: "center" });
  doc.y = figureY + 150;

  const body =
    "The body text continues after the figure. Footnote markers appear below the rule line, and the layout must not confuse them with body paragraphs.".repeat(3);
  gtBlocks.push(block(0, null, "paragraph", body));
  doc.fontSize(12).font("Helvetica").text(body);
  doc.moveDown(2);
  doc.moveTo(64, doc.y).lineTo(531, doc.y).lineWidth(0.75).stroke();
  doc.moveDown(0.3);
  const footnote1 = "1. Synthetic footnote one for layout testing only.";
  const footnote2 = "2. Synthetic footnote two; no real publication is referenced.";
  gtBlocks.push(block(0, null, "footnote", footnote1));
  gtBlocks.push(block(0, null, "footnote", footnote2));
  doc.fontSize(9).text(footnote1);
  doc.text(footnote2);

  await endDoc(handle);
  const groundTruth = buildGroundTruth({
    fixtureId: "F4-textbook-complex",
    pages: 1,
    blocks: gtBlocks,
    headings,
    tables: [{ page: 0, rows: 4, cols: 3, cells }],
  });
  return { path, pages: 1, groundTruth };
}

async function makeLongBook() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F5-long-book.pdf");
  const handle = startDoc(path);
  const doc = handle.doc;
  const total = 520;
  const gtBlocks = [];
  const headings = [];
  for (let page = 0; page < total; page++) {
    const heading = `Synthetic Volume — Page ${page + 1}`;
    const sectionLabel = `Section ${Math.floor(page / 10) + 1}.${page % 10 + 1}. `;
    const bodyText =
      sectionLabel +
      "This synthetic long book stresses page-count handling, cross-page paragraph flow and memory behavior. " +
      "No real publication is reproduced here. ".repeat(6);
    headings.push({ page, text: heading });
    gtBlocks.push(block(page, null, "heading", heading));
    gtBlocks.push(block(page, null, "paragraph", bodyText));
    doc.fontSize(18).font("Helvetica-Bold").text(heading);
    doc.moveDown(0.5);
    doc.fontSize(11).font("Helvetica").text(bodyText);
    if (page < total - 1) doc.addPage();
  }
  await endDoc(handle);
  const groundTruth = buildGroundTruth({ fixtureId: "F5-long-book", pages: total, blocks: gtBlocks, headings });
  return { path, pages: total, groundTruth };
}

async function makeNativeEn() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F6-native-en.pdf");
  const gtBlocks = [];
  const headings = [];
  const handle = startDoc(path);
  const topics = [
    ["Extraction", "Text extraction maps glyph runs into a plain character stream for downstream systems."],
    ["Segmentation", "Segmentation groups extracted characters back into headings, paragraphs and lists."],
    ["Provenance", "Provenance records which physical page each extracted fragment originated from."],
  ];
  for (let page = 0; page < 3; page++) {
    const heading = `Native English Prose — ${topics[page][0]} (Section ${page + 1})`;
    headings.push({ page, text: heading });
    gtBlocks.push(block(page, null, "heading", heading));
    handle.doc.fontSize(18).font("Helvetica-Bold").text(heading, { align: "center" });
    handle.doc.moveDown(1);
    for (let para = 0; para < 3; para++) {
      const text =
        `Paragraph ${page * 3 + para + 1} of the synthetic English corpus. ` +
        `${topics[page][1]} `.repeat(2) +
        `Sentinel ${2000 + page * 10 + para} marks the end of this paragraph.`;
      gtBlocks.push(block(page, null, "paragraph", text));
      handle.doc.fontSize(12).font("Helvetica").text(text);
      handle.doc.moveDown(0.8);
    }
    if (page < 2) handle.doc.addPage();
  }
  await endDoc(handle);
  const groundTruth = buildGroundTruth({ fixtureId: "F6-native-en", pages: 3, blocks: gtBlocks, headings });
  return { path, pages: 3, groundTruth };
}

const CN_COLUMN_SENTENCES = [
  "双栏中文排版的阅读顺序必须由地面真值明确给出。",
  "解析器需要先收集左栏的全部段落,再收集右栏的全部段落。",
  "交叉阅读两栏会破坏语义并降低下游检索质量。",
  "该合成语料为每一栏生成独特编号句子以便确定性匹配。",
  "栏宽与页边距保持固定以避免布局歧义。",
  "阅读顺序指标基于顺序对的准确率进行计算。",
];

async function makeTwoColumnCn() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F7-two-column-cn.pdf");
  const gtBlocks = [];
  const handle = startDoc(path);
  const doc = handle.doc;
  const pageWidth = 595.28 - 128;
  const columnWidth = pageWidth / 2 - 12;
  for (let page = 0; page < 3; page++) {
    const title = `双栏中文排版样本 第 ${page + 1} 页`;
    gtBlocks.push(block(page, null, "heading", title));
    doc.fontSize(16).font(cjkFont()).text(title, { align: "center" });
    doc.moveDown(1);
    const baseY = doc.y;
    for (const column of [0, 1]) {
      doc.x = 64 + column * (columnWidth + 24);
      doc.y = baseY;
      doc.fontSize(11).font(cjkFont());
      for (let k = 0; k < 3; k++) {
        const text = `${CN_COLUMN_SENTENCES[(page + column * 3 + k) % CN_COLUMN_SENTENCES.length]}(页 ${page + 1} 栏 ${column + 1} 块 ${k + 1},编号 ${3000 + page * 100 + column * 10 + k})`;
        gtBlocks.push(block(page, column, "paragraph", text));
        doc.text(text, { width: columnWidth });
        doc.moveDown(0.6);
      }
    }
    doc.x = 64;
    if (page < 2) doc.addPage();
  }
  await endDoc(handle);
  const groundTruth = buildGroundTruth({ fixtureId: "F7-two-column-cn", pages: 3, blocks: gtBlocks });
  return { path, pages: 3, groundTruth };
}

async function makeTable() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F8-table.pdf");
  const handle = startDoc(path);
  const doc = handle.doc;
  const gtBlocks = [];
  const heading = "合成表格结构样本";
  gtBlocks.push(block(0, null, "heading", heading));
  doc.fontSize(18).font(cjkFont()).text(heading, { align: "center" });
  doc.moveDown(1);
  const intro = "下表包含表头、中文单元格、数字单元格与一个空单元格,用于验证表格结构保留能力。";
  gtBlocks.push(block(0, null, "paragraph", intro));
  doc.fontSize(12).text(intro);
  doc.moveDown(1);

  const header = ["名称", "数量", "单价", "金额", "备注"];
  const rows = [
    ["合成甲物品", "3", "12.5", "37.5", "第一行"],
    ["合成乙物品", "10", "2", "20", ""],
    ["合成丙物品", "7", "9.9", "69.3", "含中文备注"],
    ["合成丁物品", "0", "5", "0", "缺货"],
    ["合成戊物品", "15", "1.5", "22.5", "最后一行"],
  ];
  const cells = [header, ...rows];
  const tableText = cells.map((row) => row.join(" ")).join("\n");
  gtBlocks.push(block(0, null, "table", tableText));
  const tableY = doc.y;
  drawRuledTable(doc, {
    x: 64,
    y: tableY,
    colWidths: [110, 70, 80, 80, 120],
    rowHeight: 26,
    cells,
    font: cjkFont(),
  });
  doc.y = tableY + 26 * cells.length + 20;
  const closing = "表格下方还存在一段正文,用于验证表格与正文的边界划分。";
  gtBlocks.push(block(0, null, "paragraph", closing));
  doc.fontSize(12).text(closing);

  await endDoc(handle);
  const groundTruth = buildGroundTruth({
    fixtureId: "F8-table",
    pages: 1,
    blocks: gtBlocks,
    headings: [{ page: 0, text: heading }],
    tables: [{ page: 0, rows: 6, cols: 5, cells }],
  });
  return { path, pages: 1, groundTruth };
}

async function makeFormula() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F9-formula.pdf");
  const handle = startDoc(path);
  const doc = handle.doc;
  const gtBlocks = [];
  const heading = "合成公式样本";
  gtBlocks.push(block(0, null, "heading", heading));
  doc.fontSize(18).font(cjkFont()).text(heading, { align: "center" });
  doc.moveDown(1);

  const inlineText = "根据质能关系 E = m * c^2 可知,质量与能量可以相互转化。";
  const display1 = "a^2 + b^2 = c^2";
  const between = "勾股定理是初等几何中最著名的定理之一:";
  const display2 = "x = (-b ± sqrt(b^2 - 4ac)) / (2a)";
  const closing = "若解析器不支持公式结构,上述内容只能以扁平文本形式保留,需要如实记录。";

  gtBlocks.push(block(0, null, "paragraph", inlineText));
  doc.fontSize(12).font(cjkFont()).text(inlineText);
  doc.moveDown(1);
  gtBlocks.push(block(0, null, "paragraph", between));
  doc.text(between);
  doc.moveDown(0.5);
  gtBlocks.push(block(0, null, "formula", display1));
  doc.fontSize(14).font(cjkFont()).text(display1, { align: "center" });
  doc.moveDown(1);
  gtBlocks.push(block(0, null, "formula", display2));
  doc.fontSize(14).text(display2, { align: "center" });
  doc.moveDown(1);
  gtBlocks.push(block(0, null, "paragraph", closing));
  doc.fontSize(12).text(closing);

  await endDoc(handle);
  const groundTruth = buildGroundTruth({
    fixtureId: "F9-formula",
    pages: 1,
    blocks: gtBlocks,
    headings: [{ page: 0, text: heading }],
    formulas: [
      { page: 0, display: false, text: "E = m * c^2" },
      { page: 0, display: true, text: display1 },
      { page: 0, display: true, text: display2 },
    ],
  });
  return { path, pages: 1, groundTruth };
}

async function makeLists() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F10-lists.pdf");
  const handle = startDoc(path);
  const doc = handle.doc;
  const gtBlocks = [];
  const heading = "合成列表结构样本";
  gtBlocks.push(block(0, null, "heading", heading));
  doc.fontSize(18).font(cjkFont()).text(heading, { align: "center" });
  doc.moveDown(1);
  doc.fontSize(12).font(cjkFont());

  const ordered = ["第一步:准备合成语料。", "第二步:生成地面真值。", "第三步:运行确定性评估。"];
  const unordered = ["无序列表项甲:文本保真。", "无序列表项乙:顺序正确。", "无序列表项丙:结构保留。"];
  const nestedParent = "第二步包含以下嵌套子项:";
  const nested = ["子项 2.1:校验唯一编号。", "子项 2.2:校验页码归属。"];

  for (const item of ordered) {
    gtBlocks.push(block(0, null, "list_item", item));
    doc.text(`1. ${item}`);
    doc.moveDown(0.3);
  }
  doc.moveDown(0.5);
  gtBlocks.push(block(0, null, "list_item", nestedParent));
  doc.text(nestedParent);
  doc.moveDown(0.3);
  for (const item of nested) {
    gtBlocks.push(block(0, null, "list_item", item));
    doc.text(`    ${item}`);
    doc.moveDown(0.3);
  }
  doc.moveDown(0.5);
  for (const item of unordered) {
    gtBlocks.push(block(0, null, "list_item", item));
    doc.text(`• ${item}`);
    doc.moveDown(0.3);
  }

  await endDoc(handle);
  const groundTruth = buildGroundTruth({
    fixtureId: "F10-lists",
    pages: 1,
    blocks: gtBlocks,
    headings: [{ page: 0, text: heading }],
    lists: [
      { page: 0, ordered: true, items: ordered },
      { page: 0, ordered: true, items: nested },
      { page: 0, ordered: false, items: unordered },
    ],
  });
  return { path, pages: 1, groundTruth };
}

const HEADER_TEXT = "合成质量基准 内部测试文献";

async function makeHeaderFooter() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F11-header-footer.pdf");
  const gtBlocks = [];
  const noise = [{ kind: "header", text: HEADER_TEXT }];
  const handle = startDoc(path);
  const doc = handle.doc;
  for (let page = 0; page < 3; page++) {
    const footer = `第 ${page + 1} 页 — 合成基准测试`;
    noise.push({ kind: "footer", text: footer });
    doc.font(cjkFont());
    doc.fontSize(9).text(HEADER_TEXT, 64, 30, { align: "center", width: 595.28 - 128 });
    doc.fontSize(12);
    doc.y = 80;
    doc.x = 64;
    for (let para = 0; para < 2; para++) {
      const text =
        `第 ${page + 1} 页第 ${para + 1} 段:页眉与页脚必须被视为噪声,不应反复混入正文语料,否则长文档检索会被重复内容污染。` +
        `哨兵编号 ${4000 + page * 10 + para}。`;
      gtBlocks.push(block(page, null, "paragraph", text));
      doc.text(text);
      doc.moveDown(1);
    }
    // Footer must stay ABOVE the 64pt bottom margin (text area ends at ~777.9):
    // pdfkit auto-inserts a page when text flows past it, which would silently
    // turn the 3-page fixture into 6 pages.
    doc.fontSize(9).text(footer, 64, 740, { align: "center", width: 595.28 - 128 });
    if (page < 2) doc.addPage();
  }
  await endDoc(handle);
  const groundTruth = buildGroundTruth({ fixtureId: "F11-header-footer", pages: 3, blocks: gtBlocks, noise });
  return { path, pages: 3, groundTruth };
}

async function makeMixed() {
  resetBlocks();
  const path = join(FIXTURES_DIR, "F12-mixed.pdf");
  const gtBlocks = [];
  const ocrKeyPhrases = [];
  const handle = startDoc(path);
  const doc = handle.doc;

  const p1a = "混合文档第一页是原生文本,包含可提取的文字层与两个段落。";
  const p1b = "第二页将是纯图像扫描页,用于验证解析器的路由与 OCR 信号。";
  gtBlocks.push(block(0, null, "heading", "混合文档 原生文本页"));
  gtBlocks.push(block(0, null, "paragraph", p1a));
  gtBlocks.push(block(0, null, "paragraph", p1b));
  doc.fontSize(16).font(cjkFont()).text("混合文档 原生文本页", { align: "center" });
  doc.moveDown(1);
  doc.fontSize(12).text(p1a);
  doc.moveDown(0.8);
  doc.text(p1b);

  const scanned = scannedLines(1, 8);
  const pngPath = join(tmpdir(), `bench-f12-page${Math.random().toString(16).slice(2)}.png`);
  await renderCnTextToPng(scanned, pngPath);
  doc.addPage();
  doc.image(pngPath, 0, 0, { width: 595.28, height: 841.89 });
  for (const line of scanned) gtBlocks.push(block(1, null, "paragraph", line));
  ocrKeyPhrases.push({ page: 1, phrase: scanned[0] });

  doc.addPage();
  const tableHeading = "混合文档 表格页";
  const cells = [["列一", "列二", "列三"], ["数据甲", "12", "备注"], ["数据乙", "34", ""]];
  gtBlocks.push(block(2, null, "heading", tableHeading));
  gtBlocks.push(block(2, null, "table", cells.map((row) => row.join(" ")).join("\n")));
  doc.y = 80;
  doc.x = 64;
  doc.fontSize(16).font(cjkFont()).text(tableHeading, { align: "center" });
  doc.moveDown(1);
  drawRuledTable(doc, { x: 64, y: doc.y, colWidths: [120, 100, 140], rowHeight: 26, cells, font: cjkFont() });

  await endDoc(handle);
  const groundTruth = buildGroundTruth({
    fixtureId: "F12-mixed",
    pages: 3,
    ocrRequired: true,
    ocrRequiredPages: [1],
    blocks: gtBlocks,
    ocrKeyPhrases,
    tables: [{ page: 2, rows: 3, cols: 3, cells }],
  });
  return { path, pages: 3, groundTruth };
}

async function makeWarmup() {
  const path = join(FIXTURES_DIR, "warmup.pdf");
  const handle = startDoc(path);
  handle.doc.fontSize(14).font("Helvetica").text("Warmup document for untimed model preload runs.");
  handle.doc.addPage();
  handle.doc.text("Second page so multi-page initialization happens during preload.");
  await endDoc(handle);
  return { path, pages: 2, groundTruth: null };
}

async function makeInvalidPdf() {
  const path = join(FIXTURES_DIR, "not-a-pdf.pdf");
  writeFileSync(path, "This is deliberately not a PDF document. It only has a .pdf extension.\n".repeat(20), "utf8");
  return { path, pages: 0, groundTruth: null };
}

const manifest = { fixtures: [] };

async function main() {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const generators = [
    ["F1-native-cn", makeNativeCn, "native-cn", "A. native Chinese prose: chars, punctuation, paragraphs, headings, pagination"],
    ["F2-multicolumn", makeMulticolumn, "multicolumn", "C/D. two-column English with explicit left-then-right ground-truth order"],
    ["F3-scanned-cn", makeScannedCn, "scanned", "I. image-only scanned Chinese (no text layer) for OCR evaluation"],
    ["F4-textbook-complex", makeTextbookComplex, "textbook", "E/G/H. headings + ruled table + figure + footnotes on one page"],
    ["F5-long-book", makeLongBook, "long-book", "L. 520-page synthetic book for long-document behavior"],
    ["F6-native-en", makeNativeEn, "native-en", "B. native English prose to separate CN-specific from general issues"],
    ["F7-two-column-cn", makeTwoColumnCn, "multicolumn-cn", "C. two-column Chinese with per-block ground-truth reading order"],
    ["F8-table", makeTable, "table", "E. ruled table: header, CN cells, numeric cells, empty cell"],
    ["F9-formula", makeFormula, "formula", "F. inline + display formulas rendered as text"],
    ["F10-lists", makeLists, "lists", "G. ordered, nested and unordered lists"],
    ["F11-header-footer", makeHeaderFooter, "header-footer", "H. repeated header/footer/page-number noise"],
    ["F12-mixed", makeMixed, "mixed", "J. native page + scanned page + table page for fallback routing signals"],
    ["warmup", makeWarmup, "warmup", "untimed model preload warmup"],
    ["not-a-pdf", makeInvalidPdf, "malformed", "K. invalid input fixture for failure-isolation testing"],
  ];
  for (const [id, generator, fixtureClass, purpose] of generators) {
    process.stdout.write(`generating ${id}... `);
    const { path, pages, groundTruth } = await generator();
    if (groundTruth) {
      await writeFile(join(FIXTURES_DIR, `${id}.ground-truth.json`), JSON.stringify(groundTruth, null, 2), "utf8");
    }
    console.log("ok");
    manifest.fixtures.push({
      id,
      filename: path.split(/[\\/]/).pop(),
      fixtureClass,
      generator: "scripts/make-fixtures.mjs (synthetic, no copyrighted content)",
      declaredPages: pages,
      groundTruth: groundTruth ? `${id}.ground-truth.json` : null,
      notes: id === "not-a-pdf" ? "invalid input fixture for failure-isolation testing" : purpose,
    });
  }
  const manifestJson = JSON.stringify(manifest, null, 2);
  await writeFile(join(FIXTURES_DIR, "fixtures.manifest.json"), manifestJson, "utf8");
  // committed copy (manifest only, never the PDFs or ground truth)
  const toolFixtureDir = join(import.meta.dirname, "..", "fixtures");
  mkdirSync(toolFixtureDir, { recursive: true });
  await writeFile(join(toolFixtureDir, "fixtures.manifest.json"), manifestJson, "utf8");
  console.log(`manifest written to ${FIXTURES_DIR} and tool fixtures/`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
