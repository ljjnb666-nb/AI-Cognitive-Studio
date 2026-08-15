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

## Persistence and deferred work

The additive `phase_8a_provider_gateway_core` migration adds provider connections, encrypted credential versions, route bindings, immutable execution snapshots, invocation provenance, append-only usage events, and append-only audit events. Workspace-owned references use composite tenant relations where provider objects cross boundaries.

Phase 8B adds mainstream LLM adapters; 8C embedding adapters; 8D TTS adapters; 8E BYOK/custom-provider UI; and 8F real-provider E2E, benchmark, usage pricing, and preset validation. None are part of Phase 8A.
