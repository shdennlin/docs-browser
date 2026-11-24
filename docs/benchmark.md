# Benchmark (PRD 3.1)

Measured by `tests/suite.py` (AC-67) on darwin, release build of the binary at `target/release/docs-browser`.
Workload: 5,000 Markdown files of about 4 KB each, directory depth 6, warm file cache, one run.

| Measure | Target | Measured | Met |
|---|---|---|---|
| Process start to listening | <= 500 ms | 10 ms | yes |
| `GET /api/tree`, first request | <= 1 s | 84 ms | yes |
| `GET /api/tree`, repeat (cached) | <= 50 ms | 2 ms | yes |
| File saved to preview re-rendered | <= 2 s | see the AC-43 row of the suite (about 0.5 s measured) | yes |
| Release binary size | recorded | 8.3 MiB | n/a |

Misses: none.
