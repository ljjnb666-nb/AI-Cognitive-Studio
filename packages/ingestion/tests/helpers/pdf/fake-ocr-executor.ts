import type { PdfOcrExecutor, PdfOcrPageRequest, PdfOcrPageResult } from "../../../src/pdf-routing.js";

/**
 * TEST-ONLY PdfOcrExecutor (BOOK-INGESTION-04B-2). Drives the SAME durable
 * page-attempt state machine the future production executor will use; it never
 * ships in production code paths. Per-page scripts are consumed in order and
 * the last entry repeats.
 */
export type FakeOcrScriptEntry = { text: string } | { errorCode: string; kind: "transient" | "terminal"; nextAttemptAt?: Date };

export function fakeOcrText(text: string): FakeOcrScriptEntry {
  return { text };
}
export function fakeOcrTransientFailure(errorCode = "SOURCE_OCR_TIMEOUT"): FakeOcrScriptEntry {
  return { errorCode, kind: "transient" };
}
export function fakeOcrTerminalFailure(errorCode = "SOURCE_OCR_ENGINE_CRASH"): FakeOcrScriptEntry {
  return { errorCode, kind: "terminal" };
}

export class FakePdfOcrExecutor implements PdfOcrExecutor {
  readonly descriptor = { name: "fake-ocr", version: "fake-ocr-v1" } as const;
  readonly calls: Array<{ ingestionRunId: string; workspaceId: string; sourceDocumentId: string; physicalPageIndex: number; routingGeneration: number; pdfByteLength: number }> = [];
  readonly defaultText = "fake ocr fallback text";
  private scripts = new Map<number, FakeOcrScriptEntry[]>();

  script(physicalPageIndex: number, entries: FakeOcrScriptEntry[]): this {
    this.scripts.set(physicalPageIndex, [...entries]);
    return this;
  }

  async extractPage(request: PdfOcrPageRequest): Promise<PdfOcrPageResult> {
    this.calls.push({ ingestionRunId: request.ingestionRunId, workspaceId: request.workspaceId, sourceDocumentId: request.sourceDocumentId, physicalPageIndex: request.physicalPageIndex, routingGeneration: request.routingGeneration, pdfByteLength: request.pdfBytes.length });
    const queue = this.scripts.get(request.physicalPageIndex);
    const entry = queue && queue.length > 0 ? (queue.length > 1 ? queue.shift()! : queue[0]!) : { text: this.defaultText };
    if ("text" in entry) return { status: "SUCCEEDED", text: entry.text };
    return { status: "FAILED", errorCode: entry.errorCode, kind: entry.kind, nextAttemptAt: entry.nextAttemptAt };
  }
}
