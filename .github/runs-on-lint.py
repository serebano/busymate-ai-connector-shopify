#!/usr/bin/env python3
"""runs-on lint: no workflow in this repository may run on a GitHub-hosted runner.

Owner order 2026-11-04 ("Eliminate totally gh runners, we have our infra runners"): every serebano
repository, public or private, runs CI only on our own runners: the ephemeral k3s scale sets
(`ci-*`, `bmai-k8s-*`) and the Mac runner (`[self-hosted, bm-mac]`). Same rule and matcher as
busymate-ai-src scripts/ci/runs-on-lint.mjs (src#3468), without its public-repo exemption.

Reads every workflow and composite action under .github/ as TEXT (no YAML parse), so a plain
`runs-on:`, a list, a matrix entry (`os: [ubuntu-latest]`) and an expression fallback
(`... || 'ubuntu-24.04'`) are all caught. A non-comment line naming ubuntu-*, macos-* or windows-*
(latest, a version, or a variant such as ubuntu-24.04-arm) fails. Comments are ignored.
Limit: a label that only exists at run time (a repo variable) is invisible here.

Usage: python3 .github/runs-on-lint.py [repo_root]    Exit: 0 clean, 1 hosted label or no workflows.
"""
import re
import sys
from pathlib import Path

HOSTED = re.compile(r"(?<![\w.-])(ubuntu|macos|windows)-(latest|\d[\w.-]*)(?![\w-])", re.IGNORECASE)


def strip_comment(line):
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1].isspace()):
            return line[:i]
    return line


def main(argv):
    root = Path(argv[1] if len(argv) > 1 else ".").resolve()
    gh = root / ".github"
    files = sorted(p for p in gh.rglob("*") if p.is_file() and p.suffix in (".yml", ".yaml")
                   and ("workflows" in p.parts or "actions" in p.parts)) if gh.is_dir() else []
    if not files:
        print("runs-on lint: UNVERIFIED, no workflow files under .github/ (fails closed)", file=sys.stderr)
        return 1
    bad = []
    for f in files:
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if HOSTED.search(strip_comment(line)):
                bad.append((f.relative_to(root), n, line.strip()))
    if bad:
        print("runs-on lint: GitHub-hosted runner label (owner order 2026-11-04: our runners only, "
              "e.g. ci-<repo> on k3s or [self-hosted, bm-mac]):", file=sys.stderr)
        for f, n, text in bad:
            print(f"::error file={f},line={n}::{text}", file=sys.stderr)
        return 1
    print(f"runs-on lint: {len(files)} workflow file(s), no GitHub-hosted labels")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
