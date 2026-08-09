# ADR 0002: Source identity and immutability

Workspace ownership is explicit through `WorkspaceMember`; `ProjectSource` is the many-to-many link between projects and logical sources. `Work`, `Edition`, and `Source` are separate because an intellectual work, a published edition, and an uploaded file have different identities.

`SourceDocument` is an immutable snapshot. Re-ingestion creates a new document version and never updates source bytes or their SHA-256. `SourceBlob` deduplicates only within a workspace, preventing cross-workspace existence disclosure.
