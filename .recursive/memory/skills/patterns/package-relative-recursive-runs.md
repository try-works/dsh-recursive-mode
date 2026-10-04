Type: `pattern`
Status: `CURRENT`
Scope: `How to operate a recursive-mode run that lives inside a reusable bundle package (e.g. dsh-recursive-mode/.recursive/run/<run-id>/) so lint/lock/verify-locks resolve it and the run stays lint-clean through every lock.`
Owns-Paths:
Watch-Paths:
- `/.recursive/run/`
- `/.recursive/memory/skills/SKILLS.md`
Source-Runs:
- `02-phase-a-read-path`
Validated-At-Commit: `promoted-from-run-02-phase-a-read-path`
Last-Validated: `2026-08-16T09:10:00Z`
Tags:
- `skills`
- `recursive-run`
- `package-relative`
- `junction`
- `receipt-accounting`

# Package-Relative Recursive Runs: Junction + Receipt Pre-Accounting

When a recursive-mode run is authored inside a reusable delivery package (the user-mandated
location for this repo's runs), the canonical lint/lock/verify-locks helpers only resolve
runs at the repo root (`<repoRoot>/.recursive/run/<run-id>/`). The run still must pass the
same machine-checkable lint contract, so three operational rules apply.

## Rule 1 — Repo-root junction for lint/lock

- Create a junction `<repoRoot>/.recursive/run/<run-id>` -> `<package>/.recursive/run/<run-id>`
  so the canonical helpers resolve the package-relative run.
- Run lint/lock/verify-locks WITH the junction present.
- Remove the junction BEFORE `git add`/commit: with it present, `git ls-files --others`
  lists run files under both the package path (tracked) and the junction path (untracked),
  doubling the diff surface and breaking WDA accounting.

## Rule 2 — In-package diff accounting

- `filter_runtime_changed_files` strips only the `.recursive/run/<run-id>/` prefix, so
  package-relative run paths (`dsh-recursive-mode/.recursive/run/<run-id>/...`) survive into
  `actual_changed_files` and MUST be listed in every phase's Worktree Diff Audit and
  Requirement Completion Status.
- Phases that omit them fail lint as soon as later-phase files enter the diff (the locked-03
  accommodation: already-locked phases cannot be edited, so their WDA/RCS stays as of their
  lock time and later files appear unaccounted — that is an accepted, run-01-documented
  accommodation, not a failure of the current phase).

## Rule 3 — Receipt placeholder pre-accounting

- A lock receipt cannot be listed in a phase's WDA/RCS before it exists (lint FAILs "path(s)
  do not exist"), yet it enters the diff the moment the phase locks.
- Pre-create a placeholder receipt at `locks/<artifact>.receipt.json` and list that path in
  the phase's WDA/RCS before locking. `recursive-lock` overwrites the placeholder with the
  real receipt (path unchanged), so the phase stays lint-clean through its own lock.
- Pre-create ALL future phases' receipt placeholders (e.g. `04`..`08`) up front and list
  them in every early phase's WDA/RCS, so the diff never outgrows a locked phase's accounting.

## Why It Matters

- The canonical helpers are the acceptance gate; a package-relative run is invisible to them
  without the junction, and its artifacts are not stripped from the diff without explicit
  WDA/RCS accounting.
- The receipt chicken-and-egg (cannot list before lock, must be listed at lock) is the single
  most common lint failure for package-relative runs; placeholder pre-accounting eliminates it.

## Application

- Author run artifacts under the package's `.recursive/run/<run-id>/`, keep canonical
  templates pristine, use the junction for lint/lock, remove it before commit, and pre-account
  all receipts (own + future) in every phase's WDA/RCS.
