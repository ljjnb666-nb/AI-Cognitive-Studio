import { describe, expect, it } from "vitest";
import {
  buildEpubProductIdentityCandidate,
  parseProductIdentityCandidate,
  tryParseProductIdentityCandidate,
} from "../src/product-identity-candidate.js";
import type { EpubExtractionMetadata } from "../src/epub-extraction-metadata.js";

function metadata(overrides: Partial<EpubExtractionMetadata> = {}): EpubExtractionMetadata {
  return {
    kind: "epub",
    epubVersion: "3.0",
    packagePath: "OEBPS/content.opf",
    renditionLayout: "REFLOWABLE",
    spineItemCount: 1,
    navigationSource: "NONE",
    navigation: [],
    dcTitle: null,
    dcLanguage: null,
    dcIdentifier: null,
    ...overrides,
  };
}

describe("EPUB product identity candidate authority", () => {
  it("projects package metadata as extraction-scoped evidence without a promotion decision", () => {
    expect(buildEpubProductIdentityCandidate(metadata({
      dcTitle: "The Book",
      dcLanguage: "zh-CN",
      dcIdentifier: "urn:uuid:book-id",
    }))).toEqual({
      kind: "epub",
      schemaVersion: "product-identity-candidate-v1",
      source: "EPUB_PACKAGE_METADATA",
      authority: "EVIDENCE_ONLY",
      title: { sourceField: "dc:title", value: "The Book" },
      language: { sourceField: "dc:language", value: "zh-CN" },
      identifier: { sourceField: "dc:identifier", value: "urn:uuid:book-id", classification: "UNCLASSIFIED" },
    });
  });

  it("keeps absent package fields explicitly absent instead of fabricating product identity", () => {
    expect(buildEpubProductIdentityCandidate(metadata())).toMatchObject({
      title: null,
      language: null,
      identifier: null,
      authority: "EVIDENCE_ONLY",
    });
  });

  it("never guesses ISBN authority from the shape of dc:identifier", () => {
    const candidate = buildEpubProductIdentityCandidate(metadata({ dcIdentifier: "9787111122334" }));
    expect(candidate.identifier).toEqual({
      sourceField: "dc:identifier",
      value: "9787111122334",
      classification: "UNCLASSIFIED",
    });
  });

  it("fails closed on a forged promotion-capable or structurally invalid candidate", () => {
    expect(() => parseProductIdentityCandidate({
      ...buildEpubProductIdentityCandidate(metadata({ dcTitle: "Book" })),
      authority: "AUTHORITATIVE",
    })).toThrow();
    expect(tryParseProductIdentityCandidate(null)).toBeNull();
    expect(tryParseProductIdentityCandidate({ kind: "epub" })).toBeNull();
  });
});
