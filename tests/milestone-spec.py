#!/usr/bin/env python3
"""Writes .claude/reviewer/specs/<M>.md: the PRD slice for one milestone (tasks, criteria, key rules).

Usage: tests/milestone-spec.py M0
The checkpoint review (`/reviewer:result`) reads this file as its spec, so that coverage is judged
against the milestone's own scope, not the whole PRD.
"""
import os
import re
import sys

m = sys.argv[1]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
prd = open(os.path.join(root, "PRD.md"), encoding="utf-8").read()

sec16 = prd.split("## 16.")[1]
parts = re.split(r"^### (M\d) —", sec16, flags=re.M)
task_block = ""
for i in range(1, len(parts), 2):
    if parts[i] == m:
        task_block = parts[i + 1]
        break
if not task_block:
    sys.exit(f"milestone {m} not found")

rows = [l for l in prd.splitlines() if re.match(rf"^\| (?:AC|UT)-\d+[a-c]? \| {m} \|", l)]

out = [f"# Spec slice for milestone {m} (generated from PRD.md; the PRD is the source of truth)", ""]
out.append("Scope: only the tasks and criteria below belong to this milestone. Requirements outside it are NOT expected in the diff.")
out.append("")
out.append(f"## Tasks ({m})")
out.append(task_block.strip())
out.append("")
out.append(f"## Acceptance criteria and unit tests owned by {m}")
out.append("| ID | M | Requirement / Test | Verification | Expected |")
out.append("|---|---|---|---|---|")
out.extend(rows if rows else ["| (none) | | | | |"])
out.append("")
out.append("## Full PRD")
out.append("The complete requirements are in <repo>/PRD.md (sections 6 to 12 for behaviour, section 13 for criteria, section 16 for tasks).")

dest = os.path.join(root, ".claude", "reviewer", "specs")
os.makedirs(dest, exist_ok=True)
path = os.path.join(dest, f"{m}.md")
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
print(path)
