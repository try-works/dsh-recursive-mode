# Changelog

## Unreleased

Recover the baseline and rebase onto the pinned DSH release (`dsh-v0.2.0-rc.2`).
Plan items **T-1** and **T31a**; see `STRENGTHENING-PLAN.md` §7.0 for the frozen
green baseline.

- **Baseline recovered (T-1).** The tree typechecks and the suite is green:
  `pnpm typecheck` clean, **45/45 spec files and 279/279 tests** passing (parity
  + invariants 54/54), `pnpm build` clean, smoke PASS. Thirteen type-import sites
  were repaired: nine tool files imported `JsonValue` from `@deepseek-ai/dsh-tools`,
  which only *imports* that type from `@deepseek-ai/dsh-util-values` and never
  re-exports it; three specs imported `CallId` from `@deepseek-ai/dsh-llm`, which
  exports `ToolCallId`.
- **rc.2 message-source break (found by the rebase, invisible before it).** At
  `0.1.1-rc.2` `MessageSourceMap` carried a catch-all `plugin` kind; at rc.2 it is
  merge-extensible and *"each producer declares its own `kind` in its own module"*.
  `src/index.ts` now declares `'recursive-mode'` and stamps its injected phase-lint
  reminder with `form: 'notice'` + a bounded `summary`, the same idiom the shipped
  `@deepseek-ai/dsh-repeat-tool-reminder` uses for its pre-step reminder. The old
  checkout could not surface this error because its `node_modules` still held a
  stale `dsh-llm`.
