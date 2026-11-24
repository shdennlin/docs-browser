# ADR 0001: Use SQLite for the note index

- **Status:** Accepted
- **Date:** 2025-01-10

## Context

We need fast full-text search over thousands of notes without running a separate server.

## Decision

Store the search index in a single SQLite file next to the notes.

## Consequences

- Zero-config deployment.
- Single-writer limit is acceptable for a personal tool.
