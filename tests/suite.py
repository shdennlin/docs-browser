#!/usr/bin/env python3
"""Runs the PRD section 13 acceptance criteria and prints `ID | M | status | note`.

Every AC and UT row found in PRD.md section 13 appears in the output. A row with no
implementation is reported as TODO and counts as not passing. Exit code is 0 only when
every selected row passes.

Usage: tests/suite.py [--milestone M0|M1|...|all] [--platform NAME] [--bin PATH]
"""
import argparse
import hashlib
import http.client
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

    def __enter__(self):
        fd, self.stderr_path = tempfile.mkstemp(prefix="docs-browser-stderr-")
        os.close(fd)
        self.proc = subprocess.Popen(
            [self.binary, self.root, "--port", str(self.port)] + self.extra,
            stdout=subprocess.DEVNULL,
            stderr=open(self.stderr_path, "wb"),
        )
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                return self
            except OSError:
                if self.proc.poll() is not None:
                    break
                time.sleep(0.1)
        raise RuntimeError("server did not start; stderr: " + open(self.stderr_path).read())

    def __exit__(self, *a):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGINT)
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.stderr_path and os.path.exists(self.stderr_path):
            os.unlink(self.stderr_path)



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


# ---------------------------------------------------------------- driver
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--milestone", default="all")
    p.add_argument("--platform", default=sys.platform)
    p.add_argument("--bin", default=os.path.join(ROOT, "target", "release", "docs-browser"))
    args = p.parse_args()

    ctx = {"bin": args.bin, "platform": args.platform}
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
