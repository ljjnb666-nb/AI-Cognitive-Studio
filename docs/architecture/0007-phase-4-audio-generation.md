# ADR 0007: Durable utterance-level podcast audio

Audio runs pin a `PodcastScriptRevision`, so a later current-script update cannot alter work in progress. Synthesis is utterance-level for retry/cost isolation, host identity, and natural pause assembly. Binaries stay in object storage, while PostgreSQL stores ownership, lineage, hashes, and metadata.

Assembly and normalization are separate durable stages, enabling resume without re-synthesis. Deterministic role-based pauses are an auditable naturalness guardrail. TTS is an adapter boundary and unauthorized real-person voice cloning is excluded. Video, captions, and social rendering remain postponed to later phases.
