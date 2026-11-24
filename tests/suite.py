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
        self.proc = subprocess.Popen(
            [self.binary, self.root, "--port", str(self.port)] + self.extra,
            stdout=subprocess.DEVNULL,
            stderr=open(self.stderr_path, "wb"),
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
        if self.stderr_path and os.path.exists(self.stderr_path):
            os.unlink(self.stderr_path)

    def __enter__(self):
        return self.start()

    def __exit__(self, *a):
        self.stop()


PORT = 4100          # default-mode server (PRD 13)
PORT_HIDDEN = 4101   # --include-hidden server
PORT_BIG = 4102      # 60,000-file tree


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
        ({}, 200),
    ]
    got = []
    for kw, want in cases:
        status, _, _ = get(PORT, "/api/tree", **kw)
        got.append((status, want))
    # A rejection must carry the security headers too (they are stamped by the outermost layer).
    _, h403, _ = get(PORT, "/api/tree", host="evil.example:4100")
    hdr_ok = h403.get("x-content-type-options") == "nosniff" and h403.get("cache-control") == "no-store"
    ok = all(a == b for a, b in got) and hdr_ok
    return ok, f"got/want={got} 403_headers_ok={hdr_ok}"


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
               "AC-13b", "AC-15", "AC-17", "AC-40", "AC-41", "AC-42"]


def run_browser(ctx, base, ids):
    """Runs tests/browser.mjs once and returns {id: (ok, note)}."""
    chrome = ctx.get("chrome") or os.environ.get("CHROME_BIN") or CHROME_DEFAULT
    if shutil.which("node") is None:
        raise Skip("node not found")
    if not os.path.exists(chrome):
        raise Skip(f"Chrome not found at {chrome}")
    r = sh(["node", "tests/browser.mjs", "--base", base, "--chrome", chrome, "--ids", ",".join(ids)], cwd=ROOT)
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


# ---------------------------------------------------------------- driver
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--milestone", default="all")
    p.add_argument("--platform", default=sys.platform)
    p.add_argument("--bin", default=os.path.join(ROOT, "target", "release", "docs-browser"))
    p.add_argument("--chrome", default=None, help="Chrome binary for the browser checks")
    args = p.parse_args()

    if not os.path.exists(FIXTURE_SITE):
        sh(["./tests/make-fixtures.sh"], cwd=ROOT)
    if not os.path.exists(args.bin):
        if args.bin == os.path.join(ROOT, "target", "release", "docs-browser"):
            sh(["cargo", "build", "--release", "--quiet"], cwd=ROOT)
    ctx = {"bin": args.bin, "platform": args.platform, "servers": {}, "chrome": args.chrome}
    atexit.register(lambda: [s.stop() for s in ctx["servers"].values()])
    rows = prd_rows()
    sel = [(i, m) for i, m in rows if args.milestone in ("all", m)]
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
