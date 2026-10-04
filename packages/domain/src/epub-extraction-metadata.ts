import { z } from "zod";
import { isSafeEpubResourcePath } from "./source-locator.js";

/**
 * Format-native EPUB extraction metadata (canonical-book-v1, additive).
 *
 * Persisted in DocumentExtraction.formatMetadata for EPUB extractions only;
 * PDF/TXT/Markdown keep NULL. This records WHAT the EPUB package looked like
 * (package path, rendition layout, spine size, navigation evidence) — it is
 * descriptive evidence, never product identity: package dc:title/dc:language/
 * dc:identifier must not be written into Work/Edition by ingestion, and
 * navigation entries are structural evidence, not an authoritative chapter
 * tree. Strict on purpose; legacy rows keep NULL and are never backfilled.
 */

export const EPUB_RENDITION_LAYOUTS = ["REFLOWABLE", "PRE_PAGINATED", "UNKNOWN"] as const;
export type EpubRenditionLayout = (typeof EPUB_RENDITION_LAYOUTS)[number];

export const EPUB_NAVIGATION_SOURCES = ["EPUB3_NAV", "EPUB2_NCX", "NONE"] as const;
export type EpubNavigationSource = (typeof EPUB_NAVIGATION_SOURCES)[number];

export const epubNavigationEntrySchema = z.strictObject({
  /** Contiguous position in the flattened navigation, starting at 0. */
  ordinal: z.number().int().min(0),
  /** Nesting depth in the source TOC tree, starting at 0. */
  depth: z.number().int().min(0),
  /** Visible TOC label, whitespace-normalized. Never fabricated. */
  label: z.string().min(1),
  /** Normalized archive-relative path of the linked resource. */
  href: z
    .string()
    .min(1)
    .refine(isSafeEpubResourcePath, { message: "UNSAFE_EPUB_RESOURCE_PATH" }),
  /** Fragment inside that resource, when the TOC link carried one. */
  fragmentId: z.string().min(1).nullish(),
});

export type EpubNavigationEntry = z.infer<typeof epubNavigationEntrySchema>;

/** Optional, NON-authoritative package descriptor fields (never product identity). */
const optionalPackageText = z
  .string()
  .min(1)
  .max(2000)
  .nullish();

export const epubExtractionMetadataSchema = z
  .strictObject({
    kind: z.literal("epub"),
    /** OPF package version as declared (e.g. "2.0", "3.0"); null when absent. */
    epubVersion: optionalPackageText,
    /** Normalized archive-relative path of the parsed OPF package document. */
    packagePath: z
      .string()
      .min(1)
      .refine(isSafeEpubResourcePath, { message: "UNSAFE_EPUB_RESOURCE_PATH" }),
    renditionLayout: z.enum(EPUB_RENDITION_LAYOUTS),
    spineItemCount: z.number().int().min(0),
    navigationSource: z.enum(EPUB_NAVIGATION_SOURCES),
    /** Flattened TOC evidence; empty when navigationSource is NONE. */
    navigation: z.array(epubNavigationEntrySchema),
    dcTitle: optionalPackageText,
    dcLanguage: optionalPackageText,
    dcIdentifier: optionalPackageText,
  })
  .refine((metadata) => (metadata.navigationSource === "NONE" ? metadata.navigation.length === 0 : metadata.navigation.length > 0), {
    message: "EPUB_NAVIGATION_SOURCE_ENTRY_MISMATCH",
  })
  .refine((metadata) => metadata.navigation.every((entry, index) => entry.ordinal === index), {
    message: "EPUB_NAVIGATION_ORDINAL_NOT_CONTIGUOUS",
  });

export type EpubExtractionMetadata = z.infer<typeof epubExtractionMetadataSchema>;

/** Strict parse for newly written EPUB extraction metadata. Throws on any violation. */
export function parseEpubExtractionMetadata(value: unknown): EpubExtractionMetadata {
  return epubExtractionMetadataSchema.parse(value);
}

/** Tolerant read for historical rows; returns null when the stored value is not valid EPUB metadata. */
export function tryParseEpubExtractionMetadata(value: unknown): EpubExtractionMetadata | null {
  const result = epubExtractionMetadataSchema.safeParse(value);
  return result.success ? result.data : null;
}
