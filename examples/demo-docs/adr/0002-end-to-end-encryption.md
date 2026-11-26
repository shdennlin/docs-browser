# ADR 0002: End-to-end encryption for note bodies

- **Status:** Accepted
- **Date:** 2026-03-14
- **Supersedes:** none

## Context

Users store private journals in Acme Notes. The sync worker uploads note bodies to object storage, and the operator should not be able to read them.

## Decision

Encrypt each note body on the client with XChaCha20-Poly1305. The per-notebook key is derived from the user's passphrase with Argon2id. Titles stay in plain text so search by name keeps working.

## Consequences

- Losing the passphrase means losing the notes; the recovery kit is shown once at sign-up.
- Full-text search over bodies runs on the device, not on the server.
- Sync payloads grow by about 3 percent because of nonces and tags.
