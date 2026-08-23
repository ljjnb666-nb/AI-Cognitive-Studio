# Phase 8C Checkpoint 3B Book production gateway

`PHASE8C_CHECKPOINT3B_DURABLE_TEXT_HANDOFF`

TEXT and structured provider responses are encrypted before the remote-success attempt, usage event, invocation success, and result receipt are committed together. The receipt uses the `provider-text-result-v1` AAD domain and is bound to workspace, invocation, attempt, snapshot, provider, and model. A retry always uses the original snapshot: a recoverable receipt is decrypted and validated, while a missing, corrupt, or half-consumed receipt is reconciliation-required.

Application code consumes a text receipt with a deterministic consumer identity. Its durable destination write and receipt tombstone/purge happen in the same PostgreSQL transaction. A same-identity replay is already-consumed; a different identity is an idempotency conflict. A consumed Book destination must be verified read-only and must never trigger another provider call.

`PHASE8C_CHECKPOINT3B_BOOK_PRODUCTION_GATEWAY`

BookAnalysis production execution is Gateway-only. `CHUNK`, reductions, and `BOOK` use `BOOK_CHUNK_ANALYSIS`, `BOOK_REDUCTION_ANALYSIS`, and `BOOK_SYNTHESIS`; embeddings remain on `EMBEDDING`. The worker resolves the durable actor from `BookAnalysisRun.jobId -> Job.userId`, verifies the job workspace and membership, and fails closed for actor-null runs. There is no static worker principal and no platform credential fallback.

When Book Analysis is enabled, the worker auto-wires an environment keyring, validated model manifest, real HTTP adapter resolver, durable workspace routes and credentials, real Prisma repository, and Redis rate/concurrency/circuit controls. Required configuration is fail-closed; explicit dependency injection remains available only for deterministic tests.

Non-scope: retrieval/query embeddings, Podcast, TTS, Short Video, provider UI/API, platform fallback, batching, pgvector, reindexing, and cosine changes.
