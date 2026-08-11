# ADR 0006: Segment-based grounded podcast generation

## Decision

Podcast generation consumes only persisted Phase 2 Book Intelligence through bounded retrieval and the Context Builder. Its `PodcastGenerationSource` snapshot is authoritative: exact historical retrieval uses the stored source-document, extraction, chunk-set, and analysis-run identity even if current intelligence advances later. The current-oriented public retrieval API retains its stale-intelligence guard. The original book is never concatenated into a podcast prompt. A durable `PodcastGenerationRun` advances through planning, narrative design, segment outline, segment drafting, humanization, grounding validation, and finalization using PostgreSQL-owned leases and stage compare-and-swap transitions. BullMQ remains execution infrastructure and the transactional outbox prevents a database/queue dual-write.

Each segment retrieves and persists its own bounded context with source, extraction, chunk-set, analysis-run, memory-item, artifact, optional chunk, evidence-span, score, selection-reason, and conservative token-estimate provenance. This keeps provider input bounded, permits a failed segment to regenerate independently, and preserves completed work across crashes.

Dialogue is persisted as ordered utterances rather than one markdown blob. This supports speaker identity, evidence per substantive claim, deterministic duration estimates, host-distribution evaluation, later user edits, and future rendering without losing structure. Final revisions retain immutable snapshots and lineage; `CurrentPodcastScript` only selects the current revision for the same episode.

Humanization is a distinct durable stage because natural speech requires explicit transformations and verification. In Phase 3 it may rewrite only non-substantive conversational glue; direct quotes and substantive or evidence-backed text are immutable. Grounding therefore runs after humanization, but old evidence can never legitimize a changed factual proposition.

Deterministic naturalness evaluation is the regression baseline because external LLM judges are non-deterministic and unavailable in hermetic tests. The metrics expose AI-feel, repetition, host similarity, grounding, source-copy risk, context-budget compliance, and fabrication boundaries while separating hard validity failures from quality warnings.

Production startup resolves podcast providers through an explicit runtime-adapter boundary. No configured provider leaves podcast generation disabled while health and ingestion workers remain active. A configured unsupported provider is a startup error. A valid adapter starts both the BullMQ consumer and outbox dispatch loop and closes both during signal shutdown. A failed later regeneration preserves `READY` when a valid `CurrentPodcastScript` already exists.

## Consequences

Provider calls are smaller and more numerous, but retries reuse durable planning, segments, humanization, and grounding instead of paying for the entire episode again. Provenance remains queryable through humanization and revision finalization. Source content is always untrusted data and cannot alter control-plane settings.

TTS and all audio concerns are postponed. Phase 3 produces script and podcast content data only; voice, timing from synthesized audio, mixing, music, waveform, and video systems require separate later-phase decisions.
