# dsh-recursive-mode — Strengthening Plan

TDD backlog + status tracker for making the recursive workflow and the "recursions" concept durable, native, and resumable.

---

## 0. Meta

| Field | Value |
|---|---|
| Status | `ACTIVE` (backlog; individual items tracked §6) |
| Workflow version | `recursive-mode-audit-v2` (parity with the repo's phase engine) |
| TDD Mode | `strict` (with per-item `pragmatic` exceptions — see §4 rationale) |
| Approval policy | `never` (this session) — no sandbox escalation; the gate is tests + build + manual verification |
| Baseline version | `0.2.4` (peerDeps `@deepseek-ai/*` `0.1.1-rc.2`) |
| Artifacts owned | `src/`, `tests/`, `preset/recursive/`, `cordis.patch.yml` (no `.recursive/run/<id>/` residue — reusable repo) |

> **Note on approval = never** (§4 T6): any enforcement path that "asks" must not silently allow. The ask→approval bridge coerces `ask` → `deny` under `never`.

---

## 1. Objective / success criteria

Make `dsh-recursive-mode` a **durable, native, resumable** recursion engine rather than a single-threaded controller that reconstructs state from the filesystem and does one-shot delegation.

Concretely, "done" means:

1. **A run is a first-class object.** Its lifecycle (`new → active → paused → blocked → complete`) is projected into the native `goals` service, so it survives session restart, is resumable from the UI, and surfaces the "blocked" state on any gate failure.
2. **The audit loop is a state machine, not a fire-and-forget call.** draft → audit → repair → re-audit → PASS → lock is modeled with continuable children / team tasks, so a review that returns `REVISE` resumes the same working set rather than spawning a fresh child.
3. **Fan-out is native.** Phase 3.5 / multi-angle verification runs through the `workflowEngine` (caps, termination, `workflow/*` events) instead of a hand-rolled loop.
4. **The board's state is native.** The bespoke fs+SSE fold is replaced by `sessionProjections` (`stateOf` / `snapshot` / `checkpoint` / `restore` / `onChanged`), removing the mount-once global-registry hack and the client re-subscription logic.
5. **Enforcement is real.** The `ask` branch honors the approval policy (no silent allow); the write-layer is gated by `fs/write-intent` / `fs/edit-intent`, not just a post-hoc read-back.
6. **Config and memory are native.** Enforcement + router config live in a `settings` namespace; phase rules and Phase-8 memory are registered as `skills` and retrieved into the review bundle.
7. **Recursions compound.** Memory (skills / patterns / episodes / incidents / domains) is retrieved into the reviewer's context bundle so each run learns from prior runs.

---

## 2. Current state + gap map

### What the plugin provides today

- `RecursiveRuntime` on `ctx.recursive` (`src/runtime.ts`) — `status`, `initRun`, `lockArtifact`, `lintArtifact`, `delegateReview`, `phaseRules`, `renderPolicy`, worktree/branch ops, tamper detection.
- 8 model tools (`recursive_status/init/lock/lint/closeout/scratch/worktree/phase`, `src/index.ts:109-117`).
- `/recursive` command (`src/commands.ts`), `recursive:policy` prompt section (`src/index.ts:129-146`).
- Enforcement via `tools/pre-execute` (`src/index.ts:161-172`, `src/enforcement.ts`) + `fs/observed` tamper.
- Pre-step phase-lint injection + idempotent scaffold repair (`src/index.ts:182-225`).
- Read-only live board via a bespoke HTTP/SSE fs fold (`src/live-route.ts`, `src/client/host-api.ts`).

### Gap map (native capability → current status)

| DSH capability | Status in the plugin |
|---|---|
| `tools`, `systemPrompt.section`, `commands.register`, `webServer.register`, `sessions.get`, `workspaceRegistry` | ✅ used |
| `subagents.start()` (one-shot) | ✅ used in `delegateReview` (`src/runtime.ts:225`) |
| `agent/pre-step`, `tools/pre-execute`, `fs/observed` | ✅ used |
| `goals` | ⚠️ **dead code** — `coupleGateBlockToGoal` shipped (`src/lifecycle.ts:126`, `src/runtime.ts:597`), never wired |
| `sessionProjections` / `sessionProjectionCache` | ❌ reimplemented as bespoke fs+SSE |
| `workflowEngine` | ❌ unused |
| `agentTeams` (`createTask` / `waitForChange` / `interrupt`) | ❌ unused |
| `subagents.startContinuable/followup/reportFrom/drain*` | ❌ unused (only `start`) |
| `settings` | ❌ enforcement/router read from fs files |
| `skills` | ❌ Phase-8 memory written to fs only |
| `approval` + `approval/request` | ⚠️ `ask` guard branch is a no-op |
| `fileReferences` / `sessionReferenceResolver` | ❌ `validateReferences` hand-rolled (`src/delegation.ts:149`) |
| `agentLoop.createAgent` / `agents` / `llm` | ❌ delegation inherits child model |
| `jobs` | ❌ long ops run synchronously in-block |
| `fs/write-intent` / `edit-intent` | ❌ write-layer gate not hooked |
| `planMode` | ❌ phases 0-2 not integrated |
| `invariants` / `sandboxPolicy` / `permissionPresets` | ❌ unused |

---

## 3. The recursion model (4 axes)

| Axis | Meaning today | Weakness to fix |
|---|---|---|
| **Inner** | draft → audit → repair → re-audit → pass (per phase) | one-shot `subagents.start()`; reviewer context lost on re-audit |
| **Outer** | phase advance through the lock chain | enforced purely in-process (`validateTransition`); not surfaced as a resumable object |
| **Spatial** | run → child → grandchild depth | only native `subagents` gives a depth guard; plugin has no depth model |
| **Temporal** | memory accumulates across runs and feeds back in | Phase-8 memory written to fs; not retrieved into the reviewer bundle |

---

## 4. Implementation backlog (spec per item)

> Each item declares `TDD Mode`. `strict` requires a RED spec (failing vitest) → GREEN impl (passing vitest), evidenced under `evidence/logs/red/<item>-tdd-red.md` and `evidence/logs/green/<item>-tdd-green.md`. `pragmatic` requires an explicit exception rationale plus compensating evidence (a manual verification or integration test that is hard to unit test).

### T1 — Project each run into a native **Goal**

- **Why:** The plugin's own `RUN_STATES` (`src/lifecycle.ts:18`) map 1:1 to goal states, but `coupleGateBlockToGoal` is **unwired**. This is the single biggest win: run state becomes durable, resumable, UI-native, and "blocked" surfaces on gate failure.
- **What:** Implement `projectRunToGoal(goalService, run, phase, state)` and wire it so init → `create`, gate-block → `block`, reopen → `pause`/`resume`, phase-8 lock → `complete`, and `validateTransition` failures actually call `goals.block(agent, ref, reason)`.
- **TDD Mode:** `strict`.
- **RED:** `tests/goals-projection.spec.ts` — expect `projectRunToGoal` to create a goal keyed by `runId` with state mapping; expect `coupleGateBlockToGoal` to be called from the lock/pre-step path.
- **GREEN:** `src/goals-projection.ts` + wire the call site in `src/index.ts` (agent/pre-step, `recursive_lock` tool, `validateTransition`).
- **Files:** `src/goals-projection.ts` (new), `src/lifecycle.ts`, `src/runtime.ts`, `src/index.ts`, `tests/goals-projection.spec.ts` (new).
- **Acceptance:** a blocked gate raises a durable goal that shows at `/goal` and resumes; existing `goals-projection` helpers are unit-testable without a live session.

### T2 — Route fan-out audit/verification through the native **workflowEngine**

- **Why:** Phase 3.5 and cross-cutting verification are natural multi-agent fan-out; the plugin reimplements the loop. `workflowEngine` gives `phase()` / `agent()` / `pipeline()` / `parallel`, built-in caps, and `workflow/*` events for board observability.
- **What:** Adapter `orchestrateAudit(workflowEngine, run, reviewers)` mapping the audit contract to `phase(title)` + `agent(prompt, opts)` + `parallel(thunks)`, returning the aggregated verdict.
- **TDD Mode:** `pragmatic` — the workflow engine runs against a live host context and is integration-grade; unit-test the *contract mapping* (pure) and cover the live path manually.
- **RED/compensating:** `tests/workflow-contract.spec.ts` tests the pure mapping (phases → `phase()` calls, agents → `agent()` opts) and asserts no cross-item null-dropping; manual verification runs a scripted audit and checks `workflow/phase|agent-start|agent-end` frames.
- **GREEN:** `src/workflow-audit.ts` (new), wire into the delegate path.
- **Acceptance:** a scripted 3-reviewer audit produces 3 `workflow/agent-end` frames + a single verified verdict.

### T3 — Model the **audit→repair→re-audit loop** as `agentTeams` Tasks

- **Why:** This is the heart of the recursion concept and currently the weakest part. `agentTeams` gives a continuable team/task state machine + `interrupt` (a real kill switch that `delegateReview` lacks today).
- **What:** `auditToPass(teams, ...)` = `createTask(phase)` → `waitForChange` until verdict → on `REVISE` send the repair instruction → `updateTask` → re-test → `verdict=APPROVE` → lock. `interrupt` on a stuck reviewer.
- **TDD Mode:** `strict`.
- **RED:** `tests/teams-task-loop.spec.ts` — with a fake team runtime, expect `createTask`, `updateTask(REVISE)`, `waitForChange`, and `interrupt` to be called in order; expect no lock until `APPROVE`.
- **GREEN:** `src/teams-loop.ts` (new) + wire the tool/entry path.
- **Acceptance:** a `REVISE` verdict resumes the same task; `interrupt` cancels a hung reviewer; the board shows a per-phase task history.

### T4 — Use **continuable** subagents for multi-round children

- **Why:** `delegateReview` calls one-shot `subagents.start()`. A review-then-repair child loses context on re-invocation.
- **What:** `delegateContinuable(subagents, ...)` = `startContinuable` → `followup` (same child, repair instruction) → settle (observed parent-side via an injected `awaitRoundResult`; `reportFrom` is the CHILD-side API, not the parent loop); `drainContinuableDescendants` on closeout. The `parent` is the **exact live direct-parent Agent** — the live service authorizes `followup`/`startContinuable`/`interrupt`/`drain` by object identity (`ctx.agents.get(parent.id) === parent`, `ancestry.has(parent)`), so a structural `{ id }` copy is `UNAUTHORIZED` and never fabricated.
- **TDD Mode:** `strict`.
- **RED:** `tests/continuable-delegate.spec.ts` — expect `startContinuable`, then `followup` on REVISE, then settle; expect no `start()`; expect one-shot fallback when the observer OR the exact live parent is missing.
- **GREEN:** `src/delegation.ts` add `delegateContinuable`; keep `delegate` for single-shot fallback.
- **Acceptance:** a re-audit child retains its working set; `subagent/end` lifecycle events fire.

### T5 — Replace the bespoke fs+SSE substrate with **sessionProjections**

- **Why:** The board reimplements a projection: fs fold (`src/snapshot.ts:96`) + `/state`+`/events` SSE (`src/live-route.ts`) + client EventSource (`src/client/host-api.ts`) + a mount-once global registry hack (`src/live-route.ts:189-231`).
- **What:** Register a `recursive` projection unit; read `stateOf`/`snapshot`; push frames on `onChanged`; use `checkpoint`/`restore`/`restoreFloor` for resume-crash safety. Delete the SSE relay + re-subscription logic.
- **TDD Mode:** `strict` (pure projection def) / `pragmatic` (client wiring — integration).
- **RED:** `tests/projection-unit.spec.ts` — register the unit, write a snapshot, assert `stateOf`/`snapshot` reflect the run fold, assert `checkpoint`/`restore` round-trips.
- **GREEN:** `src/projection.ts` (new) + rewire `src/client/host-api.ts` / `src/client/use-live.ts`.
- **Acceptance:** cold resume renders the board without a fresh SSE subscription; `onChanged` drives the strip; the `mountRecursiveRoutesOnce` global registry is removed.

### T6 — Wire the enforcement `ask` branch to the `approval` seam

- **Why:** `evaluateToolGuard` returns `{ kind: 'ask' }` (advisory) but `src/index.ts:161-172` drops it ("we let it through with a warn"). With approval = `never`, an ask that silently allows is a false sense of enforcement.
- **What:** `coerceAskToPolicy(decision, policy)` → under `never` coerce `ask`→`deny` (strict) or `warn+continue` (advisory, never silent); under `ask` raise the real question via `approval/request`; under `allow`/`always` pass.
- **TDD Mode:** `strict`.
- **RED:** `tests/approval-bridge.spec.ts` — for each policy (`never`/`ask`/`always`/`allow`) and each decision kind, assert the resulting action and that no `ask` is ever a silent allow.
- **GREEN:** `src/enforcement.ts` add `coerceAskToPolicy`; wire it in `src/index.ts` `tools/pre-execute`.
- **Acceptance:** `ask` under `never` → `deny` (strict) or an explicit logged warn+continue (advisory), never a quiet pass.

### T7 — Put enforcement + router config in a **settings** namespace

- **Why:** Enforcement config and `recursive-router.json` are read from fs files (`src/enforcement.ts`, `src/router.ts`). `settings` gives a durable, revision-tracked, UI-editable namespace.
- **What:** `registerEnforcementSettings(settings)` with the `recursive` namespace (`preStep/toolGuards/tamper` + router defaults); back `resolveEnforcementConfig` + `loadRouterPolicy` from it; react to `settings/updated`.
- **TDD Mode:** `strict`.
- **RED:** `tests/settings-config.spec.ts` — register the namespace, `get` defaults, `update` a mode, assert `settings/updated` fires and the resolved config changes.
- **GREEN:** `src/settings.ts` (new) + refactor `src/enforcement.ts` / `src/router.ts`.
- **Acceptance:** toggling strict/advisory in the settings UI changes enforcement live; config persists across restart.

### T8 — Use native **reference resolution** instead of hand-rolled validation

- **Why:** `src/delegation.ts:149` re-implements path containment + line-count checks. `fileReferences.list()` and `sessionReferenceResolver.listCandidates()/prepare()` are the canonical, cancellable seams.
- **What:** `resolveReviewerReferences(fileReferences, refs)` adapter delegating validation; keep `validateReferences` as a fallback.
- **TDD Mode:** `strict` (adapter logic pure) / `pragmatic` (live service — integration).
- **RED:** `tests/native-reference-resolve.spec.ts` — expect the adapter to invoke `fileReferences.list`/`prepare` and surface the same `ReferenceCheck` shape.
- **GREEN:** `src/delegation.ts` add the adapter; remove the duplicated `resolveUnderRoot` containment copy where the native seam covers it.
- **Acceptance:** reviewer references are validated by the native seam; an escaping path is still rejected (fail loud).

### T9 — Per-role **model routing** via `agentLoop` / `agents` / `llm`

- **Why:** Delegation currently runs on whatever model the child inherits. The review/audit role (needs rigor) and the repair role (cheaper, more iterations) should differ.
- **What:** `routeForRole(role, agentLoop)` returning the review vs repair model; use `agentLoop.createAgent`/`createAgent(ownerCtx, …)` with an explicit route; `agents.withInitiator`/`currentInitiator` for clean parent tracking.
- **TDD Mode:** `pragmatic` — model selection depends on live `llm`/`agentLoop`; unit-test the pure role→route mapping and verify the live path manually.
- **RED/compensating:** `tests/role-model-route.spec.ts` tests the mapping (review→reviewerModel, repair→repairModel) and flags an unknown role.
- **GREEN:** `src/model-route.ts` (new) + wire into `delegateContinuable`/`orchestrateAudit`.
- **Acceptance:** a review runs on the reviewer model; a repair loop runs on the cheaper model.

### T10 — Track long operations as native **jobs**

- **Why:** `lintRun`, `createLinkedWorktree`, `delegateReview` are synchronous in-block. Native `jobs` (`start/list/read/kill/wait` + `onJobDone`) gives progress + a kill switch on the board.
- **What:** Wrap the three ops in `jobs.start`; surface `onJobDone`/`onJobsChanged` to the board.
- **TDD Mode:** `strict` (wrapping) / `pragmatic` (live run — integration).
- **RED:** `tests/jobs-tracking.spec.ts` — with a fake jobs runtime, expect the op to be started, a `JobSnapshot` returned, and `onJobDone`/`onJobsChanged` to fire.
- **GREEN:** `src/jobs-runner.ts` (new) + wire into the tool execute paths.
- **Acceptance:** a hung worktree-create/linter shows as a running job and can be killed from the board.

### T11 — Hook `fs/write-intent` / `fs/edit-intent` as an authoritative write gate

- **Why:** Write-layer enforcement is read-back only (`fs/observed` tamper). `fs/write-intent` lets the plugin **deny a write to a LOCKED artifact before it happens**, and `fs/edit-intent` the same for edits.
- **What:** `lockedArtifactWriteIntent(target)` / `lockedArtifactEditIntent(target)` returning `{ version }` (ok) or undefined (deny); register both single-slot waterfalls.
- **TDD Mode:** `strict`.
- **RED:** `tests/fs-intent-gate.spec.ts` — expect a write to a `Status: LOCKED` artifact to return a deny decision; a write to a DRAFT artifact to pass.
- **GREEN:** `src/fs-intent.ts` extend + register the `fs/write-intent` / `fs/edit-intent` listeners in `src/index.ts`.
- **Acceptance:** a locked artifact cannot be written (or edited) without an explicit reopen; the guard is authoritative, not heuristic.

### T12 — Register phase rules / review checklists as **skills**

- **Why:** Phase 8 writes skill memory to fs. The native `skills` registry makes phase rules discoverable in-catalog and lets the board react to `skills/change`.
- **What:** `registerPhaseSkills(skills)` registering each phase's lint rules as a skill; read `skills.list()`/`get()` and surface `skills/change`.
- **TDD Mode:** `strict`.
- **RED:** `tests/skill-registration.spec.ts` — expect `register`/`list` to include the phase rules and `skills/change` to fire.
- **GREEN:** `src/skills-phase.ts` (new) + wire into apply.
- **Acceptance:** the recursive agent and children can discover phase rules via the native catalog rather than fs grep.

### T13 — Integrate **planMode** for phases 0-2

- **Why:** Requirements / AS-IS / TO-BE-Plan are non-mutating discovery. Running them under `planMode` enforces "plan before implement" by the harness (`/plan`, `plan:policy`, `exit_plan_mode` gate).
- **What:** `phaseUsesPlanMode(phase)` for 00-02; route `exit_plan_mode` as the phase-2→3 gate.
- **TDD Mode:** `strict` (mapping) / `pragmatic` (live integration).
- **RED:** `tests/plan-mode-integration.spec.ts` — expect phases 00-02 to be non-mutating under plan mode.
- **GREEN:** `src/plan-gate.ts` (new) + wire the prompt/gate.
- **Acceptance:** the plan phases run non-mutating; the plan gate is enforced.

### T14 — Deepen recursion: retrieve memory into the review bundle

- **Why:** Phase-8 memory should be retrieved into the reviewer's context so the recursion compounds rather than resets.
- **What:** `retrieveMemory(memoryStore, query)` returning relevant memory entries (skills / patterns / episodes / incidents / domains); seed `buildReviewBundle`'s `Relevant Memory References` from it.
- **TDD Mode:** `strict`.
- **RED:** `tests/memory-retrieval.spec.ts` — expect the bundle's `Relevant Memory References` to be populated from the memory store for a matching query.
- **GREEN:** `src/memory.ts` (new) + wire into `src/runtime.ts` `delegateReview`.
- **Acceptance:** each run receives prior-run memory; the reviewer sees it in the bundle and can cite it.

---

## 5. To-do checklist (ordered)

```
[x] T1  goals projection — run as a first-class durable object (done: src/goals-projection.ts + wiring)
[x] T6  approval ask→policy bridge — stop the silent allow (done: coerceAskToDecision)
[~] T5  sessionProjections — DEVIATED: zero-emission/per-workspace conflict (see tracker)
[~] T11 fs write/edit-intent gate — DEVIATED: single-slot waterfall occupied by fs-observation-policy (see tracker)
[x] smoke script repaired — was stale since 0.2.2 (removed event-fold surface); now passes
[x] T3  agentTeams task loop — the audit→repair→re-audit state machine (done: src/teams-loop.ts + recursive_audit_team tool)
[x] T4  continuable subagents — multi-round children keep context (done: delegateContinuable + interrupt/drain kill switches)
[x] T0  packaged skill — ship the `recursive-mode` skill via ctx.skills.registerProvider (done: src/skills.ts + skills/recursive-mode/SKILL.md)
[ ] T2  workflowEngine fan-out — native Phase 3.5 / verification orchestration
[ ] T9  per-role model routing — review vs repair model
[ ] T10 jobs tracking — long ops as visible, killable jobs
[ ] T8  native reference resolution — replace hand-rolled validateReferences
[ ] T7  settings namespace — UI-editable enforcement + router config
[ ] T12 phase rules as skills — native catalog discoverability
[ ] T13 planMode for phases 0-2 — plan-before-implement by the harness
[ ] T14 memory retrieval into bundle — recursions compound
```

---

## 6. Status tracker

| ID | Item | TDD Mode | Status | RED evidence | GREEN evidence | Notes |
|---|---|---|---|---|---|---|
| T0 | packaged `recursive-mode` skill | strict | **done** | `tests/skills.spec.ts` (5 tests, RED→GREEN) | full suite (277 tests) + smoke `SMOKE PASS` | `src/skills.ts` registers a bundled provider via `ctx.skills.registerProvider` (dsh-skill-badge shape): `source: 'bundled'`, `BUNDLED_SKILL_RANK` 600, directory resource base, body from shipped `skills/recursive-mode/SKILL.md`; model+user-invocable; optional (no registry → no-op); wired in `index.ts`; `skills` added to package `files` (verified in `npm pack --dry-run`) |
| T1 | Goals as run/phase substrate | strict | **done** | `tests/goals-projection.spec.ts` (11 tests, RED→GREEN) | full suite + smoke (T1 run goal armed / gate-block blocks) | new `src/goals-projection.ts`; wired into initRun (arm), lockArtifact (block), reopen (resume); `coupleGateBlockToGoal` kept for the no-service no-op path |
| T2 | workflowEngine fan-out | pragmatic | backlog | `evidence/logs/red/workflow-contract-tdd-red.md` | manual integration | integration-grade; contract mapping unit-tested |
| T3 | agentTeams task loop | strict | **done** | `tests/teams-task-loop.spec.ts` (7 tests, RED→GREEN) | full suite (271 tests) + smoke `SMOKE PASS` | `src/teams-loop.ts` (pure `auditToPass` state machine: create→claim→wait→audit→edit(REVISE)→complete(APPROVE)→lock; REJECT/cap release+interrupt, lock NEVER before APPROVE) + `src/recursive_audit_team.tool.ts` (turn-driven one-transition-per-call board adapter — the live subagents service has no synchronous parent-side settlement promise) + `RecursiveRuntime.auditToPass` |
| T4 | continuable subagents | strict | **done** | `tests/continuable-delegate.spec.ts` (12 tests, RED→GREEN) | full suite (272 tests) + smoke `SMOKE PASS` | `delegateContinuable` (ONE durable child: startContinuable once → followup(repair) same child → settlement observed via injected `awaitRoundResult` seam; `start()` never called on the continuable path); `interruptContinuable` (keepInbox kill switch), `drainContinuableChildren/Descendants` (host-owned teardown); NO observer OR no exact live `parent` Agent → one-shot fallback with `fellBackToOneShot` (never a fake APPROVE, never a fabricated `{ id }` authority — live `followup`/`startContinuable` authorize by object identity); repair ALWAYS synthesized from `findings[].title` (child cannot inject instruction text) |
| T5 | sessionProjections | strict/pragmatic | **deviated** | — | — | **Design conflict found:** sessionProjections folds `session/event` and is per-session; the plugin is deliberately zero-emission (resume-crash fix) and its state is per-workspace on the filesystem. A projection unit would require re-introducing recursive/* emission (the exact regression 0.2.2 fixed). The bespoke fs+SSE fold (fresh-read on every GET) already provides cold-resume safety. Revisit only with a per-workspace fs-backed unit API. |
| T6 | approval ask→policy bridge | strict | **done** | `tests/enforcement.spec.ts` (coerceAskToDecision block) | full suite + smoke (T6 ask->deny / ask->allow+warn) | `coerceAskToDecision` in `src/enforcement.ts`; wired into the `tools/pre-execute` branch — `ask` is never a silent allow (strict→deny, advisory→logged allow) |
| T7 | settings namespace | strict | backlog | `evidence/logs/red/settings-config-tdd-red.md` | `evidence/logs/green/settings-config-tdd-green.md` | UI-editable enforcement |
| T8 | native reference resolution | strict/pragmatic | backlog | `evidence/logs/red/native-reference-resolve-tdd-red.md` | `evidence/logs/green/native-reference-resolve-tdd-green.md` | keep `validateReferences` fallback |
| T9 | per-role model routing | pragmatic | backlog | `evidence/logs/red/role-model-route-tdd-red.md` | manual integration | model depends on live `llm` |
| T10 | jobs tracking | strict/pragmatic | backlog | `evidence/logs/red/jobs-tracking-tdd-red.md` | manual integration | long ops visible/killable |
| T11 | fs write/edit-intent gate | strict | **deviated** | — | — | **Ordering conflict found:** `fs/write-intent`/`fs/edit-intent` are single-slot waterfalls already occupied by the host `fs-observation-policy` (never calls `next()`), so a recursive listener would be order-fragile and could break observed-write semantics. Enforcement stays at the `tools/pre-execute` guard (now strict-deniable via T6) + `fs/observed` tamper. Revisit only if a multi-slot or layered intent API appears. |
| T12 | phase rules as skills | strict | backlog | `evidence/logs/red/skill-registration-tdd-red.md` | `evidence/logs/green/skill-registration-tdd-green.md` | native catalog discoverability |
| T13 | planMode for phases 0-2 | strict/pragmatic | backlog | `evidence/logs/red/plan-mode-integration-tdd-red.md` | manual integration | plan-before-implement |
| T14 | memory retrieval into bundle | strict | backlog | `evidence/logs/red/memory-retrieval-tdd-red.md` | `evidence/logs/green/memory-retrieval-tdd-green.md` | recursions compound |

---

## 7. Verification steps

Run from **`D:\DEV\recursive-mode\dsh-recursive-mode`**. The gate is tests + build + manual verification (approval = `never`, so nothing escalates).

### 7.1 Static + type + lint
```powershell
# Type-check (no emit)
pnpm typecheck          # tsc --noEmit

# Build the bundle (tsc declarations + tsdown) — also exercises the entry
pnpm build              # removes lib/, emits lib/*, registers via cordis.patch.yml

# Anti-slop lint (harness tool; no config change) over src + tests
# (run the anti_slop_lint tool with target "src" and "tests")
```

### 7.2 Unit + parity tests
```powershell
# Full vitest suite (tests/**/*.spec.ts)
pnpm test               # vitest run

