# Phase 18.1 processing repair

Processing state is derived from durable `IngestionRun`, `BookAnalysisRun`, current extraction/intelligence, and the worker heartbeat. `NO_RUN` is `NOT_STARTED`, never `QUEUED`.

## Product state model

`NOT_STARTED` means the source exists without an ingestion run. `QUEUED_FOR_INGESTION`, `INGESTING`, `WAITING_FOR_ANALYSIS`, `ANALYSIS_QUEUED`, and `ANALYZING` are derived only from the newest durable run ordered by creation time. `SUCCEEDED` requires current immutable intelligence. Ingestion terminal errors become `INGESTION_FAILED`; analysis terminal errors become `ANALYSIS_FAILED`. A stale queued or running run becomes `PROCESSING_DEGRADED` only when the worker heartbeat is unavailable; a healthy worker may legitimately have a backlog.

The stale window uses `SOURCE_PARSE_TIMEOUT_MS`, rather than a UI-local magic timeout. The processing panel displays its durable waiting age, automatically backs off refresh from two seconds to ten seconds, pauses high-frequency work for hidden pages, clears timers on unmount, and stops automatic polling for terminal/degraded states.

Uploads create the source, ingestion run, job, and source-ingestion outbox event in one transaction. Recovery is authenticated and tenant-scoped; it returns an existing active/succeeded run, or appends a new attempt and durable outbox event while preserving failed history.

The source row is locked during recovery. Each appended retry uses the durable SourceDocument run count as its monotonic generation identity, rather than a per-Job delivery attempt count. Thus concurrent clicks converge on one active retry in every generation; recovery never mutates a failed run back to queued, overwrites a succeeded result, or writes directly to BullMQ from Web.

The worker writes a TTL-bound, credential-free Redis heartbeat. The web product surface validates only safe capability booleans and reports capability-specific `AVAILABLE`, `DEGRADED`, or `UNKNOWN`; malformed Redis data is never treated as available. Ingestion states use the ingestion capability and analysis states use the Book Analysis capability.

The processing status endpoint is authenticated through the normal Web identity, filters by workspace ownership, and returns only product state, timestamps, statuses, recovery eligibility, worker availability, and a constrained `safeFailureCode`. It does not return database records, connection strings, raw errors, credentials, source content, prompts, or provider responses.

`pnpm dev` starts web and worker. `pnpm dev:web` starts only web and will therefore show a degraded background-processing state after the bounded stale window. `pnpm dev:worker` starts only workers.

## Release evidence

`pnpm test:phase18-1:release` binds its evidence to the checked-out (or CI-supplied exact) SHA. It includes the Phase 18 fresh-database/two-deploy regression, real PostgreSQL recovery idempotence, TTL heartbeat tests, derived-state tests, and the Phase 6 browser harness. The browser harness first uploads a real PDF without a worker, asserts the degraded recovery UI, then starts the real worker and verifies the same source reaches grounded intelligence on desktop and mobile.

Book-analysis worker enablement reuses Provider Gateway prerequisites: a built-in catalog is valid without an explicit manifest, and development/test can use the durable local keyring resolver. Production remains fail-closed without a valid keyring; malformed keyrings or explicit manifests fail fast. The legacy `BOOK_ANALYSIS_PROVIDER` remains supported, while provider selection remains run-pinned and workspace-scoped.

The processing heartbeat contains only booleans for ingestion, book analysis, podcast generation, podcast audio, and short-video generation. Podcast, audio, and short-video workers still retain their legacy process-level enablement because their production runtime composition has not yet been converted to a workspace-BYOK-independent capability. The heartbeat makes those disabled capabilities diagnosable to operators; it never exposes provider settings, credentials, payloads, or errors.

## V3 stage-aware recovery contract

The single server-derived processing contract returns `processingState`, `processingStage`, `recoveryAction`, and `stageAvailability`. Stages are `INGESTION`, `BOOK_ANALYSIS`, and `COMPLETE`; recovery actions are `NONE`, `RECHECK`, `RETRY_INGESTION`, `RETRY_ANALYSIS`, and `REPAIR_CURRENT_INTELLIGENCE`. The browser consumes these fields and does not infer a stage from the presence of an analysis status.

`CurrentBookIntelligence` is the durable product-success invariant. A succeeded analysis without that marker is degraded at the Book Analysis stage and recovery re-finalizes the marker from the existing successful run under the source-document lock. It preserves exact workspace, source document, extraction, chunk-set, analysis-run, and provider lineage, does not replay ingestion or provider work, and never overwrites an already-current marker.

Periodic heartbeat failures are diagnostic: each timer write catches its own rejection and reports only a stable safe error code. A later heartbeat continues normally, and close is idempotent.

Processing heartbeat currently represents one logical homogeneous processing-worker capability profile. Heterogeneous horizontally scaled workers require per-worker heartbeat identity and capability aggregation before that deployment model is supported.
