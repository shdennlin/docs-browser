# Getting started

## Install

```bash
npm install -g acme-notes
acme-notes init ~/notes
```

## Create your first note

```python
from acme import Client

client = Client("http://localhost:8080")
note = client.create(title="Hello", body="First note")
print(note.id)
```

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `port` | `8080` | HTTP port |
| `data_dir` | `~/notes` | Where notes are stored |
| `sync` | `false` | Enable background sync |

## Next steps

- [ ] Read the [architecture overview](../architecture/overview.md)
- [x] Install the CLI
