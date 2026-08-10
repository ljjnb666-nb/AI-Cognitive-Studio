# ADR 0002: Source identity and immutability

Workspace ownership is explicit through `WorkspaceMember`; `ProjectSource` is the many-to-many link between projects and logical sources. `Work`, `Edition`, and `Source` are separate because an intellectual work, a published edition, and an uploaded file have different identities.

`SourceDocument` is an immutable snapshot. Re-ingestion creates a new document version and never updates source bytes or their SHA-256. `SourceBlob` deduplicates only within a workspace, preventing cross-workspace existence disclosure.

Tenant-sensitive child records duplicate `workspaceId` so PostgreSQL can enforce same-workspace relationships with composite foreign keys. `ProjectSource`, `Edition`, `Source`, and `SourceDocument` use these shared tenant keys; `SourceBlob` remains deduplicated per workspace.

`UploadCompletion` is the authoritative optional one-to-one link from an `UploadSession` to a `SourceDocument`. The former `UploadSession.sourceDocumentId` scalar was removed. Provenance-bearing relations prefer `Restrict` or `NoAction` semantics over blind cascading deletion.

`Job.workspaceId` remains nullable for system jobs. Business `source.ingest` work creates its Job and IngestionRun from the same trusted workspace context. IngestionRun-to-SourceDocument tenant equality is database-enforced; IngestionRun-to-Job tenant equality is currently a service construction invariant because system Jobs may have no workspace.
