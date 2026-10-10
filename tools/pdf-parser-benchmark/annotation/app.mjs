import {
  ROLES, ROLE_LABELS, FIXTURES, MAX_DRAFT_BYTES, createDraft, makeEmptyBlock,
  parseDraft, assessDraft, buildGroundTruth, AnnotationError,
} from "./workspace.mjs";
import { MAX_CANDIDATE_BYTES, MAX_SELECTION_BYTES, MAX_PDF_BYTES, parseBookSelection,
  parseNormalizedCandidate, bookLabel, pdfPreviewEligibility, sealBlindDraft, comparePage,
} from "./review.mjs";
import { createPdfPageViewer } from "./preview.mjs";

// No fetch, XHR, WebSocket, storage, service worker, telemetry or external assets.
// Only local human-entered fields; never paste untrusted text into innerHTML.
const $ = id => document.getElementById(id);
const node = (tag, className = "", text = "") => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.textContent = text;
  return e;
};
let draft = createDraft("RB-PDF-11");
let activePage = 0;
let dirty = false;
let mapping = null, sourcePresent = false, sourceFixtureId = null, previewPage = null;
let sourceSelectionEpoch = 0;
let candidates = [], selectedCandidate = -1;
let sealed = null, gtExported = false;
const exposedFixtures = new Set();
const contentRoles = new Set(["heading", "paragraph", "list_item", "table", "figure", "caption", "footnote", "formula"]);
const labels = {
  DRAFT_SCHEMA_INVALID: "草稿格式或样本 ID 不正确",
  PAGE_SIZE_INVALID: "页面尺寸无效", PAGE_SIZE_REQUIRED: "请填写原 PDF 的页面宽度、高度",
  DRAFT_PAGE_COUNT_INVALID: "必须恰好有 3 个页面",
  DRAFT_PAGE_LINEAGE_INVALID: "原书物理页码与固定样本不一致",
  BLOCK_ROLE_INVALID: "内容块的类型不正确", BLOCK_COLUMN_INVALID: "栏位只能是 0～10 或留空",
  BLOCK_FIELDS_INVALID: "内容块属性无效", DRAFT_FIELD_INVALID: "输入文字长度或字段无效",
  KEY_MARKERS_REQUIRED: "请添加至少一条正文关键标记", KEY_MARKERS_DUPLICATED: "关键标记重复",
  GROUND_TRUTH_PAGE_CONTENT_MISSING: "三个页面均需至少一个实质内容块",
  FORMULA_TEXT_REQUIRED: "公式块不能为空", LIST_ITEM_TEXT_REQUIRED: "列表项不能留空",
  TABLE_CELLS_REQUIRED: "表格需要逐行 TSV 单元格",
  TABLE_GRID_TOO_LARGE: "表格最多 50 行、30 列，单格 1000 字符",
  TABLE_GRID_NOT_RECTANGULAR: "表格的每一行必须有相同列数",
  OCR_PAGE_NOT_SELECTED: "OCR 关键短语所在页面必须勾选需要 OCR",
  OCR_PHRASES_TOO_MANY: "每页 OCR 短语最多 50 条",
  CANONICAL_TEXT_REQUIRED: "至少录入一段真实的正文、标题或图注文字",
  GROUND_TRUTH_MARKER_CONFLICT: "关键标记不在已人工录入的正文中",
  OCR_PHRASE_NOT_IN_CANONICAL_TEXT: "OCR 关键短语不在已人工录入的正文中",
  GT_TOO_LARGE: "导出的 Ground Truth 超过 4 MB",
  DRAFT_TOO_LARGE: "草稿超过 4 MB，无法导入",
  FILE_READ_FAILED: "本地文件读取失败",
  SAVE_CANCELLED: "已取消保存，未改动本地文件",
  SAVE_FAILED: "保存失败，可能没有获得文件系统权限",
  TOO_MANY_BLOCKS: "每页最多 500 个内容块",
  BOOK_MAPPING_SCHEMA_INVALID: "书名映射格式无效",
  BOOK_MAPPING_MEMBER_INVALID: "原书文件名不合法",
  BOOK_MAPPING_SOURCE_INVALID: "原书编号、SHA 或字节长度冲突",
  BOOK_MAPPING_INCOMPLETE: "必须包含三本原书的映射",
  BOOK_MAPPING_PAGE_OUT_OF_RANGE: "原书页数与固定抽样页码冲突",
  CANDIDATE_SCHEMA_OR_FIXTURE_MISMATCH: "候选 JSON 格式或样本编号不匹配",
  CANDIDATE_PAGE_LAYOUT_INVALID: "候选必须包含子集索引 0、1、2 三页",
  CANDIDATE_PAGE_BINDING_INVALID: "候选内容块页码与所在页面不一致",
  CANDIDATE_OCR_PROVENANCE_INVALID: "候选 OCR 来源字段不符合约定",
  CANDIDATE_TOO_LARGE: "候选内容过大",
  COMPARE_TOO_MANY_BLOCKS: "逐段对照内容块数量超限",
  BLIND_GT_SEAL_REQUIRED: "请先独立导出 GT 并冻结，不得提前查看机器文字",
  SOURCE_PDF_SIZE_INVALID: "PDF 大小异常（至少 8 字节，最多 170 MB）",
  SOURCE_PDF_FILENAME_MISMATCH: "所选 PDF 与当前样本的完整原书不一致",
  SOURCE_PDF_SIZE_MISMATCH: "本机 PDF 大小与导入映射不一致",
  SOURCE_PDF_HEADER_INVALID: "所选文件没有 PDF 文件头",
  PAGE_INDEX_INVALID: "页面索引非法",
};

