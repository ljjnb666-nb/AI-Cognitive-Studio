# ADR 0003: Ingestion storage and outbox

Original bytes, temporary uploads, and extracted text live in a private S3-compatible store behind `StorageProvider`. PostgreSQL stores metadata, object keys, hashes, parser versions, lifecycle state, and offsets only.

Completing an upload writes the source document, durable job, ingestion run, and outbox event in one database transaction. A dispatcher later enqueues the deterministic run id in BullMQ, allowing at-least-once dispatch while the processor remains idempotent.
