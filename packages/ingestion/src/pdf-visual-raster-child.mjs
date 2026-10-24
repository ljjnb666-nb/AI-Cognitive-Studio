/**
 * VF03: isolated, opt-in, single physical-page PDF rasterization worker.
 * Internal IPC writes private PNG to a caller-created temp directory.
 * Never logs PDF bytes, page text, coordinates, paths, errors, or SHA.
 *
 * Native canvas dependency pinned by the ingestion package lock.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_INPUT_BYTES=32*1024*1024;
const MAX_PAGE_PIXELS=4_000_000;
const MAX_PNG_BYTES=8*1024*1024;
const args=process.argv.slice(2);

async function main() {
  if (args.length!==4) throw Error("INVALID");
  const [source, destination, indexRaw, scaleRaw]=args;
  const pageIndex=Number(indexRaw);
  const scale=Number(scaleRaw);
  if (!Number.isSafeInteger(pageIndex) || pageIndex<0 || pageIndex>=2000 ||
      !Number.isFinite(scale) || scale<0.8 || scale>1.5) throw Error("INVALID");
  const meta=await stat(source);
  if (!meta.isFile() || !meta.size || meta.size>MAX_INPUT_BYTES) throw Error("INVALID");
  const bytes=new Uint8Array(await readFile(source));
  const task=getDocument({
    data:bytes,
    disableWorker:true,
    isEvalSupported:false,
    useSystemFonts:false,
  });
  try {
    const pdf=await task.promise;
    if (pdf.numPages>2000 || pageIndex>=pdf.numPages) throw Error("INVALID");
    const page=await pdf.getPage(pageIndex+1);
    const viewport=page.getViewport({scale});
    const width=Math.ceil(viewport.width), height=Math.ceil(viewport.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width<=0 || height<=0 || width*height>MAX_PAGE_PIXELS) throw Error("INVALID");
    const canvas=createCanvas(width,height);
    const context=canvas.getContext("2d");
    context.fillStyle="#ffffff";
    context.fillRect(0,0,width,height);
    await page.render({canvasContext:context,viewport,canvas}).promise;
    const png=canvas.toBuffer("image/png");
    if (png.length>MAX_PNG_BYTES || !png.length) throw Error("INVALID");
    await writeFile(destination,png,{flag:"wx",mode:0o600});
  } finally {
    // Best-effort cleanup, never log PDF.js errors or source descriptions.
    try { await task.destroy(); } catch { /* preserve stable empty stdout */ void 0; }
  }
}

try { await main(); }
catch { process.exitCode=2; }
