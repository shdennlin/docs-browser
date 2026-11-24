# Architecture overview

Acme Notes is a small service with a web client, an API server and a local store.

## Components

```mermaid
flowchart LR
  Client[Web client] --> API[API server]
  API --> Store[(SQLite)]
  API --> Sync[Sync worker]
  Sync --> Cloud[(Object storage)]
```

## Request flow

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web client
  participant A as API
  U->>W: Save note
  W->>A: PUT /notes/42
  A-->>W: 200 OK
  W-->>U: Saved
```

## Design goals

1. Everything works offline.
2. Notes are plain files that survive the app.
3. The API stays small and predictable.

## Decisions

See [ADR 0001](../adr/0001-use-sqlite.md) for why the index lives in SQLite.
