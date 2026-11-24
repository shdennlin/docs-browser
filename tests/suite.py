#!/usr/bin/env python3
"""Runs the PRD section 13 acceptance criteria and prints `ID | M | status | note`.

Every AC and UT row found in PRD.md section 13 appears in the output. A row with no
implementation is reported as TODO and counts as not passing. Exit code is 0 only when
every selected row passes.

Usage: tests/suite.py [--milestone M0|M1|...|all] [--platform NAME] [--bin PATH]
"""
import argparse
import atexit
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE_SITE = os.path.join(ROOT, "tests", "fixtures", "site")

REGISTRY = {}  # id -> function


def ac(ac_id):
    def deco(fn):
        REGISTRY[ac_id] = fn
        return fn
    return deco


def prd_rows():
    """Returns [(id, milestone)] from the section 13 tables, in document order."""
    text = open(os.path.join(ROOT, "PRD.md"), encoding="utf-8").read()
    rows = re.findall(r"^\| ((?:AC|UT)-\d+[a-c]?) \| (M\d) \|", text, re.M)
    return rows


class Skip(Exception):
    pass


# ---------------------------------------------------------------- helpers
def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)


def raw_get(port, target, headers=None, method="GET", host=None):
    """HTTP request with the request-target sent exactly as given (no client normalisation)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = dict(headers or {})
    conn.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
    conn.putheader("Host", host or f"127.0.0.1:{port}")
    for k, v in h.items():
        conn.putheader(k, v)
    conn.endheaders()
    resp = conn.getresponse()
    body = resp.read()
    out = (resp.status, {k.lower(): v for k, v in resp.getheaders()}, body)
    conn.close()
    return out


class Server:
    """Starts the docs-browser binary on a test port and stops it afterwards."""

    def __init__(self, binary, root, port, extra=None):
        self.binary, self.root, self.port, self.extra = binary, root, port, extra or []
        self.proc = None
        self.stderr_path = None
        self.started_in = None

    def start(self):
        fd, self.stderr_path = tempfile.mkstemp(prefix="docs-browser-stderr-")
        os.close(fd)
        t0 = time.time()
        with open(self.stderr_path, "wb") as err:
            self.proc = subprocess.Popen(
                [self.binary, self.root, "--port", str(self.port)] + self.extra,
                stdout=subprocess.DEVNULL,
                stderr=err,
            )
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                self.started_in = time.time() - t0
                return self
            except OSError:
                if self.proc.poll() is not None:
                    break
                time.sleep(0.05)
        raise RuntimeError("server did not start; stderr: " + self.stderr())

    def stderr(self):
        try:
            return open(self.stderr_path, encoding="utf-8", errors="replace").read()
        except OSError:
            return ""

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGINT)
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        if self.stderr_path and os.path.exists(self.stderr_path):
            os.unlink(self.stderr_path)

    def __enter__(self):
        return self.start()

    def __exit__(self, *a):
        self.stop()


PORT = 4100          # default-mode server (PRD 13)
PORT_HIDDEN = 4101   # --include-hidden server
PORT_BIG = 4102      # 60,000-file tree
PORT_WILD = 4118     # AC-26c: --host 0.0.0.0
PORT_WARN = 4119     # AC-27: --host 0.0.0.0 warning


def server(ctx, hidden=False):
    """Lazily starts one shared server per mode; stopped by main()."""
    key = "hidden" if hidden else "default"
    if key not in ctx["servers"]:
        port = PORT_HIDDEN if hidden else PORT
        extra = ["--include-hidden"] if hidden else []
        ctx["servers"][key] = Server(ctx["bin"], FIXTURE_SITE, port, extra).start()
    return ctx["servers"][key]


def get(port, target, **kw):
    return raw_get(port, target, **kw)


def flatten(entries, prefix=""):
    """All (name, type, path) triples of a /api/tree response."""
    out = []
    for e in entries:
        out.append((e["name"], e["type"], e.get("path")))
        out.extend(flatten(e.get("children", [])))
    return out


def cargo_unit_test(ctx):
    """UT-NN rows map to Rust tests whose names start with `ut_NN_` (e.g. `ut_01_traversal_inputs`)."""
    n = ctx["id"].split("-")[1]
    r = sh(["cargo", "test", "--quiet", f"ut_{n}_"], cwd=ROOT)
    out = r.stdout + r.stderr
    # cargo prints one "running N tests" line per test binary; sum them all.
    total = sum(int(c) for c in re.findall(r"running (\d+) tests?", out))
    if total == 0:
        return False, f"no Rust test named ut_{n}_*"
    if r.returncode != 0:
        return False, "cargo test failed: " + out.strip()[-200:]
    return True, f"{total} Rust test(s) passed"


# ---------------------------------------------------------------- M0
@ac("AC-32")
def ac_32(ctx):
    """make test runs the checksum test; one flipped byte makes it fail."""
    r = sh(["./tests/check-vendor.sh", "--selftest"], cwd=ROOT)
    if r.returncode != 0:
        return False, (r.stdout + r.stderr).strip()[-200:]
    return True, "checksums OK; flipped byte detected"


# ---------------------------------------------------------------- M2
@ac("AC-01")
def ac_01(ctx):
    srv = server(ctx)
    status, _, _ = get(PORT, "/")
    first = srv.stderr().splitlines()[0] if srv.stderr() else ""
    root = os.path.realpath(FIXTURE_SITE)
    ok = (
        status == 200
        and srv.started_in <= 2.0
        and first.startswith("Serving ")
        and root in first
        and "http://127.0.0.1:4100" in first
    )
    return ok, f"status={status} started_in={srv.started_in:.2f}s first_line={first[:90]!r}"


@ac("AC-02")
def ac_02(ctx):
    server(ctx)
    status, _, body = get(PORT, "/api/tree")
    tree = json.loads(body)
    triples = flatten(tree)
    paths = {p for _, _, p in triples if p}
    names = {n for n, _, _ in triples}
    must = {"README.md", "docs/architecture.md", "docs/中文 筆記.md", "docs/flow.html",
            "link-in/architecture.md"}
    absent = {".env", ".git", ".hidden", "node_modules", "notes.txt", "link-out", "evil",
              "public", "loop", "self", "dir.md"}
    problems = []
    if status != 200:
        problems.append(f"status {status}")
    problems += [f"missing {m}" for m in must - paths]
    problems += [f"unexpected {a}" for a in absent & names]

    def dirs_first(entries, where):
        seen_file = False
        for e in entries:
            if e["type"] == "file":
                seen_file = True
            elif seen_file:
                problems.append(f"directory after file in {where}")
            dirs_first(e.get("children", []), where + "/" + e["name"])

    dirs_first(tree, "")
    return not problems, "; ".join(problems) or f"{len(triples)} entries, rules hold"


@ac("AC-03a")
def ac_03a(ctx):
    server(ctx)
    status, headers, body = get(PORT, "/api/file?path=README.md")
    want = open(os.path.join(FIXTURE_SITE, "README.md"), "rb").read()
    ok = status == 200 and headers.get("content-type") == "text/plain; charset=utf-8" and body == want
    return ok, f"status={status} type={headers.get('content-type')} body_equal={body == want}"


@ac("AC-07a")
def ac_07a(ctx):
    server(ctx)
    _, headers, _ = get(PORT, "/files/docs/flow.html")
    v = headers.get("content-security-policy")
    return v == "sandbox allow-scripts allow-popups", f"csp={v!r}"


@ac("AC-08")
def ac_08(ctx):
    server(ctx)
    want = {"style.css": "text/css", "app.js": "text/javascript", "diagram.svg": "image/svg+xml"}
    bad = []
    for name, ctype in want.items():
        status, h, _ = get(PORT, f"/files/docs/{name}")
        if status != 200 or not h.get("content-type", "").startswith(ctype) \
                or h.get("x-content-type-options") != "nosniff":
            bad.append(f"{name}: {status} {h.get('content-type')} {h.get('x-content-type-options')}")
    return not bad, "; ".join(bad) or "3 assets: status, type, nosniff ok"


@ac("AC-11")
def ac_11(ctx):
    server(ctx)
    status, _, _ = get(PORT, "/api/file?path=notes.txt")
    return status == 415, f"status={status}"


@ac("AC-12a")
def ac_12a(ctx):
    server(ctx)
    status, _, _ = get(PORT, "/api/file?path=docs/big.md")
    # Exact boundary: 5 MiB is served, 5 MiB + 1 byte is refused (PRD: "larger than 5 MiB").
    root = tempfile.mkdtemp(prefix="docs-browser-cap-")
    try:
        for name, size in (("exact.md", 5 * 1024 * 1024), ("over.md", 5 * 1024 * 1024 + 1)):
            with open(os.path.join(root, name), "wb") as f:
                f.write(b"a" * size)
        with Server(ctx["bin"], root, PORT_BIG):
            exact = get(PORT_BIG, "/api/file?path=exact.md")[0]
            over = get(PORT_BIG, "/api/file?path=over.md")[0]
    finally:
        shutil.rmtree(root, ignore_errors=True)
    ok = status == 413 and exact == 200 and over == 413
    return ok, f"big.md={status} exactly-5MiB={exact} 5MiB+1={over}"


@ac("AC-13a")
def ac_13a(ctx):
    server(ctx)
    status, _, _ = get(PORT, "/api/file?path=docs/%E4%B8%AD%E6%96%87%20%E7%AD%86%E8%A8%98.md")
    return status == 200, f"status={status}"


@ac("AC-14a")
def ac_14a(ctx):
    server(ctx)
    root = tempfile.mkdtemp(prefix="docs-browser-big-")
    try:
        for d in range(60):
            os.makedirs(os.path.join(root, f"d{d:02d}"))
            for i in range(1000):
                with open(os.path.join(root, f"d{d:02d}", f"f{i:04d}.md"), "w") as f:
                    f.write("# f\n")
        with Server(ctx["bin"], root, PORT_BIG):
            status, h, body = get(PORT_BIG, "/api/tree")
        files = sum(1 for _, t, _ in flatten(json.loads(body)) if t == "file")
        # The cap is real: about 50,000 entries come back, and the normal fixture is not marked truncated.
        normal_hdr = get(PORT, "/api/tree")[1].get("x-tree-truncated") if "default" in ctx["servers"] else None
        ok = (status == 200 and h.get("x-tree-truncated") == "1"
              and 49_000 <= files <= 50_000 and normal_hdr is None)
        return ok, (f"status={status} x-tree-truncated={h.get('x-tree-truncated')} "
                    f"files_returned={files} (60,000 on disk) normal_tree_header={normal_hdr}")
    finally:
        shutil.rmtree(root, ignore_errors=True)


@ac("AC-20")
def ac_20(ctx):
    server(ctx)
    targets = [
        "/files/../../etc/hosts",
        "/files/%2e%2e/%2e%2e/etc/hosts",
        "/files/%252e%252e/etc/hosts",
        "/files//a",
        "/api/file?path=../../etc/hosts",
        "/api/file?path=/etc/hosts",
        "/api/file?path=docs%5C..%5C..%5Cetc%5Chosts",
        "/api/file?path=README.md%00",
    ]
    bad = []
    for t in targets:
        status, _, body = get(PORT, t)
        if status != 404 or b"localhost" in body:
            bad.append(f"{t} -> {status}")
    return not bad, "; ".join(bad) or f"{len(targets)} traversal inputs all 404, no file content"


@ac("AC-21")
def ac_21(ctx):
    server(ctx)
    status, _, _ = get(PORT, "/files/link-out/hosts")
    return status == 404, f"status={status}"


@ac("AC-22")
def ac_22(ctx):
    server(ctx)
    status, _, _ = get(PORT, "/files/link-in/architecture.md")
    return status == 200, f"status={status}"


@ac("AC-23")
def ac_23(ctx):
    server(ctx)
    status, _, _ = get(PORT, "/files/evil/secret.md")
    return status == 404, f"status={status}"


@ac("AC-24")
def ac_24(ctx):
    server(ctx)
    t0 = time.time()
    status, _, body = get(PORT, "/api/tree")
    dt = time.time() - t0
    names = {n for n, _, _ in flatten(json.loads(body))}
    ok = status == 200 and dt <= 2.0 and "loop" not in names
    return ok, f"status={status} time={dt:.3f}s loop_listed={'loop' in names} bytes={len(body)}"


@ac("AC-25")
def ac_25(ctx):
    server(ctx)
    server(ctx, hidden=True)
    paths = ["/files/.hidden/note.md", "/files/.env", "/files/.git/config",
             "/files/node_modules/pkg/index.md"]
    default = [get(PORT, p)[0] for p in paths]
    hidden = [get(PORT_HIDDEN, p)[0] for p in paths]
    ok = default == [404, 404, 404, 404] and hidden == [200, 404, 404, 404]
    return ok, f"default={default} include_hidden={hidden}"


@ac("AC-26a")
def ac_26a(ctx):
    server(ctx)
    cases = [
        ({"host": "evil.example:4100"}, 403),
        ({"host": "127.0.0.2:4100"}, 403),
        ({"headers": {"Origin": "http://evil.example"}}, 403),
        ({"headers": {"Origin": "null"}}, 403),  # D11: never accepted for the API
        ({"headers": {"Origin": f"https://127.0.0.1:{PORT}"}}, 403),  # plain http only
        ({}, 200),
    ]
    got = []
    for kw, want in cases:
        status, _, _ = get(PORT, "/api/tree", **kw)
        got.append((status, want))
    # A rejection must carry the security headers too (they are stamped by the outermost layer).
    _, h403, _ = get(PORT, "/api/tree", host="evil.example:4100")
    hdr_ok = h403.get("x-content-type-options") == "nosniff" and h403.get("cache-control") == "no-store"
    # D11: `Origin: null` (an opaque-origin HTML preview loading its assets) is accepted for /files/* only.
    files_null = get(PORT, "/files/docs/style.css", headers={"Origin": "null"})[0]
    files_null_post = get(PORT, "/files/docs/style.css", method="POST", headers={"Origin": "null"})[0]
    files_evil = get(PORT, "/files/docs/style.css", headers={"Origin": "http://evil.example"})[0]
    files_null_head = get(PORT, "/files/docs/style.css", method="HEAD", headers={"Origin": "null"})[0]
    shell_null = get(PORT, "/", headers={"Origin": "null"})[0]            # not /files/: stays strict
    files_noslash_null = get(PORT, "/files", headers={"Origin": "null"})[0]
    files_upper_null = get(PORT, "/files/docs/style.css", headers={"Origin": "NULL"})[0]  # only the exact `null`
    d11_ok = ((files_null, files_null_post, files_evil) == (200, 403, 403)
              and (files_null_head, shell_null, files_noslash_null, files_upper_null) == (200, 403, 403, 403))
    ok = all(a == b for a, b in got) and hdr_ok and d11_ok
    return ok, (f"got/want={got} 403_headers_ok={hdr_ok} "
                f"/files Origin null GET={files_null} (200) HEAD={files_null_head} (200) POST={files_null_post} (403) "
                f"evil={files_evil} (403); null on / ={shell_null} (403), on /files ={files_noslash_null} (403), "
                f"'NULL' ={files_upper_null} (403)")


@ac("AC-28")
def ac_28(ctx):
    server(ctx)
    r = sh(["./tests/listening.sh", str(PORT)], cwd=ROOT)
    out = r.stdout.split()
    return out == [f"127.0.0.1:{PORT}"], f"listening={out}"


@ac("AC-29")
def ac_29(ctx):
    server(ctx)
    a = get(PORT, "/api/file", method="POST")[0]
    b = get(PORT, "/files/x", method="PUT")[0]
    return (a, b) == (405, 405), f"POST /api/file={a} PUT /files/x={b}"


@ac("AC-30")
def ac_30(ctx):
    server(ctx)
    seen = []
    for hdrs in ({}, {"Origin": f"http://127.0.0.1:{PORT}"}, {"Origin": "http://localhost:9"}):
        status, h, _ = get(PORT, "/files/docs/style.css", headers=hdrs)
        seen.append((status, [k for k in h if k.startswith("access-control")]))
    ok = all(acl == [] for _, acl in seen) and seen[0][0] == 200 and seen[1][0] == 200
    return ok, f"(status, access-control headers) per request={seen}"


@ac("AC-31")
def ac_31(ctx):
    server(ctx)
    _, h, _ = get(PORT, "/")
    v = h.get("content-security-policy", "")
    ok = "default-src 'self'" in v and "object-src 'none'" in v and "frame-ancestors 'none'" in v
    return ok, f"csp={v[:80]!r} frame_ancestors={'frame-ancestors' in v}"


@ac("AC-33")
def ac_33(ctx):
    server(ctx)
    server(ctx, hidden=True)
    paths = ["/files/Node_Modules/pkg/index.md", "/files/.GIT/config"]
    results = {
        "default": [get(PORT, p)[0] for p in paths],
        "hidden": [get(PORT_HIDDEN, p)[0] for p in paths],
        "upper": get(PORT, "/files/docs/UPPER.MD")[0],
    }
    ok = results["default"] == [404, 404] and results["hidden"] == [404, 404] and results["upper"] == 200
    return ok, str(results)


@ac("AC-34")
def ac_34(ctx):
    server(ctx)
    server(ctx, hidden=True)
    got = {
        "notes.txt": get(PORT, "/files/notes.txt")[0],
        ".env default": get(PORT, "/files/.env")[0],
        ".env hidden": get(PORT_HIDDEN, "/files/.env")[0],
        "flow.html": get(PORT, "/files/docs/flow.html")[0],
    }
    ok = list(got.values()) == [404, 404, 404, 200]
    return ok, str(got)


@ac("AC-35")
def ac_35(ctx):
    server(ctx)
    got = [get(PORT, "/files/docs")[0], get(PORT, "/api/file?path=docs/dir.md")[0], get(PORT, "/api/file")[0]]
    return got == [404, 404, 404], f"statuses={got}"


@ac("AC-36")
def ac_36(ctx):
    server(ctx)
    status = get(PORT, "/files/public/config")[0]
    names = {n for n, _, _ in flatten(json.loads(get(PORT, "/api/tree")[2]))}
    return status == 404 and "public" not in names, f"status={status} public_listed={'public' in names}"


# ---------------------------------------------------------------- M3
CHROME_DEFAULT = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BROWSER_IDS = ["AC-03b", "AC-04", "AC-05", "AC-06", "AC-07b", "AC-09", "AC-10", "AC-12b",
               "AC-13b", "AC-15", "AC-17", "AC-40", "AC-41", "AC-42", "AC-70", "AC-71", "AC-72", "AC-73", "AC-74", "AC-75", "AC-76", "AC-77", "AC-78", "AC-79", "AC-80", "AC-81", "AC-82", "AC-83", "AC-84", "AC-85", "AC-86", "AC-87"]


def run_browser(ctx, base, ids):
    """Runs tests/browser.mjs once and returns {id: (ok, note)}."""
    chrome = ctx.get("chrome") or os.environ.get("CHROME_BIN") or CHROME_DEFAULT
    if shutil.which("node") is None:
        raise Skip("node not found")
    if not os.path.exists(chrome):
        raise Skip(f"Chrome not found at {chrome}")
    cmd = ["node", "tests/browser.mjs", "--base", base, "--chrome", chrome, "--ids", ",".join(ids),
           "--root", FIXTURE_SITE, "--bin", ctx["bin"]]
    r = sh(cmd, cwd=ROOT)
    try:
        rows = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise RuntimeError("browser.mjs produced no JSON: " + (r.stderr or r.stdout)[-300:])
    return {row["id"]: (row["ok"], row["note"]) for row in rows}


def browser_check(ctx, ac_id):
    if "browser" not in ctx:
        server(ctx)
        ctx["browser"] = run_browser(ctx, f"http://127.0.0.1:{PORT}", BROWSER_IDS)
    return ctx["browser"][ac_id]


def _make_browser_ac(ac_id):
    def fn(ctx):
        return browser_check(ctx, ac_id)
    fn.__name__ = "ac_" + ac_id.lower().replace("-", "_")
    return fn


for _id in BROWSER_IDS:
    REGISTRY[_id] = _make_browser_ac(_id)


@ac("AC-14b")
def ac_14b(ctx):
    root = tempfile.mkdtemp(prefix="docs-browser-big-")
    try:
        for d in range(60):
            os.makedirs(os.path.join(root, f"d{d:02d}"))
            for i in range(1000):
                with open(os.path.join(root, f"d{d:02d}", f"f{i:04d}.md"), "w") as f:
                    f.write("# f\n")
        with Server(ctx["bin"], root, PORT_BIG):
            res = run_browser(ctx, f"http://127.0.0.1:{PORT_BIG}", ["AC-14b"])
        return res["AC-14b"]
    finally:
        shutil.rmtree(root, ignore_errors=True)


@ac("AC-16")
def ac_16(ctx):
    if shutil.which("node") is None:
        raise Skip("node not found")
    r = sh("node --test frontend/*.test.js", cwd=ROOT)
    ok = r.returncode == 0 and "ok 1 - ac_16 slugs follow the GitHub rules" in r.stdout
    tests = re.search(r"# pass (\d+)", r.stdout)
    return ok, f"node --test: exit={r.returncode} pass={tests.group(1) if tests else '?'}"


# ---------------------------------------------------------------- M4
BROWSER_IDS_M4 = ["AC-43", "AC-44", "AC-45", "AC-46", "AC-47", "AC-52", "AC-53", "AC-54"]
PORT_SSE = 4104     # server used by the shutdown check
PORT_CAP = 4105     # server used by the SSE cap check


class SSE:
    """Minimal Server-Sent Events client on a raw socket (so odd headers can be sent)."""

    def __init__(self, port, headers=None, host=None):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        extra = "".join(f"{k}: {v}\r\n" for k, v in (headers or {}).items())
        self.sock.sendall((f"GET /api/events HTTP/1.1\r\nHost: {host or f'127.0.0.1:{port}'}\r\n"
                           f"Accept: text/event-stream\r\n{extra}\r\n").encode())
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        self.status = int(head.split(b" ")[1]) if head else 0
        self.buf = rest

    def lines(self, seconds):
        """All lines received during the next `seconds`."""
        end = time.time() + seconds
        while time.time() < end:
            self.sock.settimeout(max(0.05, end - time.time()))
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                break
            except OSError:
                break
            if not chunk:
                break
            self.buf += chunk
        text, self.buf = self.buf.decode("utf-8", errors="replace"), b""
        return [ln for ln in text.splitlines() if ln.strip()]

    def events(self, seconds):
        out = []
        for ln in self.lines(seconds):
            if ln.startswith("data:"):
                try:
                    out.append(json.loads(ln[5:].strip()))
                except ValueError:
                    pass
        return out

    def wait_for(self, predicate, timeout):
        """Reads until an event satisfies `predicate`; returns it or None."""
        end = time.time() + timeout
        while time.time() < end:
            for ev in self.events(min(0.25, max(0.05, end - time.time()))):
                if predicate(ev):
                    return ev
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class edited:
    """Context manager: rewrite a fixture file, restore the original on exit."""

    def __init__(self, path, transform):
        self.path, self.transform = path, transform

    def __enter__(self):
        self.original = open(self.path, "rb").read()
        open(self.path, "wb").write(self.transform(self.original))

    def __exit__(self, *a):
        open(self.path, "wb").write(self.original)


def _fx(rel):
    return os.path.join(FIXTURE_SITE, rel)


def _quiet(srv_port):
    """Lets earlier file activity settle, then returns a fresh SSE client with its backlog drained."""
    time.sleep(1.0)
    sse = SSE(srv_port)
    sse.lines(0.6)
    return sse


def _no_event_but_control(port, quiet_path):
    """No event for `quiet_path` within 3 s, while a visible file does produce one (control)."""
    sse = _quiet(port)
    try:
        # An idle server must stay silent: its own tree rebuilds must not trigger new rebuilds
        # (on Linux, listing a directory emits access events; they must not count as changes).
        idle = sse.events(2.0)
        with edited(quiet_path, lambda b: b + b"\nquiet-change\n"):
            leaked = sse.events(3.0)
        with edited(_fx("docs/api.md"), lambda b: b + b"\ncontrol-change\n"):
            control = sse.wait_for(lambda e: e.get("type") == "changed" and e.get("path") == "docs/api.md", 3.0)
    finally:
        sse.close()
    return idle + leaked, control


@ac("AC-26b")
def ac_26b(ctx):
    server(ctx)
    evil = SSE(PORT, headers={"Origin": "http://evil.example"})
    evil.close()
    null = SSE(PORT, headers={"Origin": "null"})  # D11 does not extend to the event stream
    null.close()
    return (evil.status, null.status) == (403, 403), f"evil origin={evil.status} Origin null={null.status}"


@ac("AC-48")
def ac_48(ctx):
    server(ctx)
    leaked, control = _no_event_but_control(PORT, _fx("node_modules/pkg/index.md"))
    return not leaked and control is not None, f"events_for_ignored_dir={leaked} control_event_seen={control is not None}"


@ac("AC-57")
def ac_57(ctx):
    server(ctx)
    outside = os.path.join(os.path.dirname(FIXTURE_SITE), "site-evil", "secret.md")
    leaked, control = _no_event_but_control(PORT, outside)
    return not leaked and control is not None, f"events_for_out_of_root_link={leaked} control_event_seen={control is not None}"


@ac("AC-50")
def ac_50(ctx):
    with Server(ctx["bin"], FIXTURE_SITE, PORT_SSE) as srv:
        sse = SSE(PORT_SSE)
        sse.lines(0.5)
        t0 = time.time()
        srv.proc.send_signal(signal.SIGINT)
        bye = sse.wait_for(lambda e: e.get("type") == "bye", 3.0)
        try:
            code = srv.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            code = None
        took = time.time() - t0
        sse.close()
    return bye is not None and code == 0 and took <= 2.0, f"bye_received={bye is not None} exit_code={code} took={took:.2f}s"


@ac("AC-51")
def ac_51(ctx):
    server(ctx)
    sse = SSE(PORT)
    lines = sse.lines(16.5)
    sse.close()
    comments = [ln for ln in lines if ln.startswith(":")]
    return len(comments) >= 1, f"comment lines in 16.5 s={comments[:2]}"


@ac("AC-55")
def ac_55(ctx):
    server(ctx)
    sse = _quiet(PORT)
    ok_count, failures = 0, []
    try:
        for i in range(100):
            rel = f"docs/order-55-{i}.md"
            path = _fx(rel)
            open(path, "w").write("# o\n")
            try:
                ev = sse.wait_for(lambda e: e.get("type") == "tree", 5.0)
                if ev is None:
                    failures.append(f"{i}: no tree event")
                    continue
                tree = json.loads(get(PORT, "/api/tree")[2])
                if any(p == rel for _, _, p in flatten(tree)):
                    ok_count += 1
                else:
                    failures.append(f"{i}: tree event arrived but /api/tree lacked the file")
            finally:
                os.remove(path)
                sse.wait_for(lambda e: e.get("type") == "tree", 5.0)  # the removal's tree event
    finally:
        sse.close()
    return ok_count == 100, f"{ok_count}/100 present immediately after the tree event; failures={failures[:3]}"


@ac("AC-56")
def ac_56(ctx):
    with Server(ctx["bin"], FIXTURE_SITE, PORT_CAP):
        clients = [SSE(PORT_CAP) for _ in range(32)]
        first = [c.status for c in clients]
        extra = SSE(PORT_CAP)
        status33 = extra.status
        extra.close()
        for c in clients:
            c.close()
    return all(st == 200 for st in first) and status33 == 503, f"first 32 ok={all(st == 200 for st in first)} 33rd={status33}"


def browser_check_m4(ctx, ac_id):
    if "browser_m4" not in ctx:
        server(ctx)
        ctx["browser_m4"] = run_browser(ctx, f"http://127.0.0.1:{PORT}", BROWSER_IDS_M4)
    return ctx["browser_m4"][ac_id]


def _make_m4_browser_ac(ac_id):
    def fn(ctx):
        return browser_check_m4(ctx, ac_id)
    fn.__name__ = "ac_" + ac_id.lower().replace("-", "_")
    return fn


for _id in BROWSER_IDS_M4:
    REGISTRY[_id] = _make_m4_browser_ac(_id)


# ---------------------------------------------------------------- M5
import stat


def run_cli(ctx, args, env=None, cwd=None, timeout=8):
    """Runs the binary to completion and returns (returncode, stdout, stderr)."""
    e = dict(os.environ)
    e.update(env or {})
    r = subprocess.run([ctx["bin"]] + args, capture_output=True, text=True, timeout=timeout, env=e, cwd=cwd)
    return r.returncode, r.stdout, r.stderr


class Proc:
    """A server started with arbitrary arguments and environment; stderr is collected in a file."""

    def __init__(self, ctx, args, env=None, cwd=None):
        fd, self.err_path = tempfile.mkstemp(prefix="docs-browser-err-")
        os.close(fd)
        e = dict(os.environ)
        e.update(env or {})
        with open(self.err_path, "wb") as err:
            self.proc = subprocess.Popen([ctx["bin"]] + args, stdout=subprocess.DEVNULL,
                                         stderr=err, env=e, cwd=cwd)

    def stderr(self):
        with open(self.err_path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def wait_for_stderr(self, needle, timeout=5.0):
        end = time.time() + timeout
        while time.time() < end:
            if needle in self.stderr():
                return True
            if self.proc.poll() is not None:
                break
            time.sleep(0.05)
        return needle in self.stderr()

    def stop(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGINT)
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        if os.path.exists(self.err_path):
            os.unlink(self.err_path)


@ac("AC-26c")
def ac_26c(ctx):
    with Server(ctx["bin"], FIXTURE_SITE, PORT_WILD, ["--host", "0.0.0.0"]):
        a = get(PORT_WILD, "/api/tree", host=f"anything:{PORT_WILD}")[0]
        b = get(PORT_WILD, "/api/tree", host=f"a:{PORT_WILD}", headers={"Origin": f"http://b:{PORT_WILD}"})[0]
    return (a, b) == (200, 403), f"foreign Host, no Origin={a}; Origin differs from Host={b}"


@ac("AC-27")
def ac_27(ctx):
    pr = Proc(ctx, [FIXTURE_SITE, "--host", "0.0.0.0", "--port", str(PORT_WARN)])
    try:
        pr.wait_for_stderr("Serving")
        err = pr.stderr()
        listening = sh(["./tests/listening.sh", str(PORT_WARN)], cwd=ROOT).stdout.split()
        wildcard = any(a in (f"*:{PORT_WARN}", f"0.0.0.0:{PORT_WARN}") for a in listening)
        running = pr.proc.poll() is None
    finally:
        pr.stop()
    ok = "WARNING" in err and "exposes" in err and wildcard and running
    return ok, f"warning={'WARNING' in err and 'exposes' in err} listening={listening} still_running={running}"


@ac("AC-37")
def ac_37(ctx):
    srv = server(ctx)
    get(PORT, "/files/%0d%0aX")
    time.sleep(0.2)
    raw = srv.stderr()
    lines = [ln for ln in raw.split("\n") if "%0d%0aX" in ln]
    has_cr = "\r" in raw
    stray = [ln for ln in raw.split("\n") if ln == "X"]
    request_ok = len(lines) == 1 and lines[0].startswith("denied:") and not has_cr and not stray
    # A request path never reaches the log with real control bytes, so also try the one input that can:
    # a directory whose name contains a newline and tries to forge a WARNING line.
    outer = tempfile.mkdtemp(prefix="docs-browser-forge-")
    forged = os.path.join(outer, "x\nWARNING: forged line\ny")
    os.makedirs(forged)
    open(os.path.join(forged, "a.md"), "w").write("# a")
    pr = Proc(ctx, [forged, "--port", "4117"])
    try:
        pr.wait_for_stderr("Serving")
        err = pr.stderr()
    finally:
        pr.stop()
        shutil.rmtree(outer, ignore_errors=True)
    forged_lines = [ln for ln in err.split("\n") if ln.startswith("WARNING: forged")]
    name_ok = len(err.strip().split("\n")) == 1 and not forged_lines and "\\x0a" in err
    return request_ok and name_ok, (f"request: denied lines={len(lines)} carriage_returns={has_cr}; "
                                    f"directory name: stderr lines={len(err.strip().splitlines())} forged_lines={len(forged_lines)}")


@ac("AC-60")
def ac_60(ctx):
    a = run_cli(ctx, ["/no/such/dir"])
    b = run_cli(ctx, [os.path.join(FIXTURE_SITE, "README.md")])
    locked = tempfile.mkdtemp(prefix="docs-browser-locked-")
    os.chmod(locked, 0)
    try:
        if os.access(locked, os.R_OK | os.X_OK):
            c = None  # running as root: permission checks are bypassed, so this case cannot be tested
        else:
            c = run_cli(ctx, [locked])
    finally:
        os.chmod(locked, 0o755)
        os.rmdir(locked)
    ok = (a[0] == 2 and "error: directory not found: /no/such/dir" in a[2]
          and b[0] == 2 and "error: not a directory:" in b[2]
          and (c is None or (c[0] == 2 and "error: cannot read directory:" in c[2])))
    unreadable = "skipped (root)" if c is None else f"exit={c[0]} {c[2].strip()[:60]!r}"
    return ok, f"missing dir: exit={a[0]}; file: exit={b[0]} {b[2].strip()[:50]!r}; unreadable dir: {unreadable}"


@ac("AC-61")
def ac_61(ctx):
    with Server(ctx["bin"], FIXTURE_SITE, 4110):
        code, _, err = run_cli(ctx, [FIXTURE_SITE, "--port", "4110"])
    return code == 1 and "error: cannot bind 127.0.0.1:4110" in err, f"exit={code} stderr={err.strip()[:90]!r}"


@ac("AC-62")
def ac_62(ctx):
    pr = Proc(ctx, [FIXTURE_SITE, "--port", "0"])
    try:
        pr.wait_for_stderr("Serving")
        m = re.search(r"http://127\.0\.0\.1:(\d+)", pr.stderr())
        port = int(m.group(1)) if m else 0
        status = get(port, "/")[0] if port else None
    finally:
        pr.stop()
    return port != 0 and status == 200, f"port={port} status={status}"


def _open_check(ctx, port, extra, want_url):
    """`--open` launches the real default browser on macOS, so there it only runs when the environment
    variable DOCS_BROWSER_SUITE_OPEN=1 is set (one tab to a dead localhost URL opens per check).
    On Linux there is no browser, so the failure path is checked instead: a warning, and the server
    keeps serving."""
    if ctx["platform"] == "darwin" and not os.environ.get("DOCS_BROWSER_SUITE_OPEN"):
        raise Skip("would open a real browser tab; set DOCS_BROWSER_SUITE_OPEN=1 to run it")
    pr = Proc(ctx, [FIXTURE_SITE, "--port", str(port), "--open"] + extra)
    try:
        pr.wait_for_stderr("Serving")
        time.sleep(1.5)  # the opener runs right after the startup line
        err = pr.stderr()
        status = get(port, "/")[0]
    finally:
        pr.stop()
    if ctx["platform"] == "darwin":
        accepted = "could not open a browser" not in err
        return accepted and status == 200, (f"the OS accepted the request to open {want_url} (open::that returned Ok, "
                                            f"no warning); server_status={status}")
    ok = f"warning: could not open a browser for {want_url}" in err and status == 200
    return ok, f"warning_for_{want_url}={ok} server_status={status}"


@ac("AC-63")
def ac_63(ctx):
    return _open_check(ctx, 4111, [], "http://127.0.0.1:4111/")


@ac("AC-68")
def ac_68(ctx):
    return _open_check(ctx, 4112, ["--host", "0.0.0.0"], "http://127.0.0.1:4112/")


@ac("AC-64")
def ac_64(ctx):
    h = run_cli(ctx, ["--help"])
    v = run_cli(ctx, ["--version"])
    flags = ["--port", "--host", "--open", "--include-hidden", "--verbose"]
    missing = [f for f in flags if f not in h[1]]
    if "[default: 4747]" not in h[1]:
        missing.append("[default: 4747]")
    return h[0] == 0 and v[0] == 0 and not missing and "docs-browser" in v[1], f"help exit={h[0]} missing={missing} version={v[1].strip()!r}"


@ac("AC-65")
def ac_65(ctx):
    home = tempfile.mkdtemp(prefix="docs-browser-home-")
    cwd = tempfile.mkdtemp(prefix="docs-browser-cwd-")
    pr = Proc(ctx, [FIXTURE_SITE, "--port", "4113"], env={"HOME": home}, cwd=cwd)
    try:
        started = pr.wait_for_stderr("Serving")
        status = get(4113, "/")[0] if started else None
        first = pr.stderr().splitlines()[0] if pr.stderr() else ""
    finally:
        pr.stop()
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(cwd, ignore_errors=True)
    return status == 200 and first.startswith("Serving "), f"empty HOME and cwd: status={status} first_line={first[:60]!r}"


@ac("AC-66")
def ac_66(ctx):
    paths = ["/files/../../etc/hosts", "/files/%2e%2e/%2e%2e/etc/hosts", "/files/%252e%252e/etc/hosts",
             "/files//a", "/api/file?path=../../etc/hosts", "/api/file?path=/etc/hosts",
             "/api/file?path=docs%5C..%5C..%5Cetc%5Chosts", "/api/file?path=README.md%00"]
    result = {}
    for label, port, extra in (("default", 4114, []), ("verbose", 4115, ["--verbose"])):
        pr = Proc(ctx, [FIXTURE_SITE, "--port", str(port)] + extra)
        try:
            pr.wait_for_stderr("Serving")
            for t in paths:
                get(port, t)
            time.sleep(0.3)
            err = pr.stderr()
        finally:
            pr.stop()
        denied = sum(1 for ln in err.splitlines() if ln.startswith("denied:"))
        per_request = sum(1 for ln in err.splitlines() if re.match(r"^(GET|HEAD|POST|PUT) \S+ \d{3} \d+ms$", ln))
        result[label] = (denied, per_request)
    ok = (result["default"][0] >= len(paths) and result["verbose"][0] >= len(paths)
          and result["default"][1] == 0 and result["verbose"][1] >= len(paths))
    return ok, f"(denied lines, per-request lines): default={result['default']} verbose={result['verbose']}"


@ac("AC-69")
def ac_69(ctx):
    pr = Proc(ctx, [ROOT, "--port", "80"])
    try:
        try:
            code = pr.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            return False, "the server started: an unprivileged bind to port 80 is allowed here (on Linux the container needs --sysctl net.ipv4.ip_unprivileged_port_start=1024)"
        err = pr.stderr()
    finally:
        pr.stop()
    ok = code == 1 and "error: cannot bind" in err and "Permission denied" in err
    return ok, f"exit={code} stderr={err.strip()[:100]!r} (the reason must be 'Permission denied', not a busy port)"


@ac("AC-67")
def ac_67(ctx):
    """Benchmark on the PRD 3.1 workload: 5,000 files of 4 KB, depth 6. With --write-benchmark on macOS it
    also writes docs/benchmark.md. It fails only if the server never answers; missed targets are listed."""
    root = tempfile.mkdtemp(prefix="docs-browser-bench-")
    started = first = repeat = None
    try:
        body = ("# Heading\n\n" + "lorem ipsum dolor sit amet " * 150 + "\n")[:4096]
        for i in range(5000):
            parts = [f"l{k}_{(i // (5 ** k)) % 5}" for k in range(5)]
            d = os.path.join(root, *parts)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, f"f{i:05d}.md"), "w") as f:
                f.write(body)
        t0 = time.time()
        pr = Proc(ctx, [root, "--port", "4116"])
        try:
            while time.time() - t0 < 10:
                try:
                    if get(4116, "/")[0] == 200:  # a real response: the tree scan has finished too
                        started = time.time() - t0
                        break
                except OSError:
                    time.sleep(0.005)
            if started is not None:
                t1 = time.time(); get(4116, "/api/tree"); first = time.time() - t1
                t2 = time.time(); get(4116, "/api/tree"); repeat = time.time() - t2
        finally:
            pr.stop()
    finally:
        shutil.rmtree(root, ignore_errors=True)
    if started is None:
        return False, "the server never answered within 10 s"
    size = os.path.getsize(ctx["bin"]) / (1024 * 1024)
    targets = [("Process start to the first response", started, 0.5), ("`GET /api/tree`, first request", first, 1.0),
               ("`GET /api/tree`, repeat (cached)", repeat, 0.05)]
    lines = ["# Benchmark (PRD 3.1)", "",
             f"Measured by `tests/suite.py` (AC-67) on {ctx['platform']}, release build `{os.path.basename(ctx['bin'])}`.",
             "Workload: 5,000 Markdown files of about 4 KB each, directory depth 6, warm file cache, one run.", "",
             "| Measure | Target | Measured | Met |", "|---|---|---|---|"]
    misses = []
    for name, got, limit in targets:
        met = got <= limit
        if not met:
            misses.append(name)
        target_txt = f"<= {limit * 1000:.0f} ms" if limit < 1 else f"<= {limit:g} s"
        lines.append(f"| {name} | {target_txt} | {got * 1000:.0f} ms | {'yes' if met else 'NO'} |")
    lines.append("| File saved to preview re-rendered | <= 2 s | measured by the AC-43 row of the suite | see AC-43 |")
    lines.append(f"| Release binary size | recorded | {size:.1f} MiB | n/a |")
    lines += ["", "Misses: " + (", ".join(misses) if misses else "none") + "."]
    if ctx["platform"] == "darwin" and ctx.get("write_benchmark"):
        with open(os.path.join(ROOT, "docs", "benchmark.md"), "w") as f:
            f.write("\n".join(lines) + "\n")
    return True, (f"start={started * 1000:.0f}ms first_tree={first * 1000:.0f}ms repeat_tree={repeat * 1000:.0f}ms "
                  f"binary={size:.1f}MiB misses={misses or 'none'}")


# ---------------------------------------------------------------- driver
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--milestone", default="all")
    p.add_argument("--platform", default=sys.platform)
    p.add_argument("--bin", default=os.path.join(ROOT, "target", "release", "docs-browser"))
    p.add_argument("--chrome", default=None, help="Chrome binary for the browser checks")
    p.add_argument("--write-benchmark", action="store_true", help="AC-67: write docs/benchmark.md (macOS)")
    p.add_argument("--only", default="", help="comma-separated IDs to run (default: all rows of the milestone)")
    args = p.parse_args()

    if not os.path.exists(FIXTURE_SITE):
        sh(["./tests/make-fixtures.sh"], cwd=ROOT)
    if not os.path.exists(args.bin):
        if args.bin == os.path.join(ROOT, "target", "release", "docs-browser"):
            sh(["cargo", "build", "--release", "--quiet"], cwd=ROOT)
    args.bin = os.path.abspath(args.bin)
    ctx = {"bin": args.bin, "platform": args.platform, "servers": {}, "chrome": args.chrome,
           "write_benchmark": args.write_benchmark}
    atexit.register(lambda: [s.stop() for s in ctx["servers"].values()])
    rows = prd_rows()
    sel = [(i, m) for i, m in rows if args.milestone in ("all", m)]
    if args.only:
        wanted = set(args.only.split(","))
        sel = [(i, m) for i, m in sel if i in wanted]
    results = []
    for ac_id, m in sel:
        fn = REGISTRY.get(ac_id)
        if fn is None and ac_id.startswith("UT-"):
            fn = cargo_unit_test
        if fn is None:
            results.append((ac_id, m, "TODO", "not implemented in the runner yet"))
            continue
        ctx["id"] = ac_id
        try:
            ok, note = fn(ctx)
            results.append((ac_id, m, "PASS" if ok else "FAIL", note))
        except Skip as e:
            results.append((ac_id, m, "SKIP", str(e)))
        except Exception as e:  # noqa: BLE001
            results.append((ac_id, m, "FAIL", f"exception: {e}"))

    print(f"platform: {args.platform}")
    print("ID | M | status | note")
    print("---|---|--------|-----")
    for r in results:
        print(" | ".join(r))
    counts = {}
    for r in results:
        counts[r[2]] = counts.get(r[2], 0) + 1
    print("summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    sys.exit(0 if all(r[2] == "PASS" for r in results) else 1)


if __name__ == "__main__":
    main()
