#!/usr/bin/env bash
# Runs the browser checks (tests/browser.mjs) against a docs-browser built and served INSIDE a Linux
# container, while Chrome runs on the host. The container uses `--network host`, so the server stays
# bound to 127.0.0.1 and Chrome reaches it with `Host: 127.0.0.1:<port>` (measured in
# docs/spikes/host-dependent-acs.md). Usage: tests/linux-browser.sh [AC-04,AC-05,...]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ids="${1:-AC-03b,AC-04,AC-05,AC-06,AC-07b,AC-09,AC-10,AC-12b,AC-13b,AC-14b,AC-15,AC-17,AC-40,AC-41,AC-42,AC-43,AC-44,AC-45,AC-46,AC-47,AC-52,AC-53,AC-54}"
name="docs-browser-linux-$$"
cargo_vol=docs-browser-cargo
target_vol=docs-browser-target

for port in 4100 4102; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use on the host" >&2; exit 2
  fi
done

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Named volumes cache the toolchain downloads and build output between runs; hand them to uid 1000.
docker run --rm -v $cargo_vol:/c -v $target_vol:/t rust:1 chown 1000:1000 /c /t >/dev/null

docker run -d --name "$name" --network host --user 1000:1000 \
  -e HOME=/tmp/home -e CARGO_HOME=/tmp/cargo-home -e CARGO_TARGET_DIR=/tmp/target \
  -v $cargo_vol:/tmp/cargo-home -v $target_vol:/tmp/target -v "$root":/src:ro \
  rust:1 bash -c '
    set -e
    mkdir -p /tmp/home /tmp/work && cd /src && tar --exclude=./target --exclude=./.git --exclude=./tests/fixtures -cf - . | tar -xf - -C /tmp/work
    cd /tmp/work
    cargo build --release --quiet 2>&1 | grep -E "^error" || true
    ./tests/make-fixtures.sh >/dev/null
    python3 - <<PY
import os
for d in range(60):
    os.makedirs(f"/tmp/big/d{d:02d}", exist_ok=True)
    for i in range(1000):
        open(f"/tmp/big/d{d:02d}/f{i:04d}.md", "w").write("# f\n")
PY
    /tmp/target/release/docs-browser tests/fixtures/site --port 4100 2>/tmp/s1.err &
    /tmp/target/release/docs-browser /tmp/big --port 4102 2>/tmp/s2.err &
    echo "rustc: $(rustc --version)  uname: $(uname -sr)" > /tmp/info
    wait
  ' >/dev/null

for _ in $(seq 1 240); do
  if curl -sf -o /dev/null http://127.0.0.1:4100/ && curl -sf -o /dev/null http://127.0.0.1:4102/; then break; fi
  sleep 1
done
curl -sf -o /dev/null http://127.0.0.1:4100/ || { echo "server in the container did not come up" >&2; docker logs "$name" >&2; exit 1; }
echo "container: $(docker exec "$name" cat /tmp/info)"

main_ids="$(echo "$ids" | tr ',' '\n' | grep -v '^AC-14b$' | paste -sd, -)"
# Fixture edits and server restarts for the live-reload checks happen inside the container.
node "$root/tests/browser.mjs" --base http://127.0.0.1:4100 --ids "$main_ids" \
  --docker "$name" --croot /tmp/work/tests/fixtures/site --cbin /tmp/target/release/docs-browser > /tmp/linux-browser-main.json
node "$root/tests/browser.mjs" --base http://127.0.0.1:4102 --ids AC-14b > /tmp/linux-browser-big.json
python3 - <<'PY'
import json
rows = json.load(open("/tmp/linux-browser-main.json")) + json.load(open("/tmp/linux-browser-big.json"))
print("ID | status | note")
for r in rows:
    print(f"{r['id']} | {'PASS' if r['ok'] else 'FAIL'} | {r['note'][:110]}")
bad = [r for r in rows if not r["ok"]]
print(f"summary: PASS={len(rows)-len(bad)}, FAIL={len(bad)}")
raise SystemExit(1 if bad else 0)
PY
