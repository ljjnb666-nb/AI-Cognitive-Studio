import type { StorageProvider } from "@ai-cognitive/storage";

type Range = { start: number; end: number };
function parseRange(value: string, size: number): Range | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const left = match[1] ? Number(match[1]) : undefined;
  const right = match[2] ? Number(match[2]) : undefined;
  if ([left, right].some(value => value !== undefined && !Number.isSafeInteger(value))) return null;
  if (left === undefined) return right && right > 0 ? { start: Math.max(0, size - right), end: size - 1 } : null;
  if (left >= size || (right !== undefined && right < left)) return null;
  return { start: left, end: Math.min(right ?? size - 1, size - 1) };
}

export async function mediaResponse(request: Request, provider: StorageProvider, key: string, contentType: string): Promise<Response> {
  const head = await provider.headObject(key);
  const headers = new Headers({ "cache-control": "private, no-store", "content-type": contentType, "content-disposition": "inline", "accept-ranges": "bytes", "x-content-type-options": "nosniff" });
  if (!head) return new Response(null, { status: 404, headers });
  if (!Number.isSafeInteger(head.size) || head.size < 0) throw new Error("MEDIA_INVALID_OBJECT_SIZE");
  // Without a validator matching If-Range, serve the complete current representation.
  const rangeHeader = request.method === "GET" && !request.headers.has("if-range") ? request.headers.get("range") : null;
  const range = rangeHeader === null ? undefined : parseRange(rangeHeader, head.size);
  if (range === null) { headers.set("content-range", `bytes */${head.size}`); return new Response(null, { status: 416, headers }); }
  const length = range ? range.end - range.start + 1 : head.size;
  headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
  if (request.method === "HEAD" || length === 0) return new Response(null, { status: 200, headers });
  const cancellation = new AbortController();
  const body = await provider.getObjectStream(key, { range, signal: AbortSignal.any([request.signal, cancellation.signal]) });
  const iterator = body[Symbol.asyncIterator]();
  let remaining = length;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (chunk.done) {
          if (remaining !== 0) throw new Error("MEDIA_TRUNCATED_OBJECT");
          controller.close(); return;
        }
        if (chunk.value.length > remaining) throw new Error("MEDIA_OBJECT_LENGTH_MISMATCH");
        remaining -= chunk.value.length;
        controller.enqueue(chunk.value);
      } catch (error) {
        cancellation.abort();
        await iterator.return?.().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() { cancellation.abort(); await iterator.return?.(); },
  });
  return new Response(stream, { status: range ? 206 : 200, headers });
}