function setNotice(value, positive = false) {
  const e = $("validation");
  e.classList.toggle("ok", positive);
  e.textContent = value;
}
function localError(error) {
  const code = error instanceof AnnotationError ? error.code : "FILE_READ_FAILED";
  setNotice(labels[code] ?? ("安全检查阻塞：" + code));
}
function markDirty() {
  if (sealed) { setNotice("当前 GT 已冻结：不能在看过候选后修改原标注。请另起独立复核流程。"); return; }
  dirty = true;
  gtExported = false;
  const status = assessDraft(draft);
  if (status.status === "READY_FOR_INDEPENDENT_REVIEW") {
    setNotice(status.message + "（" + status.blocks + " 个内容块）", true);
  } else {
    setNotice(labels[status.code] ?? status.message);
  }
  renderNav();
  updatePageStatus();
}
function renderNav() {
  const nav = $("page-nav");
  nav.replaceChildren();
  for (const page of draft.pages) {
    const button = node("button", "page-item" + (activePage === page.index ? " active" : ""));
    button.type = "button";
    button.setAttribute("aria-current", activePage === page.index ? "page" : "false");
    const n = node("span", "page-num", String(page.index + 1));
    const info = node("span");
    info.append(node("strong", "", "第 " + (page.index + 1) + " 页"));
    const filled = page.blocks.some(b => contentRoles.has(b.role)) ? " · 已录入" : " · 待录入";
    info.append(node("small", "", "原书 P" + page.originalPhysicalPage + filled));
    button.append(n, info);
    button.addEventListener("click", () => { activePage = page.index; renderPage(); });
    nav.append(button);
  }
}
function updatePageStatus() {
  const page = draft.pages[activePage];
  const content = page.blocks.filter(b => contentRoles.has(b.role)).length;
  $("page-status").textContent = content ? "已录入 " + content + " 个内容块" : "待标注";
  $("block-count").textContent = page.blocks.length + " 块";
}
function labeledInput(label, element) {
  const wrap = node("div");
  const lab = node("label", "field-label", label);
  lab.append(element);
  wrap.append(lab);
  return wrap;
}
function checkbox(text, checked, update) {
  const l = node("label", "check-row");
  const c = node("input");
  c.type = "checkbox"; c.checked = checked; c.disabled = Boolean(sealed);
  c.addEventListener("change", () => { update(c.checked); markDirty(); });
  l.append(c, node("span", "", text));
  return l;
}
function renderBlock(block, index) {
  const card = node("article", "block");
  const top = node("div", "block-top");
  top.append(node("span", "block-sequence", "第 " + (index + 1) + " 块"));
  const role = node("select");
  role.setAttribute("aria-label", "内容块类型");
  for (const value of ROLES) {
    const opt = node("option", "", ROLE_LABELS[value]);
    opt.value = value;
    role.append(opt);
  }
  role.value = block.role;
  role.disabled = Boolean(sealed);
  role.addEventListener("change", () => { block.role = role.value; renderPage(); markDirty(); });
  top.append(role);
  const controls = node("div", "block-controls");
  for (const [label, fn, isDanger, disabled] of [
    ["↑ 上移", () => moveBlock(index, -1), false, index === 0],
    ["↓ 下移", () => moveBlock(index, 1), false, index === draft.pages[activePage].blocks.length - 1],
    ["删除", () => { draft.pages[activePage].blocks.splice(index, 1); renderPage(); markDirty(); }, true, false],
  ]) {
    const b = node("button", "icon-action" + (isDanger ? " danger" : ""), label);
    b.type = "button"; b.disabled = disabled || Boolean(sealed);
    b.addEventListener("click", fn);
    controls.append(b);
  }
  top.append(controls);
  card.append(top);
  const input = node("textarea");
  input.rows = block.role === "paragraph" ? 4 : 2;
  input.disabled = Boolean(sealed);
  input.maxLength = 100000;
  input.value = block.text;
  input.placeholder = block.role === "table" ? "表名/说明（可留空），单元格单独填写" :
    block.role === "figure" ? "原书图形的人工结构描述（不计入规范正文文本）" :
    "请从原书手动核对后逐字输入；不复制解析器输出";
  input.setAttribute("aria-label", ROLE_LABELS[block.role] + "文字");
  input.addEventListener("input", () => { block.text = input.value; markDirty(); });
  card.append(labeledInput("原书文字 / 结构说明", input));
  const extra = node("div", "extra-fields");
  const cLabel = node("label", "", "列号（留空为无分栏）");
  const col = node("input");
  col.type = "number"; col.min = "0"; col.max = "10";
  col.disabled = Boolean(sealed);
  col.value = block.column === null ? "" : String(block.column);
  col.addEventListener("change", () => {
    const raw = col.value.trim();
    block.column = raw === "" ? null : Number(raw);
    markDirty();
  });
  cLabel.append(col);
  extra.append(cLabel);
  if (block.role === "list_item") extra.append(checkbox("有序列表", block.ordered, value => { block.ordered = value; }));
  if (block.role === "formula") extra.append(checkbox("独立行公式", block.display, value => { block.display = value; }));
  card.append(extra);
  if (block.role === "table") {
    const tsv = node("textarea");
    tsv.rows = 5; tsv.maxLength = 50000;
    tsv.disabled = Boolean(sealed);
    tsv.placeholder = "列 A [Tab] 列 B\n数值 1 [Tab] 数值 2\n保持每行列数相同";
    tsv.value = block.tableTsv;
    tsv.addEventListener("input", () => { block.tableTsv = tsv.value; markDirty(); });
    card.append(labeledInput("人工记录表格单元格（TSV：Tab 分列，换行分行）", tsv));
  }
  return card;
}
function moveBlock(index, delta) {
  const blocks = draft.pages[activePage].blocks, swap = index + delta;
  if (swap < 0 || swap >= blocks.length) return;
  [blocks[index], blocks[swap]] = [blocks[swap], blocks[index]];
  renderPage(); markDirty();
}
function renderPage() {
  const page = draft.pages[activePage];
  $("page-title").textContent = "第 " + (activePage + 1) + " 页 · 人工核对";
  $("page-subtitle").textContent = "原书物理第 " + page.originalPhysicalPage + " 页 · 子集页码 " + page.index;
  $("ocr-required").checked = page.ocrRequired;
  $("ocr-phrases").value = page.ocrPhrasesText;
  $("previous").disabled = activePage === 0;
  $("next").disabled = activePage === 2;
  const blocks = $("blocks");
  blocks.replaceChildren();
  if (page.blocks.length === 0) blocks.append(node("p", "empty", "本页还没有内容块。请对照原书，从下方添加标题、正文、图像或表格。"));
  for (let i = 0; i < page.blocks.length; i++) blocks.append(renderBlock(page.blocks[i], i));
  for (const btn of document.querySelectorAll("[data-add]")) btn.disabled = Boolean(sealed);
  for (const id of ["ocr-required","ocr-phrases","page-width","page-height","markers","import-draft","export-gt","save-draft"])
    $(id).disabled = Boolean(sealed);
  renderNav(); updatePageStatus(); renderReferences();
}
function afterDraftLoaded() {
  sealed = null; gtExported = false;
  candidates = []; selectedCandidate = -1;
  releasePdf();
  $("fixture").value = draft.fixtureId;
  $("page-width").value = draft.pageSize.width || "";
  $("page-height").value = draft.pageSize.height || "";
  $("markers").value = draft.markersText;
  renderPage();
  markDirty();
}
async function saveObject(value, filename) {
  const json = JSON.stringify(value, null, 2) + "\n";
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  if (blob.size > MAX_DRAFT_BYTES) throw new AnnotationError("GT_TOO_LARGE");
  if (typeof window.showSaveFilePicker === "function") {
    // Invoked directly from the click path; OS prompts for a D: location.
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "私有 JSON 文件", accept: { "application/json": [".json"] } }],
      });
      const stream = await handle.createWritable();
      try { await stream.write(blob); await stream.close(); }
      catch (error) { await stream.abort().catch(() => {}); throw error; }
      setNotice("文件保存操作完成。请确认保存在 D 盘的私有 fixtures 目录，不要上传到 GitHub。", true);
      return true;
    } catch (error) {
      if (error?.name === "AbortError") localError(new AnnotationError("SAVE_CANCELLED"));
      else localError(new AnnotationError("SAVE_FAILED"));
    }
    return false;
  }
  // Browser fallback. This may land in Downloads on C:. Never claim it is on D:.
  const url = URL.createObjectURL(blob);
  const link = node("a");
  link.href = url; link.download = filename;
  document.body.append(link);
  link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  setNotice("已请求浏览器下载。请检查下载目录，并手动转移至 D 盘私有 fixtures；不要上传 JSON。");
  return true;
}

