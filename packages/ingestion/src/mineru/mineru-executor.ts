import { mkdir, mkdtemp, open, lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@ai-cognitive/shared";
import { OCR_HOST_LEASE_TTL_MS, acquireOcrHostLease, createOcrServerInstance, markOcrServerOrphaned, markOcrServerStartNeverStarted, markOcrServerStopped, markOcrServerStopping, recordOcrServerEndpoint, releaseOcrHostLease, renewOcrHostLease } from "../ocr-durability.js";
import type { PdfOcrExecutor, PdfOcrExecutorDescriptor, PdfOcrPageRequest, PdfOcrPageResult } from "../pdf-routing.js";
import { SourceError } from "../source-errors.js";
import { MINERU_EXECUTOR_NAME, buildMineruParseArgs, judgeMineruParseExit, mineruFailureForOutcome } from "./mineru-commands.js";
import { isWithinPath, type MineruExecutorConfig } from "./mineru-config.js";
import { sleep, spawnBounded, type BoundedSpawnResult } from "./mineru-process.js";
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

export type MineruOcrCallRecord = { ingestionRunId: string; physicalPageIndex: number; routingGeneration: number; outcome: "SUCCEEDED" | "FAILED"; errorCode?: string; durationMs: number };

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

export function createMineruPdfOcrExecutor(config: MineruExecutorConfig): MineruPdfOcrExecutorHandle {
  if (config.modelSource !== "local") throw new Error(SourceError.OCR_MINERU_NOT_CONFIGURED);
  const descriptor: PdfOcrExecutorDescriptor = { name: MINERU_EXECUTOR_NAME, version: config.version, parserMode: config.tier, modelRevision: null };
  const active = new Set<{ controller: AbortController; done: Promise<unknown> }>();
  let closing = false;

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
  function recordCall(request: PdfOcrPageRequest, result: PdfOcrPageResult, startedAt: number): PdfOcrPageResult {
    executor.calls.push({
      ingestionRunId: request.ingestionRunId,
      physicalPageIndex: request.physicalPageIndex,
      routingGeneration: request.routingGeneration,
      outcome: result.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      ...(result.status === "FAILED" ? { errorCode: result.errorCode } : {}),
      durationMs: Date.now() - startedAt,
    });
    if (executor.calls.length > 1000) executor.calls.shift();
    return result;
  }

  async function runPage(request: PdfOcrPageRequest, controller: AbortController, startedAt: number): Promise<PdfOcrPageResult> {
    const signal = controller.signal;
    if (closing) return failure(SourceError.OCR_PROCESS_FAILED, "transient");
    const logContext = { ingestionRunId: request.ingestionRunId, physicalPageIndex: request.physicalPageIndex, routingGeneration: request.routingGeneration, executor: MINERU_EXECUTOR_NAME };

    // 1. Host capacity authority (OcrHostLease). No busy-wait and NO stored
    // future page time (RF01 P1-01): the capacity failure propagates as a
    // run-retryable error through 04B-2's existing retryable execution
    // authority, leaving the page PENDING and immediately claimable — the
    // queue's retry cadence is the single retry clock.
    const lease = await acquireOcrHostLease(config.hostId, OCR_HOST_LEASE_TTL_MS, { executable: config.executable, modelPath: config.modelPath, tier: config.tier, version: config.version }).catch(() => null);
    if (!lease) {
      logger.warn("mineru.ocr.host_capacity", { ...logContext, failureCode: SourceError.OCR_HOST_CAPACITY });
      return await recordCall(request, failure(SourceError.OCR_HOST_CAPACITY, "transient"), startedAt);
    }
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void renewOcrHostLease(config.hostId, lease.claimToken).then((renewed) => { if (!renewed) { leaseLost = true; controller.abort(); } }).catch(() => { leaseLost = true; controller.abort(); });
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
        ...process.env,
        ...mineruEgressDenialEnv(),
        MINERU_HOME: homeDir,
        MINERU_MODEL_SOURCE: config.modelSource,
        MINERU_MODEL_BASE_DIR: config.modelPath,
        TMP: outputDir,
        TEMP: outputDir,
      };
      session = await createMineruServerSession({ executable: config.executable, executableArgs: config.executableArgs, homeDir, childEnvBase, startTimeoutMs: config.serverStartTimeoutMs, stopTimeoutMs: config.serverStopTimeoutMs, maxOutputBytes: Math.min(config.maxOutputBytes, 1_048_576), abortSignal: signal, ...(config.processImagePattern ? { processImagePattern: config.processImagePattern } : {}) });
      const startFailure = await session.start();
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
        return recordCall(request, mapped, startedAt);
      }
      serverStarted = true;
      const endpoint = session.endpoint!;
      const endpointRecorded = await recordOcrServerEndpoint({ hostClaimToken: lease.claimToken, endpoint: { pid: endpoint.pid, serverId: endpoint.serverId, transports: endpoint.transports } }).catch(() => false);
      if (!endpointRecorded) throw new Error("OCR_SERVER_ENDPOINT_RECORDING_LOST");

      // 5. THE one bounded parse invocation per claim (one claim = one
      // invocation; retries belong to 04B-2's durable attempt budget).
      const parseArgs = buildMineruParseArgs({ inputPdfPath, tier: config.tier, physicalPageIndex: request.physicalPageIndex, outputMarkdownPath });
      const parseResult = await spawnBounded(config.executable, [...config.executableArgs, ...parseArgs], { env: childEnvBase, cwd: outputDir, timeoutMs: config.timeoutMs, maxOutputBytes: Math.min(config.maxOutputBytes, 1_048_576), abortSignal: signal });
      let result: PdfOcrPageResult;
      if (parseResult.spawnErrorCode === "ENOENT") {
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
      return recordCall(request, result, startedAt);
    } catch (error) {
      // Claim-tree IO / durable-identity failures are infrastructure-class:
      // stable transient codes, never arbitrary exception text.
      const message = error instanceof Error ? error.message : "";
      const stable = message === "OCR_SERVER_INSTANCE_CONFLICT" || message === "OCR_SERVER_ENDPOINT_RECORDING_LOST" ? SourceError.OCR_PROCESS_FAILED : SourceError.OCR_TEMP_IO_ERROR;
      logger.warn("mineru.ocr.execution_error", { ...logContext, failureCode: stable });
      return recordCall(request, failure(stable, "transient"), startedAt);
    } finally {
      // 6. Bounded cleanup of everything this claim owned, in every outcome,
      // through the CLOSED server state machine (RF01 P1-07, RF02 P1-04/P1-05).
      clearInterval(heartbeat);
      let serverTerminated = false;
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
