#!/usr/bin/env python3
"""
CI gate: assert CLAUDE.md test counters match the live repo state.

PR-18 (Tier 4).  Closes the documented drift where CLAUDE.md still
claimed "157 tests" / "157 automated tests" after the suite grew to
~900.  Without this script, each feature PR has to remember to bump
the counters by hand -- and reviewers don't catch the drift because
it's not in the diff.

Two checks today:

1. The "**N across M test files**" line in CLAUDE.md matches the
   `pytest --collect-only` count and the test_*.py file count.
2. The "**Note:** The project has N automated tests" line matches.

Failing the script tells the author either:
* update CLAUDE.md to match the new state, OR
* if the suite was deliberately reduced, lower the canonical line.

Exits 0 on match, 1 on mismatch (with a diff-style message), 2 on
internal failure (CLAUDE.md missing, pytest crash, etc.).
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CLAUDE_MD = REPO_ROOT / 'CLAUDE.md'
TESTS_DIR = REPO_ROOT / 'tests'

# Match the two canonical lines:
#   Tests: **934 across 19 test files**, ...
#   **Note:** The project has 934 automated tests ...
RE_TESTS_HEADLINE = re.compile(
    r'\*\*(?P<n>\d+)\s+across\s+(?P<files>\d+)\s+test\s+files\*\*'
)
RE_TESTS_NOTE = re.compile(
    r'The project has (?P<n>\d+) automated tests'
)


def _live_test_count() -> int:
    """Run `pytest --collect-only` and parse `N tests collected`."""
    proc = subprocess.run(
        [sys.executable, '-m', 'pytest', 'tests/', '--collect-only', '-q'],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        print(f'pytest --collect-only failed (exit {proc.returncode})')
        print(proc.stderr)
        sys.exit(2)
    m = re.search(r'(\d+)\s+tests?\s+collected', proc.stdout)
    if not m:
        print('Could not parse `N tests collected` from pytest output:')
        print(proc.stdout[-500:])
        sys.exit(2)
    return int(m.group(1))


def _live_file_count() -> int:
    return sum(1 for _ in TESTS_DIR.glob('test_*.py'))


def main() -> int:
    if not CLAUDE_MD.is_file():
        print(f'CLAUDE.md not found at {CLAUDE_MD}')
        return 2

    src = CLAUDE_MD.read_text()
    headline = RE_TESTS_HEADLINE.search(src)
    note = RE_TESTS_NOTE.search(src)

    if not headline:
        print('Could not find "**N across M test files**" headline in CLAUDE.md')
        return 2
    if not note:
        print('Could not find "**Note:** The project has N automated tests" in CLAUDE.md')
        return 2

    claimed_count = int(headline.group('n'))
    claimed_files = int(headline.group('files'))
    note_count = int(note.group('n'))

    live_count = _live_test_count()
    live_files = _live_file_count()

    errors = []
    if claimed_count != live_count:
        errors.append(
            f'CLAUDE.md test headline says {claimed_count}, '
            f'pytest collected {live_count}.'
        )
    if claimed_files != live_files:
        errors.append(
            f'CLAUDE.md test headline says {claimed_files} test files, '
            f'found {live_files} test_*.py files in tests/.'
        )
    if note_count != live_count:
        errors.append(
            f'CLAUDE.md "Note:" says {note_count} automated tests, '
            f'pytest collected {live_count}.'
        )

    if errors:
        print('CLAUDE.md drift detected:')
        for e in errors:
            print(f'  * {e}')
        print()
        print('Fix: update CLAUDE.md to match the live counts.')
        print(f'  Tests collected:   {live_count}')
        print(f'  Test files:        {live_files}')
        return 1

    print(f'CLAUDE.md test counters match ({live_count} tests across '
          f'{live_files} files).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
