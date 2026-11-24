# Benchmark (PRD 3.1)

Measured by `tests/suite.py` (AC-67) on darwin, release build `docs-browser`.
Workload: 5,000 Markdown files of about 4 KB each, directory depth 6, warm file cache, one run.

| Measure | Target | Measured | Met |
|---|---|---|---|
| Process start to the first response | <= 500 ms | 95 ms | yes |
| `GET /api/tree`, first request | <= 1 s | 2 ms | yes |
| `GET /api/tree`, repeat (cached) | <= 50 ms | 1 ms | yes |
| File saved to preview re-rendered | <= 2 s | measured by the AC-43 row of the suite | see AC-43 |
| Release binary size | recorded | 7.8 MiB | n/a |

Misses: none.
