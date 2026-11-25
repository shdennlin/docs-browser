# Local Docs Browser — PRD (v1.4)

## 0. Revision Notes

| Version | Change |
|---|---|
| v1.1 | Sandboxed iframe, symlink-safe path resolution, deep-link URLs |
| v1.2 | Architecture switched to Rust (axum + notify + clap + rust-embed) |
| v1.3 | Target user and platforms, risk register, Host/Origin validation, `/files/*` sandbox header, acceptance criteria, task breakdown |
| v1.4 | `/files/*` serves an **extension whitelist** only; visibility checked on both the requested and the canonical path and compared case-insensitively; one coherent symlink policy (followed, listed, watched, aliased); event pipeline rebuilt as *update state, then broadcast*; every acceptance criterion owned by exactly one milestone; unit tests separated from acceptance criteria; decisions D1 to D10 |
| v1.4.1 (2026-11-24) | T-0.3 findings: `follow_symlinks(false)` is required on Linux, real-path events make `aliases` mandatory, ignored directories may still be watched (8.1); debouncer limits, directory detection, `Rescan` API (8.2); drop the watcher on any initial `watch()` error (8.5); new AC-57. Earlier in this revision, M0 measurements folded in: `style-src 'unsafe-inline'` is required by Mermaid (12.5); macOS `canonicalize` returns the on-disk case and APFS keeps the stored Unicode form (12.2); pinned crate versions, `rust-version`, package `exclude` (10.1); `/files//a` added to AC-20; Linux-specific variants for AC-28, AC-63, AC-68, AC-69 and a Linux-run recipe in 13 |
| v1.4.2 (2026-11-24) | M1: directory scan uses `std::fs::read_dir`; `walkdir` removed (10.1, 10.3); resolver steps 3 and 7 clarified (lexical normalization, extension checked on listed name and canonical target, non-regular files denied) |
| v1.4.3 (2026-11-24) | CP-2: app-shell CSP gains `frame-ancestors 'none'` (12.5); every response, including the Host/Origin 403, carries the security headers (11); `/api/file` bounds the read itself and `/files/*` bounds the stream to the opened length (11); `tower-http` and `mime_guess` dropped (fixed MIME table, one header middleware); `rust-embed` needs its `include-exclude` feature to keep vendor bookkeeping files out of the binary (10.1) |
| v1.4.4 (2026-11-24) | M3: frontend tests run as `node --test frontend/*.test.js` (Node 22 treats `node --test frontend/` as a file path, not a directory); client-side link classification uses the tree for Markdown/HTML targets and leaves dot-prefix visibility of assets to the server (6) |
| v1.4.5 (2026-11-24) | CP-3: heading ids are prefixed `user-content-`, slugs come from rendered text, navigation resets scroll and layout, anchor scroll waits for images (6, AC-42) |
| v1.4.6 (2026-11-24) | M4: `notify-debouncer-mini` replaced by raw `notify` events with an `Access`-event filter and an own quiet-period debounce, after a Linux-only self-triggering rebuild loop (8.1, 8.2, 10.1); AC-48 and AC-57 check that an idle server is silent |
| v1.4.7 (2026-11-24) | CP-4: deleting a symlink is classified; `resync` on every rescan; late SSE streams see shutdown; invisible paths filtered in the watcher; client reconnects by hand when the browser gives up, connects before the first fetch, cancels a pending re-render on `removed` (8.2, 8.3, 8.5) |
| v1.4.8 (2026-11-24) | M5: `--open` checks run on macOS only with `DOCS_BROWSER_SUITE_OPEN=1` (the opener cannot be intercepted: the `open` crate calls `/usr/bin/open` by absolute path); the browse URL is a pure function with a unit test (AC-63, AC-68); README added |
| v1.4.9 (2026-11-24) | CP-5: unreadable directory exits 2; startup, warning and error paths are escaped; log writes ignore a closed stderr; `--verbose` omits the query string; `--open` uses a detached opener; AC-37, 60, 67, 69 strengthened; README install path (9.1, 9.3, 13) |
| v1.4.10 (2026-11-24) | AC-26c and AC-27 use ports of their own: a shared port made AC-26c fail in a full run only (13) |
| v1.4.11 (2026-11-24) | D11, approved by the user: `Origin: null` is accepted for GET and HEAD on `/files/*` only, because Chromium 156 sends it for the assets of a sandboxed HTML preview and the strict rule broke them; found only when the suite ran with Chromium inside the Linux container (12.1, 15, AC-26a, AC-26b) |
| v1.4.12 (2026-11-24) | AC-45 also runs two interleavings deterministically, with the test delivering `changed`, `removed` and `tree` events itself through a fake EventSource: a pending re-render must not overwrite "no longer exists", and a 404 must mark the file missing so a later `tree` event restores it (8.4, 8.5) |
| v1.4.13 (2026-11-24) | Final whole-project review: the release profile of 10.1 is now in `Cargo.toml`; unused `anyhow` and `tokio-stream` removed; a literal `+` in `?file=` stays a plus (5); folders the user closed are not re-opened by a tree update, ancestors open on navigation only (5); a rescan runs once the watcher is registered, so changes during the first scan are not lost (8.1); only an `http://` origin counts as same-origin (12.1); watcher and rebuild error text is escaped (9.3); release 0.1.2 carries D11 |
| v1.4.14 (2026-11-24) | Resizable sidebar added on request: drag, keyboard, double click, 180 px to 60% limits, remembered in `localStorage` (5, AC-70, T-3.5) |
| v1.4.15 (2026-11-24) | Sidebar review fixes: a drag follows one pointer and also ends on lost capture and window blur; no jump at the grab point; the chosen width survives a smaller window; a stored value must be a strict integer; AC-70 checks all of it (5) |
| v1.4.16 (2026-11-24) | Added on request: Dracula theme in dark mode (page, Markdown, code, Mermaid, rainbow headings), `MD`/`HTML` badges, expand/collapse all, file name filter and full-text search (`GET /api/search`, 7.3, 11), default port 4747 instead of 3000 (4 browser ACs, 2 unit tests, T-3.6) |
| v1.4.17 (2026-11-25) | Release 0.1.3: includes everything of v1.4.14 to v1.4.16 (sidebar, theme, search, badges, expand/collapse, default port 4747); `Cargo.toml` and the README install tag updated |
| v1.4.18 (2026-11-25) | Added on request: per-folder expand/collapse buttons, wrap toggle, HTML fills the right panel, floating outline, settings dialog (7.3, 7.4; AC-75, T-3.7) |
| v1.4.19 (2026-11-25) | Outline entries use the heading colours and the current section is highlighted; folder icons; fix: selecting a file no longer scrolls the list sideways when names do not wrap (7.3, 7.4; AC-75) |
| v1.4.20 (2026-11-25) | Light/dark toggle button (remembered; reset follows the system again) and lighter quote text, 7:1 contrast (6 Theme; AC-76) |
| v1.4.21 (2026-11-25) | The list controls fit on one line: expand all, collapse all and wrap became icon buttons (7.3; AC-75) |
| v1.4.22 (2026-11-25) | Fix: the search box and buttons no longer scroll away with a sideways-scrolled list (they sit outside the scrolling part); buttons wrap at 180 px (7.3; AC-75) |
| v1.4.23 (2026-11-25) | File name search is fuzzy, ranked and shows full paths (7.3; AC-73); the outer panel snaps back if a browser scrolls it (AC-75) |
| v1.4.24 (2026-11-25) | Fix: contents links to headings with an emoji selector (`🛡️`, `🕵️`) did not jump; the anchor lookup now ignores U+FE0E/U+FE0F/U+200D and leading hyphens (7.4; AC-77) |
| v1.4.25 (2026-11-25) | Copy file name button (7.4; AC-78) |
| v1.4.26 (2026-11-25) | The current outline entry loses its coloured left border; background and bold remain (7.4; AC-75) |
| v1.4.27 (2026-11-25) | Contents links to missing headings are struck through and inert (7.4; AC-79) |
| v1.4.28 (2026-11-25) | Folder buttons sit right after the folder name; every file and folder has a tooltip with its full path; with Wrap off names are shown in full and the list scrolls sideways (an ellipsis variant was tried and dropped on request) (7.3; AC-75) |
| v1.4.29 (2026-11-25) | Mermaid text is re-coloured per node when a diagram's own fill makes the theme's text unreadable (below 4.5:1), in both themes (6 Mermaid; AC-80) |
| v1.4.30 (2026-11-25) | Expand/collapse icons are SVG line icons (two chevrons apart; framed box with a minus) in the text colour, the same in the toolbar and on folders (7.3; AC-72) |
| v1.4.31 (2026-11-25) | In-page tabs (command/control click, middle click), keyboard shortcuts with a help dialog (7.5; AC-81, AC-82); layout: theme and settings buttons in a bottom bar, the Names/Contents switch inside the search box (7.3; AC-83) |
| v1.4.32 (2026-11-25) | The active tab is marked by an underline (reference look) and idle tabs hide their `×`; a `?` shortcuts button at the bottom left of the list (7.3, 7.5; AC-83) |
| v1.4.33 (2026-11-25) | Release 0.1.4: includes everything of v1.4.18 to v1.4.32 (Mermaid contrast, fuzzy file name search, copy file name, dead contents links, tabs and keyboard shortcuts, light/dark toggle, bottom bar, settings dialog and the other list and outline refinements); the Linux container suite passes all 101 rows; `Cargo.toml` and the README install tag updated |
| v1.4.34 (2026-11-25) | Dark Mermaid: every plain flowchart node and every sequence-diagram participant gets its own Dracula accent (tinted fill, accent border); nodes the diagram styled itself and the light theme are unchanged (7.4; AC-84; AC-80 no longer expects plain nodes to share one colour) |
| v1.4.35 (2026-11-25) | Full-screen Mermaid viewer: a button on every diagram opens it over the page; drag pans, the wheel zooms around the pointer, `Esc` closes (7.4; AC-85) |
| v1.4.36 (2026-11-25) | Release 0.2.0: includes v1.4.34 (dark Mermaid accents) and v1.4.35 (full-screen Mermaid viewer) on top of 0.1.4, plus the README screenshots and the demo docs; `Cargo.toml` and the README install tag updated |
| v1.4.37 (2026-11-25) | The running server's version is shown at the right end of the bar at the bottom of the file list, from the new `GET /api/version` (7.3, 11; AC-86); the README install command uses the real GitHub URL |
| v1.4.38 (2026-11-25) | A status bar under the preview shows the created and modified times and, inside a git repository, the branch, the last commit of the file and whether it has uncommitted changes, from the new `GET /api/info` (7.3, 11; AC-87, UT-19, UT-20); the diagram's full-screen button is a text glyph instead of an `<svg>` (7.4; fixes AC-04); AC-71 follows the dark accents |
| v1.4.39 (2026-11-25) | Release 0.3.0: includes v1.4.34 to v1.4.38 (dark Mermaid accents, full-screen Mermaid viewer, version in the footer, file information bar). Security: `GET /api/info` no longer runs `git status`, which executes a repository's configured clean filters; `dirty` is computed with filter-free commands (UT-21). `Cargo.toml` and the README install tag updated ; the Linux container suite passes all 108 rows |
| v1.4.40 (2026-11-25) | `--open` is the default (`--no-open` turns it off); without `--port`, a busy 4747 moves to the next free port from 4748 to 4766 with a note, an explicit busy port is still an error (9, 9.1; AC-64, AC-88, UT-22); the tests pass `--no-open` |
| v1.4.41 (2026-11-25) | `docs-browser <file.md>` serves the nearest enclosing git repository (or the file's folder), opens that file with `?file=`, and prints the root and the URL (9, 9.1; AC-60, AC-89, UT-23, UT-24) |
| v1.4.45 (2026-11-25) | Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`) and PDF are listed in the tree with `IMG`/`PDF` badges and shown directly (7.3, 7.4; AC-95, AC-96, UT-27, UT-28); PDF is added to the `/files/*` whitelist; the file argument, search and `/api/file` keep their document-only rules |
| v1.4.44 (2026-11-25) | Expanded folders are remembered per served root in `localStorage` (7.3; AC-92, UT-26); the file information bar links to the file in VS Code on loopback (7.3; AC-93, AC-94); `/api/version` returns `rootKey`; `/api/info` returns `absolutePath` on loopback only |
| v1.4.43 (2026-11-25) | `--ignore NAME` (repeatable) hides exact names at any depth and only adds to the built-in list (9.1, 7.1; AC-91, UT-25); an HTML file argument is accepted, because the startup check uses the `/files/*` whitelist; code-copy button on code blocks (7.4; AC-90); §14 and D3/D4 record the decisions not taken |
| v1.4.42 (2026-11-25) | Release 0.4.0: includes v1.4.40 (browser opens by default, `--no-open`; a busy default port moves to the next free one) and v1.4.41 (a file argument serves its git repository and opens the file) on top of 0.3.0; `Cargo.toml`, `Cargo.lock` and the README install tag updated |

Review basis: two `/reviewer:spec` rounds (logs under `.claude/reviewer/runs/`, not versioned with this file). Findings are not cited by ID in this document.

## 1. Product Overview

A lightweight local web server for browsing and previewing project documentation.

The tool scans a target directory and provides:

- A file tree on the left
- A preview panel on the right
- Markdown rendering
- Mermaid diagram rendering
- Raw HTML rendering (sandboxed)
- Live reload when files change
- Shareable deep-link URLs for every file

Primary use case:

```bash
docs-browser .
```

Then open `http://127.0.0.1:4747` (the exact URL is printed at startup). The default port is 4747 because 3000 and the other usual dev-server ports are often taken; `--port` overrides it.

### 1.1 Target user, platforms and browsers

- **Target user:** a developer reading documentation in their own local repository, on their own machine, as a single user.
- **Supported platforms (MVP):** macOS and Linux. Both are verified by running the full acceptance suite (T-5.3). Windows is **not supported** (see §14).
- **Browsers:** current Chrome is the verification target. Safari and Firefox are best effort and not verified.
- **Not a target:** serving documentation to other people, hosting on a shared machine, or exposing a directory to a network.

## 2. Problem

Developers often have documentation scattered across a repository:

```text
project/
├── README.md
├── CLAUDE.md
├── docs/
│   ├── architecture.md
│   ├── flow.html
│   └── api.md
└── plans/
    └── migration.md
```

Existing tools usually focus on only one use case: Markdown preview only, static HTML serving only, full documentation-site generation, or manual sidebar configuration. The goal is a zero-config local viewer for existing files.

**Evidence from trying existing tools** (hands-on, 2026-11-24, on a fixture folder with `.md`, Mermaid and `.html` files):

- `gh-markdown-preview`: renders Markdown and Mermaid and live-reloads, but has no file tree, serves `.html` as an unsandboxed same-origin page, and follows a symlink pointing outside its root (it served `/etc/hosts`).
- `meread` 1.0.1: in directory mode serves only `README.md`; other paths return 404, Mermaid is shown as code, relative images 404, and `.html` is treated as Markdown.

## 3. Goals

The MVP should allow users to:

1. Start the server with one command.
2. Automatically scan the current directory.
3. Browse files using a collapsible folder tree.
4. Render `.md` files as formatted Markdown.
5. Render Mermaid blocks inside Markdown.
6. Render `.html` files as normal web pages, safely isolated.
7. Automatically refresh previews when files change.
8. Open any file directly by URL, and restore it on page refresh.

### 3.1 Measurable targets

Measured by task T-5.4. Conditions: release build, Apple-silicon Mac, SSD, warm file cache, 5,000 files of at most 20 KB each, directory depth at most 6. A miss is recorded and does not by itself block the MVP.

| Target | Value |
|---|---|
| Process start to listening | ≤ 500 ms |
| `GET /api/tree`, first request | ≤ 1 s |
| `GET /api/tree`, repeat request (cached) | ≤ 50 ms |
| File saved to preview re-rendered | ≤ 2 s |
| Release binary size | recorded, no limit (dominated by Mermaid) |

## 4. Non-Goals

The MVP does not provide:

- Documentation publishing, static-site export, or hosting for other people
- Authentication, TLS/HTTPS, or multi-user access
- Any write operation: editing, uploading, deleting, renaming
- Git integration
- Full IDE functionality, a search index, regular expressions, fuzzy matching of file contents (file names are fuzzy, 7.3), or a plugin system
- Preview of file types other than Markdown and HTML
- Windows support
- A configuration file or environment-variable configuration (CLI flags only)
- Polling fallback when the OS file watcher is unavailable
- Supporting `--host 0.0.0.0` as a safe mode. It works, but it is an explicitly unsafe mode (§4.1)

### 4.1 Risk register

| # | Risk | Blast radius | Mitigation / acceptance |
|---|---|---|---|
| R1 | Server bound to a non-loopback address | Every readable file under the root is readable by anyone on that network, and `Host` validation is off | Warn at startup (§9.2). **Accepted**: the user opted in. Origin check stays on (§12.1); whitelist and hidden rules still apply |
| R2 | DNS rebinding | A remote page reads the served directory through the loopback server | `Host` and `Origin` validation (§12.1). **Accepted** for non-loopback binds (R1) |
| R3 | An HTML file's script reads other files | Whole served root | `/files/*` sent with `Content-Security-Policy: sandbox`, plus iframe `sandbox` (§6, §12.4) |
| R4 | Symlink, `..` or case-variant escape | Files outside the root, or ignored folders | Canonical-path check, both-path visibility, case-insensitive comparison (§12.2, §12.3) |
| R5 | Secrets inside the root | Credentials | Whitelist of served extensions (§7.1); hidden and ignored paths unreadable by default. **Residual, accepted**: a whitelisted file (e.g. `.md`) containing a secret is served |
| R6 | XSS through Markdown or Mermaid | Same origin as the app shell | Raw HTML off, link-scheme allowlist, Mermaid `strict`, app-shell CSP (§6, §12.5) |
| R7 | Tampered vendored JavaScript | Everything the app shell can do | Pinned versions plus SHA-256 checked by a test (§12.6) |
| R8 | Scanner or watcher exhausts resources | Local slowdown | Entry cap, depth cap, ignored folders never scanned or watched (§7, §8) |
| R9 | Swap-to-symlink race between resolution and open | One out-of-root file read | **Accepted**: needs a local attacker with write access to the root |
| R10 | A sandboxed HTML page makes outbound network requests | The page's own content can be sent out; it cannot read other served files | **Accepted**: the page is user-supplied and could do so in any browser |
| R11 | OS watcher limits (inotify watch limit, FSEvents differences) | Live reload silently stops | Detect and tell the user: live reload disabled banner (§8.5) |
| R12 | Browsers allow about 6 HTTP/1.1 connections per host; each tab holds one SSE stream | Many tabs on one server can stall requests | **Accepted**; server caps SSE streams at 32 (§8.3) |
| R13 | Dev-use assumption: someone runs it on an untrusted multi-user machine | Other local users can reach the port | Out of target (§1.1); documented |

## 5. User Experience

### Start server

```bash
docs-browser .
docs-browser ./docs --port 8080
```

### UI

```text
┌─────────────────────┬──────────────────────────────┐
│ Files               │ Preview                      │
│                     │                              │
│ ▼ project           │ # Architecture               │
│   README.md         │                              │
│   CLAUDE.md         │ Web → API → Database        │
│   ▼ docs            │                              │
│     architecture.md │                              │
│     flow.html       │                              │
│     api.md          │                              │
│   ▼ plans           │                              │
│     migration.md    │                              │
└─────────────────────┴──────────────────────────────┘
```

Clicking a file updates the preview without reloading the entire application.

### Sidebar width

The width of the file list can be changed by dragging the divider between the list and the preview (mouse or touch). The divider is also a keyboard control: focus it, then Left and Right change the width by 16 px (48 px with Shift) and Home restores the default. A double click restores the default of 300 px. The width stays between 180 px and 60% of the window, even when the window is resized, and is remembered in the browser's `localStorage` (key `docs-browser.sidebarWidth`). A stored value is used only if it is exactly a plain integer of two to four digits (no spaces, sign or leading zero) and is then clamped to the limits; anything else gives the default. The width the user chose is kept when the window shrinks and comes back when it grows again. A drag follows one pointer, moves the divider by exactly the distance the pointer moved, and ends on release, cancel, lost pointer capture or the window losing focus. While dragging, the preview iframe cannot swallow the mouse. Added after the first release plan, on request, 2026-11-24 (AC-70, T-3.5).

### Deep-link behaviour

- Selecting a file updates the address bar, e.g. `http://127.0.0.1:4747/?file=docs/architecture.md`.
- Opening that URL (or pressing refresh) loads the app with that file already selected and previewed.
- The sidebar auto-expands all ancestor folders of the selected file and highlights it.
- Browser Back/Forward move between previously viewed files.
- Heading anchors use the URL hash: `/?file=docs/architecture.md#data-flow` scrolls to that heading.
- File names with spaces, CJK or other non-ASCII characters work; the `file` value is percent-encoded in the URL.

### Path identity

Everywhere a file path appears (tree, `?file=`, API, SSE events) it is the **listed path**: the path as it appears in the tree, relative to the root, using `/`. A file reachable through an in-root symlink has one listed path per route (e.g. `docs/a.md` and `link-in/a.md`). Events for such a file are delivered for every listed path (§8.2).

## 6. File Rendering

### Markdown

Supported: `.md`, `.markdown` (extension matched case-insensitively). Files are read as UTF-8; invalid bytes are replaced and a banner "File contained invalid UTF-8" is shown.

Render: headings, tables, task lists, code blocks, links, images, GitHub-flavored Markdown. Task lists need the `markdown-it-task-lists` plugin (vendored, §12.6).

**Raw inline HTML inside Markdown is disabled, with no opt-in in the MVP** (`markdown-it` option `html: false`). Rendering it in the app origin would bypass the isolation below (D3).

**Links:**

- Allowed schemes: `http`, `https`, `mailto`, and relative links. Any other scheme (`javascript:`, `data:`, `vbscript:`, `file:`) renders as inert text with no `href`.
- Relative links to a supported file (`.md`, `.markdown`, `.html`, `.htm`) switch the preview in-app and update the URL without a full page load.
- Relative links to any other whitelisted file open `/files/<path>` in a new tab; the sandbox header (§12.4) may stop a built-in viewer from rendering. Accepted.
- Relative links that resolve outside the root, or to a file that is not whitelisted or not visible, render as plain text (D5).
- External links open in a new tab with `rel="noopener noreferrer"`.
- Link targets are percent-decoded once before resolution.
- Heading anchors use a GitHub-compatible slug: lowercase, punctuation stripped, spaces to `-`, duplicates suffixed `-1`, `-2`; non-ASCII letters (e.g. CJK) are kept. The slug is computed from the heading's rendered text, and the element id carries the prefix `user-content-` (as on GitHub) so that a heading such as `# Tree` cannot clobber an element of the page; URL hashes stay unprefixed. The slug function lives in `frontend/lib.js` and is unit-tested. Opening a file starts at the top of the page; only a hash scrolls, and only after images have loaded (bounded wait).

**Images:** a relative image path is resolved against the directory of the Markdown file that contains it, then rewritten to `/files/...`. `https` images are allowed by the app-shell CSP (§12.5).

### Theme

Light mode keeps the system look. When the system is in dark mode the page uses the Dracula palette: background `#282a36`, text `#f8f8f2`, links `#8be9fd`, code blocks with the Dracula highlight.js style, Mermaid diagrams with Dracula colours, and rainbow headings (h1 to h6 in red, orange, yellow, green, cyan, purple). A change of the system setting while the page is open re-renders the Mermaid diagrams. The sun/moon button in the bar at the bottom of the file list, next to the settings button, switches between light and dark and the choice is remembered in `localStorage` (`docs-browser.theme`, values `light` or `dark`, anything else is ignored); until it is pressed, and after `Reset to defaults`, the page follows the system. Quote text has a contrast of at least 7:1 against the page.

### Mermaid

Blocks with the `mermaid` language tag render as diagrams. Mermaid runs with `securityLevel: 'strict'`. If a block fails to parse, that block shows an error box containing the parser message and the source; the rest of the page still renders.

A diagram may set its own fill colours (`style X fill:#fff3cd`). After a diagram is rendered, the viewer measures the text of every node and cluster against that shape's own fill and, when the contrast is below 4.5:1 (WCAG AA), changes the text to a dark (`#1e1f29`) or a light (`#f8f8f2`) colour, whichever reads better; text that is already readable is left alone. This applies in light and in dark mode. Fills with no colour or that are mostly transparent are skipped.

### HTML

Supported: `.html`, `.htm`.

HTML **must** render inside an `<iframe>`:

```html
<iframe
  src="/files/docs/flow.html"
  sandbox="allow-scripts allow-popups"
  referrerpolicy="no-referrer">
</iframe>
```

- `allow-same-origin` is **never** granted: the page runs in an opaque origin, so its scripts cannot read the parent DOM or call `/api/*` as the app.
- `allow-top-navigation` and `allow-forms` are never granted.
- **The iframe is not the only protection.** Every response from `/files/*` also carries `Content-Security-Policy: sandbox allow-scripts allow-popups`, so the same restrictions apply when someone opens `/files/docs/flow.html` directly as a top-level page (§12.4).

Local relative assets work, because `<img>`, `<link rel=stylesheet>` and `<script src>` loads do not require CORS:

```html
<img src="./diagram.png">
<link rel="stylesheet" href="./style.css">
<script src="./app.js"></script>
```

**Accepted limitation (D4):** a sandboxed page has an opaque origin, so `fetch()`, `XMLHttpRequest` and web-font loads of relative files from inside the HTML fail. There is no opt-in flag in the MVP (§14).

### Other states

- A deep link to a file of an unsupported type shows "Unsupported file type".
- A file larger than 5 MiB is not rendered by `/api/file`; the preview shows "File too large".
- Navigating inside the iframe (a link between two HTML pages) stays in the iframe and does not update the address bar. Accepted.
- API errors and a lost server connection: see §8.5.

## 7. File Tree

The sidebar:

- Scans directories automatically
- Lists folders and the files of the **listed** types only: the documents (`.md`, `.markdown`, `.html`, `.htm`), the images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`) and `.pdf` (§7.4). SVG is served but not listed, because it can carry script.
- Collapses and expands folders
- Sorts folders before files
- Hides folders that contain no supported file at any depth

### 7.1 Visibility and the served-extension whitelist

**Visibility.** A relative path is *visible* when none of its components is a dot-prefixed name and none equals, **compared case-insensitively**, one of the ignore-list names `.git`, `node_modules`, `dist`, `build`, `.cache`.

- `--include-hidden` makes dot-prefixed components acceptable. The five ignore-list names are **always** excluded, even with `--include-hidden`; there is no override for them. `--ignore NAME` (§9.1) adds names to this list and cannot remove any of them.
- Visibility is evaluated on **both** the listed path and the canonical path (§12.2). A symlink named `public` that points at `.git` is therefore not visible.

**Served-extension whitelist (D7).** `/files/*` serves a file only when its extension, compared case-insensitively, is one of:

```text
html htm md markdown css js mjs svg png jpg jpeg gif webp avif ico bmp woff woff2 ttf otf
```

Any other extension, including no extension, returns 404 even if the path is visible. `/api/file` additionally accepts only `md` and `markdown`. Consequences: `.env`, `.json`, `.txt`, keys and other secrets are never served in either mode.

`--include-hidden` therefore makes only **whitelisted files under dot-prefixed folders** (such as `.github/README.md`) visible and readable. That residual exposure is accepted (D8).

### 7.2 Symlinks and limits

- Symlinks whose canonical target is inside the root are listed and followed (D10); others are not listed (§12.3).
- The scanner stops at 50,000 entries and the UI shows a "Tree truncated" banner. Maximum directory depth is 64.
- The tree and the file index are built in memory and cached (§10.2).

### 7.3 File name filter and full-text search

The top of the file list has a search box with a `Names` / `Contents` switch inside its right end, and a row of three list controls: expand all, collapse all and wrap. A bar at the bottom of the list holds, from the left, a `?` button that opens the list of shortcuts, the theme button and the settings button. The `/` key focuses the box (when no other field has focus) and `Escape` clears it.

- **Names (default):** typing searches the file paths fuzzily: the letters of each word must appear in order, in any case (`arcmd` finds `docs/architecture.md`), and every word of the query must match. The tree is replaced by a flat list of the matching files, best match first, each with its badge and its full path (folder part dimmed, matched letters marked). A plain substring beats scattered letters, a match inside the file name beats one in a folder name, a match at the start of a word beats one in the middle, gaps cost points, ties go to the shorter then the alphabetically first path. At most 200 files are listed, then a line says how many more match. With no match the list says "No file name matches"; clearing the box brings the tree back with the folders as the user had them.
- **Contents:** typing (after 250 ms, at least two characters) calls `GET /api/search` and replaces the tree with a result list: the path, the number of matching lines and up to three lines with the hit marked and the line number. Clicking a result opens the file. The tree comes back when the switch returns to `Names`. A tree event while a content search is shown repeats the search.
- `Expand all` opens every folder, `Collapse all` closes every folder; the choice is remembered like a manual click. Every opened or closed folder is also remembered in this browser's `localStorage`, per served root (the key comes from `/api/version` as `rootKey`, a hash that never shows the path); on the next load those folders open again, and folders that no longer exist are dropped. `Reset to defaults` clears the remembered folders of every root (AC-92).
- Each file in the list carries a badge, `MD` for Markdown and `HTML` for HTML files.
- Each folder shows two small icon buttons on hover: the expand icon opens the folder and everything inside it, the collapse icon closes them. Clicking a button does not toggle the folder itself. The expand icon is two chevrons pointing away from each other (up and down), the collapse icon a framed box with a minus in front of a second frame; the toolbar buttons and the folder buttons use the same two icons, drawn as SVG lines in the text colour so that they follow the theme (light and dark).
- The three list controls (the expand-all and collapse-all icons, wrap `↵`) sit on one line in the default 300 px list, left aligned.
- The wrap button switches long names between wrapping and one line per name shown in full (the list then scrolls sideways). Selecting a file only scrolls the list vertically, never sideways. The search box and the buttons are outside the scrolling part, so they stay in place however far the list is scrolled sideways; the outer panel snaps back to 0 if a browser scrolls it. In a very narrow list (180 px) the buttons wrap onto a second line. Every file and folder has a tooltip with its full path. The folder icon buttons sit right after the folder name, not at the right edge.
- Each folder has a small icon, closed or open.

- **File information:** a thin bar under the preview (hidden while no file is open) shows `Created <date time>` and `Modified <n minutes ago>` (the tooltip is the full time) and, at the right, for a file inside a git repository: `⎇ <branch>`, `Committed <ago> · <short hash>` with the commit subject, or `Not committed yet`, and `● uncommitted changes` when the file differs from its last commit. `Created` is the file system's birth time and is left out where it is not available; it is the time the file appeared on this computer, so a freshly cloned or synced file shows that day, not the day it was written. The bar is filled again after every reload caused by a change on disk. It appears for Markdown and HTML pages alike. On a loopback bind the bar also has an `Open in VS Code` link (`vscode://file/<absolute path>`, percent-encoded per path segment); the server sends the absolute path in `/api/info` (`absolutePath`) only when bound to loopback, so a non-loopback bind shows no link (AC-93, AC-94).
- **Version:** the bar at the bottom of the file list shows `v` and the version of the running server (for example `v0.2.0`) at its right end, in small muted text; the tooltip is `docs-browser v0.2.0`. It comes from `GET /api/version`, so after an upgrade a page left open shows the new number only once it is reloaded.

### 7.4 Outline and settings

- **Outline:** for a Markdown file with headings, a small `☰` button floats at the top right. Hovering it shows the heading list (indented by level, in the same colours as the headings in dark mode; the section being read is highlighted with a background and bold text, without a coloured side border); clicking a heading scrolls to it and sets the `#hash`. Contents links inside a document (`[x](#some-heading)`) jump the same way: the link is matched to a heading id exactly, or, failing that, ignoring the invisible emoji selectors (U+FE0E, U+FE0F), the joiner (U+200D) and leading hyphens, because headings such as `🛡️ Title` keep those characters in their id while many tools leave them out of the link. A contents link whose heading does not exist (an out-of-date table of contents) is shown grey and struck through, with the tooltip `找不到這個標題`, and a click does nothing (the address bar is left alone). Clicking the button pins the list open or closed again (remembered). Files without headings and HTML files show no outline.
- **Copy file name:** while a file is open, a `❐` button at the top right, left of the outline button, copies the file name (the last part of the path, for example `rel.md`) to the clipboard and shows `✓` for about a second. It is also there for HTML pages and absent when no file is open.
- **Copy code:** every code block (not Mermaid) has a small `Copy` button at its top right. It copies the block's text without the button's label and shows `✓` for about a second; a failed copy shows `!`. Diagrams and files without code blocks have none (AC-90).
- **HTML pages** fill the whole right panel: no padding, border or rounded corners.
- **Images and PDF:** an image is shown at its natural size, scaled down to the panel width, straight from `/files/*`. A PDF fills the right panel like an HTML page, in a frame that gets the usual `/files/*` sandbox header (Chromium still renders the PDF there, measured). The tree marks them `IMG` and `PDF`. Both show the file information bar (AC-95).
- **Settings:** the `⚙` button in the bar at the bottom of the file list opens a dialog with: wrap long names, keep the outline open, use the full width for Markdown, and `Reset to defaults` (also resets the sidebar width). The dialog closes with `×`, `Esc` or a click outside. Everything is stored in `localStorage` of the browser only. The theme is switched with its own button (§6 Theme), not in this dialog; `Reset to defaults` also returns the theme to the system setting.

- **Full-screen diagram:** every rendered Mermaid diagram has a small `⤢` button (a text glyph, so that a diagram stays the only `<svg>` in its block) at its top right (dimmed, full strength on hover or focus). It opens a copy of the diagram over the whole page, fitted to the window (at most 400 %). Dragging with the left mouse button pans; the mouse wheel (or a trackpad pinch) zooms around the pointer, so the point under the pointer stays under it; the zoom stays between 5 % and 2000 %. A bar at the top right has `−`, the zoom level, `+`, `Fit` and `×`; a double click and the key `0` also fit, `+` and `-` zoom. `Esc` or `×` closes it; while it is open the other page shortcuts are ignored. Diagrams that failed to render have no button. The copy keeps the diagram's colours.

The server searches on demand, with no index. It walks the listed `.md`, `.markdown`, `.html` and `.htm` files, resolving every one through the resolver (§12.2) with the `/files/*` rules, so hidden folders, the ignore list, out-of-root symlinks and other extensions are never searched. A file reachable through several in-root symlinks is searched once, under its first listed path. Matching is a plain substring test per line, ignoring ASCII case (other letters are matched exactly). HTML is searched by its text with the tags removed. Limits: query 2 to 200 characters, files over 5 MiB skipped, at most 100 result files, 3 lines per file, 256 MiB read per search; hitting a limit sets `truncated`.

### 7.5 Tabs and keyboard shortcuts

- **Tabs:** a tab bar above the preview lists the open files (hidden when none is open). The active tab has a lighter background and a 2 px accent line under it, and shows its `×`; the other tabs are plain text and show their `×` only when hovered. A plain click on a file (list, search result, link inside a document) replaces the active tab; a command-click or control-click, or a middle click, opens the file in a tab of its own. A file that is already open is activated instead of being opened twice. Each tab remembers its scroll position. A tab closes with its `×`, a middle click, or `Alt W`; closing the active tab activates its right neighbour (else the left one), closing the last one shows "Select a file from the list". Tabs with the same file name show the folder as well, the full path is the tooltip. The tab list is kept in the `sessionStorage` of the browser tab, so a reload keeps it. The address bar always shows the active tab; the browser's back and forward buttons act like a plain click.
- **Shortcuts** (single keys work when no text field has focus and no dialog is open): `/` or `Cmd/Ctrl K` focus the search box; `[` and `]` previous and next tab; `Alt W` close the tab; `j` and `k` scroll down and up by 80 px; `g` and `G` go to the top and the bottom; `o` keeps the outline open or closed; `d` switches light and dark; `c` copies the file name; `?` opens the list of shortcuts (also with the `?` button at the bottom left of the file list and in the settings dialog); `Escape` closes it. `Cmd W` is left to the browser, which does not let a page take it.

## 8. Live Reload

The server watches the root and pushes events to the browser.

### 8.1 Watch scope

- The OS watch is registered on the canonical root, recursively, with `notify::Config::default().with_follow_symlinks(false)` (set on the `notify::RecommendedWatcher` itself). This setting is **required**: measured in T-0.3 (`docs/spikes/T-0.3.md`), on Linux the default `follow_symlinks: true` delivers events for files outside the root, reported as `outlink/o.md`. With `false`, in-root symlink targets are covered by the single root watch and out-of-root targets produce no events, on both macOS and Linux (D10). Measured on the raw `RecommendedWatcher` in T-0.3, and verified end to end by AC-57 (M4): changing `follow_symlinks(false)` to `true` makes AC-57 fail on Linux.
- Event paths are mapped to root-relative paths **lexically** (strip the canonical root prefix); `canonicalize` is not used on event paths, because a deleted path cannot be canonicalized.
- Event paths are **real paths**: with `follow_symlinks(false)` an in-root link target is always reported under its real path (`docs/a.md`, never `link-in/a.md`), so the `aliases` map in §8.2 is mandatory, not an optimisation.
- Events whose relative path is not visible (§7.1) are dropped. `notify` has no exclude option, so ignored directories are filtered from events but **may still be watched by the OS** (measured on Linux: 208 inotify watches for a tree where only 3 directories are visible). This is accepted for the MVP (a recursive watch also covers directories created later); the watch-limit failure is handled in §8.5. Per-directory non-recursive watches are future work (§14).

### 8.2 State, classification and aliases

The server keeps a **snapshot** (part of the cached tree, §10.2):

- `index`: every visible whitelisted file → `{ canonical_rel, kind }`
- `aliases`: `canonical_rel` → all listed paths that lead to it

After a debounce window (default 200 ms), each affected relative path is classified against the snapshot:

| In snapshot | On disk now | Result |
|---|---|---|
| yes | exists | `changed` |
| yes | missing | `removed` (and the snapshot entry is deleted) |
| no | exists and visible and whitelisted | file added: snapshot updated, `tree` |
| no | missing | ignored |

A created, deleted or renamed **directory**, a `notify` rescan or overflow notice, and any watcher error that signals lost events trigger a full rescan.

Details measured in T-0.3: `notify-debouncer-mini` emits only `Any` or `AnyContinuous` plus a path, with no create, modify, remove or rename kind and no file-versus-directory flag. Treat both kinds as "this path was touched". A directory event is recognised by comparing with the snapshot and by `stat` (a path that was a directory in the snapshot and is now missing). A rename arrives as two events (old and new path) and is not paired. A path created and removed inside one window still arrives; the "not in snapshot, missing on disk" row covers it. A rescan is `DebouncedEventBatch::Rescan` (immediate, not debounced; the enum is `#[non_exhaustive]`, so matches need a wildcard arm); on macOS several can arrive in one burst, and the "at most one rebuild at a time" rule in §8.3 coalesces them. **Changed in M4 (measured, Linux only):** the server's own reads do trigger events. Listing a directory emits inotify access events for it, and `notify-debouncer-mini` forwards them as touched paths; every tree rebuild then caused the next one, forever (an idle Linux server sent a `tree` event every few hundred milliseconds and never sent a keep-alive). macOS FSEvents has no such events, so the macOS suite passed while the Linux suite failed. The watcher therefore consumes raw `notify` events, **ignores every `Access` event** (a read is not a change; `relevance()` in `watch.rs`, covered by UT-12) and debounces itself: after the first event it waits until 200 ms pass without another, and never longer than 1 s. AC-48 and AC-57 now also require an idle server to stay silent for 2 s. Events for paths that are not visible are dropped inside the watcher callback, before they reach the channel, so a storm in `node_modules` or `.git` queues nothing. A removed path is matched against canonical paths and against listed paths, so deleting a symlink removes the entries listed through it.

Every `changed` and `removed` result is delivered once per **listed path** of that file (using `aliases`), so a viewer of `link-in/a.md` is notified when `docs/a.md` changes.

### 8.3 Pipeline and SSE stream

Order of operations is **update state, then broadcast** (never the reverse):

```text
notify -> debounce -> classify against snapshot -> update snapshot/tree (swap) -> broadcast
```

A `tree` event is emitted only **after** the new tree has been swapped in, so a client that re-fetches `/api/tree` on receipt always sees the new tree. At most one rebuild runs at a time; events arriving during a rebuild schedule exactly one more rebuild. If a rebuild fails (I/O error), the previous tree is kept, the error is logged, and the next event retries. When events were lost (a rescan), `resync` is sent even if the rebuild failed. On shutdown the flag is set with `send_replace`, so a stream that subscribes late still sees it.

`GET /api/events` is a Server-Sent Events stream:

- Messages are JSON: `{ "type": <t>, "path": "docs/architecture.md" }` where `<t>` is `changed`, `removed`, `tree`, `resync`, `unavailable` or `bye`. `path` is present only for `changed` and `removed`.
- A keep-alive SSE comment is sent every 15 s. (Measured: write to delivered debounced batch is 200 to 224 ms with a 200 ms window; the notify-to-browser budget in the live-reload criteria is therefore at least 300 ms for that leg.)
- The broadcast channel is bounded. A subscriber that lags receives one `resync`; the client then re-fetches the tree and the open file.
- The server allows at most 32 concurrent SSE streams; further requests get 503 (§4.1 R12).
- On SIGINT or SIGTERM the server sends `bye` to every stream, closes them and exits (§9.1). Open streams never block shutdown: a 2 s deadline applies.

### 8.4 Client behaviour

- Open Markdown file `changed`: re-fetch `/api/file` and re-render, keeping scroll position.
- Open HTML file `changed`, **or any changed asset** (CSS, JS, image) while an HTML file is open: reload the iframe.
- Open file `removed`: the preview shows "File no longer exists" and keeps the URL. If the file reappears (a `tree` event includes it), the preview restores itself.
- `tree`: re-fetch `/api/tree`, re-render the sidebar, preserve expanded folders.
- `resync` and every reconnect: re-fetch tree and open file.

### 8.5 Failure behaviour

- If the OS watcher cannot start (for example the inotify watch limit is reached), the server keeps serving, prints `warning: live reload disabled: <reason>` and sends `{ "type": "unavailable" }` on `/api/events`. The UI shows "Live reload unavailable". `watch()` fails synchronously with `notify::ErrorKind::MaxFilesWatch` (display `OS file watch limit reached.`) and a recursive watch can fail partway, leaving a half-registered watcher that silently misses changes: on **any** error from the initial `watch()` the server drops the watcher entirely before reporting unavailable. For `MaxFilesWatch` the warning also suggests raising `fs.inotify.max_user_watches`.
- If an API request fails or the SSE stream closes, the UI shows "Server unreachable, retrying" and keeps the last rendered content; `EventSource` reconnects automatically and the banner clears after the resync.
- On `bye` the UI shows "Server stopped"; because the stream then closes, it is replaced at once by "Server unreachable, retrying" (accepted, it follows the rule above).
- If the browser gives up on the stream (the server answered 503 because it is at its stream limit), the UI shows "Live reload unavailable" and reconnects by hand with a growing delay; it never claims to be retrying while it is not.
- The client opens the event stream before its first fetch, so nothing that changes after startup is missed. A file that answers 404 is marked missing, so a later `tree` event that lists it restores the preview; a pending re-render is cancelled when a `removed` event arrives and is postponed while a navigation is still rendering.

## 9. CLI

```bash
docs-browser [directory]
```

`directory` defaults to `.`.

Options: `<path>` is a directory (default `.`) or a Markdown/HTML file (see 9.1), `--port <N>` (default 4747, see 9.1), `--host <ADDR>` (default `127.0.0.1`), `--no-open`, `--include-hidden`, `--ignore <NAME>` (repeatable), `--verbose` (alias `-v`), `--help`, `--version`. `--open` is still accepted (hidden) for earlier scripts.

### 9.1 Startup and exit behaviour

- On success, print to stderr a line such as `Serving /abs/root at http://127.0.0.1:4747`.
- Directory missing, not a directory, or not readable: `error: directory not found: <path>`, `error: not a directory: <path>` or `error: cannot read directory: <path>: <reason>`, exit **2**. An unreadable directory is refused instead of silently serving an empty tree.
- Explicit `--port N` already in use, permission denied (port below 1024 without privilege), or address not available: `error: cannot bind <addr>:<port>: <reason>`, exit **1**. No fallback for an explicit port.
- Without `--port`: 4747 is tried first; if it is in use, the next free port from 4748 to 4766 is used and the line `note: port 4747 is busy, using <port>` goes to stderr; if all of those are busy, the OS picks a free port. Any other bind error is reported at once (exit **1**).
- Invalid `--host` or `--port`: clap usage error, exit **2**.
- `--port 0` asks the OS for a free port; the printed URL shows the real port.
- A file argument (`.md`, `.markdown`, `.html`, `.htm`): the served root is the nearest enclosing git repository, found by walking up from the file's folder to the first `.git` (a folder or a file, as in a worktree); without one, the file's own folder. No `git` command runs for this. The page opens that file with `?file=<path relative to the root>`, and the line `Opening <url>` is printed. Other file types exit `2` with `error: not a Markdown or HTML file: <path>`; a file that the viewer would refuse (for example a hidden file without `--include-hidden`) exits `2` with `error: cannot open file: <path>: <reason>`. The `Serving` line shows the real root.
- Opening the printed URL in the default browser is the default. `--no-open` turns it off. With a wildcard host (`0.0.0.0`) it opens `http://127.0.0.1:<port>/`. If opening fails (for example on a headless host), print `warning: could not open a browser for <url>: <reason>` and continue.
- No configuration file is read.
- `--ignore <NAME>` (repeatable) hides every file or folder whose name equals NAME exactly, at any depth, in the tree, `/files/*`, `/api/file` and live reload. It adds to the five built-in names (§7.1) and never removes one. A NAME that is empty, contains `/` or `\`, or is `.` or `..` exits `2`. Unlike the built-in names, matching is case-sensitive.
- SIGINT or SIGTERM: close SSE streams (§8.3) and exit **0** within 2 s.

### 9.2 Non-loopback host: warn only (D2)

When `--host` is not a loopback address, print to stderr before serving:

```text
WARNING: binding to <addr> exposes every visible file under <root> to your network.
```

The server still starts.

### 9.3 Logging

- Default (stderr): the startup line, warnings, errors, and one line per **denied** request, e.g. `denied: outside-root GET /files/link-out/hosts`.
- `--verbose`: additionally one line per request: `METHOD path status duration`.
- Paths in log lines, **including the directory in the startup, warning and error messages**, are escaped so control characters (CR, LF, ESC) cannot forge log lines. Log writes never panic: they are ignored when stderr is closed.
- `--verbose` logs the request path without the query string.
- No metrics and no log files in the MVP.

## 10. Suggested Architecture (Rust)

The deliverable is a **single self-contained binary**, no runtime dependencies:

```bash
cargo install --locked --git <repo> --tag vX.Y.Z    # `cargo install --locked docs-browser` only if the crate name is free (§15)
docs-browser .
```

### 10.1 Crates

Versions are chosen in task T-0.1, written to `Cargo.toml` as minor-pinned requirements, and `Cargo.lock` is committed. Measured at T-0.1: axum 0.8.9 (the `/{*path}` wildcard and an SSE route both ran), notify 9.0.0 (needs rustc 1.91, so `rust-version = "1.91"` is set; `notify-debouncer-mini` 0.8.0 was used until M4). `Cargo.toml` also sets `exclude = ["/tests/fixtures", "/.claude", "/target"]`: without it `cargo package` follows the fixture symlink `link-out -> /etc` and reads files outside the project (T-0.5).

| Concern | Crate | Notes |
|---|---|---|
| HTTP server, routing | `axum` + `tokio` | **Wildcard route syntax differs between axum 0.7 (`/*path`) and 0.8 (`/{*path}`).** T-0.1 compiles a wildcard route against the chosen version first. axum's `Path` and `Query` extractors already percent-decode; see §12.2 |
| SSE streams | `futures-util` (`stream::unfold`) | `tokio-stream` and `tower-http` were dropped: the stream is a small `unfold`, and headers are set by one small axum middleware |
| File watching | `notify` (raw events) with a quiet-period debounce in `watch.rs` | `notify-debouncer-mini` was dropped in M4: it forwards the inotify access events that the tree scan itself causes on Linux (see §8.2). §8.2 classifies against the snapshot, because event kinds are not reliable |
| CLI parsing | `clap` (derive) | |
| Embedded frontend | `rust-embed` | |
| Directory scan | `std::fs::read_dir` (`walkdir` dropped in M1: the scanner lists one directory at a time and decides about symlinks itself) | Symlinks are handled manually (§10.3) |
| MIME types | a fixed table in `server.rs` (`mime_guess` dropped in M2: the whitelist is small and fixed) | `.js` must map to `text/javascript`, `.svg` to `image/svg+xml` |
| Open browser | `open` | |
| Serialization | `serde`, `serde_json` | |

Edition 2021 and the release profile (`opt-level = 3`, `lto = "thin"`, `strip = true`, present in `Cargo.toml`) follow the sibling project `claude-code-stats`. `anyhow` was dropped: startup errors use a small `Failure` type that carries the exit code.

### 10.2 State ownership and concurrency

```text
AppState {
  root:           PathBuf                       // canonical, set once at startup
  include_hidden: bool                          // set once at startup
  tree:           RwLock<Arc<TreeState>>        // swapped, never mutated in place
  events:         broadcast::Sender<Event>      // bounded
  sse_slots:      Semaphore(32)
}

TreeState {
  entries:  Vec<TreeEntry>                      // what /api/tree returns
  index:    HashMap<RelPath, FileInfo>          // visible whitelisted files (snapshot, §8.2)
  aliases:  HashMap<RelPath, Vec<RelPath>>      // canonical_rel -> listed paths
  truncated: bool
}
```

- The watcher runs on its own thread and sends raw events into a channel.
- One **state task** consumes debounced events, classifies, builds the next `TreeState`, swaps it in, then broadcasts (§8.3). It is the only writer of `tree`.
- Handlers only read `AppState`; the request path never mutates it.

### 10.3 Backend responsibilities

- Serve the embedded shell for `/` (including `/?file=...`).
- `GET /api/tree`: return the cached tree.
- `GET /api/file`: read a Markdown file after the shared resolver (§12.2).
- `GET /files/*`: read-only serving through the same resolver, whitelist enforced, headers in §11.
- `GET /api/events`: the SSE stream (§8.3).
- **Scanner and symlinks:** list each directory with `read_dir`; `DirEntry::file_type` does not follow symlinks, so links are never followed implicitly. For each symlink entry, call `canonicalize`.
  - Skip it if the target is outside the root, dangling, or not visible (§7.1, both paths).
  - A **directory** symlink whose canonical target is the current directory or **an ancestor of it** is a cycle: it is omitted from the tree.
  - Any other in-root symlink is listed and, for directories, expanded. The same target can therefore appear under several listed paths; the entry cap and the depth cap bound any blow-up.
  - `aliases` records every listed path per canonical path.
- **One resolver:** a single `resolve(root, include_hidden, input)` function (§12.2) is the only code that turns a request path into a filesystem path. Handlers never call `std::fs` with raw input.

### 10.4 Embedded frontend

- Plain HTML and vanilla JavaScript; no bundler for the MVP.
- Pure logic (link rewriting, slug function, URL state, event handling) lives in `frontend/lib.js` so it is unit-tested with `node --test` without a browser.
- Vendored libraries (§12.6): `markdown-it` (`html: false`, tables), `markdown-it-task-lists`, `mermaid` (a single minified build whose file name is pinned), `highlight.js`.
- Debug builds read assets from disk; release builds embed them.

### 10.5 Suggested layout

```text
docs-browser/
├── Cargo.toml / Cargo.lock
├── Makefile                  # help, build, run, test, clean (as in claude-code-stats)
├── src/
│   ├── main.rs               # clap args, startup, exit codes, signals
│   ├── server.rs             # axum routes, headers, Host/Origin, SSE
│   ├── resolve.rs            # the resolver
│   ├── tree.rs               # scanner, visibility, aliases
│   └── watch.rs              # notify, debounce, classify, state task
├── frontend/
│   ├── index.html  app.js  lib.js  style.css
│   └── vendor/               # pinned JS, VERSIONS, CHECKSUMS
├── tests/
│   ├── make-fixtures.sh      # builds the fixture tree (§13.0)
│   └── ...                   # Rust unit and integration tests, node tests
├── docs/spikes/              # one file per spike task (T-0.x)
└── PRD.md
```

### 10.6 Release and rollback

- Ships as a git tag; users install with `cargo install --locked --git <repo> --tag vX.Y.Z`. `--locked` makes cargo honour the committed `Cargo.lock`, which is what pins exact versions; the requirements in `Cargo.toml` pin only the minor version.
- There is no server-side state and no migration.
- **Rollback trigger:** any failure in the smoke subset (AC-01, AC-07a, AC-20, AC-21, AC-25) run against the tagged build. **Rollback** is installing the previous tag.
- Prebuilt cross-platform binaries are future work (§14).

## 11. Basic API

All endpoints accept `GET` and `HEAD`. Any other method returns **405**.

### Get file tree

```http
GET /api/tree
```

```json
[
  {
    "name": "docs",
    "type": "directory",
    "children": [
      { "name": "architecture.md", "type": "file", "path": "docs/architecture.md" }
    ]
  }
]
```

Truncation (§7.2) is signalled by the response header `X-Tree-Truncated: 1`.

### Read Markdown

```http
GET /api/file?path=docs/architecture.md
```

Returns the raw file as `text/plain; charset=utf-8`; the client renders it. Only `.md` and `.markdown` are accepted.

### Serve repository files

```http
GET /files/docs/example.html
```

Only whitelisted extensions (§7.1) are served; the `Content-Type` comes from the fixed table in §10.1.

### Search

```http
GET /api/search?q=needle
```

Returns `200` with `{ "query", "results": [{ "path", "count", "matches": [{ "line", "before", "hit", "after", "more_before", "more_after" }] }], "truncated", "files_scanned" }`. A missing, too short (under 2 characters) or too long (over 200) `q` returns `400`. The Host and Origin rules (§12.1) apply as for every other route.

### Version

```http
GET /api/version
```

Returns `200` with `{ "version": "0.2.0" }`, the version in `Cargo.toml` that the running binary was built from. The Host and Origin rules (§12.1) apply as for every other route.

### File information

```http
GET /api/info?path=docs/architecture.md
```

The path is resolved with the `/files/*` rules (§12.2), so hidden folders, the ignore list, out-of-root symlinks and directories answer `404`. Returns `200` with `{ "size", "modified", "created", "git" }`: times are milliseconds since the Unix epoch, `created` is the birth time and is `null` where the platform does not record it, `git` is `null` outside a repository, otherwise `{ "branch", "commit", "dirty" }` with `commit` either `null` (never committed) or `{ "hash", "time", "subject" }` (seconds, subject cut to 200 characters; no author or e-mail). `branch` is the short hash on a detached HEAD. Git is optional: the server runs `git` with a 2 second limit, without a terminal prompt or optional locks; when git is missing, slow or failing the `git` part is `null`. `dirty` is worked out without `git status` or `git diff`, because those run the clean filters a repository names in its config (`filter.<name>.clean` is an arbitrary command) and a folder from an untrusted clone could then run code: the file's hash (`git hash-object --no-filters`) is compared with its blob in `HEAD`, and an untracked file counts as changed unless `git check-ignore` says it is ignored. Consequently a file whose line endings git converts (`core.autocrlf`, `eol` attributes) can show as changed.

### Deep-link route

```http
GET /?file=docs/architecture.md
```

Served by the same HTML shell as `/` and **always HTTP 200**. The table below applies to `/api/*` and `/files/*`, not to the shell. An invalid, missing, hidden or non-whitelisted `file` renders the app with "File not found" in the preview pane. The query string carries the file path and the hash carries the heading anchor, so they never collide.

### Status codes

| Condition | Status | Body |
|---|---|---|
| Resolver denies the path (traversal, outside root, not visible, not whitelisted, symlink escape, not found, directory, permission denied, missing `path` parameter) | **404**, never 403, so existence is not revealed | empty |
| `Host` or `Origin` not allowed (§12.1) | 403 | empty |
| Method other than GET/HEAD | 405 | empty |
| `/api/file` on a visible file whose extension is not `md`/`markdown` | 415 | empty |
| `/api/file` larger than 5 MiB | 413 | empty |
| More than 32 SSE streams | 503 | empty |
| Internal error (I/O failure) | 500 | empty; details only in the stderr log |

### Headers

| Response | Headers |
|---|---|
| `/files/*` | `Content-Security-Policy: sandbox allow-scripts allow-popups`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-cache`, `Last-Modified` |
| `/api/*` | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` |
| `/` and embedded assets | the app-shell CSP (§12.5), `Cache-Control: no-cache`, `ETag` |
| all | **no** `Access-Control-Allow-*` header |

## 12. Security

### 12.1 Network binding, Host and Origin validation

- Default bind is `127.0.0.1`. Other addresses require explicit `--host` and print the warning in §9.2.
- **Loopback bind:** a request is rejected with 403 unless its `Host` header is exactly one of `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`. Other loopback aliases such as `127.0.0.2` are rejected.
- **Origin** (every endpoint, both bind modes): if an `Origin` header is present, its host and port must equal the request's `Host` header (same origin); otherwise 403. A missing `Origin` is allowed. **One exception (D11):** `Origin: null` (exactly that lowercase value) is accepted for `GET` and `HEAD` requests to `/files/*` only. A sandboxed HTML preview has an opaque origin, and some browsers (measured: Chromium 156) send `Origin: null` when it loads its own CSS, scripts and images, which broke relative assets (PRD 6). `/api/*`, `/api/events` and every other method keep the strict rule; `/files/*` sends no CORS headers and always carries `Content-Security-Policy: sandbox`, so a page with a null origin can load those resources but not read them.
- **Non-loopback bind:** the `Host` allowlist is disabled, because the server cannot know every name it is reached by; the Origin rule above stays on (D9). Risk R1 applies.

### 12.2 Path resolution (Rust rules)

Every request that names a file (`/api/file`, `/files/*`, deep-link `?file=`) goes through one resolver:

1. At startup, `ROOT = std::fs::canonicalize(directory)`.
2. **Decoding:** the resolver itself never percent-decodes. It receives the single-decoded string produced by axum's extractors. A literal `%2e%2e` that survives that one decoding is just a file name and will not exist. Task T-0.9 verifies the extractor's behaviour.
3. Reject if the input contains a NUL byte or a backslash, or if `Path::new(input).components()` contains `ParentDir`, `RootDir` or `Prefix`. `.` segments, empty segments and a trailing slash are dropped before lookup (so `./README.md`, `docs//api.md` and `README.md/` all resolve like `README.md`); the normalized form is the listed path. This is safe because every later check runs on the normalized path.
4. `TARGET = canonicalize(ROOT.join(input))`. If it fails (not found, permission denied), deny.
5. Accept only if `TARGET.starts_with(&ROOT)`. `Path::starts_with` compares whole components, so a sibling directory that merely shares a name prefix (`docs-evil` next to `docs`) is rejected.
6. `LISTED = input`, `CANON = TARGET` made relative to `ROOT`. **Both** must be visible (§7.1, case-insensitive). Deny otherwise.
7. `TARGET` must be a regular file (a directory, FIFO, socket or device is denied), and the extension must pass the whitelist for the endpoint (§7.1) on **both** the listed name and the canonical target. Checking both is deliberate: a link `a.md -> data.json` is refused because of its target, and `a.txt -> docs/api.md` is refused because of its name.
8. Every denial returns 404 and logs `denied: <reason> <method> <escaped path>` (§9.3).

Measured in T-0.8 (`docs/spikes/T-0.8.md`): the macOS fixture volume (APFS) is case-insensitive, and `canonicalize` returns the **on-disk spelling** for a case-variant request (`Node_Modules/pkg/index.md` becomes `node_modules/pkg/index.md`, `.GIT/config` becomes `.git/config`), so a case-insensitive visibility check on the canonical path blocks them. On Linux the same inputs fail with NotFound. Visibility comparisons stay case-insensitive on every platform, and both sides of step 5 come from `canonicalize`.

APFS preserves the stored Unicode normalization form and finds a file under either NFC or NFD spelling. Therefore never compare a request string against a `read_dir` name byte-wise; compare canonical paths, or normalize both to NFC for comparison only.

### 12.3 Symlink policy

- A symlink whose canonical target is inside the root is allowed: listed, served, followed by the scanner. Change events reach it through `aliases` (§8.2).
- A symlink whose target is outside the root, dangling, or not visible is not listed, not served and never watched.
- Cycles are cut by the ancestor rule in §10.3.

### 12.4 HTML isolation

Two independent layers:

1. The preview iframe carries `sandbox="allow-scripts allow-popups"` (§6).
2. `/files/*` responses carry `Content-Security-Policy: sandbox allow-scripts allow-popups`, for **every** whitelisted type (including `.svg`), and therefore also when the URL is opened directly as a top-level page.

Neither layer grants `allow-same-origin`. `/api/*` and `/files/*` send no CORS headers.

### 12.5 App-shell CSP

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: https:; frame-src 'self'; connect-src 'self';
object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

Measured in T-0.4 (`docs/spikes/T-0.4.md`): Mermaid injects an inline `<style>` element and inline `style` attributes, so `style-src` must keep `'unsafe-inline'`. Under a strict `style-src 'self'` it still renders but with 37 CSP violations and unstyled (black) shapes. `script-src 'self'` is sufficient; no `'unsafe-eval'` is needed.

### 12.6 Vendored JavaScript

- Exact versions and the pinned Mermaid build file name are recorded in `frontend/vendor/VERSIONS`.
- `frontend/vendor/CHECKSUMS` holds the SHA-256 of each vendored file; a test recomputes and compares them.
- Licence files are kept next to each library.

## 13. Acceptance Criteria

Two kinds of checks:

- **UT-nn** are unit or library tests, run with `cargo test` or `node --test`. They need no running server.
- **AC-nn** are system-level checks against a running binary (`curl`, browser). Each AC names the **milestone that delivers it** in the `M` column. A browser check is a manual assertion with the expected result stated; T-3.4 tries to automate them with headless Chrome.

`BASE` is `http://127.0.0.1:4100`, started with `docs-browser tests/fixtures/site --port 4100` unless stated.

**Linux runs** (measured in `docs/spikes/host-dependent-acs.md`): run the binary in a Docker container (`rust:1`) on the container's own filesystem, not a bind mount (a macOS folder mounted into a container stays case-insensitive and has no native inotify). Use `docker run --network host`, so the server stays bound to `127.0.0.1` and the Mac's Chrome can reach it with `Host: 127.0.0.1:<port>`; `-p` publishing does not reach a loopback-bound server. The image has no `lsof`, `ss` or `netstat`. The runner is `python3 tests/suite.py`; it prints one `ID | M | status | note` row per criterion on each platform.

### 13.0 Fixtures

`tests/make-fixtures.sh` creates `tests/fixtures/site/` (symlinks, `.git` and invalid bytes cannot be committed reliably):

```text
site/
├── README.md              # heading, GFM table, 2 task items, link to docs/architecture.md
├── notes.txt              # visible, not whitelisted
├── .env                   # SECRET=1
├── .git/config
├── .hidden/note.md        # whitelisted file under a dot folder
├── node_modules/pkg/index.md
├── loop/self -> ..        # cycle
├── link-in  -> docs       # in-root symlink
├── link-out -> /etc       # outside root
├── evil     -> ../site-evil   # outside root, name shares the root's prefix
├── public   -> .git       # symlink to an ignored folder
├── docs/
│   ├── architecture.md    # one valid mermaid block, one relative image
│   ├── bad-mermaid.md     # one invalid mermaid block plus a heading
│   ├── links.md           # [x](javascript:alert(1)), [ok](./api.md), [out](../../outside.md), [t](../notes.txt)
│   ├── long.md            # 200 lines, heading "Bottom" at the end
│   ├── big.md             # 6 MiB
│   ├── utf8-bad.md        # contains invalid UTF-8 bytes
│   ├── api.md
│   ├── UPPER.MD           # uppercase extension
│   ├── dir.md/            # a directory named like a Markdown file
│   ├── 中文 筆記.md        # CJK name with a space
│   ├── subdir/rel.md      # image ![](../diagram.svg)
│   ├── flow.html          # relative css/js/img; its script reports to the parent via postMessage:
│   │                      #   {ran, parentAccess:'blocked'|'LEAK', apiFetch:'blocked'|'LEAK'}
│   ├── style.css  app.js  diagram.svg
../site-evil/secret.md
```

### 13.1 Functional

| ID | M | Requirement | Verification | Expected |
|---|---|---|---|---|
| AC-01 | M2 | §9 start | Start; `curl -s -o /dev/null -w '%{http_code}' $BASE/` | `200` within 2 s; stderr's first line starts `Serving ` and contains the canonical root and `http://127.0.0.1:4100` |
| AC-02 | M2 | §7 tree | `curl -s $BASE/api/tree` | Contains `README.md`, `docs/architecture.md`, `docs/中文 筆記.md`, `docs/flow.html`, `.hidden` absent; no `.env`, `.git`, `node_modules`, `notes.txt`, `link-out`, `evil`, `public`, `loop/self`; `link-in/architecture.md` present; directories before files; folders without supported files absent |
| AC-03a | M2 | §11 Markdown API | `curl -si "$BASE/api/file?path=README.md"` | `200`, `text/plain; charset=utf-8`, body equals the file |
| AC-03b | M3 | §6 Markdown | Browser `/?file=README.md` | 1 `<table>` and 2 checkbox inputs |
| AC-04 | M3 | §6 Mermaid | Browser `/?file=docs/architecture.md` | `document.querySelectorAll('.mermaid svg').length === 1` |
| AC-05 | M3 | §6 Mermaid error | Browser `/?file=docs/bad-mermaid.md` | Error box containing the source is visible; the heading is still rendered |
| AC-06 | M3 | §6 HTML | Browser `/?file=docs/flow.html` | One iframe with `sandbox` exactly `allow-scripts allow-popups`; report has `ran: true`, `parentAccess: 'blocked'`, `apiFetch: 'blocked'`; `h1` is red (CSS loaded) |
| AC-07a | M2 | §12.4 header | `curl -sI $BASE/files/docs/flow.html` | `content-security-policy: sandbox allow-scripts allow-popups` present |
| AC-07b | M3 | §12.4 top-level | Open `$BASE/files/docs/flow.html` directly in a tab | Report shows `apiFetch: 'blocked'` and `parentAccess` is not `LEAK` |
| AC-08 | M2 | §11 assets | `curl -sI` each of `/files/docs/style.css`, `app.js`, `diagram.svg` | `200`; types `text/css`, `text/javascript`, `image/svg+xml`; each has `x-content-type-options: nosniff` |
| AC-09 | M3 | §6 links | In `/?file=README.md`, click "architecture" | URL becomes `/?file=docs/architecture.md`; a `window.__marker` set before the click is still defined |
| AC-10 | M3 | §6 link rules | Browser `/?file=docs/links.md` | The `javascript:` link has no `href`; `./api.md` navigates in-app; `../../outside.md` and `../notes.txt` render as plain text |
| AC-11 | M2 | §6 unsupported | `curl -s -o /dev/null -w '%{http_code}' "$BASE/api/file?path=notes.txt"` | `415` |
| AC-12a | M2 | §6 size | `curl -s -o /dev/null -w '%{http_code}' "$BASE/api/file?path=docs/big.md"` | `413` |
| AC-12b | M3 | §6 size UI | Browser `/?file=docs/big.md` | Shows "File too large" |
| AC-13a | M2 | §5 encoding | `curl -s -o /dev/null -w '%{http_code}' "$BASE/api/file?path=docs/%E4%B8%AD%E6%96%87%20%E7%AD%86%E8%A8%98.md"` | `200` |
| AC-13b | M3 | §5 encoding UI | Browser `/?file=docs/%E4%B8%AD%E6%96%87%20%E7%AD%86%E8%A8%98.md` | Page renders; the file is highlighted in the tree |
| AC-14a | M2 | §7.2 cap header | Generate 60,000 `.md` files in a temp root; `curl -sI $BASE/api/tree` | `x-tree-truncated: 1` |
| AC-14b | M3 | §7.2 cap UI | Same root in the browser | Shows "Tree truncated" |
| AC-15 | M3 | §6 UTF-8 | Browser `/?file=docs/utf8-bad.md` | Page renders with the banner "File contained invalid UTF-8" |
| AC-16 | M3 | §6 slugs | `node --test frontend/*.test.js` slug cases: `Data Flow` → `data-flow`, duplicate `Intro` → `intro`, `intro-1`, `中文 標題` keeps CJK | All pass |
| AC-70 | M3 | §5 sidebar width | Browser, in a 1280 px window: drag the divider 120 px to the right (and release the pointer capture without a pointerup, then move the mouse once), reload, drag far right and far left; seed `localStorage` with `5000`, `12`, ` 420 ` and `abc`; seed `600`, shrink the window to 800 px and grow it back; double click the divider; focus it and press Right and Left | 300 becomes exactly 420 (stored, and 420 after the reload) and `body.resizing` is cleared after the lost capture; far right gives 768 (60% of the window), far left 180; the seeded values give 768, 180, 300 and 300; 600 becomes 480 in the 800 px window and 600 again afterwards; the double click gives 300; `aria-valuemin/now/max` read `180/300/768`; Right gives 316 and Left gives 300 |
| AC-71 | M3 | §6 theme | Browser in dark mode `/?file=docs/code.md` then `docs/architecture.md`; then in light mode | Dark: body `rgb(40, 42, 54)` on text `rgb(248, 248, 242)`, h1 `rgb(255, 85, 85)`, h2 `rgb(255, 184, 108)`, links `rgb(139, 233, 253)`, a highlighted keyword in another colour than the text, the first Mermaid node the purple accent tint `rgb(76, 67, 101)` (§7.4, AC-84) and lines `rgb(139, 233, 253)`; light: white background and h1 the same colour as the text |
| AC-72 | M3 | §7.3 badges, expand/collapse | Browser `/`: read the badges, click `Collapse all`, `Expand all`, `Collapse all` | `README.md` and Markdown files read `MD`, `docs/flow.html` reads `HTML`; the open folders go to 0, to all of them, to 0; the expand-all, collapse-all and both folder buttons hold an SVG and no text, the SVG lines are drawn in the button's text colour (differs between light and dark mode), expand and collapse use different drawings and the folder buttons use the same two as the toolbar |
| AC-73 | M3 | §7.3 fuzzy file name search | Browser: type `arcmd`, `mda`, `docs flow`, `zzzz-nothing`, clear, `srch-tar` and click the result; press `/` | `arcmd` lists `docs/architecture.md` first as a flat list with the full path, an `MD` badge and the matched letters marked; `mda` and `zzzz-nothing` give "No file name matches"; `docs flow` lists `docs/flow.html` first; clearing brings the tree back with the folders closed; the click opens `Search target`; the box has focus after `/` |
| AC-74 | M3 | §7.3, §11 content search | Browser, `Contents` switch: type `x`, `ZEBRA-needle`, click the result, type a text nobody has; `fetch('/api/search?q=a')`, `fetch('/api/search?q=hidden')` | "at least 2 characters"; one result `docs/search-target.md`, line `3:`, hit `zebra-needle`, tree hidden; the preview opens and the URL is `?file=docs/search-target.md`; "No file contains"; status `400`; nothing from `.hidden/` |
| AC-75 | M3 | §7.3, §7.4 folder buttons, wrap, outline, settings, HTML panel | Browser: `docs/code.md` outline hover, pin and click; folder expand/collapse icon buttons on `docs`; `Wrap`; settings dialog (open, full width, reset, `Esc`); then `docs/flow.html` | Outline lists `Code sample` and `Second level` (hidden until hover or pin), `Section n` entries in the heading colours with exactly one highlighted: the section scrolled to; a folder icon differs between open and closed; with `Wrap` off, a 180 px list and a large font, a wide name is shown in full on one line (no ellipsis, tooltip = its path), the list scrolls sideways, a real click on a row leaves `scrollLeft` at 0, and after scrolling fully to the right all toolbar controls are still inside the panel and in place; the folder buttons start within 10 px of the end of the folder name; if the outer panel is scrolled (`scrollLeft = 60`) it is back at 0 at once; the HTML iframe has the same width as the panel and sits at its top left, with no outline |
| AC-76 | M3 | §6 theme toggle, quote contrast | Browser with the system in light mode: press the theme button, again, again and reload; `Reset to defaults`; store `purple` and reload | Dark `rgb(40, 42, 54)`, then light, then dark again and still dark after the reload (`docs-browser.theme` is `dark`); the highlight.js sheets switch with it; quote text against the page is at least 7:1; reset gives light and removes the stored value; the bad value is ignored |
| AC-77 | M3 | §7.4 contents links, outline | Browser `/?file=docs/toc.md` (headings with emoji, `&`, `?` and a duplicate): click each contents link, including `#threat-detection--response` and `#%EF%B8%8F-threat-detection--response` for `🛡️ Threat Detection & Response`; click outline entries 3 to 7; open `/?file=docs/toc.md#-automation-mode` | Every click leaves the heading within 80 px of the top of the panel and sets the `#hash`; the deep link lands on the heading |
| AC-78 | M3 | §7.4 copy file name | Browser: `/` (no file); `/?file=docs/subdir/rel.md` and click the copy button (clipboard stubbed), wait 1.4 s; `/?file=docs/flow.html` and click it | Hidden without a file; shown with a file; `rel.md` copied once, the button shows `✓` and returns to normal after the wait; `flow.html` copied; the button does not overlap the outline button |
| AC-79 | M3 | §7.4 dead contents links | Browser `/?file=docs/toc.md` (contents with `#no-such-heading` and emoji links): inspect, click the dead link, click `#how-to-choose` | Only `no-such-heading` is marked, with `line-through`, `cursor: not-allowed` and the tooltip `找不到這個標題`; the click leaves the address unchanged; the live link jumps and is not marked (the emoji links are not marked either) |
| AC-80 | M3 | §6 Mermaid contrast | Browser `/?file=docs/contrast.md` (nodes with `fill:#fff3cd`, `#1a1a1a`, `#e3f2fd` and one unstyled) in dark mode, then in light mode | In both modes every node's text against its own fill is at least 4.5:1; the unstyled node keeps the Dracula colours (`68,71,90` fill, `248,248,242` text) in dark mode |
| AC-81 | M3 | §7.5 tabs | Browser `/?file=README.md`: plain click, command-click (real mouse, modifier 4), control-click on an open file, command-click on a link inside a document, scroll and switch tabs, reload, close with `×` and a middle click, close all, two files named alike | A plain click replaces the active tab; the command-click opens a second tab and the address shows its file; an open file is activated not duplicated; the document link opens a third tab; the scroll position (600) comes back; the tab list survives the reload with the address file active; `×` and the middle click close tabs; no tab left gives the empty state and `/`; equal names show `rel.md` and `README.md` with their folder as needed |
| AC-82 | M3 | §7.5 shortcuts | Browser `/?file=docs/outline.md`: `/`, `Cmd K`, `Ctrl K`, `d` inside the search box, `j` `j` `k` `G` `g`, `o` twice, `d` twice, `c`, `[` `]` with two tabs, `Alt W`, `?`, `j` while the dialog is open, `Escape` | The search box gets focus each time; typing `d` in it changes nothing; the page scrolls 80, 160, 80 px, then to the bottom and top; the outline button toggles; the theme switches to Dracula and back; `outline.md` is copied; `[` and `]` change the tab; `Alt W` closes one; the dialog lists at least 9 rows, ignores `j` and closes on `Escape` |
| AC-83 | M3 | §7.3 layout | Browser `/?file=README.md`: measure the theme button, the settings button, the `Names`/`Contents` switch and the list controls | Theme and settings buttons are in the bottom bar and not in the toolbar; the switch lies inside the search box at its right end (the box has room for it); the list controls are three buttons and do not include the switch; the bottom bar starts with the `?` button (leftmost, at the left and bottom edge of the list), which opens the shortcuts dialog and `Escape` closes it; with two tabs open the active one has a bottom accent line and a lighter background and shows its `×`, the other has no shadow and a hidden `×` |
| AC-84 | M3 | §7.4 Mermaid colours | Browser `docs/palette.md` (a flowchart with three plain nodes and one `style` node, and a three-participant sequence diagram) in dark and in light mode | Dark: the three plain nodes have three different fills; the `style` node keeps its own fill; each participant has one fill and border colour on both its top and bottom box, different from the other participants; every node text has contrast >= 4.5. Light: plain nodes keep the single theme fill; participants keep the theme's own distinct colours |
| AC-85 | M3 | §7.4 full-screen diagram | Browser `docs/palette.md` (two diagrams): click the button of the first; wheel up at a point, wheel down, 40 wheel-ups, 80 wheel-downs; `Fit`; drag by (120, -80) px; keys `+`, `0`, `d`, `Escape`; open the second, click `×` | There is one button per diagram and the viewer is closed at first; it opens with the whole diagram inside the window; the zoom grows on wheel up and the diagram point under the pointer does not move (within 1 % of the size); it shrinks on wheel down; it never exceeds 2000 % nor goes below 5 %; `Fit` restores the first zoom; the drag moves the diagram by the same distance without changing its size; `+` zooms, `0` fits, `d` does not switch the theme; `Escape` closes and empties the viewer; the second diagram opens its own copy (3 participants) and `×` closes it |
| AC-86 | M3 | §7.3, §11 version | Browser `/?file=README.md`: read the footer's version text and its position; `fetch('/api/version')`; the version in `Cargo.toml` | The text is `v` plus the API's version, which equals the `Cargo.toml` version and has the form `x.y.z`; the text lies inside the bottom bar, to the right of the settings button |
| AC-87 | M3 | §7.3, §11 file information | Browser: `/` (no file), `repo-demo/a.md` (committed in a repository on branch `trunk`), `repo-demo/b.md` (untracked), `docs/flow.html`; then edit `repo-demo/b.md` on disk; `fetch('/api/info?path=...')` for `.hidden/x`, `link-out/passwd`, `../x`, `docs` | No bar without a file; for `a.md` the bar lies under the preview with `Modified`, `trunk`, `Committed … ago`, the commit subject and no uncommitted mark; for `b.md` `Not committed yet` and the uncommitted mark; the HTML page has the bar too; the modified time changes after the edit; the four other paths answer `404` |
| AC-17 | M3 | §6 image base | Browser `/?file=docs/subdir/rel.md` | The image's `naturalWidth > 0` |

### 13.2 Security

| ID | M | Requirement | Verification | Expected |
|---|---|---|---|---|
| AC-20 | M2 | §12.2 traversal | `curl -s -o /dev/null -w '%{http_code}' --path-as-is` for `/files/../../etc/hosts`, `/files/%2e%2e/%2e%2e/etc/hosts`, `/files/%252e%252e/etc/hosts`, `/files//a` (leading slash after decoding); and `/api/file?path=../../etc/hosts`, `path=/etc/hosts`, `path=docs%5C..%5C..%5Cetc%5Chosts`, `path=README.md%00` | All `404`; no body contains `localhost` |
| AC-21 | M2 | §12.3 symlink out | `curl -s -o /dev/null -w '%{http_code}' $BASE/files/link-out/hosts` | `404` |
| AC-22 | M2 | §12.3 symlink in | `curl -s -o /dev/null -w '%{http_code}' $BASE/files/link-in/architecture.md` | `200` |
| AC-23 | M2 | §12.2 prefix | `curl -s -o /dev/null -w '%{http_code}' $BASE/files/evil/secret.md` | `404` |
| AC-24 | M2 | §10.3 cycle | `time curl -s $BASE/api/tree` | ≤ 2 s; finite; no `loop` entry |
| AC-25 | M2 | §7.1 hidden | Default, then `--include-hidden`: `/files/.hidden/note.md`, `/files/.env`, `/files/.git/config`, `/files/node_modules/pkg/index.md` | Default: all `404`. With `--include-hidden`: `.hidden/note.md` → `200`; `.env`, `.git/config`, `node_modules/...` still `404` |
| AC-26a | M2 | §12.1 Host/Origin | `curl -s -o /dev/null -w '%{http_code}'` on `$BASE/api/tree` with: `-H 'Host: evil.example:4100'`; `-H 'Host: 127.0.0.2:4100'`; `-H 'Origin: http://evil.example'`; no extra headers | `403`; `403`; `403`; `200`. A `403` response also carries `x-content-type-options: nosniff` and `cache-control: no-store`. With `Origin: null`: `/api/tree` gives `403`, `GET /files/docs/style.css` gives `200`, `POST` to it gives `403` (D11) |
| AC-26b | M4 | §12.1 events | `curl -s -o /dev/null -w '%{http_code}' -H 'Origin: http://evil.example' $BASE/api/events`, and the same with `-H 'Origin: null'` | `403`; `403` (D11 does not cover the event stream) |
| AC-26c | M5 | §12.1 non-loopback | Start with `--host 0.0.0.0` on a port of its own (the runner uses 4118: 4101 is held by the AC-25 server for the whole run); `curl -H 'Host: anything:<port>'` (no Origin) then `curl -H 'Host: a:<port>' -H 'Origin: http://b:<port>'` | `200`; `403` |
| AC-27 | M5 | §9.2 warning | `docs-browser tests/fixtures/site --host 0.0.0.0 --port <port>` (the runner uses 4119) | stderr contains `WARNING` and `exposes`; listens on the wildcard address (`0.0.0.0:<port>` or `*:<port>`); process keeps running |
| AC-28 | M2 | §12.1 default bind | `tests/listening.sh 4100` (uses `lsof`; falls back to `/proc/net/tcp` where `lsof` is absent, as in the Linux image) | `127.0.0.1:4100` only |
| AC-29 | M2 | §11 methods | `curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/file`; `-X PUT $BASE/files/x` | `405`; `405` |
| AC-30 | M2 | §11 CORS | `curl -sI -H 'Origin: http://localhost:9' $BASE/files/docs/style.css \| grep -ic access-control` | `0` |
| AC-31 | M2 | §12.5 CSP | `curl -sI $BASE/ \| grep -i content-security-policy` | Contains `default-src 'self'`, `object-src 'none'` and `frame-ancestors 'none'` |
| AC-32 | M0 | §12.6 vendor | `make test` runs the checksum test; then flip one byte of a vendored file | Passes; fails after the edit |
| AC-33 | M2 | §7.1 case | `/files/Node_Modules/pkg/index.md`, `/files/.GIT/config` (default and `--include-hidden`); `/files/docs/UPPER.MD` | `404`; `404`; `200` |
| AC-34 | M2 | §7.1 whitelist | `/files/notes.txt`, `/files/.env` (both modes), `/files/docs/flow.html` | `404`; `404`; `200` |
| AC-35 | M2 | §12.2 file kind | `/files/docs`, `/api/file?path=docs/dir.md`, `/api/file` (no parameter) | `404` for all three |
| AC-36 | M2 | §7.1 both paths | `/files/public/config` | `404`; `public` absent from the tree |
| AC-37 | M5 | §9.3 log safety | `curl -s "$BASE/files/%0d%0aX"`; inspect stderr. Then start the server on a directory whose name contains a newline and `WARNING: forged line` | The `denied:` line is one line (the request path stays percent-encoded and never reaches the log with raw control bytes); the startup line is one line with the newline escaped as `\x0a`, and no line starts with `WARNING: forged` |

### 13.3 Deep links and live reload

| ID | M | Requirement | Verification | Expected |
|---|---|---|---|---|
| AC-40 | M3 | §5 deep link | Fresh load of `/?file=docs/architecture.md`; reload; Back/Forward | File shown; `docs` expanded and file highlighted; reload keeps state; Back/Forward move between viewed files |
| AC-41 | M3 | §11 invalid | `/?file=does/not/exist.md`, `/?file=../../etc/hosts`, `/?file=.env` | `curl` status `200` for the shell; page shows "File not found" |
| AC-42 | M3 | §5 anchor | `/?file=docs/long.md#bottom` | The "Bottom" heading is in the viewport; opening another file afterwards starts at the top |
| AC-43 | M4 | §8.4 Markdown | Open `README.md`, append a line | The line appears within 2 s with no navigation; scroll position kept |
| AC-44 | M4 | §8.4 HTML | Open `docs/flow.html`, `touch` it | The iframe fires a new `load` event within 2 s |
| AC-45 | M4 | §8.4 removed | Delete the open file; then recreate it | "File no longer exists" with URL unchanged; the preview restores within 2 s of recreation |
| AC-46 | M4 | §8.2 tree | Create `docs/new.md`; later delete it | Appears in the sidebar within 2 s, then disappears; expanded folders stay expanded |
| AC-47 | M4 | §8.2 debounce | Write one file 50 times within 1 s | At most 5 re-renders in a 2 s window; the final content is shown |
| AC-48 | M4 | §8.1 ignored | `curl -N $BASE/api/events` while modifying `node_modules/pkg/index.md` | No event within 3 s |
| AC-50 | M4 | §8.3 shutdown | Connect an SSE client, send SIGINT | Client receives `bye`; process exits `0` within 2 s |
| AC-51 | M4 | §8.3 keep-alive | `curl -N $BASE/api/events` for 16 s | At least one `:` comment line arrives |
| AC-52 | M4 | §8.5 reconnect | Open a file in the browser, stop the server, restart it on the same port | Banner "Server unreachable, retrying" appears, then clears; the tree and the file are re-fetched without a manual reload |
| AC-53 | M4 | §8.2 aliases | Open `/?file=link-in/architecture.md`; edit `docs/architecture.md` | The view re-renders within 2 s |
| AC-54 | M4 | §8.4 asset reload | Open `docs/flow.html`; edit `docs/style.css` | The iframe reloads within 2 s |
| AC-55 | M4 | §8.3 order | Loop 100 times: create a file, wait for the `tree` event, immediately `curl /api/tree` | The new file is present in 100 of 100 responses |
| AC-56 | M4 | §8.3 SSE cap | Open 33 SSE connections | The 33rd gets `503` |
| AC-57 | M4 | §8.1 out-of-root link | `curl -N $BASE/api/events` while modifying `../site-evil/secret.md` (reached through the fixture symlink `evil`), on Linux and macOS | No event within 3 s (Linux would deliver one with the default `follow_symlinks`) |

### 13.4 CLI

| ID | M | Requirement | Verification | Expected |
|---|---|---|---|---|
| AC-60 | M5 | §9.1 bad dir | `docs-browser /no/such/dir; echo $?`; `docs-browser <dir with mode 000>; echo $?` (skipped when running as root) | stderr `error: directory not found: ...` / `cannot read directory`; exit `2` for both (a file argument is AC-89) |
| AC-61 | M5 | §9.1 port busy | Start two instances on port 4100 | Second prints `error: cannot bind 127.0.0.1:4100: ...`; exit `1` |
| AC-62 | M5 | §9.1 `--port 0` | `docs-browser tests/fixtures/site --port 0` | Startup line shows a non-zero port that answers `200` |
| AC-63 | M5 | §9.1 `--open` | macOS: run with `--open`; the runner does this only when `DOCS_BROWSER_SUITE_OPEN=1` is set, because it opens a real tab. Linux container (no desktop): run with `--open` | macOS: the OS accepts the request to open `http://127.0.0.1:<port>/` (no `warning:` on stderr) and the server answers `200`. Linux: stderr contains `warning: could not open a browser for http://127.0.0.1:<port>/` and the server still answers `200` |
| AC-64 | M5 | §9 help/version | `docs-browser --help`; `--version` | Exit `0`; help lists `--port` (with `[default: 4747]`), `--host`, `--no-open`, `--include-hidden`, `--verbose` |
| AC-65 | M5 | §9.1 zero config | Run AC-01 with `HOME=$(mktemp -d)` and an empty cwd | Passes |
| AC-66 | M5 | §9.3 logging | Run AC-20's requests with and without `--verbose` | `denied:` lines in both; per-request lines only with `--verbose` |
| AC-67 | M5 | §3.1 targets | Benchmark (T-5.4) on the §3.1 workload | Measured values recorded in the repository; misses listed |
| AC-68 | M5 | §9.1 wildcard open | macOS: `--host 0.0.0.0 --open` (same opt-in as AC-63). Linux container: same flags. The URL itself is also covered by the unit test `browse_url_never_uses_a_wildcard_address` | macOS: no `warning:` and the server answers `200`. Linux: the warning names `http://127.0.0.1:<port>/`, never `0.0.0.0` |
| AC-69 | M5 | §9.1 bind errors | macOS: `docs-browser . --port 80` as an unprivileged user. Linux: the same inside a container started with `--user 1000 --sysctl net.ipv4.ip_unprivileged_port_start=1024` (without the sysctl, Docker allows the bind, measured) | `error: cannot bind ...`; exit `1` |
| AC-88 | M5 | §9.1 default port fallback | Hold `127.0.0.1:4747` with a listener; run `docs-browser tests/fixtures/site` (no `--port`); then `docs-browser tests/fixtures/site --port 4747` | The startup line shows a port from 4748 to 4766 that answers `200`; stderr has `note: port 4747 is busy, using`; the explicit busy port exits `1` with `error: cannot bind 127.0.0.1:4747` |
| AC-89 | M5 | §9.1 file argument | Make a folder `repo/.git`, `repo/sub dir/中文 note.md`, `repo/.secret.md` and a folder `plain/` with `p.md` and `p.png`. Run `docs-browser repo/sub dir/中文 note.md --port 0`; `docs-browser plain/p.md --port 0`; `docs-browser plain/p.png`; `docs-browser repo/.secret.md` | Repo case: the `Serving` line shows `repo`, the `Opening` line has `?file=sub%20dir/%E4%B8%AD%E6%96%87%20note.md`, `/api/file` for that path answers `200`, `/api/tree` lists `sub dir`. Plain case: the root is `plain` and the URL has `?file=p.md`. `p.png` exits `2` with `not a Markdown or HTML file`; the hidden file exits `2` with `cannot open file` |
| AC-91 | M5 | §9.1 `--ignore` | `docs-browser base --port 0 --ignore drafts --ignore private`, where `base` holds `drafts/a.md`, `docs/drafts/b.md`, `docs/drafts-old/c.md`, `docs/keep.md`, `private/p.md`, `node_modules/x.md`; then `docs-browser base --ignore a/b` and `docs-browser base --ignore ""` | `/api/file` for `drafts/a.md`, `docs/drafts/b.md` and `private/p.md` answers `404`; `docs/keep.md` answers `200`; `/api/tree` lists `drafts-old` and not `node_modules`; the two invalid names exit `2` |
| AC-95 | M3 | §7.3, §7.4 images and PDF | Browser `/`: read the `IMG` and `PDF` badges of `docs/pic.png` and `docs/doc.pdf`; then `/?file=docs/pic.png` and `/?file=docs/doc.pdf` | The badges read `IMG` and `PDF`; the image loads with natural width `1` from `/files/docs/pic.png`; the PDF is an `iframe.pdf-frame` with `src` `/files/docs/doc.pdf` in a wide panel; the file information bar is shown for both |
| AC-96 | M3 | §7.1, §7.4 listing and serving of images and PDF | `GET /files/docs/doc.pdf` and `/files/docs/pic.png`; `GET /api/tree`; `GET /api/file?path=docs/doc.pdf` on the site fixture | The PDF answers `200`, `application/pdf` and the `/files/*` sandbox header; the PNG answers `200` `image/png`; the tree lists `pic.png` and `doc.pdf` and not `diagram.svg`; `/api/file` does not answer `200` for the PDF |
| AC-92 | M3 | §7.3 remembered folders | Browser `/`: clear the `docs-browser.expanded.*` keys; open `docs`; reload. Then store `docs` and `gone/folder` under the same key and reload. Then set another root's key; then `Reset to defaults` | After the reload `docs` is open; the stored list keeps only `docs`; the other root's key is untouched by this page; `Reset to defaults` removes every key and leaves no folder open |
| AC-93 | M3 | §7.3 VS Code link | Browser `/?file=docs/code.md`: read the `Open in VS Code` link of the file information bar (its `href` only; the link is never clicked) | The link reads `Open in VS Code`; its `href` is `vscode://file/` followed by the absolute path of `docs/code.md`, percent-encoded per segment |
| AC-94 | M5 | §7.3 absolute path and root key | Start the server on loopback and on `--host 0.0.0.0` with the site fixture; read `/api/info?path=docs/code.md` and `/api/version` on each | `absolutePath` is present on loopback and absent on `0.0.0.0`; `rootKey` is 16 lowercase hex digits and equal on both |
| AC-90 | M3 | §7.4 code copy | Browser `/?file=docs/code.md`: click the `Copy` button of the first code block; then `/?file=docs/palette.md` | Each code block has one button and the mermaid diagrams have none; after the click the button shows `✓` and the block's code text is unchanged |

### 13.5 Unit tests

| ID | M | Test | Expected |
|---|---|---|---|
| UT-01 | M1 | Resolver with traversal inputs: `..`, absolute, backslash, NUL, `%2e%2e` literal | `Denied` for each; a literal `%2e%2e` is only "not found" |
| UT-02 | M1 | Sibling prefix `docs-evil` vs `docs` | `Denied` |
| UT-03 | M1 | Symlink inside root, outside root, dangling | Allowed, `Denied`, `Denied` |
| UT-04 | M1 | `visible()` with dot names, ignore-list names in other cases (`Node_Modules`, `.GIT`), `--include-hidden` on and off | Case-insensitive; ignore list excluded in both modes |
| UT-05 | M1 | Both-path visibility: `public -> .git` | `Denied` |
| UT-06 | M1 | Whitelist and extension case (`UPPER.MD`, `.PNG`, `.env`, no extension) | Matches §7.1 |
| UT-07 | M1 | Directory target, permission denied, non-UTF-8 name | `Denied` |
| UT-08 | M1 | Scanner: ancestor cycle (`loop/self -> ..`) omitted; depth cap 64 | Terminates; entry omitted |
| UT-09 | M1 | Scanner: cap of 50,000 entries | `truncated = true` |
| UT-10 | M1 | `aliases`: `link-in/x` and `docs/x` share one canonical path | Both listed paths present |
| UT-11 | M1 | Folders with no supported file are pruned | Pruned |
| UT-12 | M4 | Classifier table in §8.2 (in/out of snapshot × exists/missing) | `changed`, `removed`, `tree`, ignored as specified |
| UT-13 | M4 | Broadcast channel capacity 1, send 100 events | The slow subscriber receives exactly one `resync` |
| UT-14 | M4 | Watcher init failure injected | Server keeps running; `unavailable` event sent |
| UT-15 | M4 | Rebuild coalescing: 10 events during a rebuild | Exactly one extra rebuild; never two in flight |
| UT-16 | M4 | Rebuild failure | Previous tree kept; no `tree` event; next event retries |
| UT-17 | M3 | Content search | Finds text in visible Markdown and HTML only (tags ignored, ASCII case folded, ignore list, hidden folders, other extensions, symlinks once, out-of-root and oversized files skipped); snippets cut on character boundaries |
| UT-18 | M3 | Search query and limits | Query under 2 and over 200 characters refused, trimmed otherwise; 100 files then `truncated` |
| UT-19 | M3 | File information, plain folder | A file outside any repository has size, modified time and no `git`; a directory and a missing path give nothing |
| UT-20 | M3 | File information, repository | In a fresh repository on branch `trunk`: an untracked file shows the branch, no commit and `dirty`; after a commit it shows the commit subject, a time and not `dirty`; an edit makes it `dirty` again |
| UT-21 | M3 | File information, untrusted repository | A repository whose config names a clean filter that creates a marker file: reading the file's information never creates the marker, still reports the file as changed after an edit and as unchanged after it is restored |
| UT-22 | M5 | §9.1 default port fallback | Busy start port: the bind moves to the next free port in range; all tries busy: an OS-chosen port is used |
| UT-23 | M5 | §9.1 file argument root | The root is the nearest `.git` above the file (a folder or a `.git` file); none: the file's folder; unsupported and missing files are refused |
| UT-24 | M5 | §9.1 file URL | `?file=` value is percent-encoded per byte with `/` kept; the base URL is kept |
| UT-27 | M3 | §7.1, §7.4 extension sets | `LISTED_EXTENSIONS` has the documents, the raster images and `pdf`, and not `svg` or `json`; `pdf` is served and is not a Markdown extension |
| UT-28 | M3 | §7.3 badges and media types | `frontend/lib.test.js` `ut_28`: `isImage`, `isPdf` and `badgeFor` give `MD`, `HTML`, `IMG` and `PDF` |
| UT-26 | M5 | §7.3 root key | `root_key` is 16 lowercase hex digits, the same for the same root, different for another root, and does not contain the path |
| UT-25 | M5 | §9.1 `--ignore` | A listed name hides that exact component at any depth; a longer name, a substring or another case stays visible; the built-in five stay hidden; a request for a hidden path is `NotVisible` |

Case-variant inputs in UT-01 to UT-07 are portable only as "denied": on macOS the lookup succeeds and the visibility check then blocks it, on Linux the lookup fails with NotFound (T-0.8). Assertions on canonical strings (for example for `link-out`, which is `/private/etc/hosts` on macOS and `/etc/hosts` on Linux) must be platform-aware.

### 13.6 Coverage matrix

| Requirement | Checked by |
|---|---|
| §3 goals 1 to 8 | AC-01, AC-02, AC-03b, AC-04, AC-06, AC-43, AC-40 |
| §5 sidebar width | AC-70 |
| §6 Markdown, links, images, UTF-8, slugs | AC-03a/b, AC-09, AC-10, AC-15, AC-16, AC-17 |
| §6 Mermaid and error box | AC-04, AC-05 |
| §6, §12.4 HTML isolation | AC-06, AC-07a/b |
| §7 tree, caps | AC-02, AC-14a/b, UT-08, UT-09, UT-11 |
| §7.3 name filter, search, badges | AC-72, AC-73, AC-74, UT-17, UT-18 |
| §7.3 folder buttons, wrap; §7.4 outline, settings | AC-75 |
| §6 theme toggle | AC-76 |
| §7.4 contents links and outline jumps | AC-77 |
| §7.4 copy file name | AC-78 |
| §7.4 dead contents links | AC-79 |
| §6 Mermaid contrast | AC-80 |
| §7.5 tabs and shortcuts | AC-81, AC-82 |
| §7.3 sidebar layout | AC-83 |
| §7.4 Mermaid colours (dark) | AC-84 |
| §7.4 full-screen diagram | AC-85 |
| §7.3, §11 version display | AC-86 |
| §7.3, §11 file information | AC-87, UT-19, UT-20, UT-21 |
| §7.3 remembered folders, VS Code link | AC-92, AC-93, AC-94, UT-26 |
| §7.3, §7.4 images and PDF | AC-95, AC-96, UT-27, UT-28 |
| §7.4 code copy | AC-90 |
| §6 theme | AC-71 |
| §7.1 visibility, whitelist, case | AC-25, AC-33, AC-34, AC-36, UT-04 to UT-06 |
| §8 live reload | AC-43 to AC-48, AC-50 to AC-57, UT-12 to UT-16 |
| §8.5 failures | AC-52, UT-14 |
| §9 CLI | AC-60 to AC-69, AC-01, AC-27 |
| §9.3 logging | AC-37, AC-66 |
| §11 API shape, headers, status | AC-03a, AC-08, AC-11, AC-12a, AC-29, AC-30, AC-35 |
| §12.1 Host/Origin | AC-26a/b/c |
| §12.2, §12.3 resolver and symlinks | AC-20 to AC-24, AC-35, UT-01 to UT-07, UT-10 |
| §12.5, §12.6 CSP, vendoring | AC-31, AC-32 |
| §3.1 targets | AC-67 |

## 14. Future Features

- Windows support (UNC and `\\?\` canonical prefixes, case rules)
- Opt-in flag to relax HTML isolation (e.g. CORS on `/files/*`) for pages that need `fetch()` of local files: not adopted; revisit only with a concrete need
- Opt-in for Markdown raw HTML, with sanitization: deferred
- Remove names from the built-in ignore list: not adopted (D1 is fixed; `--ignore` only adds)
- Polling fallback when the OS watcher is unavailable
- Browser automation for all browser checks in §13
- Table of contents
- JSON / YAML preview
- Keyboard navigation
- Config file such as `.docs-browser.json`: not adopted; revisit only with a concrete need
- Prebuilt cross-platform release binaries

## 15. Decisions and Open Questions

### Decisions

| ID | Decision |
|---|---|
| D1 | Hidden (dot-prefixed) and ignored paths are not readable by default. `--include-hidden` opens dot-prefixed paths only; `.git`, `node_modules`, `dist`, `build`, `.cache` are always excluded |
| D2 | A non-loopback `--host` produces a warning only; it is not refused |
| D3 | Markdown raw HTML is off, with no opt-in flag in the MVP. Not adopted; revisit only with a concrete need |
| D4 | HTML previews cannot `fetch()` local files (opaque origin); no opt-in flag in the MVP. Not adopted; revisit only with a concrete need |
| D5 | Markdown links that resolve outside the root, or to non-visible or non-whitelisted files, render as plain text |
| D6 | A sub-hash on an HTML deep link is ignored |
| D7 | `/files/*` serves only the extension whitelist in §7.1; everything else is 404 |
| D8 | The residual exposure of `--include-hidden` (whitelisted files in dot folders) is accepted |
| D9 | The Origin check stays on in non-loopback mode, as a same-origin comparison with `Host` |
| D10 | In-root symlinks are followed and listed; the watcher covers them through the root watch, and events are delivered per listed path via `aliases` |
| D11 | `Origin: null` is accepted for GET and HEAD on `/files/*` only, so HTML previews keep their relative assets in browsers that send it (12.1). Approved by the user after a measurement; the strict same-origin rule stays for `/api/*` and the event stream |

### Open questions

1. Is the crate name `docs-browser` available on crates.io? Not checked. `cargo install --git` is the install path until it is.
2. When, if ever, should Windows be supported?

## 16. Milestones and Tasks

Each task lists the acceptance criteria (AC) and unit tests (UT) it delivers. **Every AC and UT belongs to exactly one milestone**, the one in its `M` column in §13. After each milestone there is a **checkpoint task**: run `/reviewer:result` on that milestone's diff; do not start the next milestone while any **CRITICAL or HIGH** finding remains.

A spike task is done when `docs/spikes/<task>.md` exists and answers every question listed for that task.

### M0 — Validate assumptions, scaffolding

| Task | Description | Depends | Done when |
|---|---|---|---|
| T-0.1 | Scaffold the crate; choose and pin crate versions; compile a hello-world axum server with a wildcard route and an SSE route | none | `cargo run` serves a wildcard path and a stream; versions recorded in `Cargo.toml` |
| T-0.6 | `tests/make-fixtures.sh` builds the §13.0 tree | none | `ls -laR tests/fixtures/site` shows the listed symlinks, `.git`, `big.md`, `utf8-bad.md` |
| T-0.7 | Makefile with `help`, `build`, `run`, `test`, `clean` | T-0.1 | `make help` lists the targets; `make test` runs `cargo test` |
| T-0.2 | Vendor `markdown-it`, `markdown-it-task-lists`, `mermaid`, `highlight.js`; write `VERSIONS` and `CHECKSUMS`; checksum test | T-0.7 | AC-32 |
| T-0.3 | Spike on `notify` + `notify-debouncer-mini` on macOS and Linux. Questions: does a recursive watch follow symlinks? Can ignored directories be excluded? Is removal distinguishable? What does overflow look like? What is the inotify watch limit failure? | T-0.1 | Spike note answers all five |
| T-0.4 | Check that Mermaid renders under the planned CSP | T-0.2 | Spike note states the final `style-src` |
| T-0.5 | `cargo package --list` and `cargo publish --dry-run` | T-0.2 | Package list contains `frontend/` |
| T-0.8 | macOS spike: what does `canonicalize` return for `/files/Node_Modules/...` and `.GIT/config`; is the volume case-insensitive; Unicode normalization of the CJK fixture | T-0.6 | Spike note answers all three |
| T-0.9 | axum extractor spike: what do `Path` and `Query` return for `%2e%2e`, `%252e`, `%00`, `%5C`? | T-0.1 | Spike note lists the decoded strings; confirms the resolver never needs to decode |
| **CP-0** | Checkpoint review | all above | No CRITICAL or HIGH |

### M1 — Resolver and scanner (library level)

| Task | Description | Depends | Done when |
|---|---|---|---|
| T-1.1 | `resolve.rs`, `visible()`, whitelist | T-0.8, T-0.9 | UT-01 to UT-07 |
| T-1.2 | `tree.rs`: scanner, ancestor cycle rule, caps, aliases, pruning | T-1.1 | UT-08 to UT-11 |
| **CP-1** | Checkpoint review | T-1.1, T-1.2 | No CRITICAL or HIGH |

### M2 — Server and security (HTTP level)

| Task | Description | Depends | Done when |
|---|---|---|---|
| T-2.0 | `main.rs` minimal: `directory`, `--port`, `--host`, startup line, `AppState`, initial tree build | T-1.2 | AC-01, AC-28 |
| T-2.1 | Routes `/api/tree`, `/api/file`, `/files/*` with the §11 status codes | T-2.0 | AC-02, AC-03a, AC-08, AC-11, AC-12a, AC-13a, AC-14a, AC-24, AC-29, AC-35 |
| T-2.2 | Headers: `/files/*` sandbox CSP, no CORS, caching, app-shell CSP | T-2.1 | AC-07a, AC-30, AC-31 |
| T-2.3 | `Host` and `Origin` validation (loopback mode) | T-2.1 | AC-26a |
| T-2.4 | Security behaviours through HTTP: traversal, symlinks, hidden, whitelist, case | T-2.1 | AC-20, AC-21, AC-22, AC-23, AC-25, AC-33, AC-34, AC-36 |
| **CP-2** | Checkpoint review | T-2.0 to T-2.4 | No CRITICAL or HIGH |

### M3 — Frontend

| Task | Description | Depends | Done when |
|---|---|---|---|
| T-3.1 | `lib.js` (slug, link rewriting, URL state) with `node --test` | T-0.2 | AC-16 |
| T-3.2a | Shell, tree, Markdown rendering, link and image rules, UTF-8 banner | T-2.2, T-3.1 | AC-03b, AC-09, AC-10, AC-13b, AC-15, AC-17 |
| T-3.2b | Mermaid with error box | T-3.2a, T-0.4 | AC-04, AC-05 |
| T-3.2c | HTML iframe preview and the top-level check | T-3.2a | AC-06, AC-07b |
| T-3.3 | Deep links, history, anchors, not-found, size and truncation states | T-3.2a | AC-12b, AC-14b, AC-40, AC-41, AC-42 |
| T-3.5 | Resizable sidebar (added after M5, on request): divider, drag, keyboard, double click, limits, `localStorage` | T-3.2a | AC-70 |
| T-3.6 | Dracula theme, rainbow headings, `MD`/`HTML` badges, expand/collapse all, name filter, full-text search and `GET /api/search`, default port 4747 (added after M5, on request) | T-3.5 | AC-71, AC-72, AC-73, AC-74, UT-17, UT-18, AC-64 |
| T-3.7 | Folder buttons, wrap toggle, full-panel HTML, floating outline, settings dialog (added on request) | T-3.6 | AC-75 |
| T-3.8 | Light/dark toggle button and quote contrast (added on request) | T-3.7 | AC-76 |
| T-3.9 | Fuzzy ranked file name search, outer-panel snap-back, lenient anchor lookup for emoji headings (added on request) | T-3.8 | AC-73, AC-75, AC-77 |
| T-3.10 | Copy file name button (added on request) | T-3.9 | AC-78 |
| T-3.11 | Mark contents links to missing headings (added on request) | T-3.10 | AC-79 |
| T-3.12 | Mermaid text contrast per node (added on request) | T-3.11 | AC-80 |
| T-3.13 | In-page tabs and keyboard shortcuts; theme/settings bar at the bottom, scope switch in the search box (added on request) | T-3.12 | AC-81, AC-82, AC-83 |
| T-3.14 | Dark Mermaid: a distinct Dracula accent per plain node and per participant (added on request) | T-3.13 | AC-84 |
| T-3.15 | Full-screen Mermaid viewer with drag and wheel zoom (added on request) | T-3.14 | AC-85 |
| T-3.16 | Version in the footer and `GET /api/version` (added on request) | T-3.15 | AC-86 |
| T-3.17 | File information status bar and `GET /api/info` (times and optional git facts, added on request) | T-3.16 | AC-87, UT-19, UT-20, UT-21 |
| T-3.4 | Try a headless-Chrome script for the browser checks; keep it only if it is stable | T-3.3 | Script committed, or note explaining why not |
| **CP-3** | Checkpoint review | T-3.1 to T-3.3 | No CRITICAL or HIGH |

### M4 — Live reload

| Task | Description | Depends | Done when |
|---|---|---|---|
| T-4.1 | `watch.rs`: watch scope, debounce, `follow_symlinks(false)`, watcher-failure handling | T-0.3, T-2.0 | AC-47, AC-48, AC-57 |
| T-4.2 | State task: snapshot, classifier, aliases, rebuild-then-broadcast, coalescing, failure handling | T-4.1, T-1.2 | UT-12, UT-15, UT-16, AC-46, AC-53, AC-55 |
| T-4.3 | `/api/events`: keep-alive, bounded channel, `resync`, `unavailable`, `bye`, 32-stream cap, graceful shutdown, events Origin check | T-4.2 | UT-13, UT-14, AC-26b, AC-50, AC-51, AC-56 |
| T-4.4 | Client event handling, restore, failure banners, asset reload | T-4.3, T-3.3 | AC-43, AC-44, AC-45, AC-52, AC-54 |
| **CP-4** | Checkpoint review | T-4.1 to T-4.4 | No CRITICAL or HIGH |

### M5 — CLI, hardening, release

| Task | Description | Depends | Done when |
|---|---|---|---|
| T-5.1 | Full CLI: flags, exit codes, host warning, `--open`, verbose, log escaping, non-loopback Origin rule | T-4.3 | AC-26c, AC-27, AC-37, AC-60 to AC-66, AC-68, AC-69 |
| T-5.6 | Default port fallback and `--open` by default with `--no-open` (added on request) | T-5.1 | AC-64, AC-88, UT-22 |
| T-5.7 | A file argument serves its git repository (or folder) and opens the file (added on request) | T-5.6 | AC-60, AC-89, UT-23, UT-24 |
| T-5.2 | README | T-5.1 | `make help` documented; install path stated |
| T-5.3 | **MVP exit gate:** run the whole §13 suite on macOS **and** on Linux | T-5.1 | Every AC and UT passes on both. A criterion may be waived only by an explicit, dated note in this PRD, approved by its owner |
| T-5.4 | Benchmark on the §3.1 workload | T-5.1 | AC-67 |
| T-5.5 | Tag `v0.1.0`, then a no-op `v0.1.1`; install each; roll back by installing `v0.1.0` over `v0.1.1`; run the smoke subset after each | T-5.3 | Smoke subset passes on both tags |
| **CP-5** | Final result review | T-5.1 to T-5.5 | No CRITICAL or HIGH |
