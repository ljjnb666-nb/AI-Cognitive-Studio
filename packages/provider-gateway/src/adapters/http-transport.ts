import { ProviderGatewayError } from "../errors.js";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { validateProviderEndpoint, type DnsResolver } from "../safety/endpoint-policy.js";
import type { ProviderAddressResolver } from "../safety/public-lookup.js";

export type ProviderHttpRequest = { url: string; method: "POST"; headers: Readonly<Record<string, string>>; body: string; signal: AbortSignal };
export type ProviderHttpResponse = { status: number; headers: Headers | Readonly<Record<string, string | undefined>>; body: string };
export type ProviderBinaryHttpResponse = { status: number; headers: Headers | Readonly<Record<string, string | undefined>>; bytes: Uint8Array };
export type ProviderHttpTransport = { execute(request: ProviderHttpRequest): Promise<ProviderHttpResponse>; executeBinary(request: ProviderHttpRequest): Promise<ProviderBinaryHttpResponse> };
const maxTextResponseBytes = 4 * 1024 * 1024;
const maxBinaryResponseBytes = 20 * 1024 * 1024;
const defaultDns: DnsResolver = { lookup: async hostname => (await lookup(hostname, { all: true })).map(item => item.address) };

export class FetchProviderHttpTransport implements ProviderHttpTransport {
  private readonly policy: { environment?: string; allowPrivateEndpoints?: boolean; dns?: DnsResolver };
  /** Accepts the pre-audit resolver-injection signature (address resolver function) or the audit remediation policy object. */
  constructor(policy: { environment?: string; allowPrivateEndpoints?: boolean; dns?: DnsResolver } | ProviderAddressResolver = {}) {
    this.policy = typeof policy === "function" ? { dns: { lookup: async hostname => (await policy(hostname)).map(item => item.address) } } : policy;
  }
  /** node:https with agent:false pools nothing; kept for transport lifecycle callers. */
  async close(): Promise<void> { /* no pooled resources */ }
  async execute(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    const response = await this.readResponse(request, maxTextResponseBytes);
    return { status: response.status, headers: response.headers, body: new TextDecoder().decode(response.bytes) };
  }
  async executeBinary(request: ProviderHttpRequest): Promise<ProviderBinaryHttpResponse> {
    return this.readResponse(request, maxBinaryResponseBytes);
  }
  private async readResponse(request: ProviderHttpRequest, maxResponseBytes: number): Promise<ProviderBinaryHttpResponse> {
    if (request.signal.aborted) throw new ProviderGatewayError("CANCELLED");
    // Resolve once per attempt, validate both families, then bind that exact set
    // to the socket. The URL retains the original Host header and TLS SNI.
    const endpoint = await abortable(validateProviderEndpoint(request.url, { environment: this.policy.environment ?? process.env.NODE_ENV ?? "production", allowPrivateEndpoints: this.policy.allowPrivateEndpoints, dns: this.policy.dns ?? defaultDns }), request.signal);
    if (request.signal.aborted) throw new ProviderGatewayError("CANCELLED");
    return new Promise((resolve, reject) => {
      const call = httpsRequest(endpoint.url, {
        method: request.method, headers: request.headers, signal: request.signal, agent: false,
        lookup: (_hostname, options, callback) => {
          const records = endpoint.addresses.map(address => ({ address, family: isIP(address) }));
          if (options.all) callback(null, records);
          else callback(null, records[0]!.address, records[0]!.family);
        },
      }, response => {
        const chunks: Uint8Array[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponseBytes) { call.destroy(); response.destroy(); reject(new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Provider response exceeded limit")); return; }
          chunks.push(chunk);
        });
        response.on("error", () => reject(new ProviderGatewayError(request.signal.aborted ? "CANCELLED" : "TRANSIENT_UPSTREAM")));
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          resolve({ status: response.statusCode ?? 502, headers, bytes: concat(chunks, size) });
        });
      });
      call.on("error", () => reject(new ProviderGatewayError(request.signal.aborted ? "CANCELLED" : "TRANSIENT_UPSTREAM")));
      call.end(request.body);
    });
  }
}
function concat(chunks: Uint8Array[], size: number): Uint8Array { const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; } return out; }
export class DeterministicProviderHttpTransport implements ProviderHttpTransport { calls: ProviderHttpRequest[] = []; constructor(private readonly responder: (request: ProviderHttpRequest) => ProviderHttpResponse | Promise<ProviderHttpResponse>, private readonly binaryResponder?: (request: ProviderHttpRequest) => ProviderBinaryHttpResponse | Promise<ProviderBinaryHttpResponse>) {} async execute(request: ProviderHttpRequest): Promise<ProviderHttpResponse> { if (request.signal.aborted) throw new ProviderGatewayError("CANCELLED"); this.calls.push(request); return await this.responder(request); } async executeBinary(request: ProviderHttpRequest): Promise<ProviderBinaryHttpResponse> { if (request.signal.aborted) throw new ProviderGatewayError("CANCELLED"); this.calls.push(request); if (this.binaryResponder) return await this.binaryResponder(request); const response = await this.responder(request); return { status: response.status, headers: response.headers, bytes: new TextEncoder().encode(response.body) }; } }

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderGatewayError("CANCELLED"));
    if (signal.aborted) { work.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
