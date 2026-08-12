# Phase 4 audio quality

Audio is generated one pinned-script utterance at a time.  Hosts require explicit, distinct canonical provider voice identities; arbitrary voice cloning is excluded.  Speech preparation is deterministic, preserves meaning, and treats source text as data: provider SSML is escaped and only trusted code may emit speech controls.

Pause selection is persisted from the script role. Reactions and interruptions use shorter handoffs than normal turns, while segment boundaries are longer. Output targets -16 LUFS by configuration while preserving conversational dynamics. Quality evaluation records decode success, duration drift (warning envelope 0.7–1.4), silence metrics, peaks, ordering, and host distinction. Decode, lineage, hash, missing-media, and clipping safety failures block finalization.

Audio bytes are stored only in private object storage. Persisted SHA-256 values are calculated from uploaded bytes. Uploads made before ownership loss are deliberately unattached orphan keys under `audio-orphans/` for lifecycle collection; stale workers cannot publish their metadata. Production requires an explicitly configured TTS adapter; deterministic WAV providers are test-only.
