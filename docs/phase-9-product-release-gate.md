# PHASE9_PRODUCT_RELEASE_GATE

Phase 9 makes the existing workspace BYOK Gateway usable from the authenticated
Studio product. An owner opens **AI Providers** in account settings, creates a
provider connection, submits a credential, and binds each required route slot.
Credentials are encrypted with the server-only `PROVIDER_GATEWAY_KEYRING`; the
browser and settings API receive only existence, status, and a display hint.

The manifest in `PROVIDER_GATEWAY_MODEL_MANIFEST` is server-side authority for
providers, models, protocols, and capabilities. Route bindings cover Book
chunk/reduction/synthesis, embeddings, podcast script/TTS, and short-video
script/TTS. A book's three text bindings must share provider, model, and model
version. There is no platform credential or global-environment provider fallback.

Process environment can still enable a Worker domain for deployment backward
compatibility. It cannot select the durable provider/model stamped on a new
Book, Podcast, Podcast Audio, or Short Video run: that identity is derived from
the authenticated workspace route binding.

Podcast TTS requires explicit `hostVoices` on the `PODCAST_TTS` route
configuration. Each host ordinal needs `providerVoiceId`, `voiceVersion`,
`speakingRate`, `pitch`, and `outputFormat` (currently `wav`); optional style
and language are safe configuration. There is no hidden voice fallback.
Short-video TTS continues to use its accepted route configuration shape.

Upload and ingestion remain usable before provider setup. When Book readiness is
incomplete, the product directs the user to provider setup without issuing a
paid call. Failed Book and Podcast Audio requests remain visible and expose an
explicit retry, never an automatic paid retry loop.
