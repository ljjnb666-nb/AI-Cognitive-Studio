/**
 * VF03: explicit, opt-in PDF physical-page -> private immutable PNG pipeline.
 *
 * No production caller. The input PDF SHA must match a caller-provided source
 * fingerprint; successful rasterization does not prove figure semantics.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectSourcePagePng, persistPdfSourcePageVisual,
  type PdfPageVisualReceipt, type VisualWriteOnceStore,
} from "./pdf-source-visual-assets.js";

const RENDER_ERROR="SOURCE_PDF_VISUAL_RENDER_FAILED";
const SOURCE_MISMATCH="SOURCE_PDF_VISUAL_RENDER_SOURCE_MISMATCH";
const MAX_INPUT=32*1024*1024;
const MAX_OUTPUT=8*1024*1024;
const RENDER_TIMEOUT_MS=30_000;
const SHA=/^[a-f0-9]{64}$/;

export type RenderSourcePdfPageInput = {
  workspaceId: string;
  sourceDocumentId: string;
  pdfBytes: Uint8Array;
  /** Must be read from the authoritative source object, not a guess. */
  expectedOriginalPdfSha256: string;
  physicalPageIndex: number; // Zero-based, never the printed page label.
  scale?: number; // 0.8..1.5, default 1.
};

async function runWorker(sourcePath: string, outputPath: string, page: number, scale: number): Promise<void> {
  const entry=fileURLToPath(new URL("./pdf-visual-raster-child.mjs",import.meta.url));
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,[
      "--max-old-space-size=192",
      entry,sourcePath,outputPath,String(page),String(scale),
    ],{windowsHide:true,stdio:["ignore","ignore","ignore"]});
    let done=false;
    const end=(error?: Error)=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      if(error)reject(error); else resolve();
    };
    const timer=setTimeout(()=>{
      try { child.kill(); } catch { /* child may have already terminated */ void 0; }
      end(new Error(RENDER_ERROR));
    },RENDER_TIMEOUT_MS);
    child.on("error",()=>end(new Error(RENDER_ERROR)));
    child.on("close",(code,signal)=>{
      if(signal || code!==0)end(new Error(RENDER_ERROR));
      else end();
    });
  });
}

export async function renderAndStorePdfSourcePage(
  store: VisualWriteOnceStore,
  input: RenderSourcePdfPageInput,
): Promise<PdfPageVisualReceipt> {
  if(!input || !(input.pdfBytes instanceof Uint8Array) ||
     input.pdfBytes.byteLength<8 || input.pdfBytes.byteLength>MAX_INPUT ||
     !SHA.test(input.expectedOriginalPdfSha256) ||
     !Number.isSafeInteger(input.physicalPageIndex) ||
     input.physicalPageIndex<0 || input.physicalPageIndex>=2000 ||
     (input.scale!==undefined && (!Number.isFinite(input.scale) || input.scale<0.8 || input.scale>1.5))) {
    throw new Error(RENDER_ERROR);
  }
  const pdf=new Uint8Array(input.pdfBytes);
  const actualSha=createHash("sha256").update(pdf).digest("hex");
  if(actualSha!==input.expectedOriginalPdfSha256) throw new Error(SOURCE_MISMATCH);
  if(!Buffer.from(pdf.subarray(0,5)).equals(Buffer.from("%PDF-"))) throw new Error(RENDER_ERROR);

  let tempDir: string | undefined;
  try {
    tempDir=await mkdtemp(join(tmpdir(),"acs-pdf-visual-"));
    const original=join(tempDir,"original.pdf");
    const rendered=join(tempDir,"page.png");
    await writeFile(original,pdf,{flag:"wx",mode:0o600});
    await runWorker(original,rendered,input.physicalPageIndex,input.scale??1);
    const info=await stat(rendered);
    if(!info.isFile() || info.size<57 || info.size>MAX_OUTPUT) throw new Error(RENDER_ERROR);
    const png=new Uint8Array(await readFile(rendered));
    inspectSourcePagePng(png);
    return await persistPdfSourcePageVisual(store,{
      workspaceId:input.workspaceId,
      sourceDocumentId:input.sourceDocumentId,
      originalPdfSha256:actualSha,
      physicalPageIndex:input.physicalPageIndex,
      pngBytes:png,
    });
  } catch(error) {
    // Propagate only fixed errors, NEVER source PDF text, parser diagnostics,
    // original object key, temp path, or storage credentials.
    if(error instanceof Error && /^SOURCE_PDF_VISUAL_ASSET_/.test(error.message)) throw error;
    throw new Error(RENDER_ERROR);
  } finally {
    if(tempDir) {
      try { await rm(tempDir,{recursive:true,force:true}); } catch { /* no source leakage */ }
    }
  }
}
