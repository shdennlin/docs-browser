#!/usr/bin/env bash
# The whole PRD section 13 suite, plus `make test`, in ONE Linux container (T-5.3, Linux half).
# The container (rust:1) builds the project as uid 1000, installs Chromium with apt for the browser
# checks, and gets the node 22 binary from the node:22-slim image (rust:1 has no node). The
# --sysctl lets AC-69 see that an unprivileged user cannot bind port 80. Output: `make test` and one
# `ID | M | status | note` row per criterion. Usage: tests/linux-suite.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
docker volume create docs-browser-node >/dev/null
docker run --rm -v docs-browser-node:/n node:22-slim sh -c 'cp /usr/local/bin/node /n/node && chmod 755 /n/node'

exec docker run --rm --shm-size=1g --sysctl net.ipv4.ip_unprivileged_port_start=1024 \
  -v docs-browser-node:/opt/node:ro -v "$root":/src:ro rust:1 bash -c '
    set -e
    # root phase: a browser for the browser checks
    apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends chromium >/dev/null 2>&1
    echo "chromium: $(chromium --version 2>/dev/null | head -1)   xdg-open present: $(command -v xdg-open || echo no)"
    # user phase: everything else runs as an unprivileged user
    mkdir -p /tmp/home /tmp/work /tmp/target /tmp/cargo-home
    chown -R 1000:1000 /tmp/home /tmp/work /tmp/target /tmp/cargo-home
    setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/tmp/home CARGO_HOME=/tmp/cargo-home \
      CARGO_TARGET_DIR=/tmp/target PATH=/opt/node:$PATH bash -c "
        set -e
        cd /src && tar --exclude=./target --exclude=./.git --exclude=./tests/fixtures -cf - . | tar -xf - -C /tmp/work
        cd /tmp/work
        echo \"uid=\$(id -u) \$(rustc --version) node=\$(node --version) python=\$(python3 --version) kernel=\$(uname -sr)\"
        cargo build --release --quiet 2>&1 | grep -E \"^error\" || true
        make test > /tmp/make-test.txt 2>&1 && echo \"make test exit=0\" || echo \"make test exit=\$?\"
        grep -E \"test result: ok. [0-9]+ passed|vendor selftest|^# (pass|fail)\" /tmp/make-test.txt
        python3 tests/suite.py --milestone all --platform linux --bin /tmp/target/release/docs-browser --chrome /usr/bin/chromium
      "
  '