- **Dependency protocol: `file:` → `link:` (T31a).** rc.2's packages reference each
  other as `workspace:*`, which a `file:` install must satisfy inside *this*
  workspace and cannot (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`). `link:` symlinks the
  checkout's packages and leaves their own dependencies to its installed tree —
  the protocol already used for `cosmokit`/`schemastery`. The stale lockfile (whose
  relative resolutions no longer matched `package.json`) was regenerated.
- **Dependencies corrected.** Removed `@deepseek-ai/dsh-code-runtime` — at rc.2
  `packages/code-runtime` is an empty directory, so the devDependency could not
  resolve and blocked `pnpm install` outright. Removed `@deepseek-ai/dsh-invariants`
  for forward-compatibility (it still exists at rc.2; it is gone at
  `0.2.1-alpha.1`). Added `@deepseek-ai/dsh-util-values`. Repointed the dead client
  peer `dsh-client-runtime` → `dsh-client-modules`. Peers now pin `0.2.0-rc.2`.
- **`init-templates.parity` — a non-hermetic test, not a regression.** The spec
  called `detectGitContext('D:\DEV\tmp\r5-init-golden')`, a capture-time temp repo
  that no longer resolves (its `.git` outlived the repository), so the template
  fell back to `<resolve-before-locking>` and the diff read as a code regression.
  `worktreeContent` takes the context as a parameter, so the spec now supplies the
  facts the golden encodes as literals and the byte-exact assertion is unchanged.
  Two hermetic `detectGitContext` tests were added, covering the live-repo prefill
  and the placeholder degradation path. **No `src/` change was needed to make it pass.**

## 0.3.1

Ship the plugin's own packaged skill.

- **Packaged `recursive-mode` skill (dsh plugin standard):** `src/skills.ts`
  registers a bundled provider through `ctx.skills.registerProvider(...)` (the
  `dsh-skill-badge` shape): `source: 'bundled'`, `BUNDLED_SKILL_RANK` (600),
  directory resource base, body read from the shipped
  `skills/recursive-mode/SKILL.md` (the workflow operating contract — phases,
  audit loop, locking, memory). Model- and user-invocable; optional (a
  composition without a skills registry no-ops); zero-emission. `skills` is now
  in the package `files`, and `registerRecursiveSkill` is wired into `apply()`.

## 0.3.0

Strengthen the recursion concept with two new durable orchestration seams and a
first-class goals projection.

- **Goals projection (T1):** runs now project into the native goals service as
  durable, resumable, blockable objects. `src/goals-projection.ts` maps the run
  lifecycle (initRun arms, lockArtifact blocks on gate, reopen resumes); absent
  the host goals service it degrades to a no-op — filesystem state remains the
  source of truth.
- **agentTeams task loop (T3):** `src/teams-loop.ts` adds a pure
  audit→repair→re-audit state machine (`auditToPass`) that runs over ONE durable
  team task — create → claim → wait → audit → edit(REVISE) → re-audit the SAME
  task → complete(APPROVE) → lockPhase; REJECT / round-cap / stuck reviewer
  release + interrupt, and the phase is NEVER locked before an APPROVE.
  `recursive_audit_team` exposes it as a turn-driven board tool (one transition
  per call, since there is no synchronous parent-side settlement promise).
- **Continuable subagents (T4):** `delegateContinuable` carries a multi-round
  audit over ONE durable continuable child — `startContinuable` once, then
  `followup` delivers each repair to the SAME child (working set retained), with
  settlement observed through an injected `awaitRoundResult` seam. The parent is
  the **exact live Agent** (the live service authorizes by object identity, so a
  structural `{ id }` copy is never fabricated); a missing observer or live
  parent falls back to one-shot with `fellBackToOneShot`. `interruptContinuable`
  (keepInbox) and `drainContinuableChildren/Descendants` (host-owned teardown)
  complete the lifecycle. Repair text is always synthesized from
  `findings[].title` — a child cannot inject instruction text.
- **Approval ask→policy bridge (T6):** `coerceAskToDecision` stops the silent
  allow — a tool-guard `ask` becomes deny (strict) or a logged allow (advisory),
  never a silent pass.

## 0.2.4

Add a per-phase run-doc viewer: 'View phase' button on each present phase row in
the run-detail Inspector opens the phase's .recursive/run/<runId>/<fileName> doc
INSIDE the inspector panel. Markdown line parser (parsePlan base + fenced code +
tables + bold/code/link inline) and vim nav + / search are ported from
@guillaumemeyer/dsh-plan-approval (MIT, attributed in doc-viewer.tsx); NO
approve/changes/comment/quit actions, NO session-answer writes, NO recursive/*
session events (read-only, zero-emission — the no-emission scan stays green).

- New lazy server route GET /.recursive/api/doc (root + runId + file): the host
  re-validates the root (known workspace) and guards the file path (single *.md
  phase-doc basename, no subdirs / no ..; resolved doc stays under the run dir).
  Serves raw markdown (text/markdown); 400 for invalid params, 404 when missing.
  NOT added to /state or /events projection payloads.
- DocViewer component (read-only): loading/error states, Copy doc button + 'y'
  key, vim j/k/gg/G + / search n/N/Esc, footer hint bar; data-theme from the
  hoisting Inspector (0.1.10 invariant).
- Inspector: per present row a ghost 'View phase' button; the viewer renders
  inside the rec-detail body and Close returns to the phase list.
- Tests: doc-viewer parser spec, live-route doc spec (path guard / 404 / 400 /
  403 / 405 / lazy), inspector View-phase wiring spec.

## 0.2.2

Compatible with DeepSeek Harness **dsh-v0.1.1-rc.2**.

- **Zero session-event emission (durable):** removed the legacy event-fold dead
  surface — `foldRecursivePhase`, `detectTransitionIntent`, `hasOpenTurn`,
  `LifecycleDriver`, the `recursive/*` event payload interfaces
  (`RecursivePhaseEvent`, `RecursiveRunStateEvent`, `RecursiveGateBlockedEvent`,
  `RecursiveTamperEvent`, `RecursiveTransitionFailedEvent`), and the Layer 1
  pre-step gate (`evaluatePreStepGate`) with its runtime wrappers
  (`foldPhase` / `detectTransitionIntent` / `gatePreStep`). The plugin no
  longer appends any `recursive/*` session event; resume is safe on a stock
  harness without a known-plugin-event-types patch.
- **peerDependencies aligned to rc.2:** `@deepseek-ai/dsh-session`,
  `dsh-session-projection`, `dsh-system-prompt`, and `dsh-tools` now pin
  `0.1.1-rc.2` (the versions shipped by dsh-v0.1.1-rc.2). `@deepseek-ai/cordis
  ^4.0.1` and `react ^18.2.0` unchanged.
- **`prepare` script** (same as `build`) so a git/workspace install builds
  `lib/` automatically.
- **Regression guard:** `tests/no-emission.spec.ts` statically scans every
  `src/` file (server + client) and asserts no `Session.append`,
  `.emit(`, `recursive/<slug>` event-type literal, or `SessionEventMap`
  merge survives. It was written RED against the pre-cleanup tree and is GREEN
  now.
- Removed the now-dead `LifecycleDriver` serialization and fold-based tests;
  the pure `validateTransition` gate check, shared intent/result types, and
  `coupleGateBlockToGoal` no-op helper remain.

## 0.2.4

Add a per-phase run-doc viewer: 'View phase' button on each present phase row in
the run-detail Inspector opens the phase's .recursive/run/<runId>/<fileName> doc
INSIDE the inspector panel. Markdown line parser (parsePlan base + fenced code +
tables + bold/code/link inline) and vim nav + / search are ported from
@guillaumemeyer/dsh-plan-approval (MIT, attributed in doc-viewer.tsx); NO
approve/changes/comment/quit actions, NO session-answer writes, NO recursive/*
session events (read-only, zero-emission — the no-emission scan stays green).

- New lazy server route GET /.recursive/api/doc (root + runId + file): the host
  re-validates the root (known workspace) and guards the file path (single *.md
  phase-doc basename, no subdirs / no ..; resolved doc stays under the run dir).
  Serves raw markdown (text/markdown); 400 for invalid params, 404 when missing.
  NOT added to /state or /events projection payloads.
- DocViewer component (read-only): loading/error states, Copy doc button + 'y'
  key, vim j/k/gg/G + / search n/N/Esc, footer hint bar; data-theme from the
  hoisting Inspector (0.1.10 invariant).
- Inspector: per present row a ghost 'View phase' button; the viewer renders
  inside the rec-detail body and Close returns to the phase list.
- Tests: doc-viewer parser spec, live-route doc spec (path guard / 404 / 400 /
  403 / 405 / lazy), inspector View-phase wiring spec.

