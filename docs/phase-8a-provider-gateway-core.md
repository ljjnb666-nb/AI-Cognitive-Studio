# Phase 8A — Multi-Provider AI Gateway Core

Phase 8A establishes a provider-independent execution foundation. It contains **no real AI vendor adapter, vendor SDK, API credential, or external AI call**.

`packages/provider-gateway` sits below Book Intelligence, Podcast Generation, and Short Video Generation. Those packages retain their existing provider-neutral interfaces and durable job ownership rules. Later provider phases add adapters and registry manifests; they do not move vendor code into domain pipelines.

## Capabilities and routing

The registry separates stable `providerKey`, display name, protocol family, model capability metadata, and adapter version. Capability families are text generation, embedding, and speech. Text structured output is explicitly `STRICT_JSON_SCHEMA`, `JSON_MODE`, `PROMPT_ONLY`, or `UNSUPPORTED`.

Routes are independent: `BOOK_CHUNK_ANALYSIS`, `BOOK_REDUCTION_ANALYSIS`, `BOOK_SYNTHESIS`, `EMBEDDING`, `PODCAST_SCRIPT`, `PODCAST_TTS`, `SHORT_VIDEO_SCRIPT`, and `SHORT_VIDEO_TTS`. Resolution uses a workspace connection first, then an injected platform-default resolver. Platform-owned credentials are deliberately outside workspace tables. There is no runtime fallback.

Before an adapter can run, the gateway resolves an immutable snapshot containing workspace, route slot, provider/protocol/model, BYOK connection and credential-version identity, endpoint/region/configuration, capability, configuration hash, adapter version, version metadata, creation time, and correlation ID. Snapshots never contain plaintext credentials. An old snapshot keeps its selected model and retired credential; a revoked credential blocks it before an adapter call.

## Credentials and safety

Workspace credentials use a replaceable `CredentialCipher`. The supplied implementation is Node `aes-256-gcm`, backed by an explicitly configured versioned 256-bit keyring. It binds workspace, connection, credential-version, and provider key as authenticated additional data. There is no automatic key generation and the keyring is only needed when the vault is invoked.

Credential states are `ACTIVE`, `RETIRED`, and `REVOKED`. Rotation retires the previous active version; revocation is permanent for execution. Provider events use redacted, bounded metadata and never retain plaintext secrets.

Custom endpoints are validated before a future transport can use them: canonical HTTPS only, no credentials/fragments/query, and DNS answers are captured in a validated endpoint object. Public deployments reject loopback, private, link-local, shared, multicast/reserved, and IPv4-mapped private targets. `ALLOW_PRIVATE_PROVIDER_ENDPOINTS=true` only permits private endpoints outside production; production always rejects them.

## Durable execution

The public gateway request requires a canonical lowercase SHA-256 `inputHash`; callers cannot provide the final request fingerprint. The gateway computes that fingerprint from the resolved route, pinned provider configuration and credential lineage, capability/version metadata, and input identity.

PostgreSQL is the source of execution ownership. A new claim creates the immutable snapshot and logical invocation in one transaction and records a bounded claim token, worker identity, and expiry. A matching completed invocation returns `ALREADY_PROCESSED`; an active invocation returns `IN_PROGRESS`; a matching stale invocation with no durable attempt can be reclaimed. A stale owner cannot start an attempt or finalize a newer owner. Invocations that may have crossed the remote boundary are never reclaimed automatically.

Lease admission and renewal use PostgreSQL time in production. The current owner renews immediately before each candidate remote attempt and around retry backoff. Once any durable attempt exists, later redelivery with the same idempotency key never initiates another provider call: known terminal failures return `TERMINAL_FAILED`, permanent pre-remote blocks return `BLOCKED_EXISTING`, and incomplete/unknown remote outcomes return `RECONCILIATION_REQUIRED`. Transient circuit, rate, and concurrency denials made before an attempt release the zero-attempt claim so that the same request can safely retry after the gate clears.

Each remote call has its own durable attempt row. Before every attempt the gateway revalidates ownership and the pinned connection/credential, applies circuit, rate, and concurrency controls, then creates the running attempt immediately before calling the adapter. It records normalized outcome, bounded request ID and latency, and reported append-only usage. A known remote success whose local persistence cannot finish is marked `RECONCILIATION_REQUIRED` rather than replayed. This is duplicate suppression and durable local ownership, not a claim of provider-side exactly-once execution.

Workspace credentials are selected only when `ACTIVE`; a snapshot can continue using an exact pinned `RETIRED` credential, but `REVOKED`, disabled, and revoked connection states block execution. `REVOKED` connections are terminal and cannot be re-enabled, rotated, or newly routed.

## Persistence and deferred work

The additive `phase_8a_provider_gateway_core` migration adds provider connections, encrypted credential versions, route bindings, immutable execution snapshots, invocation provenance, append-only usage events, and append-only audit events. Workspace-owned references use composite tenant relations where provider objects cross boundaries.

Phase 8B adds mainstream LLM adapters; 8C embedding adapters; 8D TTS adapters; 8E BYOK/custom-provider UI; and 8F real-provider E2E, benchmark, usage pricing, and preset validation. None are part of Phase 8A.

## PHASE8C_CHECKPOINT6_SHORT_VIDEO_GATEWAY_AUTONOMY

Short Video uses workspace-owned `SHORT_VIDEO_SCRIPT`, `EMBEDDING` query, and `SHORT_VIDEO_TTS` routes. Production Worker composition creates a shared Gateway runtime from the durable job principal; it does not require static worker credentials or manually injected providers. The worker claims the run before resolving run-scoped providers, so stale or terminal deliveries do not create pins or make paid calls.

`ShortVideoSpeechExecutionPin` is a credential-free, one-per-run immutable pin for provider/model/version, voice/version, rate, pitch, style, language, format, audio version, and pipeline version. Every new TTS unit revalidates the current route against that pin. Thus replay uses the original durable receipt/snapshot, while a new unit after an incompatible A-to-B route edit fails rather than silently mixing voices.

Plan and scene generation use `ProviderTextResult`: a receipt is encrypted after the remote result, then consumed and purged in the same PostgreSQL transaction that writes either `ShortVideoPlan` or the full Scene/Narration/Evidence graph. A consumed-receipt retry verifies the exact persisted destination fingerprint; divergence is reconciliation-required, never regeneration from purged plaintext.

Query embeddings use stage-and-source operation identities of the form `short-video-query:<run>:<stage>:<source>`. They retain encrypted `ProviderEmbeddingResult` receipts for exact replay and must match every source run's consumed Book embedding vector-space identity. Missing, incompatible, or changed-route identities fail before a new remote query.

Speech uses `ProviderSpeechResult` and stable per-unit identities of the form `short-video-tts:<run>:<narration>:<unit>`. Bytes are uploaded to immutable MinIO storage and read back for SHA-256 verification before the authoritative `ShortVideoAudioArtifact` is written. Its `narrationId` and `unitOrdinal` preserve the unit lineage; artifact write plus receipt consume/purge is atomic. Consumed replay checks the database artifact fingerprint and actual object hash, so database or object corruption is reconciliation-required.

FFmpeg rendering and deterministic editorial frames remain local infrastructure; visual AI, render Gateway routes, and visual-provider features are outside this checkpoint.
