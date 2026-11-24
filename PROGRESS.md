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

## M2

| Task | Status | Evidence |
|---|---|---|
| T-2.0 minimal main, AppState | done | AC-01, AC-28 PASS on macOS and Linux |
| T-2.1 routes and status codes | done | AC-02, 03a, 11, 12a, 13a, 14a, 24, 29, 35 PASS |
| T-2.2 headers | done | AC-07a, 30, 31 PASS |
| T-2.3 Host/Origin | done | AC-26a PASS |
| T-2.4 security via HTTP | done | AC-20 to 23, 25, 33, 34, 36 PASS |
| Mutation checks | done | removing: sandbox CSP, Host allowlist, Origin check, 5 MiB cap, 415 mapping, nosniff each fails exactly its AC |
| Platforms | done | macOS (rustc 1.95.0) and Linux uid 1000 in Docker (rustc 1.100.0, no lsof): 24/24 |
| CP-2 checkpoint | done | `/reviewer:result` run 20261124T063348Z-gBTz3g: FAIL on first pass (1 high, 2 medium, 5 low; 8 verified, 0 refuted). HIGH = my own regression: a slice edit deleted `cargo_unit_test` from tests/suite.py so UT rows crashed (reproduced, restored). MEDIUM: `/api/file` read now bounded with `take(MAX+1)`; header middleware moved outermost so the Host/Origin 403 carries security headers. LOW: `frame-ancestors 'none'` added, `/files` stream bounded to the opened length, boundary tests added (exactly 5 MiB = 200, +1 byte = 413; tree cap counts ~50,000 files and the normal tree is not marked truncated). Symlink-swap race left as is: accepted risk R9 in the PRD. Mutation checks for the fixes pass. |

## M3

| Task | Status | Evidence |
|---|---|---|
| T-3.1 lib.js | done | `node --test frontend/*.test.js`: 7 pass (AC-16) |
| T-3.2a/b/c, T-3.3 frontend | done | 16 M3 criteria PASS on macOS (Chrome, headless, CDP) via `python3 tests/suite.py --milestone M3`; 15 of them PASS against a Linux container server via `tests/linux-browser.sh` (AC-16 is node only) |
| T-3.4 headless Chrome script | done | `tests/browser.mjs` (no extra packages) |
| Mutation checks | done | 9 frontend mutations each fail exactly their AC |
| CP-3 checkpoint | done | `/reviewer:result --base cp3-base` run 20261124T090059Z-ZJWAMO: PASS, 0 critical, 0 high, 2 medium, 5 low; all 7 verified true and fixed: anchor scroll waits for images; navigation resets scroll and the `wide` layout; slugs come from rendered text; heading ids prefixed `user-content-`; test header and AC-40 race fixed. My first scroll-reset assertion was vacuous (a short file lets the browser clamp the offset); replaced by re-opening the long file, mutation now caught. |

Docker leftovers to remove when finished: volumes `docs-browser-cargo` and `docs-browser-target`.

## M4 (work done, CP-4 pending)

| Task | Status | Evidence |
|---|---|---|
| T-4.1 watcher | done | `watch.rs`: raw notify events, `follow_symlinks(false)`, `Access` events ignored, own quiet-period debounce (200 ms, cap 1 s) |
| T-4.2 state task | done | classifier against the snapshot, aliases, rebuild-then-broadcast, coalescing, failed-rebuild handling; UT-12 to UT-16 PASS on macOS and Linux |
| T-4.3 `/api/events` | done | keep-alive, `resync` on lag, `unavailable`, `bye`, 32-stream cap, graceful shutdown; AC-26b, 50, 51, 56 PASS |
| T-4.4 client | done | EventSource, debounced re-render keeping scroll, iframe reload, removed and restore, reconnect banner; AC-43 to 47, 52 to 54 PASS |
| Platforms | done | macOS: all 20 M4 rows PASS. Linux container: Python/SSE rows and UT PASS; browser rows 23/23 PASS via `tests/linux-browser.sh` (AC-47 shows 5 re-renders on Linux, the limit is 5, so it is borderline; macOS shows 1) |
| Mutation checks | done | macOS: visibility filter, rebuild-before-broadcast, SSE cap, bye, keep-alive each fail their AC. Linux only: `follow_symlinks(true)` fails AC-57; counting access events as changes fails AC-48 |
| Finding worth remembering | | **Linux-only feedback loop**: the server's own directory reads emit inotify access events, and `notify-debouncer-mini` forwarded them, so an idle server rebuilt the tree forever (and never sent a keep-alive). macOS FSEvents has no such events, so macOS passed. Fixed by raw notify events with `Access` ignored; PRD 8.1, 8.2, 10.1 amended (v1.4.6); idle-silence assertion added to AC-48 and AC-57 |
| CP-4 checkpoint | pending | |
