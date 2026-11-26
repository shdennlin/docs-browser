# REST API

Base URL: `http://localhost:8080/api`

All bodies are JSON. Authenticate with `Authorization: Bearer <token>`.

## Endpoints

### `GET /notes`

Returns a list of notes. Titles are plain text; bodies are encrypted at rest.

```json
[
  { "id": 1, "title": "Hello", "updated": "2026-11-20T09:30:00Z" },
  { "id": 2, "title": "Ideas", "updated": "2026-11-22T14:05:00Z" }
]
```

### `GET /notes/{id}`

Returns one note. The body is decrypted on the client.

### `POST /notes`

```bash
curl -X POST http://localhost:8080/api/notes \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello","body":"First note"}'
```

### `PUT /notes/{id}`

Replaces the title and body. Returns `409` when the note changed on another device; see [sync conflicts](../changelog.md).

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid request body |
| `401` | Missing or expired token |
| `404` | Note not found |
| `409` | Sync conflict |
| `429` | Too many requests |
