# docs-browser

A zero-config local browser for the documentation in a folder: a file tree on the left, a preview on the
right. It renders Markdown (GitHub flavour), Mermaid diagrams and HTML files, and updates the preview when
a file changes. One static binary, no configuration file, no network access needed.

```bash
docs-browser .            # serve the current folder at http://127.0.0.1:3000
docs-browser ./docs --port 8080 --open
```

## Install

From a checkout of this repository:

```bash
cargo install --locked --path .
```

From a git URL, pinned to a release tag (replace the URL with where you host the repository; this
repository has no remote yet):

```bash
cargo install --locked --git <URL> --tag v0.1.2
```

`--locked` makes cargo use the committed `Cargo.lock`, which is what pins exact dependency versions.
Supported platforms: macOS and Linux. Windows is not supported.

## Usage

```text
docs-browser [OPTIONS] [DIRECTORY]

  --port <PORT>      TCP port, 0 asks the OS for a free one      [default: 3000]
  --host <HOST>      address to bind: an IP address or localhost [default: 127.0.0.1]
  --open             open the page in the default browser
  --include-hidden   make dot-prefixed files and folders visible and readable
  -v, --verbose      log every request to stderr
  -h, --help         print help
  -V, --version      print the version
```

- Exit codes: `0` normal stop, `1` runtime error such as a port already in use, `2` bad usage or a
  directory that is missing, not a directory, or cannot be read.
- The URL is printed at startup (`Serving <folder> at http://127.0.0.1:3000`).
- Only Markdown (`.md`, `.markdown`) and HTML (`.htm`, `.html`) files are listed. A page can also load the
  CSS, JavaScript, images and fonts next to it. Nothing else is served.
- `/?file=docs/architecture.md#section` opens a file directly; the address bar always shows the current file.

## Security model

The server is read-only and meant for one person on one machine.

- It binds to `127.0.0.1` by default. `--host 0.0.0.0` works but prints a warning: every visible file is then
  readable by your network, and the `Host` check is off (the `Origin` check stays on).
- Every request path is resolved against the canonical root. `..`, absolute paths, symlinks that leave the
  folder, and case variants such as `Node_Modules` are refused with a plain 404.
- `.git`, `node_modules`, `dist`, `build` and `.cache` are never served. Dot-prefixed files are hidden unless
  you pass `--include-hidden`. File types outside the whitelist (for example `.env`, `.json`, `.txt`) are
  never served.
- HTML files run inside a sandboxed `<iframe>` without `allow-same-origin`, and every `/files/*` response also
  carries `Content-Security-Policy: sandbox`, so a page cannot read your other files through the server.
  Because of that, JavaScript in a previewed page cannot `fetch()` your local files.
- Markdown cannot contain raw HTML, links with schemes other than `http`, `https` and `mailto` are inert,
  and Mermaid runs in strict mode.

The full requirements, decisions and acceptance criteria are in [PRD.md](PRD.md).

## Development

```bash
make help        # list the targets
make test        # Rust tests, vendored-file checksums, frontend unit tests
make build       # release build
python3 tests/suite.py --milestone all   # every acceptance criterion of PRD section 13
```

- `tests/suite.py` prints one `ID | M | status | note` row per criterion. Browser checks drive a headless
  Chrome over the DevTools protocol (`tests/browser.mjs`, no extra packages) and need Chrome installed.
- On macOS, the two `--open` checks would open a real browser tab, so they run only with
  `DOCS_BROWSER_SUITE_OPEN=1`.
- `tests/linux-browser.sh` runs the browser checks against a server built and served inside a Linux container
  (Docker), with Chrome on the host.
- `frontend/vendor/` holds the pinned browser libraries; `tests/check-vendor.sh` verifies their checksums.
- `docs/spikes/` records the measurements behind the design; `docs/benchmark.md` the performance numbers.
