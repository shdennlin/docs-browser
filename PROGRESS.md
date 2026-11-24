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

## M4

| Task | Status | Evidence |
|---|---|---|
| T-4.1 watcher | done | `watch.rs`: raw notify events, `follow_symlinks(false)`, `Access` events ignored, own quiet-period debounce (200 ms, cap 1 s) |
| T-4.2 state task | done | classifier against the snapshot, aliases, rebuild-then-broadcast, coalescing, failed-rebuild handling; UT-12 to UT-16 PASS on macOS and Linux |
| T-4.3 `/api/events` | done | keep-alive, `resync` on lag, `unavailable`, `bye`, 32-stream cap, graceful shutdown; AC-26b, 50, 51, 56 PASS |
| T-4.4 client | done | EventSource, debounced re-render keeping scroll, iframe reload, removed and restore, reconnect banner; AC-43 to 47, 52 to 54 PASS |
| Platforms | done | macOS: all 20 M4 rows PASS. Linux container: Python/SSE rows and UT PASS; browser rows 23/23 PASS via `tests/linux-browser.sh` (AC-47 shows 5 re-renders on Linux, the limit is 5, so it is borderline; macOS shows 1) |
| Mutation checks | done | macOS: visibility filter, rebuild-before-broadcast, SSE cap, bye, keep-alive each fail their AC. Linux only: `follow_symlinks(true)` fails AC-57; counting access events as changes fails AC-48 |
| Finding worth remembering | | **Linux-only feedback loop**: the server's own directory reads emit inotify access events, and `notify-debouncer-mini` forwarded them, so an idle server rebuilt the tree forever (and never sent a keep-alive). macOS FSEvents has no such events, so macOS passed. Fixed by raw notify events with `Access` ignored; PRD 8.1, 8.2, 10.1 amended (v1.4.6); idle-silence assertion added to AC-48 and AC-57 |
| CP-4 checkpoint | done | `/reviewer:result --base cp4-base` run 20261124T092745Z-2qYBhA: PASS, 0 critical, 0 high, 3 medium, 8 low. Fixed: 503 left the client with a false 'retrying' banner (manual reconnect with backoff); a pending re-render could overwrite 'no longer exists' (cancel on removed, 404 marks missing); deleting a symlink was never classified (listed paths matched); `send_replace` on shutdown; `resync` after a failed rescan rebuild; invisible events dropped in the watcher; the event stream opens before the first fetch; reload postponed while a navigation renders. Not changed: 'Server stopped' being replaced by 'Server unreachable' (follows PRD 8.5 and AC-52). The stale-timer race had no deterministic test at first (it needs a delete about 240 ms after a write, a window of roughly 30 ms). It has one now: AC-45 delivers `changed`, `removed` and `tree` events itself through a fake EventSource, and both fixes (cancel the pending re-render on `removed`; a 404 marks the file missing) are mutation checked. After the fixes AC-47 on Linux dropped from 5 to 2 re-renders. |

## M5

| Task | Status | Evidence |
|---|---|---|
| T-5.1 CLI | done | exit codes 0/1/2, non-loopback WARNING, `--open` (detached, wildcard-safe URL via `browse_url`), `--verbose` (path only, no query), escaped paths in startup/warning/error lines, log writes that never panic, unreadable directory refused with exit 2; AC-26c, 27, 37, 60 to 66, 69 PASS on macOS; 27 unit tests |
| T-5.2 README | done | install from a checkout or a git URL, usage, security model, development |
| T-5.4 benchmark | done | `docs/benchmark.md` (5,000 files: 10 ms start, 84 ms first tree, 2 ms cached, 8.3 MiB binary; no misses) |
| Mutation checks | done | non-loopback warning, exit codes 2 and 1, request log, non-loopback Origin rule, escaped directory name in the startup line, unreadable-directory probe each fail their AC |
| CP-5 checkpoint | done | `/reviewer:result --base cp5-base` run 20261124T094335Z-uz8uhk: PASS, 0 critical, 0 high, 5 medium, 7 low; 11 verified, 1 unverified (`eprintln!` panics on closed stderr, fixed and measured); all 12 handled. Notable: an f-string with a backslash (SyntaxError before Python 3.12) would have broken the whole suite on Linux; AC-37 could not fail until it was given a directory name that tries to forge a log line |

