import { z } from "zod";
import type { EpubExtractionMetadata } from "./epub-extraction-metadata.js";

/**
 * BOOK-INGESTION-04C-4A product-identity candidate contract.
 *
 * This is immutable extraction-scoped EVIDENCE only. It deliberately carries
 * no Work/Edition id and no promotion decision. A later promotion phase must
 * resolve the current extraction first, then compare this evidence with the
 * product identity authority and user-owned values.
 */
export const PRODUCT_IDENTITY_CANDIDATE_SCHEMA_VERSION = "product-identity-candidate-v1" as const;

const candidateValue = z.string().min(1).max(2000);

const titleEvidenceSchema = z.strictObject({
  sourceField: z.literal("dc:title"),
  value: candidateValue,
});

const languageEvidenceSchema = z.strictObject({
  sourceField: z.literal("dc:language"),
  value: candidateValue,
});

const identifierEvidenceSchema = z.strictObject({
  sourceField: z.literal("dc:identifier"),
  value: candidateValue,
  /**
   * dc:identifier is not synonymous with ISBN. 04C-4A preserves the package
   * value without guessing a scheme from its shape.
   */
  classification: z.literal("UNCLASSIFIED"),
});

export const productIdentityCandidateSchema = z.strictObject({
  kind: z.literal("epub"),
  schemaVersion: z.literal(PRODUCT_IDENTITY_CANDIDATE_SCHEMA_VERSION),
  source: z.literal("EPUB_PACKAGE_METADATA"),
  authority: z.literal("EVIDENCE_ONLY"),
  title: titleEvidenceSchema.nullable(),
  language: languageEvidenceSchema.nullable(),
  identifier: identifierEvidenceSchema.nullable(),
});

export type ProductIdentityCandidate = z.infer<typeof productIdentityCandidateSchema>;
export type ProductIdentityEvidence =
  | NonNullable<ProductIdentityCandidate["title"]>
  | NonNullable<ProductIdentityCandidate["language"]>
  | NonNullable<ProductIdentityCandidate["identifier"]>;

/** Deterministic projection from the already validated EPUB metadata contract. */
export function buildEpubProductIdentityCandidate(metadata: EpubExtractionMetadata): ProductIdentityCandidate {
  return productIdentityCandidateSchema.parse({
    kind: "epub",
    schemaVersion: PRODUCT_IDENTITY_CANDIDATE_SCHEMA_VERSION,
    source: "EPUB_PACKAGE_METADATA",
    authority: "EVIDENCE_ONLY",
    title: metadata.dcTitle ? { sourceField: "dc:title", value: metadata.dcTitle } : null,
    language: metadata.dcLanguage ? { sourceField: "dc:language", value: metadata.dcLanguage } : null,
    identifier: metadata.dcIdentifier
      ? { sourceField: "dc:identifier", value: metadata.dcIdentifier, classification: "UNCLASSIFIED" }
      : null,
  });
}

export function parseProductIdentityCandidate(value: unknown): ProductIdentityCandidate {
  return productIdentityCandidateSchema.parse(value);
}

/** Tolerant historical read: legacy/non-EPUB rows stay NULL and are never backfilled. */
export function tryParseProductIdentityCandidate(value: unknown): ProductIdentityCandidate | null {
  const parsed = productIdentityCandidateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
