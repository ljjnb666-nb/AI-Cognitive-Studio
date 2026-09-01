# Phase 13: Personalized Cognition System

The active personal corpus is current Book Intelligence only, scoped by workspace and user. A cognition enters it after the user saves it, starts a Thinking Session, or creates a Teach Back attempt. `ARCHIVED` wins over all prior interactions. Historical records remain audit/history data and never re-enter the active corpus.

`TeachBackAssessment.masteryState` remains the mastery source of truth. `UserCognitionReviewState` is a user-scoped scheduling cache reconciled in the same result-consumption transaction. The `phase13-v1` intervals are deterministic: unassessed `1,2,4,7,14,30`; needs review `1,1,2,3,5,7`; developing `3,5,7,14,21,30`; demonstrated `7,14,30,60,90,120` days, clamped at the final value.

Manual reviews use a client UUID and one durable event. They advance only the schedule, never mastery. Reads and mutations use workspace plus user scope and return private-not-found semantics for inaccessible cognitions.

Cross-book associations compare only current cognitions from different source documents. Both embeddings must share provider, model, model-version semantics, embedding version, and dimensions. Invalid vectors are discarded; deterministic cosine similarity must meet 0.80. Vectors never leave server code, and the association is only `SEMANTICALLY_RELATED`.
