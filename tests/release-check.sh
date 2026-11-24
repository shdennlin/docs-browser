#!/usr/bin/env bash
# Release and rollback check (PRD 10.6, T-5.5): install two tags from this repository, run the smoke
# subset (AC-01, AC-07a, AC-20, AC-21, AC-25) against each installed binary, then roll back by
# installing the older tag over the newer one and run the smoke subset again.
# Usage: tests/release-check.sh OLD_TAG NEW_TAG
set -euo pipefail

old="${1:?usage: release-check.sh OLD_TAG NEW_TAG}"
new="${2:?usage: release-check.sh OLD_TAG NEW_TAG}"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
status=0

install_tag() {
  cargo install --locked --git "file://$root" --tag "$1" --root "$tmp/root" --force --quiet 2>&1 | grep -vE "^(warning|note)" || true
  echo "installed $1 -> $("$tmp/root/bin/docs-browser" --version)"
}

smoke() {
  local out
  out="$(python3 "$root/tests/suite.py" --milestone M2 --only AC-01,AC-07a,AC-20,AC-21,AC-25 --bin "$tmp/root/bin/docs-browser")" || status=1
  echo "$out" | grep -E "\| (PASS|FAIL|SKIP) \||summary" | cut -c1-110
}

echo "== install $old";  install_tag "$old"; smoke
echo "== install $new";  install_tag "$new"; smoke
echo "== roll back: install $old over $new"; install_tag "$old"; smoke
[ "$status" -eq 0 ] && echo "release check: OK" || echo "release check: FAILED"
exit "$status"
