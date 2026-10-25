import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Environment } from "@ai-cognitive/shared/server";
import type { PdfOcrExecutor, PdfOcrPageResult } from "../pdf-routing.js";
import { SourceError } from "../source-errors.js";
import { spawnBounded, type BoundedSpawnResult } from "../mineru/mineru-process.js";

export const RAPIDOCR_PINNED_VERSION = "3.9.2";
export const RAPIDOCR_PINNED_ONNX_VERSION = "1.22.1";
export const RAPIDOCR_EXECUTOR_NAME = "rapidocr-offline";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 512_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_SOURCE_BYTES = 110_000_000;

type Runner = typeof spawnBounded;
export type RapidOcrExecutorConfig = {
  python: string;
  script: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

function existingFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function resolveRapidOcrExecutorConfig(
  env: Environment, hasFile: (path: string) => boolean = existingFile,
): RapidOcrExecutorConfig | null {
  const any = env.RAPIDOCR_PYTHON_PATH !== undefined ||
    env.RAPIDOCR_TIMEOUT_MS !== undefined || env.RAPIDOCR_MAX_OUTPUT_BYTES !== undefined;
  if (env.OCR_PROVIDER !== "rapidocr") {
    if (any) throw new Error("OCR_RAPIDOCR_PROVIDER_REQUIRED");
    return null;
  }
  if (!env.RAPIDOCR_PYTHON_PATH ||
      !isAbsolute(env.RAPIDOCR_PYTHON_PATH) || !hasFile(env.RAPIDOCR_PYTHON_PATH)) {
    throw new Error("OCR_RAPIDOCR_PYTHON_INVALID");
  }
  if (env.WORKER_INGESTION_CONCURRENCY !== 1) {
    // One CPU model per worker host for the initial candidate integration.
    // Separate worker replicas must still be governed by deployment admission.
    throw new Error("OCR_RAPIDOCR_CONCURRENCY_UNSUPPORTED");
  }
  const timeoutMs = env.RAPIDOCR_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = env.RAPIDOCR_MAX_OUTPUT_BYTES ?? DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes<4096 ||
      maxOutputBytes>MAX_OUTPUT_BYTES) {
    throw new Error("OCR_RAPIDOCR_LIMITS_INVALID");
  }
  return {
    python: env.RAPIDOCR_PYTHON_PATH,
    script: fileURLToPath(new URL("./rapidocr-child.py",import.meta.url)),
    timeoutMs,
    maxOutputBytes,
  };
}

/**
 * Minimal child environment: untrusted PDFs are rendered in this Python
 * process, so provider keys, database credentials and application secrets
 * must not cross the OS process boundary. Windows Python/ONNX require a
 * small set of system paths; user-defined PYTHONPATH/PYTHONHOME are excluded.
 * Network proxies are explicitly pointed at the offline refusal endpoint.
 */
export function rapidOcrOfflineEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const system: NodeJS.ProcessEnv = {};
  const passThrough = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA",
    "APPDATA", "SystemDrive", "COMSPEC", "LD_LIBRARY_PATH", "LANG",
    "LC_ALL", "LC_CTYPE",
  ] as const;
  for (const key of passThrough) if (source[key] !== undefined) system[key] = source[key];
  return {
    ...system,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    OMP_NUM_THREADS: "2",
    OPENBLAS_NUM_THREADS: "2",
    MKL_NUM_THREADS: "2",
    NO_PROXY: "*",
    no_proxy: "*",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    http_proxy: "http://127.0.0.1:1",
    https_proxy: "http://127.0.0.1:1",
    all_proxy: "http://127.0.0.1:1",
  };
}

function safeParseJson(stdout: string): unknown {
  if (!stdout || stdout.length>MAX_OUTPUT_BYTES || stdout.trim().split("\n").length!==1) return null;
  try { return JSON.parse(stdout.trim()) as unknown; } catch { return null; }
}

