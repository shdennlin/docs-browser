# Progress ledger

Tracks PRD section 16 tasks and evidence. Run `python3 tests/suite.py` for the live acceptance table.

## M0

| Task | Status | Evidence |
|---|---|---|
| T-0.1 scaffold, pin crates, wildcard + SSE dry run | done | axum 0.8.9 `/{*path}` served `docs/a/b.md`; SSE streamed `data: tick`; `Cargo.toml` pins minor versions |
| T-0.6 fixtures | done | `tests/make-fixtures.sh` builds the tree; symlinks, `.git`, 6 MiB `big.md`, invalid-UTF-8 `utf8-bad.md` verified |
| T-0.7 Makefile | done | `make help`, `make test` exit 0 |
| T-0.2 vendor + checksums | done | `frontend/vendor/` (bun-fetched), `VERSIONS`, `CHECKSUMS`; AC-32 PASS |
| T-0.3 notify spike | done | `docs/spikes/T-0.3.md`: Linux default follows out-of-root symlinks; `follow_symlinks(false)` required; PRD 8.1/8.2/8.5 amended, AC-57 added |
| T-0.4 CSP vs Mermaid | done | `docs/spikes/T-0.4.md`: Mermaid needs `style-src 'unsafe-inline'` |
| T-0.5 package dry run | done | `docs/spikes/T-0.5.md`: 19 files, 1.6 MiB compressed; fixtures need `exclude` |
| T-0.8 canonicalize / case | done | `docs/spikes/T-0.8.md` |
| T-0.9 axum decoding | done | `docs/spikes/T-0.9.md` |
| (extra) host-dependent AC dry run | done | `docs/spikes/host-dependent-acs.md` |
| CP-0 checkpoint | done | `/reviewer:result` run 20261124T061511Z-Ie2og1: PASS, 0 critical, 0 high, 2 medium, 5 low; all 7 verified and handled (F1 and F2 fixed; F3 partly: `--locked` documented; F4 to F7 fixed) |

## PRD amendments (all applied in PRD v1.4.1, 2026-11-24)

1. 12.5: record that `'unsafe-inline'` for `style-src` is required by Mermaid (measured). No wording change to the policy.
2. 12.2 last paragraph: macOS `canonicalize` returns the on-disk spelling; Linux fails with NotFound for case variants (T-0.8). Add Unicode note: compare canonical paths, never raw request strings against `read_dir` names byte-wise on macOS.
3. AC-20: add `/files//a` (RootDir case) (T-0.9).
4. AC-28: Linux has no `lsof`; use `tests/listening.sh` helper that falls back to `/proc/net/tcp`.
5. AC-69: on Linux run with `--user 1000 --sysctl net.ipv4.ip_unprivileged_port_start=1024`; macOS uses plain unprivileged port 80.
6. AC-63 and AC-68: manual on macOS; on Linux assert the warning-and-continue path.
7. 13 intro: Linux browser checks use `docker run --network host`, server stays on `127.0.0.1`.
8. UT-01 to UT-07: case-variant assertions are "denied" only (macOS: OK then blocked; Linux: NotFound).
9. 10.1: pin `rust-version = "1.91"` (notify 9 / debouncer-mini 0.8 require 1.91); package `exclude` for fixtures (T-0.5).

## M1

| Task | Status | Evidence |
|---|---|---|
| T-1.1 `resolve.rs`, `visible()`, whitelist | done | UT-01 to UT-07 PASS on macOS and Linux (uid 1000); mutation checks: removing the canonical-visibility check, the root prefix check, or the case-insensitive ignore compare each fail the matching test |
| T-1.2 `tree.rs` scanner | done | UT-08 to UT-11 PASS on both platforms; removing the cycle rule fails UT-08 |
| CP-1 checkpoint | done | `/reviewer:result` run 20261124T062351Z-YTgFKN: PASS, 0 critical, 0 high, 1 medium, 3 low. All 4 verified and handled: F1 (file-symlink tests added, PRD 12.2 step 7 clarified), F2 (normalisation documented and tested), F3 (Linux-only non-UTF-8 test), F4 (scanner skips non-regular symlink targets, caps asserted). Own review found no bypass. Mutation checks caught: canonical visibility, root prefix, cycle rule, case-insensitive ignore, canonical extension, non-regular target guard (the first FIFO test did not exercise its guard; fixed) |
