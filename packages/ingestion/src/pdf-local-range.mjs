import { open } from "node:fs/promises";
import { PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Maximum individual disk read sent to PDF.js, independent of PDF file size. */
export const PDF_LOCAL_RANGE_MAX_BYTES = 1024 * 1024;

class LocalFilePdfTransport extends PDFDataRangeTransport {
  #file;
  #closed = false;
  #pending = new Set();
  #onFailure;

  constructor(file, length, onFailure) {
    // No progressive body and no eager full-file allocation.
    super(length, null, true);
    this.#file = file;
    this.#onFailure = onFailure;
  }

  requestDataRange(begin, end) {
    if (this.#closed) return;
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
        begin < 0 || end <= begin || end > this.length ||
        end - begin > PDF_LOCAL_RANGE_MAX_BYTES) {
      this.#onFailure(new Error("INVALID_PDF_RANGE"));
      return;
    }

    const request = (async () => {
      const chunk = new Uint8Array(end - begin);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesRead } = await this.#file.read(chunk, offset, chunk.byteLength - offset, begin + offset);
        if (bytesRead <= 0) throw new Error("TRUNCATED_PDF_RANGE");
        offset += bytesRead;
      }
      if (!this.#closed) this.onDataRange(begin, chunk);
    })();
    this.#pending.add(request);
    void request.then(
      () => { this.#pending.delete(request); },
      (error) => {
        this.#pending.delete(request);
        if (!this.#closed) this.#onFailure(error);
      },
    );
  }

  async close() {
    this.#closed = true;
    await Promise.allSettled(this.#pending);
    await this.#file.close();
  }

  abort() {
    this.#closed = true;
  }
}

/**
 * The caller must close only AFTER PDF.js destroys its loading task.
 * The open file handle remains private to the parsing child; never expose
 * remote object URLs or unrestricted filesystem access to PDF.js.
 */
export async function openLocalPdfRange(input, onFailure) {
  const file = await open(input, "r");
  try {
    const info = await file.stat();
    if (!Number.isSafeInteger(info.size) || info.size < 5) throw new Error("INVALID_PDF_SIZE");
    return new LocalFilePdfTransport(file, info.size, onFailure);
  } catch (error) {
    await file.close();
    throw error;
  }
}
