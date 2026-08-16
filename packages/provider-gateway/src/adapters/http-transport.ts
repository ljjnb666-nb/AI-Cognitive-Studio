import { ProviderGatewayError } from "../errors.js";

export type ProviderHttpRequest = { url: string; method: "POST"; headers: Readonly<Record<string, string>>; body: string; signal: AbortSignal };
export type ProviderHttpResponse = { status: number; headers: Headers | Readonly<Record<string, string | undefined>>; body: string };
export type ProviderHttpTransport = { execute(request: ProviderHttpRequest): Promise<ProviderHttpResponse> };
const maxResponseBytes = 4 * 1024 * 1024;
export class FetchProviderHttpTransport implements ProviderHttpTransport {
  async execute(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    if (request.signal.aborted) throw new ProviderGatewayError("CANCELLED");
    let response: Response;
    try { response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: request.signal, redirect: "manual" }); } catch (error) { if (request.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new ProviderGatewayError("CANCELLED"); throw new ProviderGatewayError("TRANSIENT_UPSTREAM"); }
    const reader = response.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    if (reader) { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maxResponseBytes) { await reader.cancel(); throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Provider response exceeded limit"); } chunks.push(next.value); } }
    return { status: response.status, headers: response.headers, body: new TextDecoder().decode(concat(chunks, bytes)) };
  }
}
function concat(chunks: Uint8Array[], size: number): Uint8Array { const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; } return out; }
export class DeterministicProviderHttpTransport implements ProviderHttpTransport { calls: ProviderHttpRequest[] = []; constructor(private readonly responder: (request: ProviderHttpRequest) => ProviderHttpResponse | Promise<ProviderHttpResponse>) {} async execute(request: ProviderHttpRequest): Promise<ProviderHttpResponse> { if (request.signal.aborted) throw new ProviderGatewayError("CANCELLED"); this.calls.push(request); return this.responder(request); } }