export async function verifyRapidOcrRuntime(
  config: RapidOcrExecutorConfig, run: Runner = spawnBounded,
): Promise<{ modelSha256: string }> {
  const result = await run(config.python,[config.script,"--probe"],{
    env:rapidOcrOfflineEnv(),timeoutMs:20_000,maxOutputBytes:8192,
  });
  if (result.code !== 0 || result.outputOverflow || result.timedOut || result.aborted ||
      result.spawnErrorCode || result.signal) {
    throw new Error("OCR_RAPIDOCR_PROBE_FAILED");
  }
  const receipt = safeParseJson(result.stdout) as Record<string,unknown> | null;
  if (!receipt || Object.keys(receipt).sort().join(",")!==
        ["modelSha256","onnxruntime","rapidocr","schemaVersion","status"].sort().join(",") ||
      receipt.schemaVersion!==1 || receipt.status!=="READY" ||
      receipt.rapidocr!==RAPIDOCR_PINNED_VERSION ||
      receipt.onnxruntime!==RAPIDOCR_PINNED_ONNX_VERSION ||
      typeof receipt.modelSha256!=="string" ||
      !/^[a-f0-9]{64}$/.test(receipt.modelSha256)) {
    throw new Error("OCR_RAPIDOCR_PROVENANCE_INVALID");
  }
  return {modelSha256:receipt.modelSha256};
}

function failure(code: string, kind: "transient" | "terminal"): PdfOcrPageResult {
  return {status:"FAILED",errorCode:code,kind};
}

export function createRapidOcrPdfOcrExecutor(
  config: RapidOcrExecutorConfig,
  verified: {modelSha256:string},
  run: Runner = spawnBounded,
): PdfOcrExecutor {
  if (!/^[a-f0-9]{64}$/.test(verified.modelSha256)) {
    throw new Error("OCR_RAPIDOCR_PROVENANCE_INVALID");
  }
  return {
    descriptor: {
      name:RAPIDOCR_EXECUTOR_NAME,version:RAPIDOCR_PINNED_VERSION,
      parserMode:"offline-pdf-1.6x",modelRevision:verified.modelSha256,
    },
    async extractPage(request): Promise<PdfOcrPageResult> {
      if (!Number.isSafeInteger(request.physicalPageIndex) ||
          request.physicalPageIndex<0 || request.pdfBytes.length>MAX_SOURCE_BYTES ||
          request.pdfBytes.length<5) {
        return failure(SourceError.OCR_OUTPUT_INVALID,"terminal");
      }
      let dir: string | null = null;
      try {
        dir=await mkdtemp(join(tmpdir(),"acs-rapidocr-"));
        const input=join(dir,"source.pdf");
        await writeFile(input,request.pdfBytes,{flag:"wx"});
        const result: BoundedSpawnResult=await run(config.python,[
          config.script,"--pdf",input,"--page",String(request.physicalPageIndex),
        ],{
          cwd:dir,env:rapidOcrOfflineEnv(),timeoutMs:config.timeoutMs,
          maxOutputBytes:config.maxOutputBytes,
        });
        if (result.timedOut) return failure(SourceError.OCR_TIMEOUT,
          result.treeTerminationConfirmed ? "transient" : "terminal");
        if (result.aborted || result.signal || result.spawnErrorCode) {
          return failure(SourceError.OCR_PROCESS_FAILED,"terminal");
        }
        if (result.outputOverflow) return failure(SourceError.OCR_OUTPUT_INVALID,"terminal");
        if (result.code!==0) return failure(SourceError.OCR_PROCESS_FAILED,"terminal");
        const parsed=safeParseJson(result.stdout) as Record<string,unknown> | null;
        if (!parsed || Object.keys(parsed).sort().join(",")!==["schemaVersion","status","text"].sort().join(",") ||
            parsed.schemaVersion!==1 || parsed.status!=="SUCCEEDED" ||
            typeof parsed.text!=="string" || parsed.text.length>180_000 ||
            parsed.text.includes("\0")) {
          return failure(SourceError.OCR_OUTPUT_INVALID,"terminal");
        }
        return {status:"SUCCEEDED",text:parsed.text};
      } catch {
        return failure(SourceError.OCR_TEMP_IO_ERROR,"transient");
      } finally {
        if (dir!==null) await rm(dir,{recursive:true,force:true}).catch(()=>undefined);
      }
    },
  };
}