$("fixture").addEventListener("change", event => {
  const id = event.target.value;
  if (dirty && !window.confirm("切换样本会清除当前内存中未保存的内容。确定继续吗？")) {
    event.target.value = draft.fixtureId;
    return;
  }
  if (exposedFixtures.has(id)) {
    setNotice("当前会话已经揭示过这本书的机器候选。为避免污染独立标注，请使用独立的人工复核会话。");
    event.target.value = draft.fixtureId; return;
  }
  draft = createDraft(id); activePage = 0; dirty = false; afterDraftLoaded();
});
$("previous").addEventListener("click", () => { activePage = Math.max(0, activePage - 1); renderPage(); });
$("next").addEventListener("click", () => { activePage = Math.min(2, activePage + 1); renderPage(); });
$("ocr-required").addEventListener("change", e => { draft.pages[activePage].ocrRequired = e.target.checked; markDirty(); });
$("ocr-phrases").addEventListener("input", e => { draft.pages[activePage].ocrPhrasesText = e.target.value; markDirty(); });
$("markers").addEventListener("input", e => { draft.markersText = e.target.value; markDirty(); });
for (const [field, key] of [["page-width", "width"], ["page-height", "height"]]) {
  $(field).addEventListener("change", e => {
    draft.pageSize[key] = e.target.value === "" ? 0 : Number(e.target.value);
    markDirty();
  });
}
for (const btn of document.querySelectorAll("[data-add]")) {
  btn.addEventListener("click", () => {
    const page = draft.pages[activePage];
    if (page.blocks.length >= 500) return localError(new AnnotationError("TOO_MANY_BLOCKS"));
    page.blocks.push(makeEmptyBlock(btn.getAttribute("data-add")));
    renderPage(); markDirty();
  });
}
$("check").addEventListener("click", () => markDirty());
$("save-draft").addEventListener("click", () => {
  try { void saveObject(parseDraft(draft), draft.fixtureId + ".ground-truth.draft.json"); }
  catch (error) { localError(error); }
});
$("export-gt").addEventListener("click", async () => {
  try {
    const candidate = buildGroundTruth(draft);
    if (!window.confirm("导出的是人工标注候选文件，不是已复核证据。确认已经从原书人工录入，并另行安排两人独立复核？")) return;
    const pendingFixture = draft.fixtureId;
    const pendingSnapshot = JSON.stringify(parseDraft(draft));
    const saved = await saveObject(candidate, pendingFixture + ".ground-truth.json");
    if (saved && draft.fixtureId === pendingFixture && JSON.stringify(parseDraft(draft)) === pendingSnapshot && !sealed) { gtExported = true; setNotice("已请求保存 GT 候选。请确认文件实际落盘，然后可冻结并对照候选；该文件仍非人工复核证据。", true); }
  } catch (error) { localError(error); }
});
$("import-draft").addEventListener("click", () => $("draft-file").click());
$("draft-file").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > MAX_DRAFT_BYTES) return localError(new AnnotationError("DRAFT_TOO_LARGE"));
  if (dirty && !window.confirm("导入草稿将替换当前内存中未保存的内容。确定继续吗？")) return;
  try {
    const imported = parseDraft(JSON.parse(await file.text()));
    draft = imported; activePage = 0; dirty = false;
    afterDraftLoaded();
    setNotice("已从本机文件导入草稿；仅恢复编辑内容，不代表已完成复核。");
  } catch (error) {
    if (error instanceof AnnotationError) localError(error);
    else localError(new AnnotationError("FILE_READ_FAILED"));
  }
});

