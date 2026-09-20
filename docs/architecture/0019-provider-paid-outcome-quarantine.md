# Provider paid-outcome quarantine

The Provider Gateway's local `(workspaceId, idempotencyKey)` uniqueness prevents duplicate local invocation rows. It is not a provider-side idempotency guarantee: a remote request may have completed while its response was lost.

Every execution snapshot therefore pins the recovery capability this codebase actually implements. Current adapters are `NONE`; an upstream API feature is not sufficient. A `NONE` paid speech attempt with `REMOTE_OUTCOME_UNKNOWN` must not be replayed automatically.

Podcast Audio records an open, workspace-bound paid-outcome quarantine keyed by its stable semantic audio identity. The quarantine is independent of Job status: capacity can later be released without granting a new paid retry. A normal request observes the gate before deriving a retry generation identity.

Only an OWNER-operated internal service may resolve the gate. `DEFINITIVE_REMOTE_FAILURE` permits a retry on authoritative evidence. `ABANDON_AND_ALLOW_RETRY` requires an explicit risk acknowledgement and reason; it is auditable and never automatic. A durable provider speech result remains the only basis for audio-result recovery; suspected remote success is not product success.
