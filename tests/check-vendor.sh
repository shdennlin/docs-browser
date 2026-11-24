#!/usr/bin/env bash
# Verifies frontend/vendor (PRD 12.6): every file listed in CHECKSUMS matches its SHA-256, and no
# unlisted code file exists in the folder. `--selftest` also proves that a flipped byte and an extra
# file are both detected.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

sha_check() {
  # $1 = directory holding the vendored files and CHECKSUMS
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$1" && sha256sum -c CHECKSUMS --quiet)
  else
    (cd "$1" && shasum -a 256 -c CHECKSUMS --quiet)
  fi
}

# The set of files in the folder (minus bookkeeping files) must equal the set of names in CHECKSUMS.
fileset_check() {
  local listed actual
  listed="$(awk '{print $2}' "$1/CHECKSUMS" | sed 's/^\*//' | LC_ALL=C sort)"
  actual="$(cd "$1" && ls -1 | grep -vE '^(CHECKSUMS|VERSIONS|LICENSE\..*)$' | LC_ALL=C sort)"
  if [[ "$listed" != "$actual" ]]; then
    echo "vendor file set differs from CHECKSUMS:" >&2
    diff <(printf '%s\n' "$listed") <(printf '%s\n' "$actual") >&2 || true
    return 1
  fi
}

full_check() { sha_check "$1" && fileset_check "$1"; }

full_check "$root/frontend/vendor"
echo "vendor checksums: OK"

if [[ "${1:-}" == "--selftest" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  # 1) a flipped byte must be detected
  cp "$root"/frontend/vendor/* "$tmp"/
  python3 - "$tmp/markdown-it.umd.min.js" <<'PY'
import sys
p = sys.argv[1]
b = bytearray(open(p, "rb").read())
b[len(b) // 2] ^= 0x01
open(p, "wb").write(b)
PY
  if full_check "$tmp" >/dev/null 2>&1; then
    echo "vendor selftest: FAIL (a flipped byte was not detected)" >&2
    exit 1
  fi

  # 2) an extra, unlisted file must be detected
  rm -rf "$tmp"/*
  cp "$root"/frontend/vendor/* "$tmp"/
  echo 'alert(1)' > "$tmp/extra.js"
  if full_check "$tmp" >/dev/null 2>&1; then
    echo "vendor selftest: FAIL (an unlisted file was not detected)" >&2
    exit 1
  fi
  echo "vendor selftest: OK (flipped byte and extra file both detected)"
fi
