/** Real disposable executor owner used only by the machine-local crash test.
 * The parent kills this Node process after observing the live managed engine;
 * production finally/close handlers must therefore never get to run. */
import { readFileSync } from "node:fs";
import { prisma } from "@ai-cognitive/db";
import { createMineruPdfOcrExecutor } from "../../../src/mineru/mineru-executor.js";
import type { MineruExecutorConfig } from "../../../src/mineru/mineru-config.js";
import { sha256Bytes } from "../../../src/mineru/mineru-standard-admission.js";
import type { PdfOcrPageRequest } from "../../../src/pdf-routing.js";
process.once("message",async(message:{config:MineruExecutorConfig;pdfPath:string;request:Omit<PdfOcrPageRequest,"pdfBytes"|"standardExecutionRequest">})=>{
 const handle=createMineruPdfOcrExecutor(message.config,{standardModelsVerified:true});
 try {
  const pdfBytes=new Uint8Array(readFileSync(message.pdfPath));
  const result=await handle.executor.extractPage({...message.request,pdfBytes,standardExecutionRequest:{sourcePdfSha256:sha256Bytes(pdfBytes)}});
  process.send?.({state:"finished",status:result.status});
 } catch {process.send?.({state:"failed"});}
 finally {await handle.close();await prisma.$disconnect();process.disconnect?.();}
});
