# ADR 0005: Phase 2 book intelligence

The original book is untrusted data, never a prompt. Immutable `SourceBlock` and UTF-16 `SourceSpan` remain citation authority; chunks, structure, embeddings, analyses, and memory are derived, versioned artifacts.

`SourceDocument -> DocumentExtraction -> SourceBlock -> DocumentStructureNode -> ChunkSet -> DocumentChunk -> chunk analysis -> section/chapter analysis -> book synthesis -> BookMemory -> Context Builder`.

Chunking is deterministic and structure-first, then page/block/paragraph/sentence boundaries, only finally splitting oversized text without splitting UTF-16 surrogate pairs. Chunk provenance maps every emitted range back to its source block. Quotes are persisted only after exact substring validation.

Analysis consumes a bounded chunk or bounded child-artifact/evidence pack through a provider abstraction. It never receives a complete book by default. Book Memory is typed, relational, evidence-backed, and version-aware; it is the reusable boundary for later podcast work, which is explicitly outside Phase 2.

The Context Builder deterministically ranks typed memory and optional chunks under a caller token budget, exposing selected provenance and scores. Embeddings are versioned retrieval indexes, not source truth. A new extraction produces new derived versions and current pointers move without deleting historical artifacts. Long-running writes use idempotency keys and PostgreSQL remains authoritative while BullMQ is only execution infrastructure.
