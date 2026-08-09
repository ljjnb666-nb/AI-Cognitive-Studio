# ADR 0004: Source security and citation grounding

Every uploaded byte sequence is untrusted. Server-side code computes SHA-256, verifies object size and magic bytes, isolates user filenames from storage keys, and parsers make no network calls. URL policy rejects non-HTTPS, credentialed, loopback, link-local, and common private IPv4 targets; a later URL fetcher must add DNS rebinding protection.

`SourcePage`, `SourceBlock`, and validated `SourceSpan` form the permanent grounding model. A retrieval chunk may be added later but is not a permanent citation anchor.
