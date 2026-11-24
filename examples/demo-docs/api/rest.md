# REST API

Base URL: `http://localhost:8080/api`

## Endpoints

### `GET /notes`

Returns a list of notes.

```json
[
  { "id": 1, "title": "Hello", "updated": "2025-01-15T09:30:00Z" },
  { "id": 2, "title": "Ideas", "updated": "2025-01-16T14:05:00Z" }
]
```

### `POST /notes`

```bash
curl -X POST http://localhost:8080/api/notes \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello","body":"First note"}'
```

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid request body |
| `404` | Note not found |
| `429` | Too many requests |
