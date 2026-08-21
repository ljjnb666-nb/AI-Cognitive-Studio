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

## EMBEDDING_DURABLE_HANDOFF_ANALYSIS

Checkpoint 1 does not solve the crash boundary between a successful provider embedding response and `DocumentChunkEmbedding`/`BookMemoryEmbedding` persistence. Gateway idempotency deliberately stores no raw vectors, so a replay cannot reconstruct them without another paid call. Checkpoint 2 should choose one of: persist encrypted/short-lived response handoff data transactionally; create a durable per-batch paid-call receipt with vector payload; or make the caller persist vectors in the same durable completion protocol before acknowledging gateway success. The recommended option is a durable per-batch handoff record with bounded encrypted vector payloads and an atomic consumer acknowledgement, so retry can complete persistence without repaying the provider.

## COSINE_SIMILARITY_AUDIT

`packages/book-intelligence/src/embeddings.ts` currently computes dot product only. It does not divide by both vector norms, so it is `DOT_PRODUCT_ONLY`; this checkpoint intentionally does not change retrieval math.
