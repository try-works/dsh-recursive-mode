# recursive-status parity fixtures

Golden reference fixtures for the TypeScript port of
`skills/recursive-mode/scripts/recursive-status.py`. The Python runtime's
console output against `repo/.recursive/run/fixture-run/` is captured
byte-exactly into the two `expected-status*.txt` files; the TS port must
reproduce them.

Run 09 (TS-only): the plugin is python-free. The one-shot fixture-run
regenerator is `regen-fixtures.ts` (TypeScript). It rebuilds the fixture
RUNS (artifacts + real LockHashes + tamper + pinned mtimes) but intentionally
does NOT rewrite the golden `expected-status*.txt` files — those are the
canonical `recursive-status.py` oracle capture from run 07 and stay stable.
Regenerate fixture runs with:  `npx tsx tests/fixtures/regen-fixtures.ts`

## Layout

```
tests/fixtures/
  regen-fixtures.ts            # one-shot TS regenerator (rebuilds fixture runs only)
  expected-status.txt          # golden:  recursive-status.py --run-id fixture-run
  expected-status-with-hashes.txt  # golden: --run-id fixture-run --show-hashes
  README.md                    # this file
  repo/                        # fake, git-less repo
    .recursive/run/
      fixture-run/             # the parity run (see matrix below)
      older-run/               # exists only for latest-run selection
```

The fixture repo deliberately has **no `.git`** and **no `locks/` receipts**;
only `.recursive/run/<run-id>/*.md` artifacts exist. The `repo` tree is
untracked in git until committed (it is not ignored).

## State matrix (fixture-run)

Workflow profile is `memory-phase8` (COMPAT), declared in the `Workflow
version:` header of every artifact. This profile was chosen because:

- It is **not** `legacy`, so absent late-phase files (06/07/08) show
  `PENDING` rather than being folded to `SKIPPED`.
- It is **not** a STRICT profile, so audited phases need no audit sections and
  the git-less repo triggers no diff-basis errors.

| Artifact | On disk | Status field | Folded state | Fold reason |
| --- | --- | --- | --- | --- |
| `00-requirements.md` | yes | `LOCKED` | `LOCKED` | Lock-valid: LockedAt + matching LockHash + Coverage/Approval PASS + fully checked TODO. Phase 0 is not audited, so no Audit gate needed. |
| `00-worktree.md` | yes | `LOCKED` | `LOCKED` | Same minimal lock-valid structure. |
| `01-as-is.md` | yes | `DRAFT` | `DRAFT` | No lock fields; audited phase but profile is COMPAT so gates may be anything. |
| `01.5-root-cause.md` | absent | — | `SKIPPED` | Optional phase, never created → `(not needed)`. |
| `02-to-be-plan.md` | yes | `DRAFT` | `DRAFT` | No lock fields. |
| `03-implementation-summary.md` | absent | — | `PENDING` | Mandatory, missing → blockers: `File missing`. |
| `03.5-code-review.md` | absent | — | `SKIPPED` | Optional phase, never created. |
| `04-test-summary.md` | absent | — | `PENDING` | Mandatory, missing. |
| `05-manual-qa.md` | yes | `LOCKED` | `LOCKED*` (invalid) | Lock-valid when written, then a `tamper-marker` line was appended **after** the `LockHash` line so the stored hash no longer matches → `LockHash mismatch`. Phase 5 is not audited, so no Audit gate needed. |
| `06-decisions-update.md` | absent | — | `PENDING` | Mandatory, missing. |
| `07-state-update.md` | absent | — | `PENDING` | Mandatory, missing. |
| `08-memory-impact.md` | absent | — | `PENDING` | Mandatory, missing. |

Current phase: `1 (AS-IS)` (first artifact that exists but is not lock-valid).

### Expected phase table (the parity contract)

