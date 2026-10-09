# DECISIONS.md

## Recursive Run Index

- No run history is intentionally checked into this reusable skill repository.

## Current Working Decisions

- Keep Python as the canonical implementation surface for complex enforcement logic and use PowerShell wrappers where that materially reduces parity drift.
- Treat subagent availability as environment-dependent and require a concrete capability probe before choosing delegated review.
- Treat delegated review as valid only when the bundle and any meaningful subagent work can be verified against actual files, actual recursive artifacts, and the actual diff basis.
- Prefer `mixed` as the documented smoke mode when cross-toolchain parity is desired, while keeping `python` independently runnable in environments without PowerShell.
- Require status-specific evidence fields in `## Requirement Completion Status` so audited artifacts cannot pass on vague prose-only completion claims.
- Treat `/.recursive/memory/skills/` as an optional durable memory surface: retrieve or update specific skill-memory docs only when those docs have been intentionally promoted as reusable repository guidance.
- DSH bundle patch-row entry `name` values must resolve from the profile's module-resolution context: use a package name or package-subpath export (e.g. `dsh-recursive-mode/src/index.ts`), never a profile-relative `./src/*.ts` path, because patch-row entry resolution is anchored to the profile directory (`ctx.baseUrl`), not the bundle directory.
- A bundle service realm in a `cordis:group` isolate can still register root-realm tools through `ctx.tools.register`; prove cross-realm tool injection with a boot test that mirrors the production patch structure rather than relying on a same-realm smoke mount alone.
- When a recursive run lives inside a reusable bundle package (e.g. `dsh-recursive-mode/.recursive/run/<run-id>/`), the canonical lint/lock/verify-locks helpers only resolve runs at the repo root (`<repoRoot>/.recursive/run/`). Create a junction `<repoRoot>/.recursive/run/<run-id> -> <package>/.recursive/run/<run-id>` for lint/lock, and remove it before `git add`/commit so the tracked package paths are not double-listed as untracked through the junction.
- In a package-relative run, run artifacts are NOT stripped from the diff by `filter_runtime_changed_files` (which strips only `/.recursive/run/<run-id>/` prefixes). Every phase's Worktree Diff Audit and Requirement Completion Status must account for the full `dsh-recursive-mode/.recursive/run/<run-id>/...` path set, or the phase will fail lint when later-phase files enter the diff.
- A lock receipt cannot be listed in a phase's WDA/RCS before it exists (lint fails "path(s) do not exist"), yet it enters the diff the moment the phase locks. Pre-create a placeholder receipt file at `locks/<artifact>.receipt.json` and list it in the phase's WDA/RCS before locking; `recursive-lock` overwrites the placeholder with the real receipt (path unchanged), so the phase stays lint-clean through its own lock.
- The dsh-recursive-mode plugin resolves the control-plane root strictly from the session's workspace: `agent.session.header.cwd` -> `ctx.workspaceRegistry.resolveByPath(cwd)` -> workspace `path` is the control-plane root, and the plugin never calls `workspaceRegistry.list()` to find "the" workspace nor reads another open workspace's `.recursive/` tree. Root resolution is fresh per call (or digest-cached on cwd), never a long-lived global.
- The per-session `ctx.recursive` service MUST sit behind `isolate: { recursive: true }` in a `cordis:group` (mount guard rejects root-realm leaks), and the preset uses two-stage init: Stage A (mount-time `apply()` registers service/tools/commands/prompt/skills/client, no repo work) + Stage B (`agent/session-start` resolves the workspace-scoped root, bootstraps the scaffold idempotently if missing, and enumerates runs as directory names only; on `source: 'resume'` it re-reads only the active run's current phase doc and never re-bootstraps/re-creates a run).
- The recursive preset ships `tool-presentation` with `mode: both` (Code Mode SDK + native tools), and per-run scratch is markdown (`scratch/scratch.md`) plus an optional runnable `scratch.ts`, git-ignored, disposable, and never citable as an Input for a phase doc.

- Native delegation is TS-only: the canonical `/.recursive/config/recursive-router.json` stays declarative config, but resolution/probing/delegation live in the plugin (`src/router.ts`, `src/delegation.ts`) and external-CLI router wrappers are not vendored. Order per role: native DSH subagent provider -> external-CLI route -> self-audit/local-controller fallback; a missing provider or policy resolves to self-audit, never a hard failure (optionality-preserving).
- Delegated work rides a file-backed context-in contract: a review bundle (`evidence/review-bundles/<phase>-bundle.md`, with `Artifact Path` + `Artifact Content Hash` = LF-normalized sha256) plus a main-agent `handoff.md` and per-child `brief.md`/`reply.md`; the delegation prompt is reference-based (pointers, not a monolithic paste) so the child reads the files it needs. The plugin calls `ctx.subagents.start()` with the full request (`prompt`, `label`, `outputSchema`, `toolFilter`, `maxDepth`) and fail-louds on NO_PROVIDER / UNSUPPORTED_CAPABILITY / DELEGATION_FAILED — never accepted-then-ignored.
- Child-scoped scratch: each delegated child gets its own disposable scratch under `<run-dir>/scratch/<child-id>.md` (escape-guarded), while the parent's `scratch/scratch.md` stays the main agent's working memory; a child may read the parent scratch only when the prompt includes it, and writes go only to the child's own file.


## Decision: Phase C — layered enforcement via DSH lifecycle seams (run 05)

- **Status:** decided (run 05, Phase C). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** recursive-mode enforces its workflow through DSH's native lifecycle seams: a phase-transition gate on `agent/pre-step` (authoritative), surgical tool guards on `tools/pre-execute` (scope-filtered to recursive agents), a `recursive:policy` prompt section (legible contract), durable log-folded phase state (`recursive/*` events, resume/fork-safe), and goal-round pause-on-block coupling. Enforcement is layered: Layers 1 and 2 are *callers* of the `lifecycle.ts` transition set, never duplicate predicates.
- **Consequences:** a model turn that would advance a run without its gates passing is blocked (`{kind:'reject'}` → turn ends `blocked`, no model call); individual tool calls that violate the active phase's policy are denied or routed to approval; `recursive:policy` makes the contract legible; `recursive/phase` events make transitions observable; enforcement state survives resume/fork by folding from the session log.
- **Rationale:** prompt-only enforcement is today's status quo (the agent routinely skips parts); tool-internal-only is bypassable (raw fs/shell can fake `Status: LOCKED`); the DSH tool pipeline is open — enforcement must sit on the lifecycle/tool seams the harness owns (§8.5).

## Decision: Enforcement strictness is configurable strict|advisory per gate (run 05)

- **Status:** decided (run 05, Phase C). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** `strict|advisory` per gate (preStep, toolGuards, tamper), default advisory. The pre-step gate reads on transition intent only (not synchronously per turn), avoiding false positives on unrelated turns.
- **Consequences:** strict flips reject/deny; advisory emits `recursive/gate-blocked` (warn) and lets the step through (or `ask` for TDD/QA sign-off seams); the config rides the plugin config, never the workflow files (harness-agnostic).
- **Rationale:** enforcement must not break unrelated work in the same session; advisory is the safe default and strict is the opt-in hardening (§13.5).

## Decision: The lifecycle manager is transitions + events only (run 05)

- **Status:** decided (run 05, Phase C). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** `lifecycle.ts` owns transitions and events only — it never stores run state in a second place. It reconciles the file tree via the §4.7 read path + `lock.ts`, and state is derived on every transition.
- **Consequences:** no `MANIFEST.json`-style cache to drift; resume/fork/session-restart reconstruct identical state by re-reading files + folding the session log; the fold is re-derived on every transition and the events are the projection's input.
- **Rationale:** a manifest is a second store for state that the lifecycle already derives and emits — writing it twice re-introduces the exact drift problem the design removes (§8.8/§8.9).

## Decision: Emitters are the scope authority; the projection never re-derives it (run 06)

- **Status:** decided (run 06, Phase D). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** every `recursive/*` event carries `{ runId, worktreeRoot }` and its constructor rejects an empty key. The `recursive` projection unit groups events by that control-plane root and never re-derives scope by reading another workspace's `.recursive/` tree.
- **Consequences:** the binding workspace-scoping invariant (run 03 R1) is enforced at the event boundary, not recomputed in the fold; the client renders exactly the active workspace's runs; a session that touches multiple workspaces still folds each root separately and correctly.
- **Rationale:** if the fold resolved the root itself it would need `workspaceRegistry.list()` or a cached global — the exact two anti-patterns the invariant forbids.

## Decision: The projection unit is pure and synchronous, with internal-only intents (run 06)

- **Status:** decided (run 06, Phase D). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** the `recursive` projection unit's `init()` takes no session/agent context, `apply()` returns the same reference for unrelated events (zero-work fold), `view()` emits wire-JSON per run, and the internal `recursive/phase-intent` event is emitted but excluded from the observable fold.
- **Consequences:** the fold is deterministic and resume/fork-safe; the projection cannot depend on "the" active workspace; internal transition intents never leak into the rendered run-state wire-JSON.
- **Rationale:** a synchronous, context-free init is the DSH projection contract's guarantee that drives B6 — emitters are the scope authority, the fold is a pure reducer over the session log.

## Decision: The client half is read-only and seam-based, never host-installed standalone (run 06)

- **Status:** decided (run 06, Phase D). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** `src/client/**` carries no filesystem or session imports (read-only-client principle, §11.9). Structural seams in `src/client/contract.ts` stand in for the host-injected `dsh-client-*` packages (which are not installable standalone under a workspace peer), so the `dsh.client` bundle typechecks and builds in-repo and composes into `window.__DSH_BOOT__` at runtime.
- **Consequences:** the bundle is self-contained at build time (tsdown cjs + module-loader closure); at runtime the host injects the real `dsh-client-runtime`, `ui-slots`, `ui-conversation`, `ui-sidebar`, `ui-settings`, and `api-remotes` capabilities; client code is auditable as pure read + render with no filesystem reach.
- **Rationale:** bundling host packages into the plugin duplicates the harness client runtime and breaks version alignment; self-contained structural seams keep the client typecheckable and buildable without pulling workspace peers that cannot be installed standalone.

## Decision: The kanban board + inspector + node/strip are derivations over the projection, not a second store (run 06)

- **Status:** decided (run 06, Phase D). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** the board lanes, run-card facts, and column assignment are pure functions (`derive.ts`) over the `recursive` projection's wire-JSON. The board, inspector, conversation run node, and status strip are renderers that read that projection; none of them writes run state or reaches into the workspace.
- **Consequences:** the §11.7 visualization catalog has a single source of truth (the projection); swapping or restyling a renderer cannot change run state; the details-seat inspector and conversation node render the same facts the board does.
- **Rationale:** run state already lives in the file tree + the folded session log (§8.8/§8.9); a client-side store would be a third copy that can only drift.
## Decision: The client board UI is driven by one shared module-level open-state store (run 08)

- **Status:** decided (run 08, Phase 3). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** `src/client/open-state.ts` owns `{open, selection}` + subscribe; the sidebar launcher, the shell.overlay entry, the board, and the inspector all read/write the SAME store (launcher opens, overlay gates, board selects, inspector goes back). Slot components stay stateless renderers; the store is the single source of UI truth.
- **Consequences:** cross-slot coordination (launcher opens the same overlay the board renders) needs no per-slot state or event plumbing; the store is client-local and emits no `recursive/*` session events (zero-emission preserved).
- **Rationale:** run 08 found the launcher had no onClick (dead button), the overlay had no open-state (unconditional render), and the inspector was never mounted (unreachable) — per-slot state cannot express the open/select/back coordination; a shared store fixes all three at once.

## Decision: The plugin runtime/scaffold surface is TS-native; lint runs in-process via the ts-lint port (run 09)

- **Status:** decided (run 09, Phase 6). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** `src/ts-lint.ts` is the full TS port of the canonical `lint-recursive-run.py`; `lintArtifact` calls `lintRun(root, runId)` IN-PROCESS (no python subprocess), and the plugin ships 0 `.py`/`.ps1` vendored scripts. `bootstrapScaffold` is the idempotent upsert repair for partial scaffolds: it adds missing control-plane files/dirs and re-upserts marked blocks, NEVER overwrites user content and never touches `run/` artifacts; session resume triggers it once per root.
- **Consequences:** lint verdicts are deterministic and byte-identical to the canonical oracle (golden fixture FAIL:42 / WARN:17); tests run python-free; existing partial scaffolds (e.g. `dsh-righthand`, `dsh-anti-slop`) are repaired in place with `run/` byte-preserved and `0 .py` added; the TS port + scaffold repair ship together so no runtime shells a vendored script mid-run.
- **Rationale:** the canonical lint script was the last python dependency in the plugin runtime; porting it to TS removed the python requirement entirely (R2), while keeping the canonical script as the locked oracle for parity (R1/R4). Repairs are upsert-only so user content and in-flight runs are never clobbered (R3/R6).

## Decision: UI/product drift landing outside a run's phase loop must be reconciled into that run's closeout (run 07)

- **Status:** decided (run 07, Phase 6). **Owner:** dsh-recursive-mode maintainers.
- **Decision:** when UI/product changes land outside a run's phase loop — e.g. the post-phase-03 user-facing fixes 0.1.13–0.1.18 that repaired run 07's board/run-detail UI after user acceptance failed (unstyled render, empty board, stale workspace after switch) — those changes MUST be reconciled into that run's closeout: Phase 03.5 records the broken-UI gaps and the out-of-run repair chain, Phase 04 records the GREEN suite over the FINAL code (not the phase-03 snapshot), and Phase 05 signs off the FINAL UI.
- **Consequences:** a run whose product only became correct after its phase loop cannot leave its phase docs describing the earlier snapshot; the closeout phases are the honest reconciliation point, and the git history + user acceptance (not the phase-loop timeline) are the source of truth for "what actually shipped".
- **Rationale:** run 07's phase-03 UI FAILED acceptance and was repaired by creator steering (0.1.13 Paper redesign, 0.1.14 workspace precedence, 0.1.15 SSE await, 0.1.16 scope reset + workspacePath header sync, 0.1.17 strip removal, 0.1.18 setState(null) removal); recording the phase-03 snapshot as final would fabricate a clean history that contradicts the real commits and the user's 0.1.18 acceptance.



## Decision: Enforcement defaults to STRICT, not advisory (2026-10-10)

- **Status:** decided. **Owner:** dsh-recursive-mode maintainers, at the repository owner's instruction.
- **Supersedes:** "Enforcement strictness is configurable strict|advisory per gate (run 05)" — that entry's `default advisory` is no longer
  true. It is left verbatim above as a dated record; this entry is the current statement.
- **Decision:** `preStep`, `toolGuards` and `tamper` all default to `strict`. One literal,
  `DEFAULT_ENFORCEMENT_MODE` in `src/enforcement.ts`, is read by every site: the runtime `DEFAULT_ENFORCEMENT`, the
  resolver's fill for an ABSENT OR UNRECOGNIZED value, both helper parameter defaults, and the three schema defaults in
  `src/config.ts`.
- **Rationale:** the owner's rule is that only one phase may be active at a time, that phases are sequential, and that the
  active phase must be locked before the next begins. Under `advisory` that rule is only WARNED about, and a live run
  demonstrated the cost: it ignored the lock chain for over an hour, wrote phase 8 before phase 1.5, and locked nothing —
  twelve DRAFT artifacts and a single operations entry. Advisory is the unsafe default for a rule the operator expects to
  hold.
- **Why it is safe now, when it was not before:** strict previously denied the run's OWN artifacts, which made the workflow
  unusable. That false positive was fixed, and a test now walks all twelve phases asserting the active artifact stays
  writable while later ones are refused.
- **Consequences:** an out-of-order tool call and an out-of-order transition are now REFUSED pre-dispatch rather than
  warned; a tampered artifact whose LockHash no longer matches is refused. A PARTIAL config section — a settings patch
  merging one field — now fills the unstated gates with the default posture rather than with a permissive one; the old fill
  returned `advisory`, i.e. a config looser than the plugin's own default. An ordering refusal from the guard carries the
  gate-block ask (`fix`/`reopen`/`abandon`), because that ask is the human's only way out of a blocked lock and must not
  become unreachable on the DEFAULT path. `coerceAskToDecision`'s parameter default follows the config default by
  reference: the domain has no neutral branch, and an `advisory` literal there would be a hidden second copy of the old
  default that no config could close.
