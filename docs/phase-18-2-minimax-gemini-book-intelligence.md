# Phase 18.2: MiniMax and Gemini Book Intelligence routing

Book Intelligence resolves each Provider Gateway route independently. A single
durable run may therefore use MiniMax-M3 for `BOOK_CHUNK_ANALYSIS`,
`BOOK_REDUCTION_ANALYSIS`, and `BOOK_SYNTHESIS`, while using Google Gemini
`gemini-embedding-2` for `EMBEDDING`. MiniMax and Gemini can participate in
one Book Intelligence run through purpose-specific Provider Gateway routes.

## Provider responsibilities

MiniMax is a first-class built-in provider (`minimax` / `MiniMax-M3`) with only
the `TEXT_GENERATION` capability. Its endpoint is the provider-owned fixed
`https://api.minimax.io/v1/text/chatcompletion_v2`; workspace configuration
cannot turn it into an arbitrary HTTP client. MiniMax credentials use the
normal encrypted Provider Connection and credential-version flow.

Gemini's active built-in embedding model is `gemini-embedding-2`. Book
Intelligence requests 768 output dimensions through the native Gemini embedding
adapter and rejects missing, non-finite, or wrong-length vectors before durable
persistence. `text-embedding-004` remains a historical identity only; it is
not silently reinterpreted as the current model.

## Lineage and safety

Embedding identity includes provider, model, dimensions, and the existing
version/hash fields. Equal embedding dimensions do not imply equal embedding
spaces. Similarity and retrieval only use matching identity hashes, so historical
Gemini `text-embedding-004` vectors cannot be silently mixed with
`gemini-embedding-2` vectors.

MiniMax uses a JSON prompt contract plus the existing gateway JSON parsing and
Book Intelligence domain/grounding/quote/offset/publication validation. This
phase does not claim native strict JSON Schema support and does not send an
unsupported `response_format` parameter. Only the structurally parsed final
assistant message is consumed; provider reasoning fields are ignored, and no
`<think>` regex stripping is used.

Book Intelligence readiness requires all three text routes and the embedding
route, a compatible catalog model, an active decryptable workspace credential,
and executable endpoint policy. A missing embedding route reports
`BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED`; no provider fallback or historical
vector reuse occurs. Existing route snapshots and credential versions remain
pinned for active durable work and are immutable execution evidence.

## Validation matrix and limitations

Deterministic transport tests cover MiniMax fixed-endpoint/auth/model/message
mapping, final-content-only handling, JSON validation failures, and normalized
upstream failures. Gemini adapter tests cover `gemini-embedding-2`, explicit
768 output dimensionality, and finite vector validation. The Phase 18.2 release
gate also retains Phase 18, Phase 18.1, Provider Gateway/BYOK, W06, and Phase 6
browser coverage.

No real provider credential is used by the release gate. MiniMax speech, image,
video, music, embedding support, automatic provider failover, and mass
re-embedding are intentionally out of scope.