```
Phase 0 (Requirements)     [LOCKED]
Phase 0 (Worktree)         [LOCKED]
Phase 1 (AS-IS)            [DRAFT]        blockers: Unchecked TODO items: 1; Coverage gate is MISSING; ...
Phase 1.5 (Root Cause)     [SKIPPED] (not needed)
Phase 2 (TO-BE Plan)       [DRAFT]        blockers: Unchecked TODO items: 1; Coverage gate is MISSING; ...
Phase 3 (Implementation)   [PENDING]      blockers: File missing
Phase 3.5 (Code Review)    [SKIPPED] (not needed)
Phase 4 (Test Summary)     [PENDING]      blockers: File missing
Phase 5 (Manual QA)        [LOCKED*] (invalid)
Phase 6 (Decisions)        [PENDING]      blockers: File missing
Phase 7 (State)            [PENDING]      blockers: File missing
Phase 8 (Memory)           [PENDING]      blockers: File missing
```

Notes for the port:

- `LOCKED*`/invalid is the *phase-table* rendering of a tampered lock; the
  literal `LockHash mismatch` text is emitted by the Lock Chain section.
  In this fixture the Lock Chain breaks at DRAFT `01-as-is.md` before
  reaching phase 5, so the phrase appears **only** in the phase table's
  `(invalid)` suffix. To observe the literal string, lock phases 01–04 too.
- `File missing` appears in two places: the phase-table blockers preview and
  the Lock Chain `[PENDING]` line (which is where the chain breaks for the
  first missing mandatory phase, 03, in this fixture).
- The Lock Chain walks from the start and breaks at the first non-lock-valid
  artifact: here `[OK]` ×2 then `[DRAFT] 01-as-is.md`.

## Lock-hash recipe

Replicates `lock_hash_from_content` exactly:

1. LF-normalize: `content.replace("\r\n", "\n").replace("\r", "\n")`.
2. Remove the `LockHash:` line: regex `(?m)^[ \t]*LockHash:.*(?:\n|$)`.
3. `sha256` hex of the remaining UTF-8 bytes.

Practical recipe used by `regen_fixtures.py`: write the file with
`LockHash: 0000…0` (64 zeros), hash the whole content minus the LockHash
line, then replace the placeholder with the real hash. The tampered
`05-manual-qa.md` is finalized the same way and then a junk line is
appended after the LockHash line.

## mtime setup (latest-run selection)

`get_latest_run_directory` sorts run directories by `st_mtime` descending
and picks the first. Without `--run-id`, `fixture-run` must be selected.
`regen_fixtures.py` pins mtimes with `os.utime`:

| run dir | pinned mtime (UTC) |
| --- | --- |
| `fixture-run` | `2026-01-15 09:00:00` (newer) |
| `older-run` | `2026-01-01 09:00:00` (older) |

Every file inside each run dir is pinned to the same value as its run dir.
If the TS port reads mtimes at higher resolution than seconds, or the
filesystem exposes a different mtime precision, the test should compare
mtime *values* rather than assume a particular representation. The
regenerator asserts that the no-`--run-id` run produces output
byte-identical to the `fixture-run` golden.

## Regenerating the goldens

```
python -B D:\DEV\recursive-mode\dsh-recursive-mode\tests\fixtures\regen_fixtures.py
```

`-B` prevents bytecode writes. The script:

1. Recreates both runs (real LockHashes, tampered 05).
2. Pins mtimes.
3. Runs the Python reference with and without `--show-hashes` and writes the
   two goldens byte-exactly.
4. Verifies latest-run selection and the expected markers, then prints the
   full golden.

Equivalent manual commands (what the goldens were captured from):

```
python -B skills/recursive-mode/scripts/recursive-status.py ^
  --repo-root dsh-recursive-mode/tests/fixtures/repo --run-id fixture-run ^
  > dsh-recursive-mode/tests/fixtures/expected-status.txt

python -B skills/recursive-mode/scripts/recursive-status.py ^
  --repo-root dsh-recursive-mode/tests/fixtures/repo --run-id fixture-run --show-hashes ^
  > dsh-recursive-mode/tests/fixtures/expected-status-with-hashes.txt
```

## Golden byte conventions

- Files are UTF-8, no BOM, LF-only endings, trailing newline.
- The `===…===` rule under the title is `=` repeated `max(8, len(title))`
  times.
- Everything except the title rule, the two lock-hash values, and the
  `Quick Command` run-id line is derived from phase/blocker strings; the TS
  port should reproduce the format rather than hard-code the goldens.
