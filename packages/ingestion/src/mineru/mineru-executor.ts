import { classifyOcrQuality } from "../ocr-quality.js";
import { recordOcrExecution } from "../ocr-execution-receipt.js";
import { isApprovedMineruManifest, APPROVED_MINERU_MANIFEST_SHA256 } from "./mineru-approved-inventory.js";
import { snapshotMineruStandardModels } from "./mineru-model-snapshot.js";
import { verifyOcrSourceAuthority, renewOcrSourcePageLease, OCR_SOURCE_AUTHORITY_INVALID } from "../ocr-source-authority.js";
import { mkdir, mkdtemp, open, lstat, rm, writeFile } from "node:fs/promises";
import { freemem } from "node:os";
import { join } from "node:path";
import { logger } from "@ai-cognitive/shared";
import { OCR_HOST_LEASE_TTL_MS, acquireOcrHostLease, createOcrServerInstance, markOcrServerOrphaned, markOcrServerStartNeverStarted, markOcrServerStopped, markOcrServerStopping, recordOcrServerEndpoint, releaseOcrHostLease, renewOcrHostLease } from "../ocr-durability.js";
import type { PdfOcrExecutor, PdfOcrExecutorDescriptor, PdfOcrExecutionFacts, PdfOcrPageRequest, PdfOcrPageResult } from "../pdf-routing.js";
import { SourceError } from "../source-errors.js";
import { MINERU_EXECUTOR_NAME, buildMineruParseArgs, judgeMineruParseExit, mineruFailureForOutcome } from "./mineru-commands.js";
import { MINERU_STANDARD_TIER, assessMineruStandardExecution, sha256Bytes, verifyMineruStandardModels } from "./mineru-standard-admission.js";
import { parseServerBaseUrl, setParseServerModeManaged, waitForStandardParseServerReady } from "./mineru-standard-server-setup.js";
import { isWithinPath, type MineruExecutorConfig } from "./mineru-config.js";
import { probeFreeTcpPort, sleep, spawnBounded, type BoundedSpawnResult } from "./mineru-process.js";
import { createMineruServerSession, type MineruServerSession } from "./mineru-server.js";

/**
 * The REAL MinerU PdfOcrExecutor (BOOK-INGESTION-04B-3).
 *
 * Responsibility boundary (04B-2 remains authoritative for routing, page
 * checkpoints, the retry budget, quality and publication): this executor
 * performs exactly ONE bounded MinerU invocation per OcrPageAttempt claim —
 *  1. acquire the host OCR capacity slot (OcrHostLease — the single capacity
 *     authority; a conflict is a bounded transient capacity failure, never a
 *     busy-wait and never a second semaphore)
 *  2. renew the host lease on a heartbeat while it owns MinerU work; renewal
 *     loss aborts execution (SOURCE_OCR_HOST_LEASE_LOST, transient)
 *  3. build an application-generated per-claim temp tree:
 *     <homeRoot>/<runId>/generation-<gen>/page-<idx>/<unique>/{home,input,output}
 *     with a claim-scoped MINERU_HOME and a pinned unique doclib port —
 *     mutable MinerU state is NEVER shared between concurrent claims (04B-0)
 *  4. run the claim-scoped doclib server through the durable OcrServerInstance
 *     lifecycle (STARTING → RUNNING with validated endpoint identity →
 *     STOPPED/ORPHANED)
 *  5. run `mineru parse` once (argv array, hard timeout, output caps,
 *     MINERU_MODEL_SOURCE=local + proxy-env egress denial so the local-only
 *     contract is enforced at the process boundary)
 *  6. classify the outcome into the stable SOURCE_OCR_* failure classes and
 *     stop/clean everything in a finally block (bounded; releases only its own
 *     token-fenced lease)
 *
 * The requested physicalPageIndex is the ONLY page lineage: MinerU output is
 * never consulted for page identity.
 */

