# ADR 0003: Ingestion storage and outbox

Original bytes, temporary uploads, and extracted text live in a private S3-compatible store behind `StorageProvider`. Server-side calls use the internal `S3_ENDPOINT`; browser presigned PUT URLs are created by an AWS SDK v3 client configured with `S3_PUBLIC_ENDPOINT ?? S3_ENDPOINT`. Signed URLs are never host-rewritten after signing. PostgreSQL stores metadata, object keys, hashes, parser versions, lifecycle state, and offsets only.

Upload completion treats uploaded bytes as untrusted data, never as instructions. It streams the temporary object once to calculate its actual byte count and server-side incremental SHA-256, retaining only a 64 KiB sniff prefix. The canonical key `workspaces/<workspaceId>/source-blobs/<sha256>` is content-addressed and private. A newly copied canonical object, or an orphan object found at that key, is streamed and verified against the digest and size before any database identity is created. A known corrupt pre-existing canonical object is preserved and fails integrity validation rather than being overwritten.

`getObjectBytes` is transitional compatibility for the current parser input path; upload completion is streaming. Parser streaming, parser isolation, concurrent `SourceBlob` dedupe, and atomic `UploadSession` completion claims remain deferred to later gates.

Completing an upload writes the source document, durable job, ingestion run, and outbox event in one database transaction. A dispatcher later enqueues the deterministic run id in BullMQ, allowing at-least-once dispatch while the processor remains idempotent.
