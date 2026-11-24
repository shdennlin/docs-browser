# Benchmark (PRD 3.1)

Measured by `tests/suite.py` (AC-67) on darwin, release build `docs-browser`.
Workload: 5,000 Markdown files of about 4 KB each, directory depth 6, warm file cache, one run.

| Measure | Target | Measured | Met |
|---|---|---|---|
| Process start to the first response | <= 500 ms | 138 ms | yes |
| `GET /api/tree`, first request | <= 1 s | 4 ms | yes |
| `GET /api/tree`, repeat (cached) | <= 50 ms | 6 ms | yes |
| File saved to preview re-rendered | <= 2 s | measured by the AC-43 row of the suite | see AC-43 |
| Release binary size | recorded | 8.4 MiB | n/a |

Misses: none.
