Type: `pattern`
Status: `CURRENT`
Scope: `How a recursive-mode skill/package delivery keeps the canonical control-plane scaffold pristine while still shipping a full .recursive scaffold to installer users.`
Owns-Paths:
Watch-Paths:
- `/.recursive/`
- `/.recursive/memory/skills/SKILLS.md`
- `/.recursive/run/`
Source-Runs:
- `01-dsh-plugin-skeleton`
Validated-At-Commit: `promoted-from-run-01-dsh-plugin-skeleton`
Last-Validated: `2026-08-15T18:00:00Z`
Tags:
- `skills`
- `delivery`
- `isolation`
- `canonical-workspace`
- `plugin`

# DSH Bundle / Plugin Delivery Keeps The Canonical Workspace Pristine

When a recursive-mode skill is installed into a user workspace, the installer copies the
canonical template files (`/.recursive/RECURSIVE.md`, `DECISIONS.md`, `STATE.md`,
`AGENTS.md`, `README.md`, the memory plane, and the root `.gitignore`) from the skill
package into that workspace. Those templates are therefore part of the skill's shipped
surface, not scratch space for a run happening inside the canonical skill repo itself.

## Rule

- Never edit the canonical templates to record a run's deltas (decisions, state, memory
  promotion, node_modules ignores).
- Keep every run-scoped control-plane change inside the delivery package itself: mirror the
  `.recursive/` scaffold under the package directory (e.g. `dsh-recursive-mode/.recursive/`),
  and write run artifacts under the package's own `.recursive/run/<run-id>/`.
- When a run inside the canonical repo needs to record a durable decision/state/memory
  delta, apply it to the mirrored scaffold inside the delivery package, and re-point the
  run's own citations (`Inputs`, `Changed Files`, WDA lists) at the mirrored paths.

## Why It Matters

- The canonical templates are copied verbatim by `install-recursive-mode`; any run residue
  there leaks into every future installer user's workspace.
- The lint is stateless: it re-checks every locked artifact against the live git diff, so a
  reverted canonical template shows up as an "outside the diff" citation failure in earlier
  locked phases. Re-point the run's accounting to the in-package mirror instead.
- A package-local `.gitignore` (instead of the repo-root one) keeps hygiene fixes scoped to
  the delivery artifact.

## Application

- Delivery packages (e.g. a DSH plugin bundle) should carry the mirrored `.recursive/`
  scaffold byte-identical to the canonical template at the time of delivery, so installer
  users receive the same control plane the run was validated against.
- Run-local deltas (decisions/state/memory promotion) land in the mirror; the canonical
  workspace stays byte-pristine vs its baseline commit.
