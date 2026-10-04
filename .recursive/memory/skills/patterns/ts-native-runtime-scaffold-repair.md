Type: pattern
Status: CURRENT
Scope: How the dsh-recursive-mode plugin keeps its runtime TS-native and repairs partial scaffolds safely: port canonical Python/PS1 scripts to TS modules called in-process, keep the canonical script as the locked parity oracle (golden fixture), delete vendored `.py`/`.ps1` from the package, and repair partially-bootstrapped workspaces with an idempotent upsert (`bootstrapScaffold`) that adds missing control-plane files, never overwrites user content, and never touches `run/` artifacts — with a session-resume trigger and a manual `/recursive bootstrap` path.
Owns-Paths:
- dsh-recursive-mode/src/ts-lint.ts
- dsh-recursive-mode/src/runtime.ts
- dsh-recursive-mode/src/bootstrap.ts
Watch-Paths:
- dsh-recursive-mode/src/index.ts
- dsh-recursive-mode/src/commands.ts
- dsh-recursive-mode/src/phase-rules.ts
Source-Runs:
- 09-ts-only-runtime-and-scaffold-repair
Validated-At-Commit: promoted-from-run-09-ts-only-runtime-and-scaffold-repair
Last-Validated: 2026-08-19T00:00:00Z
Tags:
- skills
- recursive-run
- ts-native
- python-free
- scaffold-repair
- parity-oracle
- idempotent-upsert

# Pattern: TS-Native Runtime + Idempotent Scaffold Repair (run 09)

## When to use

When a DSH plugin ships a recursive-mode-style runtime that currently shells vendored python/ps1 scripts, or when a target workspace has a partial `.recursive/` scaffold (e.g. only `memory/` + `run/`) that needs the missing control-plane files without clobbering user content — especially when a live agent session is mid-run in that workspace.

## Pattern

- `lintRun(root, runId)` is the full TS port of the canonical lint script; `lintArtifact` calls it IN-PROCESS and filters verdicts to the requested artifact (no python subprocess).
- Golden fixture parity: run the TS lint against a fixture repo and assert byte-identical `[FAIL]`/`[WARN]` verdicts + counts vs the canonical expected output (e.g. FAIL:42 / WARN:17), normalizing path prefixes.
- `bootstrapScaffold(root)` is the idempotent upsert repair: adds missing dirs/files, re-upserts marked blocks, NEVER overwrites user content, never touches `run/` (only creates `.recursive/run/.gitkeep`), and removes stale `.py`/`.ps1` from existing `.recursive/scripts/`.
- Session resume triggers the repair once per root; a manual `/recursive bootstrap` verb exists for operators.
- Second pass creates 0 items (idempotence is tested).

## Key implementation points

- Python-style leading `(?m)` regex flags are invalid in JS `new RegExp` — pass `'m'`/`'ms'` as the flags argument instead; template-literal `\s` needs `\\s` in source.
- Git diff-basis verification in a TS port must use single braces: `` `${hash}^{commit}` `` — template literals do not escape braces (Python f-strings use `{{commit}}`).
- Lint-parity normalization strips `[FAIL]`/`[WARN]` prefixes + path basenames and filters the CLI `Lint failed` banner from the golden fails.

## Verification

- Full suite runs python-free (0 `.py` shell-outs).
- Live repair evidence: before/after tree listings for each repaired workspace + a second-pass `created: 0` run.
