import { MINERU_STANDARD_TIER } from "./mineru-standard-admission.js";

/** Claim-scoped managed engine bootstrap. MinerU 4.0.3's health loop reads
 * mode on every cycle and starts the supervised engine without rebooting
 * doclib. Its existing owner/stop identity stays authoritative. */

const API_PREFIX = "/api/v1";
const MANAGED_MODE_KEY = "parse_server.local.mode";

export type ManagedServerSetupFailure =
  | { kind: "CONFIG_SET_FAILED"; detail: string }
  | { kind: "STATUS_UNAVAILABLE"; detail: string }
  | { kind: "READINESS_TIMEOUT"; detail: string };

/**
 * The claim doclib's endpoint file is UNTRUSTED external-process output; the
 * executor must never fetch an attacker-chosen URL from it. The claim-scoped
 * doclib only ever serves plain HTTP on IPv4 loopback, so anything else is
 * rejected before any network contact (SSRF guard, Mimosa finding 2026-10-29).
 */
const LOOPBACK_BASE_URL_PATTERN = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/;

/** Every exported network operation repeats the SSRF boundary check. */
function validLoopbackBaseUrl(baseUrl: string): boolean {
  const match = LOOPBACK_BASE_URL_PATTERN.exec(baseUrl);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function transportsBaseUrl(transports: Array<Record<string, unknown>>): string | null {
  for (const transport of transports) {
    if (transport["type"] !== "tcp" || typeof transport["base_url"] !== "string") continue;
    if (validLoopbackBaseUrl(transport["base_url"])) return transport["base_url"];
  }
  return null;
}

export function parseServerBaseUrl(transports: Array<Record<string, unknown>>): string | null {
  return transportsBaseUrl(transports);
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Persists the managed-mode override into the CLAIM doclib config service. */
export async function setParseServerModeManaged(baseUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<ManagedServerSetupFailure | null> {
  if (!validLoopbackBaseUrl(baseUrl)) return { kind: "CONFIG_SET_FAILED", detail: "INVALID_LOOPBACK_ENDPOINT" };
  try {
    const result = await requestJson(`${baseUrl.replace(/\/$/, "")}${API_PREFIX}/configs/${encodeURIComponent(MANAGED_MODE_KEY)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "managed" }),
    }, timeoutMs, signal);
    if (!result.ok) return { kind: "CONFIG_SET_FAILED", detail: `HTTP ${result.status}` };
    return null;
  } catch (error) {
    return { kind: "CONFIG_SET_FAILED", detail: error instanceof Error ? error.message.slice(0, 200) : "unknown" };
  }
}

type LocalParseServerStatusView = {
  healthy?: unknown;
  managed_running?: unknown;
  managed_tier?: unknown;
  supported_tiers?: unknown;
};

function localParseServerView(statusBody: unknown): LocalParseServerStatusView | null {
  if (!statusBody || typeof statusBody !== "object") return null;
  const parseServer = (statusBody as Record<string, unknown>)["parse_server"];
  if (!parseServer || typeof parseServer !== "object") return null;
  const local = (parseServer as Record<string, unknown>)["local"];
  return local && typeof local === "object" ? (local as LocalParseServerStatusView) : null;
}

/** Positive evidence of standard availability is mandatory; missing tier
 * metadata cannot be interpreted as standard-ready. */
export function isStandardReady(local: LocalParseServerStatusView): boolean {
  if (local.healthy !== true || local.managed_running !== true) return false;
  if (local.managed_tier !== undefined && local.managed_tier !== null && local.managed_tier !== MINERU_STANDARD_TIER) return false;
  const reportedByMode = local.managed_tier === MINERU_STANDARD_TIER;
  const reportedBySupportedTiers = Array.isArray(local.supported_tiers) && local.supported_tiers.includes(MINERU_STANDARD_TIER);
  return reportedByMode || reportedBySupportedTiers;
}

/**
 * Bounded readiness poll for the claim's managed standard engines. Resolves
 * null when ready; a failure kind otherwise. Every wait is abortable (host
 * lease loss / cancellation) and bounded by the caller's server-start budget.
 */
export async function waitForStandardParseServerReady(
  baseUrl: string,
  readinessTimeoutMs: number,
  options: { pollIntervalMs?: number; statusTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ManagedServerSetupFailure | null> {
  if (!validLoopbackBaseUrl(baseUrl)) return { kind: "STATUS_UNAVAILABLE", detail: "INVALID_LOOPBACK_ENDPOINT" };
  const deadline = Date.now() + readinessTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const statusTimeoutMs = options.statusTimeoutMs ?? 5_000;
  let lastDetail = "no successful status probe";
  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { kind: "STATUS_UNAVAILABLE", detail: "aborted" };
    try {
      const result = await requestJson(`${baseUrl.replace(/\/$/, "")}${API_PREFIX}/server/status`, { method: "GET" }, Math.min(statusTimeoutMs, Math.max(1, deadline - Date.now())), options.signal);
      if (result.ok) {
        const local = localParseServerView(result.body);
        if (local && isStandardReady(local)) return null;
        lastDetail = JSON.stringify(local ?? result.body).slice(0, 200);
      } else {
        lastDetail = `HTTP ${result.status}`;
      }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message.slice(0, 200) : "probe error";
    }
    await new Promise<void>((resolveSleep) => {
      const done = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", done); resolveSleep(); };
      const timer = setTimeout(done, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      options.signal?.addEventListener("abort", done, { once: true });
      if (options.signal?.aborted) done();
    });
  }
  return { kind: "READINESS_TIMEOUT", detail: lastDetail };
}
