import { prisma } from "@ai-cognitive/db";
import { createHash } from "node:crypto";
import { BOOK_PAID_GRANT_TYPE, assertBookExecutionAuthority, assertBookJobAuthority, type BookExecutionContext, type BookAuthorityTransaction, isBookAnalysisEmbeddingIdempotencyKey, estimateAnalysisTokens } from "@ai-cognitive/book-intelligence";
import { FetchProviderHttpTransport, ProviderGatewayError, ProviderAdapterFailure, createProviderAdapterResolver, stableHash, type ProviderAdapterResolver, type ProviderHttpTransport } from "@ai-cognitive/provider-gateway";
export { BOOK_PAID_GRANT_TYPE };
export type BookPaidGrant = { version: 1; providerPolicy?: "MINIMAX_M3_CN_MERGE_V1" | "MINIMAX_M3_CN_CHUNK_CANARY_V1" | "MINIMAX_M3_CN_CHUNK_BATCH_V1" | "MINIMAX_M3_CN_CHUNK_BUDGET_V1"; mergeContinuation?: { cumulativeTextLimit?: 75 | 120; sectionThinking?: "disabled"; sectionOutputLimit?: 4096; directSynthesis?: true; stageAllocation?: "section-recovery"; priorStageCounts?: { SECTION: number; CHAPTER: number; BOOK: number; EMBEDDINGS: number }; priorEmbeddingInputCount?: number; maxOutputTokens: 16000; priorReservedMicroCny: number; cumulativeMaxMicroCny: number; carryForward: Array<{ grantId: string; digest: string; reservedMicroCny: number }> }; mergeProbe?: { operationKey: string; originalBodyHash: string; priorGrantId: string; priorReservedMicroCny: number; cumulativeMaxMicroCny: number }; canaryChunkId?: string; firstChunkOrdinal?: number; lastChunkOrdinal?: number; sourceDocumentId: string; extractionId: string; sha256: string; bootstrapId: string; expiresAt: string; credentialIds: string[]; maxMicroCny: number; maxTextCalls?: number; maxEmbeddingCalls?: number; reservedMicroCny: number; textCalls: number; embeddingCalls: number; entries: Array<{ ordinal: number; kind: "TEXT" | "EMBEDDING"; reservedMicroCny: number; inputUpper: number; outputMax: number; state: string; operationKey?: string; requestFingerprint?: string; reportedInputTokens?: number; reportedOutputTokens?: number; httpStatus?: number; remoteErrorCode?: string; stage?: string; inputCount?: number }>; stopped?: boolean };
/** Billing evidence is independent of the generated JSON's semantic validity.
 * Absent/inconsistent usage still retains the complete original reservation. */
export function boundedMiniMaxReportedUsage(body: string, httpStatus: number, inputUpper: number, outputMax: number): {reportedInputTokens:number;reportedOutputTokens:number}|undefined {
  try {
    const p=JSON.parse(body) as {model?:unknown;error?:unknown;base_resp?:{status_code?:unknown};choices?:Array<{finish_reason?:unknown}>;usage?:{prompt_tokens?:unknown;completion_tokens?:unknown;total_tokens?:unknown}};
    if(httpStatus<200||httpStatus>=300||p.error||(p.model!==undefined&&p.model!=="MiniMax-M3")||(p.base_resp?.status_code!==undefined&&p.base_resp.status_code!==0)||!["stop","length"].includes(String(p.choices?.[0]?.finish_reason)))return;
    const input=p.usage?.prompt_tokens,output=p.usage?.completion_tokens,total=p.usage?.total_tokens;
    if(typeof input!=="number"||!Number.isSafeInteger(input)||input<1||input>inputUpper||typeof output!=="number"||!Number.isSafeInteger(output)||output<1||output>outputMax||(total!==undefined&&total!==input+output))return;
    return{reportedInputTokens:input,reportedOutputTokens:output};
  }catch{return;}
}

function mergeStageCaps(continuation: BookPaidGrant["mergeContinuation"]) {
  if (continuation?.cumulativeTextLimit === 120) return { SECTION: 75, CHAPTER: 37, BOOK: 8, EMBEDDINGS: 9 };
  if (continuation?.stageAllocation === "section-recovery") return { SECTION: 56, CHAPTER: 16, BOOK: 3, EMBEDDINGS: 9 };
  if (continuation?.cumulativeTextLimit === 75) return { SECTION: 52, CHAPTER: 18, BOOK: 5, EMBEDDINGS: 9 };
  return { SECTION: 46, CHAPTER: 16, BOOK: 3, EMBEDDINGS: 9 };
}

