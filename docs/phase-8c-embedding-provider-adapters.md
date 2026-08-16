# Phase 8C embedding provider adapters

Verified 2026-08-17 using the vendors' primary documentation: OpenAI Embeddings API, Gemini Embeddings API, Alibaba Cloud Model Studio synchronous embedding API, Cohere Embed v2 API, and Voyage Text Embeddings API.

| Provider | Protocol | Endpoint family | Auth | Fixture model | Dimensions | Batch/purpose |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_EMBEDDINGS` | `/v1/embeddings` | Bearer | `text-embedding-3-small` | pinned capability/default | ordered input, semantic purpose is runtime metadata |
| Gemini | `GEMINI_EMBEDDINGS` | `models/{model}:batchEmbedContents` | `x-goog-api-key` | `gemini-embedding-001` | configurable, pinned | independent requests; all five task types |
| Qwen | `OPENAI_COMPATIBLE` | regional `/compatible-mode/v1/embeddings` | Bearer | `text-embedding-v4` | configurable, pinned | approved Beijing/Singapore workspace hosts only; semantic purpose is not sent |
| Cohere | `COHERE_EMBEDDINGS_V2` | `/v2/embed` | Bearer | `embed-v4.0` | configurable where capability says so | max 96; document/query/classification/clustering |
| Voyage | `VOYAGE_EMBEDDINGS` | `/v1/embeddings` | Bearer | `voyage-3.5-lite` | capability-controlled | document/query or neutral similarity |

All adapters use float vectors, one transport call per gateway attempt, bounded transport, and provider-supplied input-token usage only. Runtime texts and vectors are never persisted by ProviderGateway.

Protocol compatibility != capability compatibility. Changing provider, model, modelVersion, embeddingVersion, or dimensions requires a new embedding identity and re-embedding before vectors are compatible.

## EMBEDDING_DURABLE_HANDOFF_ANALYSIS

The current book path can crash after a successful remote call returns vectors but before `DocumentChunkEmbedding`/`BookMemoryEmbedding` persistence. Gateway idempotency deliberately stores no raw vectors, so a replay cannot reconstruct them without another paid call. Checkpoint 2 should choose one of: persist encrypted/short-lived response handoff data transactionally; create a durable per-batch paid-call receipt with vector payload; or make the caller persist vectors in the same durable completion protocol before acknowledging gateway success. The recommended option is a durable per-batch handoff record with an atomic consumer acknowledgement, so retry can complete persistence without repaying the provider.

## COSINE_SIMILARITY_AUDIT

`packages/book-intelligence/src/embeddings.ts` currently computes dot product only. It does not divide by both vector norms, so it is `DOT_PRODUCT_ONLY`; this checkpoint intentionally does not change retrieval math.
