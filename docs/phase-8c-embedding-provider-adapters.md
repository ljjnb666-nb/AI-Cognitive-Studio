# Phase 8C embedding provider adapters

Verified 2026-08-17 using the vendors' primary documentation: OpenAI Embeddings API, Gemini Embeddings API, Alibaba Cloud Model Studio synchronous embedding API, Cohere Embed v2 API, and Voyage Text Embeddings API.

| Provider | Protocol | Endpoint family | Auth | Fixture model | Dimensions | Batch/purpose |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_EMBEDDINGS` | `/v1/embeddings` | Bearer | `text-embedding-3-small` | pinned capability/default | ordered input, semantic purpose is runtime metadata |
| Gemini | `GEMINI_EMBEDDINGS` | `models/{model}:batchEmbedContents` | `x-goog-api-key` | `gemini-embedding-001` | configurable, pinned | independent requests; all five task types |
| Qwen | `OPENAI_COMPATIBLE` | regional `/compatible-mode/v1/embeddings` | Bearer | `text-embedding-v4` | configurable, pinned | approved Beijing/Singapore workspace hosts only; semantic purpose is not sent |
| Cohere | `COHERE_EMBEDDINGS_V2` | `/v2/embed` | Bearer | `embed-v4.0` | configurable where capability says so | max 96; document/query/classification/clustering |
| Voyage | `VOYAGE_EMBEDDINGS` | `/v1/embeddings` | Bearer | `voyage-3.5-lite` | capability-controlled | document/query or neutral similarity |

All adapters use float vectors, one transport call per gateway attempt, bounded transport, and provider-supplied input-token usage only. Runtime texts are never persisted by ProviderGateway.

## PHASE8C_CHECKPOINT2A_DURABLE_HANDOFF

Checkpoint 2A stores an encrypted `ProviderEmbeddingResult` for each successful EMBEDDING invocation. It contains only an AES-256-GCM encrypted normalized vector payload plus vector count, dimensions, cipher version, and relational provenance to workspace, snapshot, invocation, and remote attempt. The plaintext is bounded to 8 MiB after the normal provider input, count, dimension, finite-number, and non-zero-vector checks; values are never truncated.

AAD is domain-separated as `provider-embedding-result-v1` and binds workspace, invocation, attempt, snapshot, pinned provider, and pinned model IDs. The result vault is preflighted before every durable embedding remote attempt. Replay decrypts using the persisted snapshot identity and validates vectors again. Tampering, missing keys, malformed payloads, and a legacy `SUCCEEDED` invocation without its receipt fail closed as `RECONCILIATION_REQUIRED`; they never cause another provider call.

The attempt success, usage append, encrypted receipt creation, invocation success, and claim clearing occur in one transaction. Text-generation accounting remains unchanged and no generic provider-response table exists. Results are handoff artifacts: unconsumed receipts remain recoverable; Checkpoint 2B will atomically materialize application-owned vectors then delete or purge the receipt. Checkpoint 2A does not activate book-pipeline embeddings, change batching/reindexing, or repair the current dot-product-only similarity implementation.

Protocol compatibility != capability compatibility. Changing provider, model, modelVersion, embeddingVersion, or dimensions requires a new embedding identity and re-embedding before vectors are compatible.

## PHASE8C_CHECKPOINT2B_ATOMIC_MATERIALIZATION

Checkpoint 2B turns a successful encrypted receipt into application-owned vectors with one PostgreSQL transaction. `ProviderEmbeddingResult` is retained as a tombstone: before consumption it contains the AES-256-GCM payload; after a successful materializer callback it retains invocation, workspace, snapshot, count/dimensions, consumer kind/key/fingerprint and timestamps, while ciphertext, IV, authentication tag and key version are purged.

The fingerprint binds workspace, invocation, pinned snapshot, consumer kind, ordered destination ids, destination content hashes and lineage, plus embedding version. Book Intelligence re-reads and validates targets inside the same transaction, preserves vector order, uses the snapshot provider/model/dimensions and canonical identity hash, and fails closed on conflicting rows. The Gateway locks the receipt, validates/decrypts it, invokes the materializer, writes the tombstone and purges the payload. Callback failure rolls back all writes. Matching retries return `ALREADY_CONSUMED`; mismatched fingerprints are rejected. Missing/corrupt unconsumed receipts remain reconciliation-required. Gateway replay after consumption returns `ALREADY_PROCESSED` with `embeddingConsumed: true`, without vectors or another provider call. Consumption creates no new invocation, attempt or usage event.

## EMBEDDING_DURABLE_HANDOFF_ANALYSIS

## PHASE8C_CHECKPOINT3A_BOOK_INTELLIGENCE_GATEWAY_ACTIVATION

The durable Book Intelligence `EMBEDDINGS` stage now submits one deterministic ordered composite request to Provider Gateway: `DocumentChunk` targets ordered by ordinal/id followed by `BookMemoryItem` targets ordered by ordinal/id. One `BOOK_ANALYSIS_EMBEDDINGS` receipt is consumed in the same PostgreSQL transaction that materializes both embedding tables. The consumer key is the analysis-run id and its fingerprint binds the complete ordered lineage and content-hash target set.

The old production direct provider/vector-persistence path has been removed. A persisted gateway receipt is replayed without a second provider call; the materializer rechecks the BookAnalysisRun claim token, lease, status and stage while holding the receipt transaction, so a stale owner leaves an unconsumed recoverable receipt for the next owner. Acceptance uses deterministic local provider adapters only; it never calls an external AI service.

Retrieval gateway migration, cosine-similarity changes, pgvector, reindexing and advanced batching remain out of scope for this checkpoint. No schema migration is introduced.

Checkpoint 1 does not solve the crash boundary between a successful provider embedding response and `DocumentChunkEmbedding`/`BookMemoryEmbedding` persistence. Gateway idempotency deliberately stores no raw vectors, so a replay cannot reconstruct them without another paid call. Checkpoint 2 should choose one of: persist encrypted/short-lived response handoff data transactionally; create a durable per-batch paid-call receipt with vector payload; or make the caller persist vectors in the same durable completion protocol before acknowledging gateway success. The recommended option is a durable per-batch handoff record with bounded encrypted vector payloads and an atomic consumer acknowledgement, so retry can complete persistence without repaying the provider.

## COSINE_SIMILARITY_AUDIT

`packages/book-intelligence/src/embeddings.ts` currently computes dot product only. It does not divide by both vector norms, so it is `DOT_PRODUCT_ONLY`; this checkpoint intentionally does not change retrieval math.
