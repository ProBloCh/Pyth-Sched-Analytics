"""Minimal citation lint: find Author-Year patterns in source/docs and
verify each maps to a known entry in docs/research/papers.yaml.

This is the *minimum* useful version of the research-provenance idea.
It catches the failure mode of citations entering the codebase from
memory (a real failure mode this repo experienced -- see commit history
of the exceed-alice roadmap).  It does NOT auto-verify against
Crossref, render graphs, or maintain Karpathy-style sketches -- those
are deferred until the maintenance commitment is clear.

Usage::

    python tools/check_citations.py            # report; exit 0 always
    python tools/check_citations.py --strict   # exit 1 on unmatched

Suppress a false positive on any line by adding the literal token
``cite-ignore`` (e.g. in a comment or HTML comment).

The papers.yaml schema is intentionally simple -- a list of entries
with ``key``, ``title``, ``authors``, ``year``, optional ``doi`` /
``arxiv``, and an ``aliases`` list of every textual form the citation
takes in the codebase.  See docs/research/papers.yaml for examples.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PAPERS_YAML = REPO_ROOT / "docs" / "research" / "papers.yaml"

SCAN_DIRS = ("solver", "completion", "evm", "paths", "interface", "docs")
ROOT_FILES = ("app.py", "multi_resolution_pipeline.py",
              "CLAUDE.md", "REMAINING_WORK.md")
SCAN_GLOBS = ("*.py", "*.md")

_CITATION_RE = re.compile(
    r"\b"
    r"(?P<lead>[A-Z][A-Za-z'\-]{2,}"
    r"(?:\s*(?:&|and)\s*[A-Z][A-Za-z'\-]{2,})?"
    r"(?:\s+et\s+al\.?)?)"
    r"[\s,]*\(?"
    r"(?:PMJ\s+|JMIS\s+|NeurIPS\s+|ICML\s+)?"
    r"(?P<year>1[89][0-9]{2}|20[0-9]{2})"
    r"\)?"
)
_IGNORE = "cite-ignore"
_BLOCKLIST = frozenset({
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
    "Saturday", "Sunday", "January", "February", "March", "April",
    "May", "June", "July", "August", "September", "October",
    "November", "December", "ArXiv", "GitHub", "OpenAlex", "PyPI",
    "Crossref", "ISO", "Azure", "Redis", "NumPy", "SciPy", "PMI",
    "DCMA", "GAO",
})


def _normalise(lead: str) -> str:
    head = re.split(r"\s+(?:&|and)\s+|\s+et\s+al", lead, maxsplit=1)[0]
    return head.strip().lower()


def load_aliases(yaml_path: Path) -> dict[tuple[str, int], str]:
    """Build a (surname, year) -> paper-key index from papers.yaml.

    Uses a tiny hand-rolled YAML reader to avoid a PyYAML dependency
    just for this script.  Only handles the subset of YAML our
    papers.yaml actually uses (block-style sequences and mappings,
    quoted strings, simple scalars).
    """
    if not yaml_path.exists():
        return {}
    text = yaml_path.read_text(encoding="utf-8")

    # Strip header comments and the document marker.
    body_start = text.find("schema_version:")
    if body_start < 0:
        return {}

    out: dict[tuple[str, int], str] = {}
    current_key: str | None = None
    current_authors: list[str] = []
    current_year: int | None = None
    current_aliases: list[str] = []

    def commit():
        if current_key is None:
            return
        for alias in current_aliases:
            m = _CITATION_RE.match(alias.strip())
            if m:
                out[(_normalise(m.group("lead")),
                     int(m.group("year")))] = current_key
        if current_authors and current_year is not None:
            first = current_authors[0]
            surname = (first.split(",")[0]
                       if "," in first else first.split()[-1]).strip()
            key = (surname.lower(), current_year)
            out.setdefault(key, current_key)

    in_authors = in_aliases = False
    for raw in text[body_start:].splitlines():
        # Track list-item starts to commit previous entry.
        if re.match(r"^- key:\s*(\S+)", raw):
            commit()
            current_key = re.match(r"^- key:\s*(\S+)", raw).group(1).strip()
            current_authors = []
            current_year = None
            current_aliases = []
            in_authors = in_aliases = False
            continue

        m_year = re.match(r"^\s+year:\s*(\d+)", raw)
        if m_year and current_key:
            current_year = int(m_year.group(1))
            in_authors = in_aliases = False
            continue

        if re.match(r"^\s+authors:", raw):
            # inline list?
            inline = re.match(r"^\s+authors:\s*\[(.*)\]", raw)
            if inline:
                current_authors = [s.strip().strip('"').strip("'")
                                   for s in inline.group(1).split(",") if s.strip()]
                in_authors = False
            else:
                in_authors = True
                in_aliases = False
            continue

        if re.match(r"^\s+aliases:", raw):
            inline = re.match(r"^\s+aliases:\s*\[(.*)\]", raw)
            if inline:
                current_aliases = [s.strip().strip('"').strip("'")
                                   for s in inline.group(1).split(",") if s.strip()]
                in_aliases = False
            else:
                in_aliases = True
                in_authors = False
            continue

        if in_authors:
            m_item = re.match(r'^\s+-\s+["\'](.+)["\']\s*$', raw) or \
                     re.match(r'^\s+-\s+(.+)\s*$', raw)
            if m_item and not raw.lstrip().startswith("- key:"):
                current_authors.append(m_item.group(1).strip())
                continue
            in_authors = False

        if in_aliases:
            m_item = re.match(r'^\s+-\s+["\'](.+)["\']\s*$', raw) or \
                     re.match(r'^\s+-\s+(.+)\s*$', raw)
            if m_item and not raw.lstrip().startswith("- key:"):
                current_aliases.append(m_item.group(1).strip())
                continue
            in_aliases = False

    commit()
    return out


def iter_files(root: Path) -> list[Path]:
    paths: list[Path] = []
    for d in SCAN_DIRS:
        base = root / d
        if not base.exists():
            continue
        for pat in SCAN_GLOBS:
            paths.extend(p for p in base.rglob(pat)
                         if "__pycache__" not in p.parts)
    for f in ROOT_FILES:
        p = root / f
        if p.exists():
            paths.append(p)
    return paths


def scan(root: Path, alias_idx: dict[tuple[str, int], str]
         ) -> tuple[list[tuple[str, int, str, str]],
                    list[tuple[str, int, str]]]:
    matched: list[tuple[str, int, str, str]] = []
    unmatched: list[tuple[str, int, str]] = []
    for path in iter_files(root):
        rel = path.relative_to(root).as_posix()
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if _IGNORE in line:
                continue
            for m in _CITATION_RE.finditer(line):
                surname = _normalise(m.group("lead"))
                if not surname:
                    continue
                head = surname.split()[0].title()
                if head in _BLOCKLIST:
                    continue
                year = int(m.group("year"))
                key = alias_idx.get((surname, year))
                snippet = m.group(0).strip()
                if key:
                    matched.append((rel, lineno, snippet, key))
                else:
                    unmatched.append((rel, lineno, snippet))
    return matched, unmatched


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Lint codebase citations against docs/research/papers.yaml")
    parser.add_argument("--strict", action="store_true",
                        help="Exit 1 if any citation doesn't match a paper")
    parser.add_argument("--show-matched", action="store_true",
                        help="Print matched citations as well as unmatched")
    args = parser.parse_args(argv)

    alias_idx = load_aliases(PAPERS_YAML)
    if not alias_idx:
        print(f"WARN: {PAPERS_YAML.relative_to(REPO_ROOT)} not found "
              "or empty -- nothing to lint against.", file=sys.stderr)
        return 0

    matched, unmatched = scan(REPO_ROOT, alias_idx)

    print(f"Citation lint: {len(matched)} matched, "
          f"{len(unmatched)} unmatched, "
          f"{len(alias_idx)} aliases known.")

    if args.show_matched:
        for rel, line, snippet, key in matched[:50]:
            print(f"  ok    {rel}:{line}  {snippet!r} -> {key}")
        if len(matched) > 50:
            print(f"  ... ({len(matched) - 50} more matched)")

    if unmatched:
        print(f"\nUnmatched citations (add to papers.yaml or "
              f"add `{_IGNORE}` to suppress):")
        for rel, line, snippet in unmatched[:50]:
            print(f"  ??    {rel}:{line}  {snippet!r}")
        if len(unmatched) > 50:
            print(f"  ... ({len(unmatched) - 50} more)")

    if args.strict and unmatched:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