# Targeted, per item:
pnpm exec vitest run tests/goals-projection.spec.ts tests/projection-unit.spec.ts
pnpm exec vitest run tests/teams-task-loop.spec.ts tests/continuable-delegate.spec.ts
pnpm exec vitest run tests/approval-bridge.spec.ts tests/fs-intent-gate.spec.ts
pnpm exec vitest run tests/settings-config.spec.ts tests/skill-registration.spec.ts
pnpm exec vitest run tests/workflow-contract.spec.ts tests/role-model-route.spec.ts
pnpm exec vitest run tests/jobs-tracking.spec.ts tests/native-reference-resolve.spec.ts
pnpm exec vitest run tests/plan-mode-integration.spec.ts tests/memory-retrieval.spec.ts

# The repos' own parity goldens (must still pass — regressions catch parity breaks):
pnpm exec vitest run tests/status.parity.spec.ts tests/run.parity.spec.ts tests/lint-parity.spec.ts
```

### 7.3 Smoke
```powershell
# Plugin smoke (bare-Context mount + tool read path; no live session needed).
# Repaired from the stale 0.2.2 event-fold surface; now covers T1/T6 too.
npx tsx scripts/test-recursive-mode-smoke.ts
```

### 7.4 Recursive-run linter (the repo's own phase-engine parity check)
```powershell
# Lint this repo's own control plane against the vendored rules (must be clean):
#   (use the in-process lintRun — ts-lint.ts — via a one-off, or the recursive_lint tool
#    if a recursive session is mounted. Do NOT shell out to python.)
```
> Note: no committed `.recursive/run/<id>/` residue. Run any recursive lint against a temp scaffold, not the repo tree.

### 7.5 Manual board/workflow verification (per integration item)
1. Start a recursive session in a temp workspace (`recursive_init` a run).
2. `recursive_phase` → confirm the current-phase lint rules are injected once per phase.
3. `recursive_lock` → confirm prerequisites are validated; a blocked gate raises a durable goal (T1) and appears at `/goal`; reopen works.
4. Write to a `Status: LOCKED` artifact → confirm the write is denied (T6 strict) and, under approval `never`, `ask` coerces to `deny`; under advisory it logs a warn (never silent).
5. Open the Recursive board → confirm the run board + strip render from the live fs fold (T5 deviated — the fs+SSE fold stays, fresh-read on every GET), no broken `useLiveProjection` hook-order, no SSE re-subscribe on visibility.
6. Run a scripted multi-reviewer audit → confirm `workflow/agent-start|agent-end` frames (T2) and a single verified verdict; confirm the review runs on the reviewer model (T9).
7. Long op (worktree-create / lint) → confirm it shows as a job and can be killed (T10).

### 7.6 Definition of done (per item)
- RED spec exists under `tests/<item>.spec.ts` and is evidenced under `evidence/logs/red/`.
- GREEN implementation exists (function + wiring) and the spec passes; evidence under `evidence/logs/green/`.
- `pnpm typecheck`, `pnpm test`, `pnpm build` are green.
- No `.recursive/run/<id>/` residue in the repo tree.
- `anti_slop_lint` over `src/`/`tests/` reports no new findings.
- The repo's own parity specs (`spec.parity`) still pass.

---

## 8. Sequencing rationale

- **T1 + T6 first (done)**: the run becomes a durable, resumable goal-backed object and the enforcement `ask` branch stops being a silent allow — the correctness backbone.
- **T5 deviated**: sessionProjections folds `session/event` (per-session); the plugin is zero-emission + per-workspace by design (0.2.2 fix). The fs+SSE fold already gives fresh-read cold-resume safety. Revisit only with a per-workspace, fs-backed unit API.
- **T11 deviated**: `fs/write-intent`/`edit-intent` are single-slot waterfalls occupied by the host `fs-observation-policy` (never calls `next()`); a recursive listener would be order-fragile. The `tools/pre-execute` guard + T6 strict-deny carries the enforcement.
- **T3 + T4 (done)**: they transform the audit loop into a resumable state machine — the core of the "recursions concept." T3 runs the loop over ONE durable `agentTeams` task (create→claim→wait→audit→edit(REVISE)→complete(APPROVE)→lock; REJECT/cap/stuck release+interrupt, never lock before APPROVE) with a turn-driven board tool; T4 carries the actual audit rounds over ONE durable continuable child (startContinuable → followup(repair) → settle) with an explicit observer seam and an exact live-parent Agent authority, a keepInbox interrupt, and a host-owned drain — a missing observer or live parent falls back to one-shot rather than fabricating a verdict or an `{ id }` authority.
- **T2 + T9 + T10 after**: native orchestration, per-role models, and visible long ops.
- **T8 + T7 + T12 + T13 + T14 last**: reference/config/skill/plan/memory consolidation.
