# Phase 17 — Closed Beta

Set `BETA_ACCESS_MODE=ENFORCED` for a real Closed Beta deployment. The default is `OFF`, which preserves Phase 1–16 behavior. In enforced mode, an authenticated account must have an ACTIVE `BetaParticipant` before Studio identity resolution and personal-workspace provisioning can occur. Authentication, health, and `/beta/access` remain available.

## Operations

Bootstrap an existing account only: `pnpm beta:operator -- --email existing-user@example.com`. This never creates an authentication account. Operators create high-entropy (32-byte) codes through the internal operating path; only SHA-256 digests are stored, and raw codes must be displayed once without logging, URLs, or browser persistence. Redeeming requires affirmative consent (`phase17-beta-consent-v1`), and expired, revoked, used, or invalid codes return the same safe error.

Participants may withdraw. Withdrawal blocks later Studio access in enforced mode and deletes first-party `ProductEvent` and `BetaFeedback` records. It deliberately does not delete account, source, workspace, or other core product data.

## Telemetry and feedback

Telemetry is first-party PostgreSQL only. Server-derived participant, user, and workspace identity prevent spoofing. The event taxonomy is `phase17-events-v1`: Studio session start and podcast start/25/50/75/90/end (plus checklist view/dismiss). Event retries are idempotent by participant and client event ID. Event properties are allowlisted and capped at 2 KB; they cannot carry source text, prompts, credentials, headers, or model output.

Podcast milestones are emitted only by normal `timeupdate` progress; while seeking, milestones are suppressed. Completion is a unique participant/audio pair that started and reached 90% or ended. Feedback is optional and user-authored; it may include a 1–5 naturalness or value rating and is operator-only.

## Metric definitions and limitations

Metrics version is `phase17-metrics-v1`, calculated with explicit `asOf`. Activation is the later of safely user-attributed successful Book Intelligence and first value (podcast 25%, saved Cognition, completed Thinking, or assessed Teach Back). D1 is `[activation+24h, activation+48h)`; D7 is `[activation+168h, activation+192h)`. Only fully matured windows enter the denominator. Small samples show raw numerators/denominators and must not be interpreted as statistically significant, causal, or real-user conclusions. Synthetic fixtures validate computation only; runtime metrics query the real database.
