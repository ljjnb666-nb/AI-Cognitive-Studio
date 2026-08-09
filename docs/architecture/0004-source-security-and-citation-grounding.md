# ADR 0004: Source security and citation grounding

Every uploaded byte sequence is untrusted. Server-side code computes SHA-256, verifies object size and magic bytes, isolates user filenames from storage keys, and parsers make no network calls. URL policy rejects non-HTTPS, credentialed, loopback, link-local, and common private IPv4 targets; a later URL fetcher must add DNS rebinding protection.

`SourcePage`, `SourceBlock`, and validated `SourceSpan` form the permanent grounding model. `SourceBlock.text` is the canonical normalized citation text. A `SourceSpan` uses JavaScript UTF-16 code-unit offsets and the half-open interval `[startOffset, endOffset)`; its `quoteText` must equal `SourceBlock.text.slice(startOffset, endOffset)`, and its `quoteHash` is the SHA-256 lowercase hex digest of the UTF-8 quote text.

`physicalPageIndex` is a zero-based physical-source page index. `printedPageLabel` is an independent nullable human-visible value and must never be inferred from the physical index. TXT, Markdown, and EPUB sources do not receive fabricated physical pages. A retrieval chunk or result may be added later but is not a permanent citation anchor.

`DocumentExtraction` records the actual parser and canonical-normalization provenance. `CurrentDocumentExtraction` is the sole authority for which extraction is current; changing it does not delete or overwrite historical `DocumentExtraction`, `SourcePage`, or `SourceBlock` records. `textStorageKey`, when present, is a derived whole-extraction convenience artifact assembled from canonical block text and is not citation source of truth.

The Gate 3 migration follows the unpublished Gate 2 migration within the same Phase 1 migration chain. No production application writes occur between those migrations, so the migration deliberately does not pretend to backfill canonical `SourceBlock.text` from offsets or hashes.