function parse(value: unknown): BookPaidGrant {
  const p = value as BookPaidGrant;
  if (!p || (p.providerPolicy !== undefined && p.providerPolicy !== "MINIMAX_M3_CN_MERGE_V1" && p.providerPolicy !== "MINIMAX_M3_CN_CHUNK_CANARY_V1" && p.providerPolicy !== "MINIMAX_M3_CN_CHUNK_BATCH_V1" && p.providerPolicy !== "MINIMAX_M3_CN_CHUNK_BUDGET_V1") || (p.providerPolicy === "MINIMAX_M3_CN_CHUNK_CANARY_V1" && (typeof p.canaryChunkId !== "string" || !p.canaryChunkId || p.maxTextCalls !== 1 || p.maxEmbeddingCalls !== 0 || p.maxMicroCny > 80000)) || (["MINIMAX_M3_CN_CHUNK_BATCH_V1", "MINIMAX_M3_CN_CHUNK_BUDGET_V1"].includes(p.providerPolicy ?? "") && (!Number.isSafeInteger(p.firstChunkOrdinal) || !Number.isSafeInteger(p.lastChunkOrdinal) || p.firstChunkOrdinal! < 28 || p.lastChunkOrdinal! > 140 || p.lastChunkOrdinal! < p.firstChunkOrdinal! || p.maxTextCalls !== p.lastChunkOrdinal! - p.firstChunkOrdinal! + 1 || p.maxEmbeddingCalls !== 0 || p.maxMicroCny > 4_000_000)) || p.version !== 1 || !p.sourceDocumentId || !p.extractionId || !p.sha256 || !p.bootstrapId || !Array.isArray(p.credentialIds) || !p.credentialIds.length || !Array.isArray(p.entries) || !Number.isSafeInteger(p.maxMicroCny) || p.maxMicroCny < 1 || p.maxMicroCny > (p.providerPolicy === "MINIMAX_M3_CN_MERGE_V1" ? (p.mergeContinuation?.cumulativeTextLimit === 120 ? 20_000_000 : 10_000_000) : 5_000_000) || (p.maxTextCalls !== undefined && (!Number.isInteger(p.maxTextCalls) || p.maxTextCalls < 0 || p.maxTextCalls > 200)) || (p.maxEmbeddingCalls !== undefined && (!Number.isInteger(p.maxEmbeddingCalls) || p.maxEmbeddingCalls < 0 || p.maxEmbeddingCalls > 64)) || !Number.isSafeInteger(p.reservedMicroCny) || p.reservedMicroCny < 0 || !Number.isSafeInteger(p.textCalls) || p.textCalls < 0 || !Number.isSafeInteger(p.embeddingCalls) || p.embeddingCalls < 0 || !Number.isFinite(Date.parse(p.expiresAt))) throw new Error("BOOK_PAID_GRANT_INVALID");
  if (["MINIMAX_M3_CN_CHUNK_BATCH_V1", "MINIMAX_M3_CN_CHUNK_BUDGET_V1"].includes(p.providerPolicy ?? "") && (p.reservedMicroCny !== p.entries.reduce((n,e)=>n+e.reservedMicroCny,0) || p.textCalls !== p.entries.length || p.embeddingCalls !== 0 || p.entries.some(e=>e.kind!=="TEXT"||!Number.isSafeInteger(e.reservedMicroCny)||e.reservedMicroCny<1||!e.operationKey))) throw new Error("BOOK_PAID_GRANT_INVALID");
  if(p.providerPolicy === "MINIMAX_M3_CN_MERGE_V1" && ((p.mergeProbe ? p.maxTextCalls!==1||p.maxEmbeddingCalls!==0||p.maxMicroCny>203213||!p.mergeProbe.priorGrantId||!/^[a-f0-9]{64}$/.test(p.mergeProbe.operationKey)||!/^[a-f0-9]{64}$/.test(p.mergeProbe.originalBodyHash)||!Number.isSafeInteger(p.mergeProbe.priorReservedMicroCny)||p.mergeProbe.priorReservedMicroCny<0||p.mergeProbe.cumulativeMaxMicroCny!==10000000||p.mergeProbe.priorReservedMicroCny+p.maxMicroCny>10000000 : p.mergeContinuation ? p.maxTextCalls===undefined||p.maxTextCalls>(p.mergeContinuation.cumulativeTextLimit??65)||p.maxEmbeddingCalls===undefined||p.maxEmbeddingCalls>9 : p.maxTextCalls!==65||p.maxEmbeddingCalls!==9)||p.reservedMicroCny!==p.entries.reduce((n,e)=>n+e.reservedMicroCny,0)||p.textCalls!==p.entries.filter(e=>e.kind==="TEXT").length||p.embeddingCalls!==p.entries.filter(e=>e.kind==="EMBEDDING").length||p.entries.some(e=>!e.operationKey||!Number.isSafeInteger(e.reservedMicroCny)||e.reservedMicroCny<1)))throw new Error("BOOK_PAID_GRANT_INVALID");
  if(p.mergeProbe&&p.providerPolicy!=="MINIMAX_M3_CN_MERGE_V1")throw new Error("BOOK_PAID_GRANT_INVALID");
  if(p.mergeContinuation){const c=p.mergeContinuation;if(c.cumulativeTextLimit!==undefined&&((c.cumulativeTextLimit!==75&&c.cumulativeTextLimit!==120)||!c.priorStageCounts||c.priorStageCounts.SECTION+c.priorStageCounts.CHAPTER+c.priorStageCounts.BOOK+p.maxTextCalls!>c.cumulativeTextLimit))throw new Error("BOOK_PAID_GRANT_INVALID");if(c.stageAllocation!==undefined&&(c.stageAllocation!=="section-recovery"||c.cumulativeTextLimit!==75))throw new Error("BOOK_PAID_GRANT_INVALID");if(c.directSynthesis!==undefined&&(c.directSynthesis!==true||c.cumulativeTextLimit!==120))throw new Error("BOOK_PAID_GRANT_INVALID");if(c.sectionOutputLimit!==undefined&&(c.sectionOutputLimit!==4096||c.sectionThinking!=="disabled"))throw new Error("BOOK_PAID_GRANT_INVALID");if(c.sectionThinking!==undefined&&c.sectionThinking!=="disabled")throw new Error("BOOK_PAID_GRANT_INVALID");if(p.providerPolicy!=="MINIMAX_M3_CN_MERGE_V1"||p.mergeProbe||c.maxOutputTokens!==16000||c.cumulativeMaxMicroCny!==(c.cumulativeTextLimit===120?20000000:10000000)||!Array.isArray(c.carryForward)||!c.carryForward.length||new Set(c.carryForward.map(r=>r.grantId)).size!==c.carryForward.length||c.carryForward.some(r=>!r.grantId||!/^[a-f0-9]{64}$/.test(r.digest)||!Number.isSafeInteger(r.reservedMicroCny)||r.reservedMicroCny<1)||!Number.isSafeInteger(c.priorReservedMicroCny)||c.priorReservedMicroCny!==c.carryForward.reduce((n,r)=>n+r.reservedMicroCny,0)||c.priorReservedMicroCny+p.maxMicroCny>c.cumulativeMaxMicroCny)throw new Error("BOOK_PAID_GRANT_INVALID");}
  if(p.mergeContinuation){const c=p.mergeContinuation,counts=c.priorStageCounts,caps=mergeStageCaps(c);if(counts!==undefined&&(!counts||Object.keys(counts).length!==4||Object.entries(caps).some(([k,max])=>!Number.isSafeInteger(counts[k as keyof typeof counts])||counts[k as keyof typeof counts]<0||counts[k as keyof typeof counts]>max)))throw new Error("BOOK_PAID_GRANT_INVALID");if(c.priorEmbeddingInputCount!==undefined&&(!Number.isSafeInteger(c.priorEmbeddingInputCount)||c.priorEmbeddingInputCount<0||c.priorEmbeddingInputCount>547))throw new Error("BOOK_PAID_GRANT_INVALID");}
  return p;
}
/** Gross reservations stay immutable. Only bounded, supplier-reported usage replaces
 * an entry's outstanding exposure; this is a no-cache price ceiling, not an invoice. */
