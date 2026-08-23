# PHASE8C_CHECKPOINT5_PODCAST_SPEECH_GATEWAY_AUTONOMY

Checkpoint 5 activates `PODCAST_TTS` with the `SPEECH` capability. The generic Gateway `SpeechInput` and `SpeechResponse` use a binary-safe HTTP transport; the installed OpenAI implementation calls `/v1/audio/speech` and requests WAV output.

`ProviderSpeechResult` is the single additive migration in this checkpoint. It encrypts TTS bytes before consumption, records receipt metadata and provenance, and removes ciphertext, IV, authentication tag, and key version when a consumer commits its business destination. The podcast consumer writes immutable S3/MinIO objects, verifies their hash on read-back, then commits the authoritative destination and receipt consumption together under AudioGenerationRun ownership.

Retries recover the original execution snapshot before resolving the current route. A changed route therefore cannot generate a second paid result for an existing chunk operation. New operations must match the durable run's provider, model, model version, voice identity, and speech semantics. The production worker obtains its actor from `AudioGenerationRun → Job → WorkspaceMember`; it does not use a static worker account or a browser identity.

Short Video TTS is intentionally out of scope. Migration count: 1.
