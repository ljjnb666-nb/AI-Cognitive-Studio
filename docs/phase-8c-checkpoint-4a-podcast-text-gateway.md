# PHASE8C_CHECKPOINT4A_PODCAST_TEXT_GATEWAY_ACTIVATION

Podcast paid text generation uses the workspace BYOK `PODCAST_SCRIPT` route for episode planning, narrative design, segment outlines, segment drafts, and segment humanization. Each operation has a deterministic run/stage/segment identity and uses the existing encrypted `ProviderTextResult` receipt.

The receipt consumer verifies the live Podcast lease in its transaction, writes the existing Podcast destination rows, then tombstones and purges the receipt in that same transaction. A stale owner cannot write or consume. Existing invocations are recovered from their pinned snapshot before a current route is resolved, so a later route switch cannot repay a completed operation.

The principal is derived from `PodcastGenerationRun.jobId -> Job.userId`; job workspace equality and exact workspace membership are required. There is no platform credential fallback.

Retrieval remains explicitly outside this checkpoint: `buildBookContextForIntelligence` continues to receive the injected `EmbeddingProvider`. Query embeddings, pgvector, cosine scoring, reindexing, Podcast TTS, audio, Short Video, and provider UI are non-scope.
