#!/usr/bin/env bash
# Prints the address a TCP port is listening on, one per line (e.g. 127.0.0.1:4100).
# Uses lsof when present; otherwise parses /proc/net/tcp and /proc/net/tcp6 (Linux images without lsof).
set -euo pipefail
port="${1:?usage: listening.sh PORT}"

if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | sort -u
  exit 0
fi

hexport="$(printf '%04X' "$port")"
python3 - "$hexport" <<'PY'
import socket, struct, sys
hexport = sys.argv[1]
def v4(h):
    return socket.inet_ntoa(struct.pack("<I", int(h, 16)))
def v6(h):
    b = bytes.fromhex(h)
    b = b"".join(b[i:i+4][::-1] for i in range(0, 16, 4))
    return "[" + socket.inet_ntop(socket.AF_INET6, b) + "]"
for path, conv in (("/proc/net/tcp", v4), ("/proc/net/tcp6", v6)):
    try:
        lines = open(path).read().splitlines()[1:]
    except FileNotFoundError:
        continue
    for line in lines:
        f = line.split()
        local, state = f[1], f[3]
        addr, port = local.split(":")
        if port == hexport and state == "0A":  # 0A = LISTEN
            print(f"{conv(addr)}:{int(port, 16)}")
PY