// 02: browser-only private references. Never persist mapping, PDF bytes,
// normalized candidate text, a comparison, or an object URL.
const pdfViewer = createPdfPageViewer({
  canvas: $("pdf-canvas"),
  onStatus: ({ kind, message }) => {
    const status = $("preview-status");
    status.textContent = message;
    status.dataset.state = kind;
  },
  loadPdfJs: async () => {
    // The only dynamic import is the exact-version local npm asset, no CDN.
    const pdfjs = await import("./vendor/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", import.meta.url).href;
    return pdfjs;
  },
});
function releasePdf() {
  sourceSelectionEpoch++;
  pdfViewer.clear();
  sourcePresent = false; sourceFixtureId = null; previewPage = null;
  $("pdf-view").hidden = true;
  $("pdf-status").textContent = "未打开原书 PDF。";
}
function renderReferences() {
  $("book-title").textContent = bookLabel(mapping, draft.fixtureId);
  const page = draft.pages[activePage];
  $("preview-page").textContent = String(page.originalPhysicalPage);
  const canPreview = sourcePresent && sourceFixtureId === draft.fixtureId;
  $("pdf-view").hidden = !canPreview;
  if (canPreview && previewPage !== page.originalPhysicalPage) {
    previewPage = page.originalPhysicalPage;
    void pdfViewer.go(previewPage);
  }
  const picker = $("candidate-choice");
  picker.replaceChildren();
  const empty = node("option", "", candidates.length ? "请选择一份已有候选" : "尚未导入");
  empty.value = ""; picker.append(empty);
  for (const [i, candidate] of candidates.entries()) {
    const opt = node("option", "", candidate.parser + " · " + candidate.mode + " · " + (i+1));
    opt.value = String(i); picker.append(opt);
  }
  picker.value = selectedCandidate >= 0 ? String(selectedCandidate) : "";
  const selected = candidates[selectedCandidate];
  $("candidate-status").textContent = selected
    ? selected.parser + " / " + selected.version + "；" + selected.ocrLabel +
      (selected.engine ? "（引擎：" + selected.engine + "）" : "") +
      "。缺少块级页码：" + selected.unknownBindings + "；文件内容未独立验真。"
    : "未选择候选。仅接受当前三页子集的 normalized.json，导入不会解锁机器文字。";
  $("blind-status").textContent = sealed
    ? "当前人工 GT 已冻结；机器对照只读，不生成准确率或双人复核声明。"
    : "盲标阶段：机器候选文字隐藏。请先导出人工 GT 候选，再冻结。";
  $("reveal-candidate").disabled = Boolean(sealed);
  $("comparison").hidden = !sealed;
  if (!sealed) { $("comparison-rows").replaceChildren(); return; }
  if (!selected) {
    $("comparison-context").textContent = "请选择同一样本的机器候选以查看本页对照。";
    $("comparison-rows").replaceChildren(); return;
  }
  try {
    const diff = comparePage(sealed, draft, selected, activePage);
    $("comparison-context").textContent = "原书物理页 " + diff.sourcePage +
      " · " + selected.parser + " " + selected.mode + " · " + diff.note;
    const host = $("comparison-rows"); host.replaceChildren();
    if (!diff.rows.length) host.append(node("p","empty","本页双方均无可对照的文字。"));
    for (const row of diff.rows) {
      const panel = node("article","comparison-row");
      panel.append(node("strong","difference-status",row.status));
      const columns = node("div","comparison-columns");
      const human = node("div","comparison-cell");
      human.append(node("small","","人工 GT " + (row.humanId??"（无此段）")),node("pre","",row.humanText));
      const machine = node("div","comparison-cell");
      machine.append(node("small","","机器候选 " + (row.candidateOrdinal??"（无此段）") +
        (row.kind ? " · " + row.kind : "")),node("pre","",row.candidateText));
      columns.append(human,machine);panel.append(columns);host.append(panel);
    }
  } catch (error) { localError(error); $("comparison-rows").replaceChildren(); }
}
$("load-book-map").addEventListener("click", () => $("book-map-file").click());
$("book-map-file").addEventListener("change", async event => {
  const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
  try {
    if (file.size > MAX_SELECTION_BYTES) throw new AnnotationError("DRAFT_TOO_LARGE");
    mapping = parseBookSelection(JSON.parse(await file.text()));
    $("map-status").textContent = "仅此标签页加载了 3 本原书的文件名；不会保存到 GT JSON。";
    renderReferences();
  } catch (error) { localError(error); }
});
$("load-source-pdf").addEventListener("click", () => $("source-pdf-file").click());
$("source-pdf-file").addEventListener("change", async event => {
  const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
  const pendingFixture = draft.fixtureId;
  const selectionEpoch = ++sourceSelectionEpoch;
  try {
    if (file.size > MAX_PDF_BYTES) throw new AnnotationError("SOURCE_PDF_SIZE_INVALID");
    pdfPreviewEligibility(file, pendingFixture, mapping);
    if (!(await file.slice(0,8).text()).startsWith("%PDF-")) throw new AnnotationError("SOURCE_PDF_HEADER_INVALID");
    if (draft.fixtureId !== pendingFixture || selectionEpoch !== sourceSelectionEpoch) return;
    releasePdf();
    sourcePresent = true; sourceFixtureId = pendingFixture;
    previewPage = draft.pages[activePage].originalPhysicalPage;
    $("pdf-status").textContent = "已手动选择 " + file.name +
      "；文件名、大小和 PDF 头通过检查，原书 SHA 尚未验证。";
    renderReferences();
    void pdfViewer.open(file, previewPage);
  } catch (error) {
    if (draft.fixtureId !== pendingFixture || selectionEpoch !== sourceSelectionEpoch) return;
    if (error instanceof AnnotationError && error.code === "SOURCE_PDF_FILENAME_MISMATCH") {
      const original = FIXTURES[pendingFixture].source + ".pdf";
      const mapped = mapping?.[FIXTURES[pendingFixture].source]?.displayName;
      $("pdf-status").textContent = "当前样本 " + pendingFixture + " 对应完整原书 " + original +
        (mapped && mapped !== original ? "（映射文件名：" + mapped + "）" : "") +
        "。你选择的是 " + file.name + "，请重新选择完整原书，不要选三页实验样本。";
    } else {
      $("pdf-status").textContent = "所选 PDF 未通过本地安全检查；可重新选择正确的完整原书。";
    }
    localError(error);
  }
});
$("clear-source-pdf").addEventListener("click", () => { releasePdf(); renderReferences(); });
$("load-candidate").addEventListener("click", () => $("candidate-file").click());
$("candidate-file").addEventListener("change", async event => {
  const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
  try {
    if (file.size > MAX_CANDIDATE_BYTES) throw new AnnotationError("CANDIDATE_TOO_LARGE");
    const pendingFixture = draft.fixtureId;
    const candidate = parseNormalizedCandidate(JSON.parse(await file.text()), pendingFixture);
    if (draft.fixtureId !== pendingFixture) throw new AnnotationError("CANDIDATE_SCHEMA_OR_FIXTURE_MISMATCH");
    if (candidates.length === 4) throw new AnnotationError("CANDIDATE_TOO_LARGE");
    candidates.push(candidate); selectedCandidate = candidates.length - 1;
    renderReferences(); setNotice("候选仅载入浏览器内存，尚未独立验真；人工 GT 必须先冻结。");
  } catch (error) { localError(error); }
});
$("candidate-choice").addEventListener("change", event => {
  selectedCandidate = event.target.value === "" ? -1 : Number(event.target.value);
  renderReferences();
});
$("reveal-candidate").addEventListener("click", () => {
  try {
    if (!gtExported || !candidates[selectedCandidate]) throw new AnnotationError("BLIND_GT_SEAL_REQUIRED");
    const snapshot = sealBlindDraft(draft);
    if (!window.confirm("请确认：已独立依据原书完成标注，且 GT 候选 JSON 已保存。揭示机器输出后本标签页禁止修改或重新导出该份 GT。继续？")) return;
    sealed = snapshot; exposedFixtures.add(draft.fixtureId);
    renderPage();
    setNotice("盲标 GT 已冻结，可以对照机器候选。机器输出不能反向写入 GT；还需两位真实复核者独立复核。", true);
  } catch (error) { localError(error); }
});

window.addEventListener("pagehide", () => releasePdf());
window.addEventListener("beforeunload", event => {
  if (dirty) { event.preventDefault(); event.returnValue = ""; }
});
renderPage();
markDirty();
dirty = false;