Incident: my first AC-63 and AC-68 implementation assumed the `open` crate looks up `open` on PATH and put a stub first. It calls `/usr/bin/open` by absolute path, so those two runs probably opened two real browser tabs on 127.0.0.1:4111 and :4112 (dead URLs). The checks are now opt-in on macOS (`DOCS_BROWSER_SUITE_OPEN=1`).

## T-5.3 final runs

- A full macOS run found one failure that single-milestone runs had hidden: AC-26c started its `--host 0.0.0.0` server on 4101, which the AC-25 include-hidden server still held, so the request reached the loopback-mode server and got 403. AC-26c and AC-27 now use ports of their own (4118, 4119); PRD v1.4.10.
- Linux: `rust:1` container, uid 1000, `--sysctl net.ipv4.ip_unprivileged_port_start=1024` (needed for AC-69), container-local copy of the repo. Non-browser rows run in the container; the 23 browser rows run through `tests/linux-browser.sh` (server in the container, `--network host`, Chrome on the host); AC-16 runs in `node:22-slim` (pulled with the user's approval) because `rust:1` has no node.

## T-5.3 single-container Linux run, and D11

The goal's closing check asks for the Linux half in one Docker run. `tests/linux-suite.sh` does that: one `rust:1` container builds the project as uid 1000, installs Chromium with apt (approved by the user), takes the node 22 binary from the approved `node:22-slim` image, runs `make test` and the whole suite. Its first run gave 84 PASS and 1 FAIL (AC-06).

**Finding:** Chromium 156 sends `Origin: null` (with `Sec-Fetch-Site: cross-site`, mode `no-cors`) when a sandboxed HTML preview loads its own CSS, scripts and images. The strict Origin rule of PRD 12.1 answered 403, so those assets broke. Every earlier browser run used Google Chrome 158 on macOS, which does not send it. The fix relaxes a security rule, so the user was asked and approved option A: D11, `Origin: null` accepted for GET and HEAD on `/files/*` only; `/api/*` and the event stream stay strict. AC-26a and AC-26b test both directions and were mutation checked.

## Final whole-project review and release 0.1.2

`/reviewer:result` on everything except the vendored libraries (base: the vendor commit), run 20261124T151644Z-0OLIna: PASS, 0 critical, 0 high, 1 medium, 8 low, all 9 verified. Handled:

- MEDIUM tags predating D11: released 0.1.2 (carries D11 and the fixes below); README names `v0.1.2`.
- LOW: release profile of PRD 10.1 added to `Cargo.toml`; unused `anyhow` and `tokio-stream` removed; a literal `+` in `?file=` stays a plus; a tree update no longer re-opens folders the user closed; a rescan runs once the watcher is registered; only an `http://` origin counts as same-origin; watcher and rebuild error text is escaped.
- LOW not changed: classifying a removed directory is O(removed paths x aliases) on the single state task, which only matters for very large deletions. Accepted; a fix would collapse removed paths to their topmost ancestor.

## T-5.5 (release and rollback), final form

`tests/release-check.sh v0.1.1 v0.1.2`: installs each tag from this repository with `cargo install --locked --git file://... --tag`, runs the smoke subset (AC-01, 07a, 20, 21, 25) against the installed binary, then rolls back by installing `v0.1.1` over `v0.1.2` and runs the subset again. Result: v0.1.1 installs as 0.1.1 (5/5), v0.1.2 installs as 0.1.2 (5/5), rollback gives 0.1.1 again (5/5). The earlier pair `v0.1.0` and `v0.1.1` passed the same check before D11. Tags are local only: `v0.1.0`, `v0.1.1`, `v0.1.2`.

## Final runs on the tagged tree (v0.1.2)

- `make test`: macOS exit 0 (27 Rust tests, vendor selftest, 7 node tests); Linux container exit 0 (28 Rust tests, same checks).
- Full PRD 13 suite: macOS 85/85 (`DOCS_BROWSER_SUITE_OPEN=1`, `--write-benchmark`); Linux 85/85 in one container (`tests/linux-suite.sh`).
- Side effect to know about: the two macOS `--open` checks (AC-63, AC-68) ask the OS to open a browser tab each time they run.