export type MineruOcrCallRecord = { ingestionRunId: string; physicalPageIndex: number; routingGeneration: number; outcome: "SUCCEEDED" | "FAILED"; errorCode?: string; durationMs: number; execution?: PdfOcrExecutionFacts };

export type MineruPdfOcrExecutorHandle = {
  executor: PdfOcrExecutor & { readonly calls: readonly MineruOcrCallRecord[] };
  /** Stops accepting new work and tears down everything still owned. Bounded. */
  close(): Promise<void>;
};

/**
 * Fixed process-scoped egress denial for MinerU children. Defense-in-depth
 * PLUS the enforced MINERU_MODEL_SOURCE=local configuration: this is NOT a
 * kernel/network sandbox — it denies the HTTP stacks MinerU's download paths
 * use (requests/huggingface_hub/modelscope) and raw sockets are out of scope.
 * Uppercase and lowercase conventional proxy variables are both covered.
 */
function mineruEgressDenialEnv(): Record<string, string> {
  const denial = { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "" };
  return { ...denial, http_proxy: denial.HTTP_PROXY, https_proxy: denial.HTTPS_PROXY, all_proxy: denial.ALL_PROXY, no_proxy: "" };
}

export function createMineruPdfOcrExecutor(config: MineruExecutorConfig, options: { standardModelsVerified?: boolean } = {}): MineruPdfOcrExecutorHandle {
  if (config.modelSource !== "local") throw new Error(SourceError.OCR_MINERU_NOT_CONFIGURED);
  // STEP6-2B-1: standard admission exists in the config ONLY when both
  // experiment switches are on and the manifest parsed; the factory
  // additionally refuses to even hold standard capability without the
  // startup model-verification proof (hashes verified against the manifest).
  if (config.standard && options.standardModelsVerified !== true) throw new Error("OCR_STANDARD_MODELS_UNVERIFIED:STARTUP_MODEL_VERIFICATION_REQUIRED");
  if (config.standard && !isApprovedMineruManifest(config.standard.manifest)) throw new Error("UNAPPROVED_MODEL_INVENTORY");
  const standardModelsVerified = options.standardModelsVerified === true;
  // The descriptor is persisted for EVERY page attempt. Its modelRevision
  // must not advertise a standard manifest for flash attempts, including
  // ENGINES_NOT_READY demotions. Per-page verified model provenance requires
  // a separately fenced durable attempt extension in STEP6-2B-2.
  const descriptor: PdfOcrExecutorDescriptor = { name: MINERU_EXECUTOR_NAME, version: config.version, parserMode: config.tier, modelRevision: null };
  const active = new Set<{ controller: AbortController; done: Promise<unknown> }>();
  let closing = false;

  // A Uint8Array is mutable even when its identity and byteLength stay the
  // same. Never cache a source hash solely by object identity: a later page
  // could otherwise pass an out-of-date byte-identity check after mutation.
  // Only standard proposals pay this hashing cost; default flash does not.
  function sourcePdfSha256(bytes: Uint8Array): string | null {
    try {
      return sha256Bytes(bytes);
    } catch {
      return null;
    }
  }

  const executor: PdfOcrExecutor & { readonly calls: MineruOcrCallRecord[] } = {
    descriptor,
    calls: [],
    async extractPage(request: PdfOcrPageRequest): Promise<PdfOcrPageResult> {
      const startedAt = Date.now();
      const controller = new AbortController();
      const execution = runPage(request, controller, startedAt);
      // Bookkeeping mirror that NEVER rejects: the caller owns the original
      // promise's rejection; a second rejecting handle would be an unhandled
      // rejection racing the process.
      const entry = { controller, done: execution.then(() => undefined, () => undefined) };
      void entry.done.finally(() => active.delete(entry));
      active.add(entry);
      return await execution;
    },
  };

  function failure(errorCode: string, kind: "transient" | "terminal", nextAttemptAt?: Date): PdfOcrPageResult {
    return { status: "FAILED", errorCode, kind, ...(nextAttemptAt ? { nextAttemptAt } : {}) };
  }

  /** Bounded in-memory invocation journal (observability / real-acceptance evidence). */
  async function recordCall(request: PdfOcrPageRequest, result: PdfOcrPageResult, startedAt: number, facts: PdfOcrExecutionFacts): Promise<PdfOcrPageResult> {
    facts.timings={...facts.timings,beforeCleanupMs:Date.now()-startedAt};
    if(result.status==="SUCCEEDED") facts.qualityDecision=classifyOcrQuality(result.text,request.physicalPageIndex,facts.proposedTier==="standard");
    if (facts.sourceAuthority && !await recordOcrExecution(facts,result)) result=failure(OCR_SOURCE_AUTHORITY_INVALID,"terminal");
    executor.calls.push({
      ingestionRunId: request.ingestionRunId,
      physicalPageIndex: request.physicalPageIndex,
      routingGeneration: request.routingGeneration,
      outcome: result.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      ...(result.status === "FAILED" ? { errorCode: result.errorCode } : {}),
      durationMs: Date.now() - startedAt,
      execution: facts,
    });
    if (executor.calls.length > 1000) executor.calls.shift();
    return { ...result, execution: facts };
  }

  async function runPage(request: PdfOcrPageRequest, controller: AbortController, startedAt: number): Promise<PdfOcrPageResult> {
    // Own the exact proposed bytes before the first asynchronous boundary.
    if (request.standardExecutionRequest || request.pageClaimToken) request = { ...request, pdfBytes: Uint8Array.from(request.pdfBytes) };
    const signal = controller.signal;
    if (closing) return failure(SourceError.OCR_PROCESS_FAILED, "transient");
    const logContext = { ingestionRunId: request.ingestionRunId, physicalPageIndex: request.physicalPageIndex, routingGeneration: request.routingGeneration, executor: MINERU_EXECUTOR_NAME };

    // STEP6-2B-1 per-page guarded tier resolution (Candidate → Admission →
    // the EXISTING claim/lease Authority below, unchanged). A standard
    // proposal is re-verified here against facts the executor trusts itself:
    // config presence (structurally implies both experiment switches), the
    // startup model-verification proof, byte-identity of the received PDF
    // against the claimed source hash, and the live memory floor. Any refusal
    // demotes the page to the pinned flash tier — the exact pre-slice
    // behaviour — and the refusal is recorded, never silently dropped.
    const sourceClaim = request.standardExecutionRequest?.sourcePdfSha256 ?? null;
    const actualSourceSha256 = sourceClaim !== null || request.pageClaimToken ? sourcePdfSha256(request.pdfBytes) : null;
    const tierRecheck = assessMineruStandardExecution({
      admissionConfig: config.standard ?? null,
      modelsVerified: standardModelsVerified,
      sourceClaim,
      actualSourceSha256,
      availableMemoryBytes: freemem(),
    });
    const sourceAuthority = request.standardExecutionRequest || request.pageClaimToken ? await verifyOcrSourceAuthority({
      workspaceId: request.workspaceId, sourceDocumentId: request.sourceDocumentId, ingestionRunId: request.ingestionRunId,
      physicalPageIndex: request.physicalPageIndex, routingGeneration: request.routingGeneration,
      runExecutionToken: request.runExecutionToken, pageClaimToken: request.pageClaimToken ?? "",
      sourceSha256: actualSourceSha256 ?? "", sourceSizeBytes: request.pdfBytes.byteLength,
    }) : null;
    if ((request.standardExecutionRequest || request.pageClaimToken) && !sourceAuthority) return failure(OCR_SOURCE_AUTHORITY_INVALID, "terminal");
    const actualTier = tierRecheck.admitted ? MINERU_STANDARD_TIER : config.tier;
    const executionFacts: PdfOcrExecutionFacts = {
      ...(sourceAuthority ? { sourceAuthority } : {}),
      engine: MINERU_EXECUTOR_NAME,
      engineVersion: config.version,
      proposedTier: sourceClaim !== null ? MINERU_STANDARD_TIER : null,
      admittedTier: actualTier,
      actualTier: null,
      tierAdmission: sourceClaim === null ? "FLASH_DEFAULT" : tierRecheck.admitted ? "STANDARD_ADMITTED" : "STANDARD_REFUSED",
      tierRefusalCode: sourceClaim !== null && !tierRecheck.admitted ? tierRecheck.reason : null,
      modelManifestSha256: tierRecheck.manifestSha256,
    };
    if (sourceClaim !== null && !tierRecheck.admitted) {
      logger.warn("mineru.ocr.standard_refused", { ...logContext, reason: tierRecheck.reason, actualTier });
    }

    // 1. Host capacity authority (OcrHostLease). No busy-wait and NO stored
    // future page time (RF01 P1-01): the capacity failure propagates as a
    // run-retryable error through 04B-2's existing retryable execution
    // authority, leaving the page PENDING and immediately claimable — the
    // queue's retry cadence is the single retry clock.
    const lease = await acquireOcrHostLease(config.hostId, OCR_HOST_LEASE_TTL_MS, { executable: config.executable, modelPath: config.modelPath, tier: actualTier, version: config.version }).catch(() => null);
    if (!lease) {
      logger.warn("mineru.ocr.host_capacity", { ...logContext, failureCode: SourceError.OCR_HOST_CAPACITY });
      return await recordCall(request, failure(SourceError.OCR_HOST_CAPACITY, "transient"), startedAt, executionFacts);
    }
    executionFacts.hostId=config.hostId;
    executionFacts.hostClaimToken=lease.claimToken;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void renewOcrHostLease(config.hostId, lease.claimToken).then((renewed) => { if (!renewed) { leaseLost = true; controller.abort(); } else if (sourceAuthority) { void renewOcrSourcePageLease(sourceAuthority).then(ok=>{ if(!ok) controller.abort(); }).catch(()=>controller.abort()); } }).catch(() => { leaseLost = true; controller.abort(); });
    }, config.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(OCR_HOST_LEASE_TTL_MS / 3)));

    const claimRoot = join(config.homeRoot, request.ingestionRunId, `generation-${request.routingGeneration}`, `page-${request.physicalPageIndex}`);
    let claimDir: string | null = null;
    let session: MineruServerSession | null = null;
    let serverStarted = false;
    let inputDir: string | null = null;
    let outputDir: string | null = null;
    /** RF02 P1-05: explicit tree-termination evidence from a failed start (null = no session/start evidence). */
    let startTreeProof: boolean | null = null;
    let stopDisposition = "NOT_STARTED";
    try {
      // 2. Application-generated per-claim temp tree (no user-controlled path
      // segment anywhere; mkdtemp supplies the unique leaf directory).
      await mkdir(claimRoot, { recursive: true });
      claimDir = await mkdtemp(join(claimRoot, "claim-"));
      const homeDir = join(claimDir, "home");
      inputDir = join(claimDir, "input");
      outputDir = join(claimDir, "output");
      const inputPdfPath = join(inputDir, "input.pdf");
      const outputMarkdownPath = join(outputDir, "result.md");
      await mkdir(homeDir, { recursive: true });
      await mkdir(inputDir, { recursive: true });
      await mkdir(outputDir, { recursive: true });
      await writeFile(inputPdfPath, request.pdfBytes);
      const executionModelRoot = actualTier === MINERU_STANDARD_TIER ? join(claimDir,"models") : config.modelPath;
      if (actualTier === MINERU_STANDARD_TIER && config.standard) {
        const snapshotStarted=Date.now();
        await snapshotMineruStandardModels(config.modelPath,executionModelRoot,config.standard,signal);
        executionFacts.timings={snapshotMs:Date.now()-snapshotStarted};
        executionFacts.modelManifestSha256=APPROVED_MINERU_MANIFEST_SHA256;
      }
      const controlledConfig = join(homeDir,"controlled-config.yaml");
      if (actualTier === MINERU_STANDARD_TIER) await writeFile(controlledConfig,"{}\n");

      if (sourceAuthority && !await verifyOcrSourceAuthority(sourceAuthority,sourceAuthority)) return await recordCall(request,failure(OCR_SOURCE_AUTHORITY_INVALID,"terminal"),startedAt,executionFacts);

      // 3. Durable server instance identity BEFORE launch (STARTING carries a
      // deliberately nullable endpoint contract — 04B-1/04B-0).
      const instanceId = await createOcrServerInstance({
        workspaceId: request.workspaceId,
        sourceDocumentId: request.sourceDocumentId,
        ingestionRunId: request.ingestionRunId,
        hostId: config.hostId,
        hostClaimToken: lease.claimToken,
        runExecutionToken: request.runExecutionToken,
        mineruHome: homeDir,
      });
      if (instanceId === null) throw new Error("OCR_SERVER_INSTANCE_CONFLICT");

      // 4. Claim-scoped server session; children get local-only model config
      // and proxy-env egress denial (never "auto", never a network source).
      const childEnvBase: NodeJS.ProcessEnv = {
        ...(actualTier === MINERU_STANDARD_TIER ? Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("MINERU_"))) : process.env),
        ...mineruEgressDenialEnv(),
        MINERU_HOME: homeDir,
        MINERU_MODEL_SOURCE: config.modelSource,
        MINERU_MODEL_BASE_DIR: executionModelRoot,
        TMP: outputDir,
        TEMP: outputDir,
        ...(actualTier === MINERU_STANDARD_TIER ? {
          MINERU_CONFIG: controlledConfig,
          MINERU_MODEL_SMALL_BACKEND: "onnx",
          MINERU_MODEL_VLM_ENGINE: "llama-cpp",
          MINERU_MODEL_VLM_SERVER_URL: "",
          MINERU_DOCLIB_MANAGED_PARSE_SERVER_HOST: "127.0.0.1",
          MINERU_DOCLIB_MANAGED_PARSE_SERVER_PORT: String(await probeFreeTcpPort()),
          MINERU_DOCLIB_MANAGED_PARSE_SERVER_STRICT_PORT: "true",
        } : {}),
      };
      session = await createMineruServerSession({ executable: config.executable, executableArgs: config.executableArgs, homeDir, childEnvBase, startTimeoutMs: config.serverStartTimeoutMs, stopTimeoutMs: config.serverStopTimeoutMs, maxOutputBytes: Math.min(config.maxOutputBytes, 1_048_576), abortSignal: signal, ...(config.processImagePattern ? { processImagePattern: config.processImagePattern } : {}) });
      const doclibStarted=Date.now();
      const startFailure = await session.start();
      executionFacts.timings={...executionFacts.timings,doclibStartMs:Date.now()-doclibStarted};
      if (startFailure) {
        // RF02 P1-05: remember the EXPLICIT tree-termination evidence so the
        // finally block can prove "nothing survived" instead of guessing.
        startTreeProof = startFailure.treeTerminationConfirmed === true;
        const mapped = startFailure.kind === "EXECUTABLE_NOT_FOUND"
          ? failure(SourceError.OCR_MINERU_NOT_FOUND, "terminal")
          : startFailure.kind === "START_TIMEOUT"
            ? failure(SourceError.OCR_TIMEOUT, "transient")
            : startFailure.kind === "ABORTED"
              ? failure(leaseLost ? SourceError.OCR_HOST_LEASE_LOST : SourceError.OCR_PROCESS_FAILED, "transient")
              : failure(SourceError.OCR_PROCESS_FAILED, "transient");
        logger.warn("mineru.ocr.server_start_failed", { ...logContext, kind: startFailure.kind, failureCode: mapped.status === "FAILED" ? mapped.errorCode : SourceError.OCR_PROCESS_FAILED, ...(startFailure.kind === "START_FAILED" ? { stderrTail: startFailure.stderrTail.slice(-300) } : {}) });
        return await recordCall(request, mapped, startedAt, executionFacts);
      }
      serverStarted = true;
      const endpoint = session.endpoint!;
      executionFacts.serverIdentity={pid:endpoint.pid,serverId:endpoint.serverId};
      const endpointRecorded = await recordOcrServerEndpoint({ hostClaimToken: lease.claimToken, endpoint: { pid: endpoint.pid, serverId: endpoint.serverId, transports: endpoint.transports } }).catch(() => false);
      if (!endpointRecorded) throw new Error("OCR_SERVER_ENDPOINT_RECORDING_LOST");

      // MinerU 4.0.3 health.run refreshes managed mode on every cycle and
      // starts its supervised engine when managed_proc is absent. The doclib
      // identity is never restarted or replaced; its stop owns engine cleanup.
      if (actualTier === MINERU_STANDARD_TIER && config.standard) {
        const engineStarted=Date.now();
        const baseUrl = parseServerBaseUrl(endpoint.transports);
        const setup = baseUrl === null ? { kind: "STATUS_UNAVAILABLE" as const, detail: "no_tcp_transport" } : await setParseServerModeManaged(baseUrl, 5_000, signal);
        const probe = setup ?? await waitForStandardParseServerReady(baseUrl!, config.serverStartTimeoutMs, { signal });
        executionFacts.timings={...executionFacts.timings,engineReadyMs:Date.now()-engineStarted};
        if (probe !== null) {
          logger.warn("mineru.ocr.standard_engines_not_ready", { ...logContext, detail: probe.detail });
          executionFacts.tierAdmission = "STANDARD_REFUSED";
          executionFacts.tierRefusalCode = "ENGINES_NOT_READY";
          executionFacts.admittedTier = config.tier;
          // Continue through the SAME bounded spawn and error classification
          // as ordinary flash; timeout/abort/overflow must not be reclassified
          // as generic parse failures by a special demotion code path.
        }
      }

      // 5. THE one bounded parse invocation per claim (one claim = one
      // invocation; retries belong to 04B-2's durable attempt budget).
      const parseTimeoutMs = executionFacts.admittedTier === MINERU_STANDARD_TIER && config.standard ? config.standard.timeoutMs : config.timeoutMs;
      executionFacts.actualTier=executionFacts.admittedTier ?? config.tier;
      const parseArgs = buildMineruParseArgs({ inputPdfPath, tier: executionFacts.actualTier, physicalPageIndex: request.physicalPageIndex, outputMarkdownPath });
      const parseStarted=Date.now();
      const parseResult = await spawnBounded(config.executable, [...config.executableArgs, ...parseArgs], { env: childEnvBase, cwd: outputDir, timeoutMs: parseTimeoutMs, maxOutputBytes: Math.min(config.maxOutputBytes, 1_048_576), abortSignal: signal });
      executionFacts.timings={...executionFacts.timings,parseMs:Date.now()-parseStarted};
      let result: PdfOcrPageResult;
      if (parseResult.spawnErrorCode === "ENOENT") {
        executionFacts.actualTier=null;
        result = failure(SourceError.OCR_MINERU_NOT_FOUND, "terminal");
      } else if (parseResult.timedOut) {
        result = failure(SourceError.OCR_TIMEOUT, "transient");
      } else if (parseResult.aborted) {
        result = failure(leaseLost ? SourceError.OCR_HOST_LEASE_LOST : SourceError.OCR_PROCESS_FAILED, "transient");
      } else if (parseResult.outputOverflow) {
        result = failure(SourceError.OCR_OUTPUT_INVALID, "terminal");
      } else {
        result = await resultForParseOutput(parseResult, outputMarkdownPath, outputDir, config.maxOutputBytes);
      }
      if (executionFacts.actualTier === MINERU_STANDARD_TIER && config.standard && !(await verifyMineruStandardModels(executionModelRoot,config.standard)).ok) {
        result=failure("SOURCE_OCR_MODEL_IDENTITY_CHANGED","terminal");
      }
      if (sourceAuthority && !await verifyOcrSourceAuthority(sourceAuthority, sourceAuthority)) {
        return await recordCall(request, failure(OCR_SOURCE_AUTHORITY_INVALID, "terminal"), startedAt, executionFacts);
      }
      return await recordCall(request, result, startedAt, executionFacts);
    } catch (error) {
      // Claim-tree IO / durable-identity failures are infrastructure-class:
      // stable transient codes, never arbitrary exception text.
      const message = error instanceof Error ? error.message : "";
      const stable = message === "OCR_STANDARD_MODEL_SNAPSHOT_REJECTED" ? SourceError.OCR_MODEL_NOT_FOUND : message === "OCR_SERVER_INSTANCE_CONFLICT" || message === "OCR_SERVER_ENDPOINT_RECORDING_LOST" ? SourceError.OCR_PROCESS_FAILED : SourceError.OCR_TEMP_IO_ERROR;
      logger.warn("mineru.ocr.execution_error", { ...logContext, failureCode: stable });
      return await recordCall(request, failure(stable, message === "OCR_STANDARD_MODEL_SNAPSHOT_REJECTED" ? "terminal" : "transient"), startedAt, executionFacts);
    } finally {
      // 6. Bounded cleanup of everything this claim owned, in every outcome,
      // through the CLOSED server state machine (RF01 P1-07, RF02 P1-04/P1-05).
      clearInterval(heartbeat);
      let serverTerminated = session === null;
      if (session) {
        if (serverStarted) await markOcrServerStopping(lease.claimToken).catch(() => false);
        const disposition = await session.stop();
        stopDisposition = disposition.kind;
        if (serverStarted && session.endpoint) {
          serverTerminated = disposition.kind === "STOPPED" || disposition.kind === "ALREADY_EXITED" || disposition.kind === "KILLED_BY_RECORDED_IDENTITY";
          if (serverTerminated) await markOcrServerStopped(lease.claimToken, disposition.kind).catch(() => undefined);
          else await markOcrServerOrphaned(lease.claimToken, disposition.kind === "ORPHAN_SUSPECT" ? disposition.reason : "STOP_IDENTITY_UNAVAILABLE").catch(() => undefined);
        } else if (!serverStarted) {
          // RF02 P1-05 state-machine boundary: STARTING -> STOPPED ONLY with
          // explicit proof that no owned process survived (the spawn never
          // happened, or the owned tree termination was confirmed). A missing
          // endpoint alone is NEVER that proof -> ORPHANED, evidence preserved.
          if (startTreeProof === true) {
            serverTerminated = true;
            await markOcrServerStartNeverStarted(lease.claimToken).catch(() => undefined);
          } else {
            await markOcrServerOrphaned(lease.claimToken, "START_IDENTITY_UNAVAILABLE").catch(() => undefined);
          }
        }
      }
      // RF02 P1-04 cleanup contract: the claim temp tree may only be removed
      // when the server is PROVEN terminated. Otherwise the claim HOME (the
      // doclib.endpoint.json identity evidence the crash reconciler needs)
      // is preserved and only the bulky, non-identity input/output data is
      // removed — OcrServerInstance.mineruHome keeps resolving to real,
      // usable recovery evidence.
      if (claimDir) {
        if (serverTerminated) {
          await rm(claimDir, { recursive: true, force: true }).catch(() => undefined);
        } else if (inputDir && outputDir) {
          await rm(inputDir, { recursive: true, force: true }).catch(() => undefined);
          await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      // Token-fenced: a stale token can never release a newer owner's lease.
      if (leaseLost) {
        logger.warn("mineru.ocr.host_lease_lost", { ...logContext, failureCode: SourceError.OCR_HOST_LEASE_LOST });
      } else {
        await releaseOcrHostLease(config.hostId, lease.claimToken).catch(() => false);
      }
      logger.info(serverStarted ? "mineru.ocr.page_invocation_completed" : "mineru.ocr.page_invocation_aborted", { ...logContext, stopDisposition, durationMs: Date.now() - startedAt });
    }

    /**
     * Reads and validates the bounded markdown output; classifies every
     * deviation. RF01 P1-03: the output is UNTRUSTED external-process output,
     * so the bound is enforced BEFORE any allocation — resolved-path check,
     * lstat (regular file, symlink/reparse rejected), size cap, then a read
     * limited to the stat'd size that fails closed if the file grows.
     */
    async function resultForParseOutput(parseResult: BoundedSpawnResult, expectedMarkdownPath: string, outputDir: string, maxOutputBytes: number): Promise<PdfOcrPageResult> {
      const outcome = judgeMineruParseExit({ exitCode: parseResult.code, stdout: parseResult.stdout });
      if (outcome.kind !== "OUTPUT_WRITTEN") {
        const mapped = mineruFailureForOutcome(outcome);
        return failure(mapped.errorCode, mapped.kind);
      }
      // The output MUST be exactly the application-generated path inside the
      // application-generated output directory.
      if (outcome.markdownPath !== expectedMarkdownPath) return failure(SourceError.OCR_OUTPUT_INVALID, "terminal");
      if (!isWithinPath(expectedMarkdownPath, outputDir)) return failure(SourceError.OCR_OUTPUT_INVALID, "terminal");
      let info;
      try {
        info = await lstat(expectedMarkdownPath);
      } catch {
        return failure(SourceError.OCR_TEMP_IO_ERROR, "transient");
      }
      // Symlink/reparse-point ambiguity and non-regular files are rejected
      // before any read; the size cap is enforced BEFORE allocating memory.
      if (info.isSymbolicLink() || !info.isFile()) return failure(SourceError.OCR_OUTPUT_INVALID, "terminal");
      if (info.size > maxOutputBytes) return failure(SourceError.OCR_OUTPUT_INVALID, "terminal");
      let fileHandle;
      try {
        fileHandle = await open(expectedMarkdownPath, "r");
      } catch {
        return failure(SourceError.OCR_TEMP_IO_ERROR, "transient");
      }
      try {
        const markdown = Buffer.alloc(info.size);
        const read = await fileHandle.read(markdown, 0, info.size, 0);
        // Fail closed if the file changed size between stat and read.
        const extra = Buffer.alloc(1);
        const grew = (await fileHandle.read(extra, 0, 1, info.size)).bytesRead > 0;
        if (grew || read.bytesRead !== info.size) return failure(SourceError.OCR_OUTPUT_INVALID, "terminal");
        const text = stripUtf8Bom(markdown.toString("utf8"));
        // "Actual candidate textual output" is the executor's bar for SUCCEEDED
        // (mission output contract). Canonical usability stays 04B-2's authority.
        if (text.trim().length === 0) return failure(SourceError.OCR_NO_USABLE_TEXT, "transient");
        return { status: "SUCCEEDED", text };
      } catch {
        return failure(SourceError.OCR_TEMP_IO_ERROR, "transient");
      } finally {
        await fileHandle.close().catch(() => undefined);
      }
    }
  }

  const handle: MineruPdfOcrExecutorHandle = {
    executor,
    async close(): Promise<void> {
      closing = true;
      const deadline = Date.now() + 30_000;
      for (const entry of active) entry.controller.abort();
      while (active.size > 0 && Date.now() < deadline) await sleep(100);
      active.clear();
    },
  };
  return handle;
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
