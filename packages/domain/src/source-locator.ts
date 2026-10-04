import { z } from "zod";

/**
 * Canonical source locator contract (canonical-book-v1).
 *
 * A locator records WHERE inside the physical/digital artifact a block came
 * from. PDFs may own physical pages; EPUBs must never fabricate one and are
 * located by spine position plus the EPUB-internal resource path. Validation is
 * deterministic only: nothing here performs file access.
 */

export const pdfSourceLocatorSchema = z.strictObject({
  kind: z.literal("pdf"),
  physicalPageIndex: z.number().int().min(0),
  printedPageLabel: z.string().nullish(),
});

export const epubSourceLocatorSchema = z.strictObject({
  kind: z.literal("epub"),
  spineIndex: z.number().int().min(0),
  href: z
    .string()
    .min(1)
    .refine(isSafeEpubResourcePath, { message: "UNSAFE_EPUB_RESOURCE_PATH" }),
  fragmentId: z.string().nullish(),
  elementPath: z.string().nullish(),
});

export const canonicalSourceLocatorSchema = z.discriminatedUnion("kind", [
  pdfSourceLocatorSchema,
  epubSourceLocatorSchema,
]);

export type PdfSourceLocator = z.infer<typeof pdfSourceLocatorSchema>;
export type EpubSourceLocator = z.infer<typeof epubSourceLocatorSchema>;
export type CanonicalSourceLocator = z.infer<typeof canonicalSourceLocatorSchema>;

/**
 * EPUB resource paths must stay inside the archive: no absolute, drive, or UNC
 * paths, no traversal segments, no percent-encoded traversal, and no external
 * schemes. This mirrors (and must never be looser than) the ingestion parser's
 * own path validation.
 */
export function isSafeEpubResourcePath(path: string): boolean {
  if (!path) return false;
  if (/^(?:[\\/]|[a-zA-Z]:|\\\\)/.test(path)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  if (/%2e|%2f|%5c/i.test(path)) return false;
  return path.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}

export function parseSourceLocator(value: unknown): CanonicalSourceLocator {
  return canonicalSourceLocatorSchema.parse(value);
}

export function tryParseSourceLocator(value: unknown): CanonicalSourceLocator | null {
  const result = canonicalSourceLocatorSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Axis-aligned bounding box for a block. Units are intentionally unconstrained
 * (each producer defines its coordinate space); only finiteness and ordering
 * are contractual. A producer that cannot supply a real box must omit it —
 * never fabricate one.
 */
export const sourceBlockBboxSchema = z
  .strictObject({
    x0: finiteNumber(),
    y0: finiteNumber(),
    x1: finiteNumber(),
    y1: finiteNumber(),
  })
  .refine((bbox) => bbox.x1 >= bbox.x0 && bbox.y1 >= bbox.y0, {
    message: "INVERTED_SOURCE_BLOCK_BBOX",
  });

export type SourceBlockBbox = z.infer<typeof sourceBlockBboxSchema>;

export function parseSourceBlockBbox(value: unknown): SourceBlockBbox {
  return sourceBlockBboxSchema.parse(value);
}

export function tryParseSourceBlockBbox(value: unknown): SourceBlockBbox | null {
  const result = sourceBlockBboxSchema.safeParse(value);
  return result.success ? result.data : null;
}

function finiteNumber(): z.ZodType<number> {
  return z.number().refine(Number.isFinite, { message: "NON_FINITE_NUMBER" });
}
