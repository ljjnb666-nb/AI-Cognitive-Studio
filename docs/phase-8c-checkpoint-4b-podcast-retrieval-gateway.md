# PHASE8C_CHECKPOINT4B_PODCAST_RETRIEVAL_GATEWAY_AUTONOMY

Checkpoint 4B completes Podcast production AI autonomy for text and retrieval.
The worker composes a shared workspace-BYOK Provider Gateway runtime: paid script
stages use `PODCAST_SCRIPT`; retrieval query embeddings use `EMBEDDING` with
purpose `QUERY`. TTS/audio and all reindexing/vector-migration work remain out
of scope.

The durable Podcast principal is `PodcastGenerationRun.jobId -> Job.userId ->
WorkspaceMember`. Missing users, membership, or workspace alignment fail before
either provider is resolved or any remote call starts.

The retrieval provider is run-scoped. It loads every pinned
`PodcastGenerationSource.analysisRunId` through
`loadConsumedBookAnalysisEmbeddingIdentity`; that consumed Book Gateway receipt
is the authority for provider, model, embedding version, dimensions, and hash.
Missing receipts and incompatible multi-source identities fail closed. A new
query also preflights the current `EMBEDDING` route against that identity.

Queries have stable keys (`PLANNING` and `SEGMENT_CONTEXT:<segmentId>`). The
Gateway idempotency key is run-scoped. An existing exact request recovers its
encrypted `ProviderEmbeddingResult` before resolving the current route, so a
route A to B change cannot repurchase or mix vector spaces. A changed query or
retrieval semantic version is an idempotency conflict.

Unlike Book document embeddings, query receipts have no application-owned
destination. They remain encrypted, recoverable, unconsumed, and unpurged for
safe exact replay. Retrieval ranking, stable selection, budgets, and source
lineage are unchanged.
