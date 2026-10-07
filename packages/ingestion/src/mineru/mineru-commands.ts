import { SourceError } from "../source-errors.js";

/**
 * Pure MinerU command/output contract (BOOK-INGESTION-04B-3).
 *
 * Every shape here is derived from the 04B-0 benchmark gate's EMPIRICALLY
 * VERIFIED MinerU 4.0.3 contract:
 *  - `mineru parse <pdf> --tier <mode> --pages <pagesArg> --output <md> --json --force`
 *  - 1-based page selectors (`--pages 1-1`); canonical physicalPageIndex is 0-based
 *  - `mineru parse` is a CLIENT of a per-MINERU_HOME doclib server; without a
 *    running server it exits 1 with error.code "server_not_running" (verified),
 *    so the executor owns a claim-scoped server lifecycle
 *  - success stdout is a JSON envelope { parse: { status: "done" }, output: { status: "written", path } }
 *    and the markdown is written to the requested --output path
 *  - a missing local model fails deterministically at parse time with an
 *    engine_error whose message matches /is not ready/ and no download
 *
 * MinerU output NEVER provides page identity: the invocation's requested
 * physicalPageIndex is the authoritative lineage and nothing here parses
 * MinerU page comments for identity.
 */

export const MINERU_EXECUTOR_NAME = "mineru";
/** The only MinerU version this executor is pinned and benchmark-verified against. */
export const MINERU_PINNED_VERSION = "4.0.3";
/** 04B-0 production recommendation: flash is the only benchmarked production tier. */
export const MINERU_PINNED_TIER = "flash" as const;

export type MineruEndpoint = { version: number; pid: number; serverId: string; transports: Array<Record<string, unknown>> };

/**
 * Validates the durable doclib endpoint identity written to
 * `<MINERU_HOME>/doclib.endpoint.json` (04B-0: version 2 envelope with
 * pid + server_id + transports). Returns null for anything else — endpoint
 * files are untrusted external-process output.
 */
export function parseMineruEndpoint(raw: string): MineruEndpoint | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const endpoint = value as { version?: unknown; pid?: unknown; server_id?: unknown; transports?: unknown } | null;
  if (!endpoint || typeof endpoint !== "object") return null;
  if (endpoint.version !== 2) return null;
  if (typeof endpoint.pid !== "number" || !Number.isSafeInteger(endpoint.pid) || endpoint.pid <= 0) return null;
  if (typeof endpoint.server_id !== "string" || endpoint.server_id.length === 0) return null;
  if (!Array.isArray(endpoint.transports)) return null;
  return { version: 2, pid: endpoint.pid, serverId: endpoint.server_id, transports: endpoint.transports as Array<Record<string, unknown>> };
}

/**
 * The single authoritative binding between the canonical 0-based
 * physicalPageIndex and MinerU's 1-based page selector. The invocation's
 * requested page IS the provenance; this conversion is exact and refuses
 * anything non-integer/negative (fail closed on off-by-one hazards).
 */
export function mineruPageSelector(physicalPageIndex: number): string {
  if (!Number.isSafeInteger(physicalPageIndex) || physicalPageIndex < 0) throw new Error(SourceError.PARSE);
  return `${physicalPageIndex + 1}-${physicalPageIndex + 1}`;
}

/** Builds the exact argv for one bounded parse invocation (spawn arg array — never a shell string). */
export function buildMineruParseArgs(input: { inputPdfPath: string; tier: string; physicalPageIndex: number; outputMarkdownPath: string }): string[] {
  return ["parse", input.inputPdfPath, "--tier", input.tier, "--pages", mineruPageSelector(input.physicalPageIndex), "--output", input.outputMarkdownPath, "--json", "--force"];
}

/** Builds `mineru server start|stop` argv (04B-0-verified subcommands). */
export function buildMineruServerArgs(action: "start" | "stop"): string[] {
  return ["server", action];
}

export type MineruParseEnvelope = {
  parse?: { status?: unknown };
  output?: { status?: unknown; path?: unknown };
  error?: { type?: unknown; code?: unknown; message?: unknown };
};

/** Best-effort bounded parse of the stdout JSON envelope; null when not valid JSON. */
export function parseMineruParseEnvelope(stdout: string): MineruParseEnvelope | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as MineruParseEnvelope;
  } catch {
    return null;
  }
}

export type MineruParseOutcome =
  | { kind: "OUTPUT_WRITTEN"; markdownPath: string }
  | { kind: "MODEL_NOT_FOUND" }
  | { kind: "SERVER_UNAVAILABLE" }
  | { kind: "OUTPUT_NOT_WRITTEN" }
  | { kind: "PROCESS_FAILED" };

const isStatus = (value: unknown, expected: string) => value === expected;
const errorMessage = (envelope: MineruParseEnvelope): string => {
  const message = envelope.error?.message;
  return typeof message === "string" ? message : "";
};

/**
 * Deterministically classifies one completed parse invocation. Evidence-based
 * mapping (04B-0/04B-3 probes), never exception text:
 *  - exit 0 + done + written → OUTPUT_WRITTEN with the envelope's output path
 *    (the executor additionally requires it to equal the requested path)
 *  - exit 1 + engine "Model repo ... is not ready" → MODEL_NOT_FOUND (terminal)
 *  - exit 1 + error.code "server_not_running" → SERVER_UNAVAILABLE (transient)
 *  - exit 0 without a written output → OUTPUT_NOT_WRITTEN (deterministic
 *    process behavior → terminal)
 *  - everything else → PROCESS_FAILED (transient)
 */
export function judgeMineruParseExit(input: { exitCode: number | null; stdout: string }): MineruParseOutcome {
  const envelope = parseMineruParseEnvelope(input.stdout);
  if (input.exitCode === 0) {
    if (!envelope || !isStatus(envelope.parse?.status, "done")) return { kind: "PROCESS_FAILED" };
    if (isStatus(envelope.output?.status, "written") && typeof envelope.output?.path === "string" && envelope.output.path.length > 0) return { kind: "OUTPUT_WRITTEN", markdownPath: envelope.output.path };
    return { kind: "OUTPUT_NOT_WRITTEN" };
  }
  if (envelope?.error) {
    if (/is not ready/i.test(errorMessage(envelope))) return { kind: "MODEL_NOT_FOUND" };
    if (envelope.error.code === "server_not_running") return { kind: "SERVER_UNAVAILABLE" };
  }
  return { kind: "PROCESS_FAILED" };
}

/** Maps a parse outcome to the executor's stable failure surface (null = success path handled by caller). */
export function mineruFailureForOutcome(outcome: Exclude<MineruParseOutcome, { kind: "OUTPUT_WRITTEN" }>): { errorCode: string; kind: "transient" | "terminal" } {
  switch (outcome.kind) {
    case "MODEL_NOT_FOUND":
      return { errorCode: SourceError.OCR_MODEL_NOT_FOUND, kind: "terminal" };
    case "SERVER_UNAVAILABLE":
    case "PROCESS_FAILED":
      return { errorCode: SourceError.OCR_PROCESS_FAILED, kind: "transient" };
    case "OUTPUT_NOT_WRITTEN":
      return { errorCode: SourceError.OCR_OUTPUT_INVALID, kind: "terminal" };
  }
}
