# recursive-mode

Drive the recursive-mode workflow: an audit-gated, phase-disciplined loop that
carries one requirement from an AS-IS understanding through a TO-BE plan,
implementation, test, and manual QA, to locked control-plane state and durable
memory. Every phase follows `draft → audit → repair → re-audit → pass → lock`.

## When to use

- The user says "implement the run", "implement run <id>", "start a recursive
  run", "resume <run-id>", or otherwise asks to advance a run.
- The repo carries a `/.recursive/` control plane (RECURSIVE.md, STATE.md,
  DECISIONS.md, memory/, run/).

## Source of truth

The canonical spec is `/.recursive/RECURSIVE.md`; read it before starting or
resuming. The control plane lives under `/.recursive/`, one run under
`/.recursive/run/<run-id>/`, and durable memory under `/.recursive/memory/`.
Treat bridge docs (`AGENTS.md`, `CLAUDE.md`, `.codex/AGENTS.md`, `.agent/PLANS.md`)
as harness adapters, not a second spec — on conflict, follow `/.recursive/RECURSIVE.md`.

## Phases

A run advances one phase at a time in order; each phase owns a Markdown artifact
under `/.recursive/run/<run-id>/`:

- Phase 0 — `00-requirements.md` (gather requirements)
- Phase 0 (Worktree) — `00-worktree.md` (record the diff basis and scope)
- Phase 1 — `01-as-is.md` (AS-IS analysis)
- Phase 2 — `02-to-be-plan.md` (TO-BE plan)
- Phase 3 — `03-implementation-summary.md` (implement, strict/pragmatic TDD)
- Phase 3.5 — `03.5-code-review.md` (delegated or self review)
- Phase 4 — `04-test-summary.md` (test evidence)
- Phase 5 — `05-manual-qa.md` (manual QA)
- Phase 6 — `06-decisions-update.md` (update `/.recursive/DECISIONS.md`)
- Phase 7 — `07-state-update.md` (update `/.recursive/STATE.md`)
- Phase 8 — `08-memory-impact.md` (update `/.recursive/memory/`)

Use `recursive_status` to read the current phase and its state. Use `recursive_init`
to scaffold a run, `recursive_lock` to lock a passed phase (it refuses premature
locks), `recursive_lint` to machine-check an artifact before acceptance, and
`recursive_closeout` to advance the receipt when the phase is done.

## The audit loop

Audited phases must follow `draft → audit → repair → re-audit → pass → lock`.
Never set `Coverage: PASS` or `Approval: PASS` unless the artifact ends with
`Audit: PASS`. When subagents are unavailable, perform the same audit as
self-audit; do not weaken or skip it. Delegate an audit only with the full
context bundle (phase name + artifact path, upstream artifacts reread for the
audit, diff basis from `00-worktree.md`, changed files + code references,
phase-specific audit questions); if the bundle is incomplete, perform the audit
yourself and record `Audit Execution Mode: self-audit`. A `success: false` or any
nonzero delegated exit is a failed attempt — preserve diagnostics, repair owned
issues, rerun, and verify before acceptance.

## Locking and memory

Lock a phase with `recursive_lock` — it is the supported way to write
`Status: LOCKED`, `LockedAt`, and `LockHash`, and it refuses a lock whose
prerequisites are unmet. Phase 6 owns `/.recursive/DECISIONS.md`, Phase 7 owns
`/.recursive/STATE.md`, Phase 8 owns `/.recursive/memory/**`. Read
`/.recursive/memory/MEMORY.md` before loading other memory docs, and record
durable, reusable conclusions (not raw transcripts) when a run teaches the repo
something about capability availability, fit, or quality.
