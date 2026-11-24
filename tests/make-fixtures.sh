#!/usr/bin/env bash
# Builds tests/fixtures/site (PRD section 13.0). Safe to re-run: it recreates the tree.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
base="$here/fixtures"
site="$base/site"

rm -rf "$base"
mkdir -p "$site" "$base/site-evil"

# Outside-root sibling whose name shares the root's prefix.
printf '# secret\nOUTSIDE-ROOT\n' > "$base/site-evil/secret.md"
printf '# outside\n' > "$base/outside.md"

cd "$site"
mkdir -p docs/subdir docs/dir.md .git .hidden node_modules/pkg loop

cat > README.md <<'MD'
# Root README

See [architecture](docs/architecture.md) and [flow](docs/flow.html).

- [x] task done
- [ ] task open

| a | b |
|---|---|
| 1 | 2 |
MD

printf 'plain text note\n' > notes.txt
printf 'SECRET=1\n' > .env
printf '[core]\n\trepositoryformatversion = 0\n' > .git/config
printf '# Hidden note\n' > .hidden/note.md
printf '# pkg\n' > node_modules/pkg/index.md

cat > docs/architecture.md <<'MD'
# Architecture

```mermaid
flowchart LR
    Browser --> API
    API --> Database
```

![diagram](./diagram.svg)
MD

cat > docs/bad-mermaid.md <<'MD'
# Bad Mermaid Page

```mermaid
flowchart LR
    A --> --> B [[[
```
MD

cat > docs/links.md <<'MD'
# Links

[x](javascript:alert(1))

[ok](./api.md)

[out](../../outside.md)

[t](../notes.txt)
MD

{
  echo "# Long page"
  for i in $(seq 1 200); do echo; echo "Paragraph $i."; done
  echo
  echo "## Bottom"
  echo
  echo "end"
} > docs/long.md

# 6 MiB Markdown file (above the 5 MiB cap).
head -c 6291456 /dev/zero | tr '\0' 'a' > docs/big.md

# Invalid UTF-8 bytes inside an otherwise valid Markdown file.
printf '# Bad bytes\n\nbefore \xff\xfe\xfa after\n' > docs/utf8-bad.md

printf '# API\n\nBack to [root](../README.md)\n' > docs/api.md
cat > docs/search-target.md <<'MD'
# Search target

This line has the unique word zebra-needle-42 inside it.

Another line without it.
MD
{
  echo '# Outline page'
  for i in 1 2 3 4; do
    echo; echo "## Section $i"; echo
    for j in $(seq 1 40); do echo "Line $j of section $i."; echo; done
  done
} > docs/outline.md
{
  echo '# Toc page'
  echo
  echo '- [Executive Summary](#executive-summary)'
  echo '- [Workflow](#workflow)'
  echo '  - [🤖 Automation Mode](#-automation-mode)'
  echo '  - [How to Choose?](#how-to-choose)'
  echo '- [Threat Detection & Response](#threat-detection--response)'
  echo '- [Repeat](#repeat-1)'
  echo '- [Threat again](#%EF%B8%8F-threat-detection--response)'
  echo '- [Gone heading](#no-such-heading)'
  for h in '## Executive Summary' '## Workflow' '### 🤖 Automation Mode' '### How to Choose?' '## 🛡️ Threat Detection & Response' '## Repeat' '## Repeat'; do
    echo; echo "$h"; echo
    for j in $(seq 1 30); do echo "Filler $j."; echo; done
  done
} > docs/toc.md
cat > docs/code.md <<'MD'
# Code sample

## Second level

```js
const answer = 42; // a keyword and a number
function f() { return answer; }
```

[a link](./api.md) and `inline code`.
MD
printf '# Upper extension\n' > docs/UPPER.MD
printf '# CJK name\n' > "docs/中文 筆記.md"
printf '# Relative image\n\n![d](../diagram.svg)\n' > docs/subdir/rel.md

cat > docs/flow.html <<'HTML'
<!doctype html>
<html>
<head><meta charset="utf-8"><title>flow</title><link rel="stylesheet" href="./style.css"></head>
<body>
<h1 id="h">HTML flow page</h1>
<img id="img" src="./diagram.svg" width="40" height="40">
<pre id="report">pending</pre>
<script src="./app.js"></script>
</body>
</html>
HTML

echo 'h1 { color: rgb(255, 0, 0); }' > docs/style.css

# Reports what the sandbox allows. parentAccess is only meaningful when framed.
cat > docs/app.js <<'JS'
(function () {
  var report = { type: 'fixture-report', ran: true, parentAccess: 'n/a', apiFetch: 'pending' };
  if (window.parent !== window) {
    report.parentAccess = 'blocked';
    try { void window.parent.document.title; report.parentAccess = 'LEAK'; } catch (e) {}
  }
  function done() {
    window.__fixtureReport = report;
    var el = document.getElementById('report');
    if (el) el.textContent = JSON.stringify(report);
    try { window.parent.postMessage(report, '*'); } catch (e) {}
    document.title = 'JS-RAN';
  }
  fetch('/api/tree')
    .then(function (r) { return r.text(); })
    .then(function () { report.apiFetch = 'LEAK'; })
    .catch(function () { report.apiFetch = 'blocked'; })
    .then(done);
})();
JS

printf '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>\n' > docs/diagram.svg

# Symlinks (cannot be committed reliably).
ln -s docs link-in
ln -s /etc link-out
ln -s ../site-evil evil
ln -s .git public
ln -s .. loop/self

echo "fixtures built at $site"
