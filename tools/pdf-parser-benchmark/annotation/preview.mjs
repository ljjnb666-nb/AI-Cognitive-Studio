/**
 * Local-only PDF.js canvas preview. The caller supplies a user-picked File and
 * a checked-in, exact-version PDF.js module. No URL/network or OCR pathway.
 * Races are fenced across file replacements, page turns and close events.
 */
export const MAX_INLINE_PDF_BYTES = 64 * 1024 * 1024;
export const MAX_CANVAS_PIXELS = 3_000_000;
export const MAX_CANVAS_SIDE = 4096;

export function createPdfPageViewer({ canvas, onStatus, loadPdfJs }) {
  let epoch = 0, pageEpoch = 0;
  let document = null, loadingTask = null, renderTask = null, renderedPage = null;
  let requestedPage = null, externalOnly = false;
  let previousRenderSettled = Promise.resolve();
  const current = token => token === epoch;
  const emit = (kind, message) => onStatus({ kind, message });
  const destroy = value => { if (value) void Promise.resolve(value.destroy()).catch(() => {}); };
  const resetCanvas = () => {
    canvas.hidden = true;
    canvas.width = 0;
    canvas.height = 0;
  };

  function clear() {
    epoch++; pageEpoch++; requestedPage = null; externalOnly = false;
    if (renderTask) {
      const prior = renderTask;
      prior.cancel();
      previousRenderSettled = Promise.resolve(prior.promise).catch(() => {});
    }
    renderTask = null;
    // pdf.js owns all decoded pages and buffers. Do not retain the File.
    if (renderedPage) { try { renderedPage.cleanup(); } catch {} }
    renderedPage = null;
    destroy(loadingTask);
    loadingTask = null;
    destroy(document);
    document = null;
    resetCanvas();
    emit("empty", "未打开原书 PDF。");
  }

  async function go(physicalPage) {
    requestedPage = physicalPage;
    const token = epoch, turn = ++pageEpoch;
    // clear() may have detached a previous canvas renderer before it settles.
    // Await its cancellation before sharing the canvas with the next book.
    await previousRenderSettled;
    if (!current(token) || turn !== pageEpoch) return;
    const previous = renderTask;
    if (previous) {
      previous.cancel();
      try { await previous.promise; } catch {}
    }
    if (!current(token) || turn !== pageEpoch) return;
    renderTask = null;
    if (renderedPage) { try { renderedPage.cleanup(); } catch {} renderedPage = null; }
    resetCanvas();
    if (!document) {
      if (externalOnly) emit("external", "内存保护：请用系统 PDF 阅读器跳转原书物理第 " + physicalPage + " 页。");
      return;
    }
    if (!Number.isInteger(physicalPage) || physicalPage < 1 || physicalPage > document.numPages) {
      emit("error", "原书没有物理第 " + physicalPage + " 页，请核对是否选择了完整原书；可使用系统 PDF 阅读器。");
      return;
    }
    emit("loading", "正在渲染原书物理第 " + physicalPage + " 页…");
    try {
      const page = await document.getPage(physicalPage);
      if (!current(token) || turn !== pageEpoch) { page.cleanup(); return; }
      renderedPage = page;
      const unit = page.getViewport({ scale: 1 });
      if (!Number.isFinite(unit.width) || !Number.isFinite(unit.height) ||
          unit.width <= 0 || unit.height <= 0) throw new Error("INVALID_PAGE_GEOMETRY");
      const scale = Math.min(1.5, MAX_CANVAS_SIDE / unit.width,
        MAX_CANVAS_SIDE / unit.height, Math.sqrt(MAX_CANVAS_PIXELS / (unit.width * unit.height)));
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("CANVAS_UNAVAILABLE");
      const task = page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" });
      renderTask = task;
      await task.promise;
      if (!current(token) || turn !== pageEpoch) return;
      renderTask = null;
      canvas.hidden = false;
      emit("ready", "原书物理第 " + physicalPage + " 页已在本机完成渲染（不代表 SHA 验真）。");
    } catch (error) {
      if (!current(token) || turn !== pageEpoch) return;
      renderTask = null;
      resetCanvas();
      emit("error", "原书第 " + physicalPage + " 页预览失败，请使用系统 PDF 阅读器核对（" +
        (error?.name === "RenderingCancelledException" ? "渲染已取消" : "页面无法解码") + "）。");
    }
  }

  async function open(file, physicalPage) {
    clear();
    requestedPage = physicalPage;
    const token = epoch;
    if (file.size > MAX_INLINE_PDF_BYTES) {
      externalOnly = true;
      emit("external", "文件超过本机内嵌预览的 64 MB 内存保护上限；请使用系统 PDF 阅读器跳转物理第 " +
        physicalPage + " 页。");
      return;
    }
    emit("loading", "正在本机读取 PDF；不会上传文件，也不会运行 OCR…");
    try {
      const pdfjs = await loadPdfJs();
      if (!current(token)) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!current(token)) return;
      loadingTask = pdfjs.getDocument({
        data: bytes, isEvalSupported: false, enableXfa: false, useWasm: false, useSystemFonts: false,
        disableAutoFetch: true, disableStream: true, disableRange: true,
      });
      const loaded = await loadingTask.promise;
      if (!current(token)) { destroy(loaded); return; }
      document = loaded;
      loadingTask = null;
      await go(requestedPage);
    } catch {
      if (!current(token)) return;
      resetCanvas();
      emit("error", "无法在本机打开这份 PDF（可能损坏、加密或渲染组件未安装）；请使用系统 PDF 阅读器核对。");
    }
  }

  return { clear, open, go };
}
