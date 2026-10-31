import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { acquireOcrHostLease, releaseOcrHostLease } from "../../src/ocr-durability.js";
import { reconcileOcrServerInstances } from "../../src/mineru/mineru-reconciler.js";
import { processCreationTime, recordedProcessAlive } from "../../src/mineru/mineru-process.js";
import { parseServerBaseUrl } from "../../src/mineru/mineru-standard-server-setup.js";
import { S3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { APPROVED_MINERU_MANIFEST_SHA256, approvedManifestText } from "../../src/mineru/mineru-approved-inventory.js";
import { PDF_ROUTING_PLAN_SCHEMA_VERSION, PDF_INSPECTOR_VERSION } from "../../src/pdf-routing.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, Prisma } from "@ai-cognitive/db";
import type { Environment } from "@ai-cognitive/shared/server";
import { createIngestionService, createMineruPdfOcrExecutor, PDF_ROUTING_GENERATION, resolveMineruExecutorConfig, sha256Bytes, verifyMineruRuntime, verifyMineruStandardModels, type MineruExecutorConfig } from "../../src/index.js";

/**
 * MACHINE-LOCAL REAL MinerU STANDARD tier acceptance gate (STEP6-2B-1).
 *
 * Same policy as mineru-real.integration.test.ts: runs ONLY where a pinned
 * local MinerU 4.0.3 runtime is provisioned:
 *   MINERU_REAL_EXECUTABLE=<absolute mineru executable>
 *   MINERU_REAL_MODEL_PATH=<shared local model root>
 * Optional:
 *   MINERU_REAL_STANDARD_PDF=<absolute path of a private scanned single-page
 *   PDF> — the standard-admitted case is skipped silently when absent (the
 *   private fixture is NEVER committed to this repository).
 *
 * Proven here, against the REAL production executor path:
 *  1. standard admission: verified manifest -> actual tier "standard" with
 *     the verified manifest digest recorded in the execution facts;
 *  2. runtime demotion: an impossible memory floor refuses the standard
 *     proposal and the SAME invocation executes flash (pre-slice behaviour);
 *  3. source byte-identity: a mismatched source claim refuses standard.
 */

const realExecutable = process.env.MINERU_REAL_EXECUTABLE;
const realModelPath = process.env.MINERU_REAL_MODEL_PATH;
const realStandardPdf = process.env.MINERU_REAL_STANDARD_PDF;
const gateActive = Boolean(realExecutable && realModelPath);

const describeReal = gateActive ? describe : describe.skip;

const workspaceIds: string[] = [];
const userIds: string[] = [];
const runIds: string[] = [];
const tempRoots: string[] = [];
const hostCounter = { value: 0 };


async function realStandardConfig(overrides: Record<string, string> = {}): Promise<MineruExecutorConfig> {
  const tempRoot = mkdtempSync(join(process.env.MINERU_REAL_PRIVATE_ROOT ?? tmpdir(), "mineru-std-real-"));
  tempRoots.push(tempRoot);
  const manifestPath = join(tempRoot,"manifest.json");
  writeFileSync(manifestPath,approvedManifestText());
  const environment = {
    OCR_PROVIDER: "mineru",
    MINERU_MODEL_SOURCE: "local",
    MINERU_MODEL_PATH: realModelPath,
    MINERU_EXECUTABLE: realExecutable,
    MINERU_HOME_ROOT: join(tempRoot, "homes"),
    MINERU_MAX_OUTPUT_BYTES: "8000000",
    OCR_HOST_ID: `mineru-std-real-${(hostCounter.value += 1)}`,
    OCR_TIER_STANDARD_EXPERIMENTAL_ENABLED: "true",
    OCR_TIER_STANDARD_EXECUTION_ADMISSION_ENABLED: "true",
    MINERU_STANDARD_MODEL_MANIFEST: manifestPath,
    // Local-acceptance knob ONLY for the memory floor (the default 2.5 GiB
    // stays the production contract): a host that concurrently runs another
    // session's Docker stack may legitimately fall below the default floor at
    // execution time, and lowering the floor for THIS gate must be an explicit
    // operator decision recorded in the run log — never a code default.
    ...(process.env.MINERU_STANDARD_MIN_FREE_MEMORY_BYTES ? { MINERU_STANDARD_MIN_FREE_MEMORY_BYTES: process.env.MINERU_STANDARD_MIN_FREE_MEMORY_BYTES } : {}),
    ...overrides,
  } as unknown as Environment;
  const config = resolveMineruExecutorConfig(environment)!;
  expect(config.standard).toBeDefined();
  return config;
}

async function createRunFixture(bytes: Uint8Array) {
  const user = await prisma.user.create({ data: { email: `mineru-std-${randomUUID()}@test`, name: "MinerU Std Real" } });
  userIds.push(user.id);
  const workspace = await prisma.workspace.create({ data: { name: `mineru-std-${randomUUID()}` } });
  workspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const storageKey = `test/${randomUUID()}`;
  const blob = await prisma.sourceBlob.create({ data: { workspaceId: workspace.id, sha256: sha256Bytes(bytes), sizeBytes: bytes.byteLength, mediaType: "application/pdf", storageKey } });
  const source = await prisma.source.create({ data: { workspaceId: workspace.id, kind: "FILE", displayName: "standard-real.pdf" } });
  const document = await prisma.sourceDocument.create({ data: { sourceId: source.id, sourceBlobId: blob.id, workspaceId: workspace.id, version: 1, sha256: blob.sha256, sizeBytes: bytes.byteLength, mediaType: "application/pdf", storageKey } });
  const job = await prisma.job.create({ data: { userId: user.id, workspaceId: workspace.id, type: "source.ingest", status: "RUNNING", payload: { sourceDocumentId: document.id } } });
  const executionToken = `exec-${randomUUID()}`;
  const pageClaimToken = randomUUID();
  const run = await prisma.ingestionRun.create({ data: { sourceDocumentId: document.id, workspaceId: workspace.id, jobId: job.id, parserVersion: "pdf-router-v1", normalizationVersion: "canonical-text-v1", status: "RUNNING", executionClaimToken: executionToken, executionLeaseUntil: new Date(Date.now()+1200000), routingGeneration: PDF_ROUTING_GENERATION,
    routingPlan: {schemaVersion:PDF_ROUTING_PLAN_SCHEMA_VERSION, inspector:{version:PDF_INSPECTOR_VERSION}, parser:{name:"pdf-router",version:"1"},pageCount:1,pages:[{physicalPageIndex:0,route:"OCR_REQUIRED",contentEvidence:"NON_TEXT_CONTENT",reasonCodes:["IMAGE_CONTENT_WITHOUT_TEXT"]}]} } });
  await prisma.ocrPageAttempt.create({data:{ingestionRunId:run.id,workspaceId:workspace.id,sourceDocumentId:document.id,physicalPageIndex:0,routingGeneration:PDF_ROUTING_GENERATION,status:"RUNNING",claimToken:pageClaimToken,leaseUntil:new Date(Date.now()+1200000)}});
  runIds.push(run.id);
  return { runId: run.id, workspaceId: workspace.id, sourceDocumentId: document.id, executionToken, pageClaimToken };
}


async function observeOwnedStandardEngine(runId:string,ownerAlive?:()=>boolean) {
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    if(ownerAlive && !ownerAlive())throw new Error("REAL_EXECUTOR_OWNER_EXITED_BEFORE_ENGINE_OBSERVATION");
    const instance=await prisma.ocrServerInstance.findFirst({where:{ingestionRunId:runId,status:"RUNNING"}});
    if(instance?.pid && instance.serverId && Array.isArray(instance.transports)){
      const base=parseServerBaseUrl(instance.transports as Array<Record<string,unknown>>);
      if(!base) throw new Error("REAL_ENGINE_ENDPOINT_INVALID");
      try {
        const response=await fetch(`${base}/api/v1/server/status`,{redirect:"error",signal:AbortSignal.timeout(2000)});
        const status=await response.json() as {pid:number;server_id:string;parse_server?:{local?:{healthy:boolean;managed_running:boolean;managed_pid:number;managed_tier:string}}};
        const local=status.parse_server?.local;
        if(status.pid===instance.pid && status.server_id===instance.serverId && local?.healthy && local.managed_running && local.managed_tier==="standard"){
          const engineCreated=await processCreationTime(local.managed_pid);
          const doclibCreated=await processCreationTime(instance.pid);
          if(engineCreated && doclibCreated)return {instance,enginePid:local.managed_pid,engineCreated,doclibCreated};
        }
      } catch { /* transient startup probe; never an assertion of readiness */ }
    }
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error("REAL_STANDARD_ENGINE_OBSERVATION_TIMEOUT");
}

afterEach(async () => {
  if (workspaceIds.length) {
    await prisma.ocrServerInstance.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ocrPageAttempt.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.ingestionRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.job.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceDocument.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.source.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.sourceBlob.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  workspaceIds.length = 0;
  userIds.length = 0;
  runIds.length = 0;
  for (const root of tempRoots) {
    // Windows: a just-killed doclib child can hold a directory handle for a
    // moment; cleanup is best-effort evidence hygiene, never a gate.
    try { rmSync(root, { recursive: true, force: true }); } catch { /* leave for the OS */ }
  }
  tempRoots.length = 0;
});

afterAll(async () => { await prisma.$disconnect(); });

describeReal("mineru real standard execution gate (STEP6-2B-1)", () => {
  it("verifies the real model manifest and the real runtime before anything executes", async () => {
    const config = await realStandardConfig();
    await verifyMineruRuntime(config);
    const verification = await verifyMineruStandardModels(config.modelPath, config.standard!);
    expect(verification.ok).toBe(true);
    if (verification.ok) expect(verification.filesChecked).toBeGreaterThanOrEqual(1);
  }, 600_000);

  it.skipIf(!realStandardPdf)("executes a real scanned page with standard through the claim-scoped supervisor", async () => {
    if (!realStandardPdf) throw new Error("REAL_STANDARD_PDF_REQUIRED");
    const config = await realStandardConfig();
    const handle = createMineruPdfOcrExecutor(config, { standardModelsVerified: true });
    try {
      const pdfBytes = new Uint8Array(readFileSync(realStandardPdf));
      const fixture = await createRunFixture(pdfBytes);
      const result = await handle.executor.extractPage({
        ingestionRunId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sourceDocumentId: fixture.sourceDocumentId,
        physicalPageIndex: 0,
        routingGeneration: PDF_ROUTING_GENERATION,
        runExecutionToken: fixture.executionToken,
        pageClaimToken: fixture.pageClaimToken,
        pdfBytes,
        standardExecutionRequest: { sourcePdfSha256: sha256Bytes(pdfBytes) },
      });
      expect(result.status).toBe("SUCCEEDED");
      if (result.status !== "SUCCEEDED") return;
      expect(result.execution).toMatchObject({
        engine: "mineru",
        engineVersion: "4.0.3",
        proposedTier: "standard",
        tierAdmission: "STANDARD_ADMITTED",
        tierRefusalCode: null,
        modelManifestSha256: APPROVED_MINERU_MANIFEST_SHA256,
      });
      expect(result.execution!.actualTier).toBe("standard");
      expect(result.text.trim().length).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  }, 600_000);

  it("demotes a standard proposal to flash on an impossible memory floor (REAL invocation)", async () => {
    const config = await realStandardConfig({ MINERU_STANDARD_MIN_FREE_MEMORY_BYTES: "68719476736" });
    const fixturePdf = new Uint8Array(readFileSync(join(import.meta.dirname, "../fixtures/mineru/scanned-mixed-real.pdf")));
    const handle = createMineruPdfOcrExecutor(config, { standardModelsVerified: true });
    try {
      const fixture = await createRunFixture(fixturePdf);
      const result = await handle.executor.extractPage({
        ingestionRunId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sourceDocumentId: fixture.sourceDocumentId,
        physicalPageIndex: 0,
        routingGeneration: PDF_ROUTING_GENERATION,
        runExecutionToken: fixture.executionToken,
        pageClaimToken: fixture.pageClaimToken,
        pdfBytes: fixturePdf,
        standardExecutionRequest: { sourcePdfSha256: sha256Bytes(fixturePdf) },
      });
      expect(result.status).toBe("SUCCEEDED");
      if (result.status !== "SUCCEEDED") return;
      expect(result.execution).toMatchObject({
        actualTier: "flash",
        tierAdmission: "STANDARD_REFUSED",
        tierRefusalCode: "MEMORY_INSUFFICIENT",
      });
    } finally {
      await handle.close();
    }
  }, 600_000);

  it("refuses standard when the claimed source hash does not match the bytes", async () => {
    const config = await realStandardConfig();
    const fixturePdf = new Uint8Array(readFileSync(join(import.meta.dirname, "../fixtures/mineru/scanned-mixed-real.pdf")));
    const handle = createMineruPdfOcrExecutor(config, { standardModelsVerified: true });
    try {
      const fixture = await createRunFixture(fixturePdf);
      const result = await handle.executor.extractPage({
        ingestionRunId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sourceDocumentId: fixture.sourceDocumentId,
        physicalPageIndex: 0,
        routingGeneration: PDF_ROUTING_GENERATION,
        runExecutionToken: fixture.executionToken,
        pageClaimToken: fixture.pageClaimToken,
        pdfBytes: fixturePdf,
        standardExecutionRequest: { sourcePdfSha256: sha256Bytes(new TextEncoder().encode("not-the-real-bytes")) },
      });
      expect(result.status).toBe("SUCCEEDED");
      if (result.status !== "SUCCEEDED") return;
      expect(result.execution).toMatchObject({ actualTier: "flash", tierAdmission: "STANDARD_REFUSED", tierRefusalCode: "SOURCE_HASH_MISMATCH" });
    } finally {
      await handle.close();
    }
  }, 600_000);
  it.skipIf(!realStandardPdf || !process.env.MINERU_REAL_MINIO_ENDPOINT)("runs real private PDF -> MinIO -> source authority -> approved standard -> durable receipt -> manual review, with no publication",async()=>{
    if(!realStandardPdf) throw new Error("REAL_STANDARD_PDF_REQUIRED");
    const bytes=new Uint8Array(readFileSync(realStandardPdf));
    const config=await realStandardConfig();
    const handle=createMineruPdfOcrExecutor(config,{standardModelsVerified:true});
    const storage=new S3CompatibleStorageProvider({endpoint:process.env.MINERU_REAL_MINIO_ENDPOINT!,region:"us-east-1",bucket:"step62b2-private",accessKey:"local-development-only",secretKey:"local-development-only",forcePathStyle:true});
    try {
      const fixture=await createRunFixture(bytes);
      const document=await prisma.sourceDocument.findUniqueOrThrow({where:{id:fixture.sourceDocumentId}});
      await storage.putObject({key:document.storageKey,body:bytes,contentType:"application/pdf"});
      expect(sha256Bytes(await storage.getObjectBytes(document.storageKey))).toBe(document.sha256);
      await prisma.ocrPageAttempt.deleteMany({where:{ingestionRunId:fixture.runId}});
      const reset=await prisma.ingestionRun.update({where:{id:fixture.runId},data:{status:"QUEUED",executionClaimToken:null,executionLeaseUntil:null,routingGeneration:null,routingPlan:Prisma.DbNull}});
      await prisma.job.update({where:{id:reset.jobId},data:{status:"QUEUED"}});
      const service=createIngestionService(storage,{maxUploadBytes:100000000,uploadTtlSeconds:900,maxPdfPages:2000,completionLeaseMs:900000,processMaxAttempts:3,pdfOcrExecutor:handle.executor,ocrStandardAdmissionEnabled:true});
      const serviceStarted=Date.now();
      await expect(service.processIngestionRun(fixture.runId)).rejects.toThrow("SOURCE_OCR_REVIEW_REQUIRED");
      const serviceMs=Date.now()-serviceStarted;
      const run=await prisma.ingestionRun.findUniqueOrThrow({where:{id:fixture.runId}});
      const page=await prisma.ocrPageAttempt.findFirstOrThrow({where:{ingestionRunId:fixture.runId,physicalPageIndex:0}});
      const receipt=await prisma.ocrPageExecution.findUniqueOrThrow({where:{pageClaimToken:page.claimToken!}});
      expect(run.status).toBe("OCR_REQUIRED");
      expect(run.routingOutcome).toMatchObject({outcome:"REQUIRES_FALLBACK",reviewRequiredPhysicalPageIndexes:[0]});
      expect(page).toMatchObject({status:"SUCCEEDED",actualTier:"standard",qualityStatus:"REVIEW_REQUIRED",manifestDigest:APPROVED_MINERU_MANIFEST_SHA256});
      expect(receipt).toMatchObject({actualTier:"standard",executionStatus:"SUCCEEDED",manifestDigest:APPROVED_MINERU_MANIFEST_SHA256,qualityDecision:{status:"REVIEW_REQUIRED"}});
      expect(receipt.resultTextSha256).toBe(page.textSha256);
      const resultBytes=await storage.getObjectBytes(page.authoritativeArtifactKey!);
      expect(sha256Bytes(resultBytes)).toBe(page.textSha256);
      expect(await prisma.documentExtraction.count({where:{ingestionRunId:fixture.runId}})).toBe(0);
      expect(await prisma.currentDocumentExtraction.count({where:{sourceDocumentId:document.id}})).toBe(0);
      const calls=handle.executor.calls.length;
      await service.processIngestionRun(fixture.runId);
      expect(handle.executor.calls.length).toBe(calls);
      const proof={serviceMs,case:"B03-single-scan",sourceSha256:document.sha256,actualTier:page.actualTier,executionStatus:receipt.executionStatus,manifestDigest:receipt.manifestDigest,modelRevision:receipt.modelRevision,qualityDecision:receipt.qualityDecision,runStatus:run.status,routingOutcome:run.routingOutcome,resultBytes:resultBytes.length,resultSha256:page.textSha256,artifactKey:page.authoritativeArtifactKey,sourceKey:document.storageKey,publicationCount:0,calls:handle.executor.calls.map(c=>({outcome:c.outcome,durationMs:c.durationMs,timings:c.execution?.timings}))};
      writeFileSync(join(process.env.MINERU_REAL_PRIVATE_ROOT!,"full-chain-proof.private.json"),JSON.stringify(proof,null,2));
    } finally {await handle.close();}
  },600000);

  it.skipIf(!realStandardPdf).each(["cancel","timeout","parent-exit","memory-pressure"] as const)("lifecycle: real managed standard %s leaves no successful checkpoint or owned engine",async scenario=>{
    if(!realStandardPdf) throw new Error("REAL_STANDARD_PDF_REQUIRED");
    const bytes=new Uint8Array(readFileSync(realStandardPdf));
    const config=await realStandardConfig();
    if(scenario==="timeout") config.standard={...config.standard!,timeoutMs:1};
    const handle=createMineruPdfOcrExecutor(config,{standardModelsVerified:true});
    const fixture=await createRunFixture(bytes);
    const execution=handle.executor.extractPage({workspaceId:fixture.workspaceId,sourceDocumentId:fixture.sourceDocumentId,ingestionRunId:fixture.runId,physicalPageIndex:0,routingGeneration:PDF_ROUTING_GENERATION,runExecutionToken:fixture.executionToken,pageClaimToken:fixture.pageClaimToken,pdfBytes:bytes,standardExecutionRequest:{sourcePdfSha256:sha256Bytes(bytes)}});
    // Mirror rejection immediately so observing a process cannot cause an unhandled rejection.
    const settled=execution.then(result=>({result}),error=>({error}));
    let finished=false;void settled.then(()=>{finished=true;});
    let observed:Awaited<ReturnType<typeof observeOwnedStandardEngine>>|undefined;
    try {
      if(scenario!=="timeout"){
        observed=await observeOwnedStandardEngine(fixture.runId,()=>!finished);
        if(scenario==="cancel") await handle.close();
        else if(scenario==="memory-pressure") {
          // Tighten the reserve only after real engines exist. Do not allocate
          // RAM or weaken the production floor to simulate pressure.
          config.standard!.minRuntimeFreeMemoryBytes=68719476736;
        } else {
          expect(await processCreationTime(observed.instance.pid!)).toBe(observed.doclibCreated);
          // Kill only the database-bound, freshly fingerprinted doclib pid.
          // The engine must stop through its real managed-control EOF path.
          process.kill(observed.instance.pid!,"SIGKILL");
        }
      }
      const outcome=await settled;
      if("error" in outcome) throw outcome.error;
      expect(outcome.result.status).toBe("FAILED");
      if(outcome.result.status!=="FAILED")return;
      if(scenario==="timeout")expect(outcome.result.errorCode).toBe("SOURCE_OCR_TIMEOUT");
      if(scenario==="memory-pressure")expect(outcome.result.errorCode).toBe("SOURCE_OCR_MEMORY_PRESSURE");
      const receipt=await prisma.ocrPageExecution.findUniqueOrThrow({where:{pageClaimToken:fixture.pageClaimToken}});
      expect(receipt.executionStatus).toBe("FAILED");
      if(scenario==="cancel"){
        expect(receipt.actualTier).not.toBe("flash");
        expect(receipt.fallbackReason).toBeNull();
        if(receipt.actualTier===null)expect(receipt.admittedTier).toBe("standard");
      }
      expect(receipt.resultTextSha256).toBeNull();
      expect(await prisma.ocrPageAttempt.count({where:{ingestionRunId:fixture.runId,status:"SUCCEEDED"}})).toBe(0);
      const server=await prisma.ocrServerInstance.findFirstOrThrow({where:{ingestionRunId:fixture.runId}});
      expect(server.status).toBe("STOPPED");
      expect((await prisma.ocrHostLease.findUniqueOrThrow({where:{hostId:config.hostId}})).claimToken).toBeNull();
      if(observed)expect(await processCreationTime(observed.enginePid)).not.toBe(observed.engineCreated);
      else {
        const enginePid=outcome.result.execution?.serverIdentity?.enginePid;
        expect(enginePid).toBeGreaterThan(0);
        expect(await recordedProcessAlive(enginePid!)).toBe(false);
      }
    } finally {await handle.close();await settled;}
  },600000);

  it.skipIf(!realStandardPdf)("reconciles real managed engines after the Node executor owner is killed",async()=>{
    if(!realStandardPdf)throw new Error("REAL_STANDARD_PDF_REQUIRED");
    const bytes=new Uint8Array(readFileSync(realStandardPdf));
    const config=await realStandardConfig();
    const fixture=await createRunFixture(bytes);
    const child=spawn(process.execPath,["--import","tsx",join(import.meta.dirname,"../helpers/mineru/real-standard-worker.ts")],{env:process.env,windowsHide:true,stdio:["ignore","pipe","pipe","ipc"]});
    let diagnostic="";
    const capture=(chunk:Buffer)=>{if(diagnostic.length<65536)diagnostic+=chunk.toString("utf8");};
    child.stdout!.on("data",capture);child.stderr!.on("data",capture);
    const exited=new Promise<void>((resolve,reject)=>{child.once("exit",()=>resolve());child.once("error",reject);});
    void exited.catch(()=>undefined);
    child.send({config,pdfPath:realStandardPdf,request:{workspaceId:fixture.workspaceId,sourceDocumentId:fixture.sourceDocumentId,ingestionRunId:fixture.runId,physicalPageIndex:0,routingGeneration:PDF_ROUTING_GENERATION,runExecutionToken:fixture.executionToken,pageClaimToken:fixture.pageClaimToken}});
    const recovery={hostId:config.hostId,executable:config.executable,executableArgs:config.executableArgs,stopTimeoutMs:config.serverStopTimeoutMs,homeRoot:config.homeRoot};
    try {
      const observed=await observeOwnedStandardEngine(fixture.runId,()=>child.exitCode===null && child.signalCode===null);
      child.kill("SIGKILL");await exited;
      expect(await processCreationTime(observed.instance.pid!)).toBe(observed.doclibCreated);
      // Expire only this dead owner's host lease first. A still-live run must
      // protect it from a premature reconciler stop, even after owner exit.
      await prisma.ocrHostLease.update({where:{hostId:config.hostId},data:{leaseUntil:new Date(0)}});
      expect((await reconcileOcrServerInstances(recovery)).skipped).toBe(1);
      await prisma.ingestionRun.update({where:{id:fixture.runId},data:{executionLeaseUntil:new Date(0)}});
      await prisma.ocrPageAttempt.updateMany({where:{ingestionRunId:fixture.runId},data:{leaseUntil:new Date(0)}});
      const sweep=await reconcileOcrServerInstances(recovery);
      expect(sweep).toMatchObject({stopped:1,orphaned:0});
      expect((await prisma.ocrServerInstance.findUniqueOrThrow({where:{id:observed.instance.id}})).status).toBe("STOPPED");
      expect(await processCreationTime(observed.enginePid)).not.toBe(observed.engineCreated);
      expect(existsSync(observed.instance.mineruHome)).toBe(false);
      expect(await prisma.ocrPageAttempt.count({where:{ingestionRunId:fixture.runId,status:"SUCCEEDED"}})).toBe(0);
      expect(await prisma.ocrPageExecution.count({where:{pageClaimToken:fixture.pageClaimToken,executionStatus:"SUCCEEDED"}})).toBe(0);
      const second=await reconcileOcrServerInstances(recovery);expect(second.examined).toBe(0);
      const next=await acquireOcrHostLease(config.hostId);expect(next).not.toBeNull();
      if(next)await releaseOcrHostLease(config.hostId,next.claimToken);
    } finally {
      if(child.exitCode===null && child.signalCode===null)child.kill("SIGKILL");
      await exited;
      await prisma.ocrHostLease.updateMany({where:{hostId:config.hostId},data:{leaseUntil:new Date(0)}});
      await prisma.ingestionRun.updateMany({where:{id:fixture.runId},data:{executionLeaseUntil:new Date(0)}});
      await reconcileOcrServerInstances(recovery);
      if(process.env.MINERU_REAL_PRIVATE_ROOT)writeFileSync(join(process.env.MINERU_REAL_PRIVATE_ROOT,"worker-crash-child.private.log"),diagnostic);
    }
  },600000);

});
