import { prisma } from "@ai-cognitive/db";
import { createHash } from "node:crypto";
import { BOOK_PAID_GRANT_TYPE, assertBookExecutionAuthority, assertBookJobAuthority, type BookExecutionContext, type BookAuthorityTransaction, isBookAnalysisEmbeddingIdempotencyKey } from "@ai-cognitive/book-intelligence";
import { FetchProviderHttpTransport, ProviderGatewayError, ProviderAdapterFailure, createProviderAdapterResolver, type ProviderAdapterResolver, type ProviderHttpTransport } from "@ai-cognitive/provider-gateway";
export { BOOK_PAID_GRANT_TYPE };
export type BookPaidGrant = { version: 1; sourceDocumentId: string; extractionId: string; sha256: string; bootstrapId: string; expiresAt: string; credentialIds: string[]; maxMicroCny: number; maxTextCalls?: number; maxEmbeddingCalls?: number; reservedMicroCny: number; textCalls: number; embeddingCalls: number; entries: Array<{ ordinal: number; kind: "TEXT" | "EMBEDDING"; reservedMicroCny: number; inputUpper: number; outputMax: number; state: string; operationKey?: string; requestFingerprint?: string; httpStatus?: number; remoteErrorCode?: string }>; stopped?: boolean };
function parse(value: unknown): BookPaidGrant {
  const p = value as BookPaidGrant;
  if (!p || p.version !== 1 || !p.sourceDocumentId || !p.extractionId || !p.sha256 || !p.bootstrapId || !Array.isArray(p.credentialIds) || !p.credentialIds.length || !Array.isArray(p.entries) || !Number.isSafeInteger(p.maxMicroCny) || p.maxMicroCny < 1 || p.maxMicroCny > 5_000_000 || (p.maxTextCalls !== undefined && (!Number.isInteger(p.maxTextCalls) || p.maxTextCalls < 0 || p.maxTextCalls > 200)) || (p.maxEmbeddingCalls !== undefined && (!Number.isInteger(p.maxEmbeddingCalls) || p.maxEmbeddingCalls < 0 || p.maxEmbeddingCalls > 64)) || !Number.isSafeInteger(p.reservedMicroCny) || p.reservedMicroCny < 0 || !Number.isSafeInteger(p.textCalls) || p.textCalls < 0 || !Number.isSafeInteger(p.embeddingCalls) || p.embeddingCalls < 0 || !Number.isFinite(Date.parse(p.expiresAt))) throw new Error("BOOK_PAID_GRANT_INVALID");
  return p;
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
  const transport = (currentSlot: string, operationKey: string, requestFingerprint: string, context: BookExecutionContext): ProviderHttpTransport => ({
    executeBinary: async () => { throw new ProviderGatewayError("CAPABILITY_MISMATCH"); },
    execute: async request => {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      const embedding = body.model === "embedding-3" && currentSlot === "EMBEDDING" && request.url === "https://open.bigmodel.cn/api/paas/v4/embeddings";
      const text = body.model === "glm-5.3-flash" && ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"].includes(currentSlot) && request.url === "https://open.bigmodel.cn/api/paas/v4/chat/completions";
      if (!embedding && !text) throw new ProviderGatewayError("CAPABILITY_MISMATCH");
      if (text) { body.max_tokens = Math.min(typeof body.max_tokens === "number" ? body.max_tokens : 4000, 4000); body.thinking = { type: "enabled" }; body.reasoning_effort = "low"; body.stream = false; }
      if (embedding && (!Array.isArray(body.input) || body.input.length > 64 || body.input.some(value => typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8192))) throw new ProviderGatewayError("CONTEXT_LIMIT_EXCEEDED");
      const serialized = JSON.stringify(body), inputUpper = Buffer.byteLength(serialized, "utf8") + 4096, outputMax = text ? Number(body.max_tokens) : 0;
      if (inputUpper > 65536 || text && (!Number.isSafeInteger(outputMax) || outputMax < 1)) throw new ProviderGatewayError("CONTEXT_LIMIT_EXCEEDED");
      const reservedMicroCny = Math.ceil(inputUpper * (text ? 0.8 : 0.5) + outputMax * 2.8);
      const ordinal = await prisma.$transaction(async tx => {
        await assertBound(tx, grantId, context);
        await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id"=${grantId} FOR UPDATE`;
        const job = await tx.job.findUniqueOrThrow({ where: { id: grantId } }), p = parse(job.payload);
        if (job.status !== "RUNNING" || p.stopped || Date.parse(p.expiresAt) <= Date.now()) throw new ProviderGatewayError("BUDGET_EXCEEDED");
        if (p.entries.some(entry => !entry.operationKey)) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
        if (p.entries.some(entry => entry.operationKey === operationKey)) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT");
        const doc = await tx.sourceDocument.findFirst({ where: { id: p.sourceDocumentId, workspaceId: job.workspaceId!, sha256: p.sha256, source: { archivedAt: null }, currentExtraction: { extractionId: p.extractionId } }, select: { id: true } });
        const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: job.workspaceId!, userId: job.userId! } } });
        if (!doc || !member || member.role === "VIEWER") throw new ProviderGatewayError("AUTHORIZATION_FAILED");
        if (p.reservedMicroCny + reservedMicroCny > p.maxMicroCny || (text ? p.textCalls >= (p.maxTextCalls ?? 200) : p.embeddingCalls >= (p.maxEmbeddingCalls ?? 64))) throw new ProviderGatewayError("BUDGET_EXCEEDED");
        const next: BookPaidGrant = { ...p, reservedMicroCny: p.reservedMicroCny + reservedMicroCny, textCalls: p.textCalls + Number(text), embeddingCalls: p.embeddingCalls + Number(embedding), entries: [...p.entries, { ordinal: p.entries.length + 1, kind: text ? "TEXT" : "EMBEDDING", reservedMicroCny, inputUpper, outputMax, state: "RESERVED", operationKey, requestFingerprint }] };
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
        const entries = p.entries.map(entry => entry.ordinal === ordinal ? { ...entry, state: response.status >= 200 && response.status < 300 ? "RESPONSE_RECEIVED" : "REMOTE_REJECTED", httpStatus: response.status, ...(remoteErrorCode ? { remoteErrorCode } : {}), ...(responseDiagnostics ? { responseDiagnostics } : {}) } : entry);
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
      if (input.snapshot.workspaceId !== job.workspaceId || input.snapshot.providerKey !== "zhipu" || !input.snapshot.credentialVersionId || !payload.credentialIds.includes(input.snapshot.credentialVersionId)) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      // This authorization deliberately runs one Book job, one invocation at a time.
      if (!input.request.idempotencyKey || !/^[a-f0-9]{64}$/.test(input.request.requestFingerprint) || !input.request.bookExecution || input.request.bookExecution.workspaceId !== input.snapshot.workspaceId || input.request.workspaceId !== input.snapshot.workspaceId) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      const context=input.request.bookExecution;
      const validOperation=input.snapshot.routeSlot==="EMBEDDING"?isBookAnalysisEmbeddingIdempotencyKey(input.request.idempotencyKey,context.analysisRunId):input.request.idempotencyKey.startsWith(`book-analysis-text:${context.analysisRunId}:${context.jobId}:`);
      if(!validOperation)throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      const operationKey = createHash("sha256").update(input.request.idempotencyKey).digest("hex");
      const adapter = createProviderAdapterResolver(transport(input.snapshot.routeSlot, operationKey, input.request.requestFingerprint, input.request.bookExecution))(identity);
      if (!adapter) throw new ProviderGatewayError("CAPABILITY_MISMATCH");
      try { return await adapter.execute(input); } catch (error) { if (!(error instanceof ProviderGatewayError && error.code === "IDEMPOTENCY_CONFLICT")) await stop(input.request.bookExecution); throw error; }
    } };
  };
}