export function bookPaidExposureMicroCny(p: BookPaidGrant): number {
  if(p.mergeContinuation)return p.entries.reduce((total,e)=>{const known=e.state==="RESPONSE_RECEIVED"&&e.httpStatus!==undefined&&e.httpStatus>=200&&e.httpStatus<300&&Number.isSafeInteger(e.reportedInputTokens)&&e.reportedInputTokens!>0;
    if(e.kind==="TEXT"&&known&&e.reportedInputTokens!<=e.inputUpper&&Number.isSafeInteger(e.reportedOutputTokens)&&e.reportedOutputTokens!>0&&e.reportedOutputTokens!<=e.outputMax)return total+Math.ceil(e.reportedInputTokens!*2.1+e.reportedOutputTokens!*8.4);
    if(e.kind==="EMBEDDING"&&known&&Number.isSafeInteger(e.inputCount)&&e.reportedInputTokens!<=e.inputCount!*3072)return total+Math.ceil(e.reportedInputTokens!*.5);
    return total+e.reservedMicroCny;},0);

  if (!["MINIMAX_M3_CN_CHUNK_BATCH_V1", "MINIMAX_M3_CN_CHUNK_BUDGET_V1"].includes(p.providerPolicy ?? "")) return p.reservedMicroCny;
  return p.entries.reduce((total, e) => {
    const known=e.state==="RESPONSE_RECEIVED"&&e.httpStatus!==undefined&&e.httpStatus>=200&&e.httpStatus<300&&Number.isSafeInteger(e.reportedInputTokens)&&e.reportedInputTokens!>0&&e.reportedInputTokens!<=e.inputUpper&&Number.isSafeInteger(e.reportedOutputTokens)&&e.reportedOutputTokens!>0&&e.reportedOutputTokens!<=e.outputMax;
    return total+(known?Math.ceil(e.reportedInputTokens!*2.1+e.reportedOutputTokens!*8.4):e.reservedMicroCny);
  },0);
}
export async function readBookPaidGrant(id: string) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id } });
  if (job.type !== BOOK_PAID_GRANT_TYPE || !job.workspaceId || !job.userId) throw new Error("BOOK_PAID_GRANT_INVALID");
  return { job, payload: parse(job.payload) };
}
/** Explicit operator binding; old/unbound grants remain readable but cannot execute. */
export async function bindBookPaidGrant(id: string, analysisRunId: string, actor: { workspaceId: string; userId: string }) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "BookAnalysisRun" WHERE "id"=${analysisRunId} FOR UPDATE`;
    const run = await tx.bookAnalysisRun.findUniqueOrThrow({ where: { id: analysisRunId } });
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${run.jobId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${id} FOR UPDATE`;
    const [job, grant] = await Promise.all([tx.job.findUniqueOrThrow({ where: { id: run.jobId } }), tx.job.findUniqueOrThrow({ where: { id } })]);
    const p = parse(grant.payload);
    if (grant.workspaceId !== actor.workspaceId || grant.userId !== actor.userId || grant.type !== BOOK_PAID_GRANT_TYPE || grant.status !== "QUEUED" || grant.attemptCount !== 0 || (p as BookPaidGrant & {binding?:unknown}).binding !== undefined || p.entries.length || run.status !== "QUEUED" || job.status !== "QUEUED" || !job.userId || job.userId !== grant.userId || run.workspaceId !== grant.workspaceId || job.workspaceId !== run.workspaceId || run.sourceDocumentId !== p.sourceDocumentId || run.extractionId !== p.extractionId || (job.payload as { bookPaidGrantId?: string }).bookPaidGrantId) throw new Error("BOOK_PAID_BINDING_DENIED");
    await tx.job.update({ where: { id }, data: { payload: { ...p, binding: { analysisRunId: run.id, jobId: run.jobId, dispatchGeneration: run.dispatchGeneration } } } });
    await tx.job.update({ where: { id: job.id }, data: { payload: { ...(job.payload as object), bookPaidGrantId: id } } });
  });
}
async function assertBound(tx: BookAuthorityTransaction, grantId: string, context: BookExecutionContext) {
  try { const state = await assertBookExecutionAuthority(tx, context); if (state.grantId !== grantId) throw new Error(); }
  catch { throw new ProviderGatewayError("AUTHORIZATION_FAILED"); }
}
export async function cancelBookPaidGrant(id: string, actor: { workspaceId: string; userId: string }) {
  const { job: grantJob, payload } = await readBookPaidGrant(id);
  if (grantJob.workspaceId !== actor.workspaceId || grantJob.userId !== actor.userId) throw new Error("BOOK_PAID_ACTOR_DENIED");
  const binding = (payload as BookPaidGrant & { binding?: { analysisRunId: string; jobId: string; dispatchGeneration: number } }).binding;
  if (!binding) throw new Error("BOOK_PAID_BINDING_REQUIRED");
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "BookAnalysisRun" WHERE "id"=${binding.analysisRunId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${binding.jobId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${id} FOR UPDATE`;
    await tx.job.updateMany({ where: { id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", completedAt: new Date() } });
    await tx.job.updateMany({ where: { id: binding.jobId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", completedAt: new Date() } });
    await tx.bookAnalysisRun.updateMany({ where: { id: binding.analysisRunId, jobId: binding.jobId, dispatchGeneration: binding.dispatchGeneration, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", errorCode: "BOOK_AUTHORIZATION_CANCELLED", executionClaimToken: null, executionLeaseUntil: null, completedAt: new Date() } });
  });
}
export async function activateBookPaidGrant(id: string, actor: { workspaceId: string; userId: string }) {
 const grant = await readBookPaidGrant(id);
 if (grant.job.workspaceId !== actor.workspaceId || grant.job.userId !== actor.userId) throw new Error("BOOK_PAID_ACTOR_DENIED");
 const binding = (grant.payload as BookPaidGrant & { binding?: { analysisRunId: string } }).binding;
 if (!binding) throw new Error("BOOK_PAID_BINDING_REQUIRED");
 return prisma.$transaction(async tx => {
  await tx.$queryRaw`SELECT "id" FROM "BookAnalysisRun" WHERE "id"=${binding.analysisRunId} FOR UPDATE`;
  const run = await tx.bookAnalysisRun.findUniqueOrThrow({where:{id:binding.analysisRunId}});
  await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${run.jobId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${id} FOR UPDATE`;
  const fresh=await tx.job.findUniqueOrThrow({where:{id}}),p=parse(fresh.payload);
  if(p.stopped||Date.parse(p.expiresAt)<=Date.now())throw new Error("BOOK_PAID_GRANT_EXPIRED");
  const claimed=await tx.job.updateMany({where:{id,type:BOOK_PAID_GRANT_TYPE,status:"QUEUED",attemptCount:0},data:{status:"RUNNING",attemptCount:1,startedAt:new Date()}});
  if(claimed.count!==1)throw new Error("BOOK_PAID_GRANT_ALREADY_STARTED");
  const state=await assertBookJobAuthority(tx,run.id,["QUEUED","RUNNING"]);
  if(state.grantId!==id)throw new Error("BOOK_PAID_BINDING_REQUIRED");
  return {job:fresh,payload:p};
 });
}
export function createBookPaidResolver(grantId: string, upstream: ProviderHttpTransport = new FetchProviderHttpTransport(), hooks: { beforeSendAdmission?: () => Promise<void> } = {}): ProviderAdapterResolver {
  const stop = async (context: BookExecutionContext) => { await prisma.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "BookAnalysisRun" WHERE "id"=${context.analysisRunId} FOR UPDATE`; const run=await tx.bookAnalysisRun.findUnique({where:{id:context.analysisRunId}}); const [clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`; if(!run||run.jobId!==context.jobId||run.dispatchGeneration!==context.dispatchGeneration||run.executionClaimToken!==context.claimToken||!run.executionLeaseUntil||run.executionLeaseUntil.getTime()<=clock!.now.getTime())return; await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${context.jobId} FOR UPDATE`; await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${grantId} FOR UPDATE`; const job = await tx.job.findUniqueOrThrow({ where: { id: grantId } }); const p = parse(job.payload); if (job.status !== "RUNNING") return; await tx.job.update({ where: { id: grantId }, data: { payload: { ...p, stopped: true }, status: "FAILED", completedAt: new Date(), error: { code: "BOOK_PAID_EXECUTION_STOPPED" } } }); }); };
  const transport = (currentSlot: string, operationKey: string, requestFingerprint: string, context: BookExecutionContext, minimax: boolean, requestedChunkId?: string, requestedChunkHash?: string, budgetOnly = false, mergeStage?: "SECTION" | "CHAPTER" | "BOOK" | "EMBEDDINGS"): ProviderHttpTransport => ({
    executeBinary: async () => { throw new ProviderGatewayError("CAPABILITY_MISMATCH"); },
    execute: async request => {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      const embedding = !minimax && body.model === "embedding-3" && currentSlot === "EMBEDDING" && request.url === "https://open.bigmodel.cn/api/paas/v4/embeddings";
      const text = minimax ? body.model === "MiniMax-M3" && (mergeStage ? ["BOOK_REDUCTION_ANALYSIS","BOOK_SYNTHESIS"].includes(currentSlot) : currentSlot === "BOOK_CHUNK_ANALYSIS") && request.url === (budgetOnly || mergeStage ? "https://api.minimax.cn/v1/chat/completions" : "https://api.minimax.cn/v1/text/chatcompletion_v2") : body.model === "glm-5.3-flash" && ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"].includes(currentSlot) && request.url === "https://open.bigmodel.cn/api/paas/v4/chat/completions";
      if (!embedding && !text || mergeStage && body.service_tier !== undefined && body.service_tier !== "standard") throw new ProviderGatewayError("CAPABILITY_MISMATCH");
      const mergeGrant=mergeStage?(await readBookPaidGrant(grantId)).payload:undefined,probe=mergeGrant?.mergeProbe,continuation=mergeGrant?.mergeContinuation;
      if(probe&&(!text||mergeStage!=="SECTION"))throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      if (text) { body.max_tokens = mergeStage ? (probe||continuation?16000:8000) : Math.min(typeof body.max_tokens === "number" ? body.max_tokens : 4000, 4000); if (!minimax) { body.thinking = { type: "enabled" }; body.reasoning_effort = "low"; } else { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; if(mergeStage)body.reasoning_split=true; } body.stream = false; }
      if (continuation?.sectionThinking === "disabled" && mergeStage === "SECTION") {
        body.thinking = { type: "disabled" };
        if (continuation.sectionOutputLimit !== undefined) body.max_completion_tokens = continuation.sectionOutputLimit;
      }
      if (continuation?.directSynthesis && (mergeStage === "CHAPTER" || mergeStage === "BOOK")) {
        body.thinking = { type: "disabled" };
        body.max_completion_tokens = mergeStage === "BOOK" ? 8192 : 4096;
      }
      if(probe&&stableHash({...body,max_completion_tokens:8000})!==probe.originalBodyHash)throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      if (budgetOnly) {
        const {payload:grant}=await readBookPaidGrant(grantId);
        if(grant.providerPolicy!=="MINIMAX_M3_CN_CHUNK_BUDGET_V1")throw new ProviderGatewayError("AUTHORIZATION_FAILED");
        // There is no fixed application token ceiling. The model's physical
        // 512K output maximum and the unspent CNY authorization are the bounds.
        body.max_completion_tokens=524288;body.reasoning_split=true;
        const inputBound=Buffer.byteLength(JSON.stringify(body),"utf8")+4096;
        const available=grant.maxMicroCny-bookPaidExposureMicroCny(grant);
        const affordable=Math.floor((available-Math.ceil(inputBound*2.1))/8.4);
        if(affordable<1)throw new ProviderGatewayError("BUDGET_EXCEEDED");
        body.max_completion_tokens=Math.min(524288,affordable);
      }
      if (embedding && (!Array.isArray(body.input) || body.input.length > 64 || body.input.some(value => typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8192))) throw new ProviderGatewayError("CONTEXT_LIMIT_EXCEEDED");
      const serialized = JSON.stringify(body), inputUpper = Buffer.byteLength(serialized, "utf8") + 4096, outputMax = text ? Number(minimax ? body.max_completion_tokens : body.max_tokens) : 0;
      if (inputUpper > (mergeStage && embedding ? 64*8192+8192 : budgetOnly || mergeStage ? 32768 : minimax ? 16384 : 65536) || text && (!Number.isSafeInteger(outputMax) || outputMax < 1)) throw new ProviderGatewayError("CONTEXT_LIMIT_EXCEEDED");
      const reservedMicroCny = mergeStage && embedding ? (body.input as string[]).length * 1536 : Math.ceil(inputUpper * (minimax ? 2.1 : text ? 0.8 : 0.5) + outputMax * (minimax ? 8.4 : 2.8));
      const ordinal = await prisma.$transaction(async tx => {
        await assertBound(tx, grantId, context);
        await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${grantId} FOR UPDATE`;
        const job = await tx.job.findUniqueOrThrow({ where: { id: grantId } }), p = parse(job.payload);
        if (job.status !== "RUNNING" || p.stopped || Date.parse(p.expiresAt) <= Date.now()) throw new ProviderGatewayError("BUDGET_EXCEEDED");
        if (!mergeStage && ((p.providerPolicy === "MINIMAX_M3_CN_CHUNK_BUDGET_V1") !== budgetOnly || (p.providerPolicy?.startsWith("MINIMAX_") === true) !== minimax || p.providerPolicy === "MINIMAX_M3_CN_CHUNK_CANARY_V1" && p.canaryChunkId !== requestedChunkId)) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
        if(mergeStage){
          if(p.providerPolicy!=="MINIMAX_M3_CN_MERGE_V1")throw new ProviderGatewayError("AUTHORIZATION_FAILED");
          if(stableHash(probe??null)!==stableHash(p.mergeProbe??null)||stableHash(continuation??null)!==stableHash(p.mergeContinuation??null))throw new ProviderGatewayError("AUTHORIZATION_FAILED");
          if(p.mergeProbe){const old=await tx.job.findUniqueOrThrow({where:{id:p.mergeProbe.priorGrantId}}),prior=parse(old.payload);if(old.type!==BOOK_PAID_GRANT_TYPE||old.workspaceId!==job.workspaceId||old.userId!==job.userId||old.status!=="FAILED"||!prior.stopped||prior.sourceDocumentId!==p.sourceDocumentId||prior.extractionId!==p.extractionId||prior.reservedMicroCny!==p.mergeProbe.priorReservedMicroCny||prior.reservedMicroCny+p.reservedMicroCny+reservedMicroCny>p.mergeProbe.cumulativeMaxMicroCny)throw new ProviderGatewayError("AUTHORIZATION_FAILED");}
          if(p.mergeContinuation){for(const carried of p.mergeContinuation.carryForward){const old=await tx.job.findUniqueOrThrow({where:{id:carried.grantId}});if(old.id===grantId||old.type!==BOOK_PAID_GRANT_TYPE||old.workspaceId!==job.workspaceId||old.userId!==job.userId||old.status!=="FAILED"||stableHash(old.payload)!==carried.digest||(old.payload as BookPaidGrant).sourceDocumentId!==p.sourceDocumentId||(old.payload as BookPaidGrant).extractionId!==p.extractionId||(old.payload as BookPaidGrant).reservedMicroCny!==carried.reservedMicroCny)throw new ProviderGatewayError("AUTHORIZATION_FAILED");}if(p.mergeContinuation.priorReservedMicroCny+bookPaidExposureMicroCny(p)+reservedMicroCny>p.mergeContinuation.cumulativeMaxMicroCny)throw new ProviderGatewayError("BUDGET_EXCEEDED");}
          const stageCaps = mergeStageCaps(p.mergeContinuation);
          const state=await tx.bookAnalysisRun.findUniqueOrThrow({where:{id:context.analysisRunId},include:{job:true}});
          const expectedStage=mergeStage==="BOOK"?"BOOK_SYNTHESIS":mergeStage==="EMBEDDINGS"?"EMBEDDINGS":`${mergeStage}_ANALYSIS`;
          if(state.analysisStage!==expectedStage||!(state.job.payload as {frozenChunks?:unknown}).frozenChunks||p.entries.filter(e=>e.stage===mergeStage).length+(p.mergeContinuation?.priorStageCounts?.[mergeStage]??0)>=stageCaps[mergeStage])throw new ProviderGatewayError("AUTHORIZATION_FAILED");
          if(embedding){const inputs=body.input as string[];if(body.dimensions!==2048||inputs.some(t=>estimateAnalysisTokens(t)>3072)||p.entries.reduce((n,e)=>n+(e.inputCount??0),0)+(p.mergeContinuation?.priorEmbeddingInputCount??0)+inputs.length>547)throw new ProviderGatewayError("CONTEXT_LIMIT_EXCEEDED");}
        }
        if (minimax && !mergeStage) {
          const chunk=await tx.documentChunk.findFirst({where:{id:requestedChunkId,chunkSet:{analysisRuns:{some:{id:context.analysisRunId}}}},include:{sourceSpans:{orderBy:{ordinal:"asc"},include:{sourceBlock:true}}}});
          const messages=body.messages as Array<{role:string;content:unknown}>|undefined;let envelope:{content?:unknown;sourceEvidence?:Array<{sourceBlockId:string;startOffset:number;endOffset:number;text:string;spanIndex?:number}>}|undefined;
          try { const users=messages?.filter(m=>m.role==="user"); if(users?.length===1&&typeof users[0]!.content==="string")envelope=JSON.parse(users[0]!.content); } catch { /* Reject malformed provenance. */ }
          const evidence=envelope?.sourceEvidence;
          if(!chunk||chunk.contentHash!==requestedChunkHash||["MINIMAX_M3_CN_CHUNK_BATCH_V1", "MINIMAX_M3_CN_CHUNK_BUDGET_V1"].includes(p.providerPolicy ?? "") && (chunk.ordinal < p.firstChunkOrdinal! || chunk.ordinal > p.lastChunkOrdinal!)||!Array.isArray(evidence)||envelope?.content!==undefined||evidence.length!==chunk.sourceSpans.length||evidence.map(e=>e.text).join("\n\n")!==chunk.content||evidence.some((e,i)=>{const s=chunk.sourceSpans[i]!;return (e.spanIndex!==undefined&&e.spanIndex!==i)||e.sourceBlockId!==s.sourceBlockId||e.startOffset!==s.startOffset||e.endOffset!==s.endOffset||e.text!==s.sourceBlock.text.slice(s.startOffset,s.endOffset);}))throw new ProviderGatewayError("AUTHORIZATION_FAILED");
        }
        if (p.entries.some(entry => !entry.operationKey)) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
        if (p.entries.some(entry => entry.operationKey === operationKey)) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT");
        const doc = await tx.sourceDocument.findFirst({ where: { id: p.sourceDocumentId, workspaceId: job.workspaceId!, sha256: p.sha256, source: { archivedAt: null }, currentExtraction: { extractionId: p.extractionId } }, select: { id: true } });
        const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: job.workspaceId!, userId: job.userId! } } });
        if (!doc || !member || member.role === "VIEWER") throw new ProviderGatewayError("AUTHORIZATION_FAILED");
        if (bookPaidExposureMicroCny(p) + reservedMicroCny > p.maxMicroCny || (text ? p.textCalls >= (p.maxTextCalls ?? 200) : p.embeddingCalls >= (p.maxEmbeddingCalls ?? 64))) throw new ProviderGatewayError("BUDGET_EXCEEDED");
        const next: BookPaidGrant = { ...p, reservedMicroCny: p.reservedMicroCny + reservedMicroCny, textCalls: p.textCalls + Number(text), embeddingCalls: p.embeddingCalls + Number(embedding), entries: [...p.entries, { ordinal: p.entries.length + 1, kind: text ? "TEXT" : "EMBEDDING", reservedMicroCny, inputUpper, outputMax, state: "RESERVED", operationKey, requestFingerprint, ...(mergeStage?{stage:mergeStage,...(embedding?{inputCount:(body.input as string[]).length}:{})}:{}) }] };
        await tx.job.update({ where: { id: grantId }, data: { payload: next as never } });
        return next.entries.length;
      });
      // The existing reservation is already durable. Serialize send admission
      // with cancellation, and start the HTTP operation while authority is locked.
      await hooks.beforeSendAdmission?.();
      const admitted = await prisma.$transaction(async tx => {
        await assertBound(tx, grantId, context);
        if(request.signal.aborted)throw new ProviderGatewayError("CANCELLED");
        const grant=await tx.job.findUniqueOrThrow({where:{id:grantId}}),p=parse(grant.payload);
        await tx.job.update({where:{id:grantId},data:{payload:{...p,entries:p.entries.map(e=>e.ordinal===ordinal?{...e,state:"DISPATCHED"}:e)}as never}});
        return { pending: upstream.execute({ ...request, body: serialized }).then(response => ({ response }), error => ({ error })) };
      });
      const outcome = await admitted.pending;
      if ("error" in outcome) {
        await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${grantId} FOR UPDATE`;const job=await tx.job.findUniqueOrThrow({where:{id:grantId}}),p=parse(job.payload);await tx.job.update({where:{id:grantId},data:{payload:{...p,entries:p.entries.map(e=>e.ordinal===ordinal?{...e,state:"REMOTE_OUTCOME_UNKNOWN"}:e)}as never}});});
        throw outcome.error;
      }
      const response = outcome.response;
      let remoteErrorCode: string | undefined;
      let responseDiagnostics: { finishReason?: string; contentCharacters?: number; jsonComplete?: boolean } | undefined;
      try {
        const body = JSON.parse(response.body) as { error?: { code?: unknown }; choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> };
        const code = String(body.error?.code ?? ""); if (/^[A-Za-z0-9_.-]{1,80}$/.test(code)) remoteErrorCode = code;
        const choice = body.choices?.[0], reason = choice?.finish_reason, content = choice?.message?.content;
        if (text && choice) {
          let jsonComplete = false;
          if (typeof content === "string") try { JSON.parse(content); jsonComplete = true; } catch { /* Diagnostics only; never repair a provider response. */ }
          responseDiagnostics = { ...(["stop", "length", "content_filter", "tool_calls"].includes(String(reason)) ? { finishReason: String(reason) } : {}), ...(typeof content === "string" ? { contentCharacters: content.length, jsonComplete } : {}) };
        }
      } catch { /* Do not store raw provider text or private source content. */ }
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${grantId} FOR UPDATE`;
        const job = await tx.job.findUniqueOrThrow({ where: { id: grantId } }), p = parse(job.payload);
        let reportedUsage: { reportedInputTokens: number; reportedOutputTokens: number } | undefined;
        if (p.providerPolicy === "MINIMAX_M3_CN_MERGE_V1" || p.providerPolicy === "MINIMAX_M3_CN_CHUNK_BUDGET_V1" || p.providerPolicy === "MINIMAX_M3_CN_CHUNK_BATCH_V1" && responseDiagnostics?.jsonComplete && responseDiagnostics.finishReason === "stop") {
          const entry=p.entries.find(e=>e.ordinal===ordinal)!;
          reportedUsage=boundedMiniMaxReportedUsage(response.body,response.status,entry.inputUpper,entry.outputMax);
        }
        let reportedEmbeddingUsage:{reportedInputTokens:number}|undefined;
        if(p.mergeContinuation&&embedding&&response.status>=200&&response.status<300)try{const b=JSON.parse(response.body),e=p.entries.find(e=>e.ordinal===ordinal)!,tokens=b.usage?.prompt_tokens;if(b.model==="embedding-3"&&!b.error&&Number.isSafeInteger(tokens)&&tokens>0&&tokens<=e.inputCount!*3072&&(b.usage.total_tokens===undefined||b.usage.total_tokens===tokens))reportedEmbeddingUsage={reportedInputTokens:tokens};}catch{/* Unknown usage retains the complete reservation. */}
        const entries = p.entries.map(entry => entry.ordinal === ordinal ? { ...entry, ...reportedUsage, ...reportedEmbeddingUsage, state: response.status >= 200 && response.status < 300 ? "RESPONSE_RECEIVED" : "REMOTE_REJECTED", httpStatus: response.status, ...(remoteErrorCode ? { remoteErrorCode } : {}), ...(responseDiagnostics ? { responseDiagnostics } : {}) } : entry);
        await tx.job.update({ where: { id: grantId }, data: { payload: { ...p, entries } as never } });
      });
      try { await prisma.$transaction(tx => assertBound(tx, grantId, context)); }
      catch {
        await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${grantId} FOR UPDATE`;
          const job=await tx.job.findUniqueOrThrow({where:{id:grantId}}),p=parse(job.payload);
          await tx.job.update({where:{id:grantId},data:{payload:{...p,entries:p.entries.map(e=>e.ordinal===ordinal?{...e,state:"RESPONSE_QUARANTINED"}:e)}as never}});
        });
        let usage: {inputTokens?:number;outputTokens?:number}|undefined;
        try { const raw=(JSON.parse(response.body) as {usage?:{prompt_tokens?:unknown;completion_tokens?:unknown}}).usage; const input=raw?.prompt_tokens,output=raw?.completion_tokens; usage={...(typeof input==="number"&&Number.isSafeInteger(input)&&input>=0?{inputTokens:input}:{}),...(typeof output==="number"&&Number.isSafeInteger(output)&&output>=0?{outputTokens:output}:{})}; } catch { /* No raw response retained. */ }
        throw new ProviderAdapterFailure("AUTHORIZATION_FAILED",{retryable:false,usage});
      }
      return response;
    },
  });
  return identity => {
    return { execute: async input => {
      const { job, payload } = await readBookPaidGrant(grantId);
      const merge=payload.providerPolicy === "MINIMAX_M3_CN_MERGE_V1";
      const minimax = merge ? input.snapshot.routeSlot!=="EMBEDDING" : payload.providerPolicy === "MINIMAX_M3_CN_CHUNK_CANARY_V1" || payload.providerPolicy === "MINIMAX_M3_CN_CHUNK_BATCH_V1" || payload.providerPolicy === "MINIMAX_M3_CN_CHUNK_BUDGET_V1";
      if (input.snapshot.workspaceId !== job.workspaceId || input.snapshot.providerKey !== (minimax ? "minimax" : "zhipu") || !input.snapshot.credentialVersionId || !payload.credentialIds.includes(input.snapshot.credentialVersionId)) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      // This authorization deliberately runs one Book job, one invocation at a time.
      if (!input.request.idempotencyKey || !/^[a-f0-9]{64}$/.test(input.request.requestFingerprint) || !input.request.bookExecution || input.request.bookExecution.workspaceId !== input.snapshot.workspaceId || input.request.workspaceId !== input.snapshot.workspaceId) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      const context=input.request.bookExecution;
      let requestedChunkId=payload.canaryChunkId, requestedChunkHash:string|undefined;
      if(minimax&&!merge){const prefix=`book-analysis-text:${context.analysisRunId}:${context.jobId}:CHUNK:chunk:`;if(!input.request.idempotencyKey.startsWith(prefix))throw new ProviderGatewayError("AUTHORIZATION_FAILED");const parts=input.request.idempotencyKey.slice(prefix.length).split(":");if(parts.length!==2||!parts[0]||!parts[1])throw new ProviderGatewayError("AUTHORIZATION_FAILED");requestedChunkId=parts[0];requestedChunkHash=parts[1];if(payload.providerPolicy==="MINIMAX_M3_CN_CHUNK_CANARY_V1"&&requestedChunkId!==payload.canaryChunkId)throw new ProviderGatewayError("AUTHORIZATION_FAILED");}
      let mergeStage:"SECTION"|"CHAPTER"|"BOOK"|"EMBEDDINGS"|undefined;
      if(merge){
        if(input.snapshot.routeSlot==="EMBEDDING")mergeStage="EMBEDDINGS";
        else {const prefix=`book-analysis-text:${context.analysisRunId}:${context.jobId}:`,tail=input.request.idempotencyKey.slice(prefix.length),parts=tail.split(":");if(!input.request.idempotencyKey.startsWith(prefix)||parts.length!==2||!["SECTION","CHAPTER","BOOK"].includes(parts[0]!)||!/^[a-f0-9]{64}$/.test(parts[1]!))throw new ProviderGatewayError("AUTHORIZATION_FAILED");mergeStage=parts[0] as typeof mergeStage;if(input.snapshot.routeSlot!==(mergeStage==="BOOK"?"BOOK_SYNTHESIS":"BOOK_REDUCTION_ANALYSIS"))throw new ProviderGatewayError("AUTHORIZATION_FAILED");}
      }
      if(payload.mergeProbe&&(mergeStage!=="SECTION"||!input.request.idempotencyKey.endsWith(":SECTION:"+payload.mergeProbe.operationKey)))throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      const validOperation=input.snapshot.routeSlot==="EMBEDDING"?isBookAnalysisEmbeddingIdempotencyKey(input.request.idempotencyKey,context.analysisRunId):input.request.idempotencyKey.startsWith(`book-analysis-text:${context.analysisRunId}:${context.jobId}:`);
      if(!validOperation)throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      const operationKey = createHash("sha256").update(input.request.idempotencyKey).digest("hex");
      const adapter = createProviderAdapterResolver(transport(input.snapshot.routeSlot, operationKey, input.request.requestFingerprint, input.request.bookExecution, minimax, requestedChunkId, requestedChunkHash, payload.providerPolicy === "MINIMAX_M3_CN_CHUNK_BUDGET_V1",mergeStage))(identity);
      if (!adapter) throw new ProviderGatewayError("CAPABILITY_MISMATCH");
      try { return await adapter.execute(input); } catch (error) { if (!(error instanceof ProviderGatewayError && error.code === "IDEMPOTENCY_CONFLICT")) await stop(input.request.bookExecution); throw error; }
    } };
  };
}
