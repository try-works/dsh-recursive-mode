# dsh-recursive-mode — Strengthening Plan

TDD backlog + status tracker for making the recursive workflow and the "recursions" concept legible, enforced, and crash-resumable over a file-backed control plane.

> **Revision note (this version).** §1 and §3 were rewritten and T5/T11 were closed as `settled` after two external audits contradicted the original premise. Fourteen items (T15–T28) were added. The superseded wording is preserved verbatim in §9.2 so the change of direction is reviewable rather than silent.
>
> **Revision note (+ baseline correction).** An independent review pass re-verified every load-bearing claim in §6 and corrected the baseline against upstream. **The tree is currently RED** — `pnpm typecheck` fails at 12 sites and five spec files fail — so **T-1** was added ahead of everything and **T31 was split** into T31a/T31b. The pinned target is **`dsh-v0.2.0-rc.2`**, the latest *release*, which the local checkout already contains. See §7.0 for the frozen baseline and §10 for the full change list.
>
> **Revision note (+ new home, and GREEN).** The plugin has been rebuilt from scratch in its own repository (`D:\DEV\dsh-recursive-mode`) against the pinned `dsh-v0.2.0-rc.2`, and **§7.0's frozen baseline is now GREEN**: `pnpm typecheck` clean, **45/45 spec files and 279/279 tests passing**, `pnpm build` clean, smoke PASS. **T-1 and T31a are done.** The rebase surfaced four things the review could not see from the old checkout — a **13th** typecheck error that *is* a genuine rc.2 API break, a **dependency protocol** (`file:` → `link:`) that had to change before the tree would install at all, a **corrected dead-dependency finding** (`dsh-invariants` still exists at rc.2), and the **real root cause** of the `init-templates.parity` failure (a non-hermetic test, not a code regression). All four are recorded in §10.

---

## 0. Meta

| Field | Value |
|---|---|
| Status | `ACTIVE` (backlog; individual items tracked §6) |
| Workflow version | `recursive-mode-audit-v2` (parity with the repo's phase engine) |
| TDD Mode | `strict` (with per-item `pragmatic` exceptions — see §4 rationale) |
| Approval policy | `never` in the reference session — no sandbox escalation; the gate is tests + build + manual verification. Any path that could "ask" must not silently allow: `ask` coerces to `deny`. |
| Baseline version | `0.3.1` — **but the peer deps are stale.** The plugin pins `@deepseek-ai/*` at `0.1.1-rc.2`; the pinned DSH baseline is **`dsh-v0.2.0-rc.2`** (the latest **release**; `639ed01539`), which is exactly where the local checkout `D:\deepseek-harness` already sits — no checkout refresh is required. `dsh-v0.2.1-alpha.1` (`5badb15009`, 2026-10-03) is a **pre-release** one release-merge ahead and is the only tag beyond the baseline; it is **not** tracked. See T31a, and do not quote commit or diff counts from the local clone — it is shallow. |
| Artifacts owned | `src/`, `tests/`, `preset/recursive/`, `cordis.patch.yml`, `STRENGTHENING-PLAN.md` (no `.recursive/run/<id>/` residue — reusable repo) |
| Inputs | §9.1 — the iii/harness audit and the Effect-v4/Tardigrade audit |

---

## 1. Objective / success criteria

Make `dsh-recursive-mode` a **legible, enforced, crash-resumable** recursion engine over a file-backed control plane.

**What this objective deliberately does NOT say.** An earlier revision read *"a durable, native, resumable recursion engine rather than a single-threaded controller that reconstructs state from the filesystem"*. Two audits showed both halves of that contrast to be wrong, so they are struck:

- **"single-threaded" is not a defect here.** Measured against `src/`: zero `Promise.all`/`race`/`allSettled`, zero uses of the jobs service, zero worker threads or child processes, three timer sites (all client SSE/polling), and 22 synchronous `writeFileSync` sites. The plugin is single-process, single-writer, with no concurrency to coordinate. A durable queue exists to decouple producers from consumers under concurrency, backpressure, or multi-process contention; none is present. The durable-queue role is already filled by **DSH's own turn loop**.
- **"reconstructs state from the filesystem" is the design, not the weakness.** Markdown artifacts, hash-chained receipts and git *are* the durable, diffable, human-reviewable substrate. Both audited systems pay real costs to approximate this: Effect's event log is `@stability unstable` with no event versioning and no snapshots, and Tardigrade's default checkpointing refuses to run while work is pending and never truncates its log. Owning the source of truth in files is the plugin's main structural advantage.

The genuine gaps are therefore **enforcement that does not fire, contracts that are not legible, in-flight work that is not recorded, and recovery that is not bounded.**

**A prior condition precedes all of them: the baseline is currently RED.** `pnpm typecheck` fails at 12 sites and five spec files fail (see §7.0). No criterion below is measurable until T-1 has made the tree green, because every item's acceptance test is "the suite stays green" and the suite is not green today.

Concretely, "done" means:

1. **The control plane stays the single source of truth, and stays readable.** Requirements, plans, evidence and state live in repo Markdown. No second store, no manifest cache, no client-side store. Every derived fact is folded from files on demand.
2. **Enforcement is real and auditable.** The tool guard receives the *active run*; `validateTransition` and `detectTamper` are on the live path rather than exported-and-uncalled; every gate decision is recorded with its reason; a `Status: LOCKED` artifact cannot be written without an explicit reopen.
3. **The phase contract is legible before it fires.** A human — and the model — can read in advance what the current phase requires, which rule will match a proposed tool call, and what the next legal transition needs. No prompt/gate contradiction.
4. **A lock only happens at a quiescent point.** A phase cannot lock while delegated or repair work is unresolved, and in-flight work is recorded so a crash mid-audit resumes rather than restarts.
5. **Work is bounded, and stuck work terminates loudly.** Audits, repair rounds, delegations and tool results all have explicit caps; a loop that stops making progress ends and requires an explicit resume rather than retrying or giving up silently.
6. **The prompt is cheap to re-send.** A byte-stable prefix carries the contract; a digest names it; only a per-turn tail varies.
7. **The dependency model matches reality.** Prerequisites, addenda and receipt invalidation form a **DAG**, not a flat sequence indexed by array position.
8. **The recursion compounds — memory is actually read and written.** Delegated work is verified against real files and the real diff; **prior-run memory is injected when a run starts** (T29) and **a completed run's learnings are extracted when Phase 8 locks** (T30). Today *neither* happens: the memory plane is created, linted, and otherwise untouched. See §3 Temporal.

---

## 2. Current state + gap map

### What the plugin provides today

- `RecursiveRuntime` on `ctx.recursive` (`src/runtime.ts`) — `status`, `initRun`, `lockArtifact`, `lintArtifact`, `delegateReview`, `auditToPass`, `phaseRules`, `renderPolicy`, worktree/branch ops, tamper detection.
- 8 model tools (`recursive_status/init/lock/lint/closeout/scratch/worktree/phase`, `src/index.ts:136-146`), plus `recursive_audit_team` when `agentTeams` resolves.
- `/recursive` command (`src/commands.ts`), `recursive:policy` prompt section (`src/index.ts:159-175`).
- Enforcement via `tools/pre-execute` (`src/index.ts:212-234`, `src/enforcement.ts`) + `fs/observed` tamper.
- Pre-step phase-lint injection + idempotent scaffold repair (`src/index.ts:221-263`).
- Read-only live board via an HTTP/SSE fold (`src/live-route.ts`, `src/client/host-api.ts`).
- 45 vitest spec files; golden lint-parity fixtures (`FAIL:42 / WARN:17`).

### Measured facts that shape the backlog

| Measurement | Value | Consequence |
|---|---|---|
| `Promise.all` / `race` / `allSettled` | 0 | no concurrency to schedule |
| jobs service use | 0 | long ops are synchronous in-block (T10) |
| worker threads / child processes | 0 | no out-of-process work |
| timers | 3 (all client SSE/polling) | nothing to sweep server-side |
| `writeFileSync` sites | 22, all synchronous | single-writer; no lock contention |
| `evaluateToolGuard` call site | `index.ts:222`, **runId = `''`** | lock-order and TDD branches cannot match — dead code (T15) |
| `validateTransition` | imported at `runtime.ts:25`, **never called** | the transition gate is not on the live path (T15) |
| `detectTamper` | exported + unit-tested, **no `index.ts` caller** | `tamper` mode surfaces only as prompt text (T15) |
| `Promise.all` in client | 0 | the client is read-only over one HTTP+SSE fold |
| readers of `memory/MEMORY.md` | **0** | no start-of-run memory injection (T29) |
| plugin peer deps | `0.1.1-rc.2` → **`0.2.0-rc.2`** (done, T31a) | matches the pinned baseline; devDeps are `link:` into the checkout |
| `pnpm typecheck` | **exit 0 — clean** (was 12 × TS2614 → then 13 sites) | T-1 done; the 13th error was a genuine rc.2 API break, see §10 |
| `pnpm test` | **45/45 files, 279/279 tests** (was 5 failed / 40 passed) | T-1 done; the `init-templates.parity` failure was a non-hermetic test, see §10 |
| parity + invariant specs | **54/54 green** (`lock`, `status`, `lint`, `phase-rules`, `bootstrap`, `r5`, `no-emission`, `init-templates`, `run`) | the §5 "keep parity green" constraint **holds** — T17's acceptance bar is reachable |
| `@deepseek-ai/dsh-client-runtime` | declared in `dsh.client.inject`, **not installed**, **absent from every tag ≥ `0.2.0-rc.2`** | a dead client peer; repointed to `dsh-client-modules` (T-1). **Note:** the plugin's client half imports *no* `dsh-client-*` package at all — it uses structural seams, so `inject` is discovery intent, not a compile dependency |
| `dsh-code-runtime` / `dsh-invariants` | two stale devDeps, **zero imports** | **Corrected at rc.2:** `packages/code-runtime` is an *empty directory* (the devDep cannot resolve — it blocked `pnpm install` outright), while `packages/runtime-diagnostics/invariants` **still exists** as `@deepseek-ai/dsh-invariants@0.2.0-rc.2`. Both removed: the first because it is broken, the second for forward-compatibility with `0.2.1-alpha.1` |
| local clone `D:\deepseek-harness` | **shallow/grafted**, at `dsh-v0.2.0-rc.2` | local diffs are meaningless; derive capability claims from the tag tree (T31a) |
| `ctx.storageDomain` use | **0** | a durable, non-session host store exists and is unused (T18/T19/T21) |
| writers of `memory/training/**` | **0** | no end-of-run extraction; the directory holds only `.gitkeep` (T30) |
| `bootstrap.ts:252-253` | writes `MEMORY.md` as the literal stub `'# MEMORY.md\n'` | the plane is scaffolded, not populated — it *looks* functional |

### Gap map (native capability → status)

> **T31a step 4 — re-walked at `dsh-v0.2.0-rc.2`.** Every capability this table names as *existing* was verified against the pinned tag tree, not the old revision: `@deepseek-ai/dsh-workflow` (workflowEngine), `dsh-settings`, `dsh-jobs`, `dsh-agent-loop`, `dsh-llm`, `dsh-skill`, `dsh-session-reference` (fileReferences/sessionReferenceResolver), `dsh-tool-fs`, `dsh-plan-mode`, `dsh-storage`, `dsh-repeat-tool-reminder`, `dsh-hook-protocol` and the `session-format-v0-to-v1`…`v3-to-v4` chain all exist at `0.2.0-rc.2`. So the ❌ rows below are **capabilities that exist and are unused**, which is what makes them backlog rather than blockers. Two cells were corrected during the rebuild (client-runtime, the dead deps) and one is outright **wrong as written** — see the `fs/observed` row.

| DSH capability | Status in the plugin |
|---|---|
| `tools`, `systemPrompt.section`, `commands.register`, `webServer.register`, `sessions.get`, `workspaceRegistry` | ✅ used |
| `subagents.start()` (one-shot) | ✅ used in `delegateReview` |
| `subagents.startContinuable/followup/interrupt/drain*` | ✅ used (T4, done) |
| `agentTeams` (`createTask` / `waitForChange` / `interrupt`) | ✅ used (T3, done) |
| `goals` | ✅ used (T1, done) |
| `agent/pre-step`, `tools/pre-execute` | ⚠️ used, but the guard receives no runId (T15) |
| `fs/observed` | ⛔ **NOT used — this row previously claimed "⚠️ used".** There was **no `fs/observed` listener anywhere in `src/`**; the string appeared only in comments (`enforcement.ts:149`, `index.ts:291`, `runtime.ts:714`). `detectTamper` was exported with no live caller. T15 creates the listener. A plan that counts a comment as a wiring is exactly the class of error §7's verification discipline exists to catch |
| `sessionProjections` | ⛔ **settled — deliberately not adopted** (T5) |
| `fs/write-intent` / `edit-intent` | ⛔ **settled — host owns the single-slot waterfall** (T11) |
| `workflowEngine` | ❌ unused (T2) |
| `settings` | ❌ enforcement/router read from fs files (T7) |
| `fileReferences` / `sessionReferenceResolver` | ❌ `validateReferences` hand-rolled (T8) |
| `agentLoop.createAgent` / `agents` / `llm` | ❌ delegation inherits the child model (T9) |
| `jobs` | ❌ long ops run synchronously in-block (T10) |
| `planMode` | ❌ phases 0-2 not integrated (T13) — package is `packages/plan/plan-mode` |
| **`ctx.storage` / `ctx.storageDomain`** | ❌ unused. A host-side durable store for *"application state that must survive restarts **without becoming session events**"* (`packages/storage/storage`). Registers no tools, injects no prompts, **writes no session events** — so it does not touch the zero-emission invariant. Backends `storage-json` / `storage-sqlite`; `kv` is the only data shape (T18/T19/T21) |
| **`dsh-repeat-tool-reminder`** | ❌ unused. Ships a **no-progress loop guard** — *"helps a model escape loops in which it calls the same tool with identical arguments without making progress"*, reminders at 3/5/8 repeats, enabled in the base bundle. T20 must reconcile with it rather than invent a parallel one |
| **session format migrations** | n/a — `packages/session/session-format` plus `session-format-v0-to-v1` … `v3-to-v4`. **This changes the risk profile behind T5's zero-emission decision** |
| `hooks` (`hook-protocol`) | ⚠️ **not what T27 proposes.** `packages/hooks/hook-protocol` is the shared rule set behind the **Claude Code and Codex bridges** (external `hooks.json`, command hooks only). It is not an internal plugin-hook API; T27 stands but must not be described as reusing it |
| `skills` | ❌ Phase-8 memory written to fs only (T12) |
| **memory plane (read)** | ⛔ **created and linted, never read.** `bootstrap.ts` scaffolds `memory/**`; `ts-lint.ts:1928 lint_memory_plane` validates it; no code path loads it into context (T29) |
| **memory plane (write)** | ⛔ **created and linted, never written.** Phase 8 scaffolds `08-memory-impact.md` as a receipt stub (`closeout.ts:59`); nothing promotes its content into `memory/domains/` or `memory/training/` (T30) |

---

## 3. The recursion model (4 axes) — corrected

| Axis | Meaning today | Weakness to fix |
|---|---|---|
| **Inner** | draft → audit → repair → re-audit → pass (per phase) | **Corrected.** Continuable children (T4, done) retain the working set, so "reviewer context lost on re-audit" no longer holds. The remaining weaknesses are that a lock does not require quiescence (T18) and that the loop is bounded by round count rather than by progress (T20). |
| **Outer** | phase advance through the lock chain | **Corrected, and worse than stated.** The original text said enforcement was "purely in-process (`validateTransition`)". Verified: `validateTransition` is **imported and never called**, and the live guard is invoked with an **empty runId**, so the lock-order and TDD branches cannot fire. The gate is not in-process — it is *absent from the live path* (T15). Separately, the chain is modelled as a flat array while the real structure is a DAG (T17). |
| **Spatial** | run → child → grandchild depth | Unchanged: DSH's subagents supply the depth guard; the plugin adds no depth model of its own. Bounded by T28. |
| **Temporal** | memory accumulates across runs and feeds back in | **Corrected, and this is the worst of the four.** The plugin *creates* the memory plane — `bootstrap.ts` writes `MEMORY.md` as the literal stub `'# MEMORY.md\n'`, creates `memory/training/` holding only a `.gitkeep`, and lints the whole plane at `ts-lint.ts:1928` — but **nothing reads it when a run starts and nothing writes it when a run ends.** The parent repo ships two hooks for exactly this (`recursive-training-phase8-trigger` on Phase-8 lock, `recursive-training-loader` before planning), and both were excluded from the plugin as run-09 OOS2 (*"dsh has no training pipeline"*). T14 was the only item touching this, and it injects into a **reviewer bundle** — which is neither hook. See T29 and T30. |

The axes remain the right frame. What changed is the diagnosis on **Inner** and **Outer**.
---

## 4. Implementation backlog (spec per item)

> Each item declares `TDD Mode`. `strict` requires a RED spec (failing vitest) → GREEN impl (passing vitest). `pragmatic` requires an explicit exception rationale plus compensating evidence (manual verification or an integration test that is hard to unit test). **Evidence paths must exist before they are cited in §6** — see the §7.2 note about plans vs. reality.

#### 4.0 The substrate rule — files vs. `ctx.storageDomain`

Several items below need somewhere to keep state that is neither an artifact nor a session event. DSH now ships the right facility, and using it correctly matters because it sits close to this repo's most important principle.

**`ctx.storage` / `ctx.storageDomain`** (`packages/storage/storage`, backends `storage-json` and `storage-sqlite`) is a host-side durable store whose stated purpose is *"application state that must survive restarts **without becoming session events**"*. It registers no tools, injects no prompts, and **writes no session events** — so it does not touch the zero-emission invariant. `kv` is the only data shape. It is optional: a composition must mount the hub plus a backend and the domain form, so the plugin must degrade gracefully when it is absent, exactly as it already does for `goals`, `skills` and `agentTeams` (`backend-not-found` / `form-not-mounted` are the failure modes).

**The rule, which protects "files are the single source of truth":**

- **Files stay authoritative.** Anything that *is* the workflow — artifacts, receipts, locks, addenda, the control plane — lives in the repo and is reviewable in git. Never mirror it into storage.
- **`ctx.storageDomain` is for caches and indexes that can be thrown away and rebuilt.** A fold cache, an operation-identity index, a guard-decision log: losing these costs performance or evidence, never correctness.
- **Derived beats stored where derivation is cheap.** Per T18, pending work is *derived from the run directory*, not recorded — so it needs no store at all. Reach for `ctx.storageDomain` only where derivation is genuinely too expensive to repeat (T21) or where a fact cannot be re-derived from files (T19).
- **Degrade, never depend.** No item may make a store mandatory. Absent storage → recompute, and say so.

### T0 — Packaged `recursive-mode` skill · **done**

Shipped: `src/skills.ts` registers a bundled provider via `ctx.skills.registerProvider` (`source: 'bundled'`, rank 600, directory resource base, body from `skills/recursive-mode/SKILL.md`). Model- and user-invocable; optional (no registry → no-op). RED: `tests/skills.spec.ts`. GREEN: full suite + smoke.

### T1 — Project each run into a native **Goal** · **done**

Shipped: `src/goals-projection.ts`; wired into `initRun` (arm), `lockArtifact` (block on gate failure), reopen (resume). Safety rule retained: a goal whose objective is not a `recursive-run:<id>` marker is never clobbered. RED: `tests/goals-projection.spec.ts` (11 tests).

### T2 — Route fan-out audit/verification through the native **workflowEngine** · **backlog**

- **Why:** Phase 3.5 and cross-cutting verification are natural multi-agent fan-out; the plugin reimplements the loop. `workflowEngine` gives `phase()` / `agent()` / `pipeline()` / `parallel`, built-in caps, and `workflow/*` events for board observability.
- **What:** Adapter `orchestrateAudit(workflowEngine, run, reviewers)` mapping the audit contract to `phase(title)` + `agent(prompt, opts)` + `parallel(thunks)`, returning the aggregated verdict.
- **TDD Mode:** `pragmatic` — the workflow engine runs against a live host context and is integration-grade; unit-test the pure contract mapping and cover the live path manually.
- **RED/compensating:** `tests/workflow-contract.spec.ts` tests the pure mapping and asserts no cross-item null-dropping; manual verification runs a scripted audit and checks `workflow/phase|agent-start|agent-end` frames.
- **GREEN:** `src/workflow-audit.ts` (new), wired into the delegate path.
- **Acceptance:** a scripted 3-reviewer audit produces 3 `workflow/agent-end` frames + a single verified verdict.
- **Open question (from audit 1):** the harness's own lesson is that fan-out belongs behind a *hook*, not a bespoke loop, and that "the loop guard is the consumer's". Confirm the cap semantics before building this.

### T3 — Model the **audit→repair→re-audit loop** as `agentTeams` Tasks · **done**

Shipped: `src/teams-loop.ts` (pure `auditToPass`: create → claim → wait → audit → edit(REVISE) → complete(APPROVE) → lock; REJECT/cap/stuck release + interrupt; **a lock never precedes an APPROVE**) plus `src/recursive_audit_team.tool.ts` (turn-driven, one transition per call) and `RecursiveRuntime.auditToPass`. RED: `tests/teams-task-loop.spec.ts` (7 tests).

**Amendment (T20):** the loop is bounded by `maxRounds ?? 3`. Audit 2 showed round count is the wrong budget — three rounds finding new problems and three rounds repeating one are different situations. Bound on consecutive no-progress instead.

### T4 — Use **continuable** subagents for multi-round children · **done**

Shipped: `delegateContinuable` — `startContinuable` once, `followup` delivers each repair to the **same** child, settlement observed through an injected `awaitRoundResult` seam. `interruptContinuable` (keepInbox), `drainContinuableChildren/Descendants`. Safety properties: repair text is always synthesized from `findings[].title` so a child cannot inject instruction text; the parent must be the **exact live Agent** (object-identity authority), never a structural `{ id }` copy; a missing observer or parent falls back to one-shot with `fellBackToOneShot` rather than fabricating a verdict. RED: `tests/continuable-delegate.spec.ts` (12 tests).

### T5 — Replace the fs+SSE substrate with **sessionProjections** · **SETTLED — but RE-VERIFY the reasoning**

Moved from `deviated` to **settled**. A projection unit folds `session/event` and is per-session; the plugin is deliberately **zero-emission** (the 0.2.2 resume-crash fix, guarded by `tests/no-emission.spec.ts`) and its state is per-workspace on the filesystem. Adopting it would require re-introducing `recursive/*` emission — the exact regression 0.2.2 removed. The fs+SSE fold reads fresh on every GET, which is the cold-resume property the projection API exists to provide.

**Independently confirmed by audit 2.** Tardigrade's per-thread `ThreadEventStore` makes the same choice for the same reason — *"its operations do not accept a thread identifier because the store already has that identity"* — and holds *"host ingress, host reads, and reactors use the same store object, so append policy and read behavior cannot diverge between paths."* Per-scope storage with a fresh read is the design, not a workaround.

T15 adds the one improvement worth taking from that area: an **incremental** fold (keep `{source, position, state}` and step only the tail) with an append-only assertion.

**⚠ RE-VERIFY (added after checking upstream).** The zero-emission fix was driven by a `SessionFormatUnsupportedError` on resume with unknown events. Upstream master now ships `packages/session/session-format` — *"pure adjacent Session format planning… compose a unique sequence of adjacent migrations"* — with concrete migrations `session-format-v0-to-v1` through `v3-to-v4`, plus `session-persistence`, `session-persistence-jsonl` and `session-projection-cache`. **That does not by itself mean the plugin should emit events again** — the per-workspace, fs-derived design stands on its own merits, and Tardigrade independently chose per-scope stores. But the *risk profile* that motivated the invariant has changed, so "settled" should mean *"the design is right"*, not *"the original hazard is still as stated"*. Re-check against the current revision as part of T31, and record the outcome here.

### T6 — Wire the enforcement `ask` branch to the **approval** seam · **done (one half); see T15 and T11**

Shipped: `coerceAskToDecision` in `src/enforcement.ts`, wired into `tools/pre-execute` — an `ask` is never a silent allow (strict → deny, advisory → allow + a package-tagged `console.warn`). RED: the `coerceAskToDecision` block in `tests/enforcement.spec.ts`.

**Status correction.** The tracker previously recorded T6 as fully done, on the strength of the `ask` branch. §1 criterion 5 has two halves: the `ask` branch **and** the write-layer gate. The write-layer half is T11 (**settled** — host owns the waterfall) plus T15 (the guard path, which does not currently fire). So criterion 5 is **half-met**, and the enabling item is not complete. The earlier §7.2 named `tests/approval-bridge.spec.ts` as this item's spec; that file was never created. The assertions live in `tests/enforcement.spec.ts`, which is what the tracker row recorded.

### T7 — Put enforcement + router config in a **settings** namespace · **backlog**

- **Why:** Enforcement config and `recursive-router.json` are read from fs files. `settings` gives a durable, revision-tracked, UI-editable namespace, and hot-reload is the norm across the audited systems (the harness's whole config surface reloads without restart).
- **What:** `registerEnforcementSettings(settings)` with the `recursive` namespace (`preStep`/`toolGuards`/`tamper` + router defaults); back `resolveEnforcementConfig` + `loadRouterPolicy` from it; react to `settings/updated`.
- **TDD Mode:** `strict`. **RED:** `tests/settings-config.spec.ts`. **GREEN:** `src/settings.ts` (new) + refactor `src/enforcement.ts` / `src/router.ts`.
- **Acceptance:** toggling strict/advisory in the settings UI changes enforcement live; config persists across restart.
- **Interaction:** T16's policy file should be the *declarative* source the settings namespace exposes, not a second config path.

### T8 — Use native **reference resolution** instead of hand-rolled validation · **backlog, rescoped**

- **Why:** `src/delegation.ts` re-implements path containment + line-count checks. `fileReferences.list()` and `sessionReferenceResolver.listCandidates()/prepare()` are the canonical, cancellable seams.
- **Rescope (audit 1):** `validateReferences` is **not called inside `delegateReview`** today — it is exported and reachable but unwired. So this item is partly a **wiring bug**, not only a replacement. Fix the call site first; then delegate the implementation.
- **TDD Mode:** `strict` (adapter logic is pure) / `pragmatic` (live service). **RED:** `tests/native-reference-resolve.spec.ts`. **GREEN:** adapter in `src/delegation.ts`; remove the duplicated `resolveUnderRoot` containment copy where the native seam covers it.
- **Acceptance:** reviewer references are validated by the native seam; an escaping path is still rejected, and the validation actually runs on the delegate path.

### T9 — Per-role **model routing** via `agentLoop` / `agents` / `llm` · **backlog**

- **Why:** Delegation runs on whatever model the child inherits. The review/audit role (rigor) and the repair role (cheaper, more iterations) should differ.
- **What:** `routeForRole(role, agentLoop)` returning the review vs repair model; `agentLoop.createAgent` with an explicit route; `agents.withInitiator`/`currentInitiator` for clean parent tracking.
- **TDD Mode:** `pragmatic`. **RED/compensating:** `tests/role-model-route.spec.ts` tests the mapping and flags an unknown role.
- **Acceptance:** a review runs on the reviewer model; a repair loop runs on the cheaper model.
- **Interaction:** audit 1 recommends modelling the seven router roles (`orchestrator`, `analyst`, `planner`, `implementer`, `code-reviewer`, `tester`, `memory-auditor`) as **agent profiles** — markdown identities with preloaded skills and tool contracts, resolved once and frozen — rather than as tier-selection keys only. That is the larger version of this item; see T23's neighbour, T22.

### T10 — Track long operations as native **jobs** · **backlog**

- **Why:** `lintRun`, `createLinkedWorktree`, `delegateReview` are synchronous in-block. Native `jobs` (`start`/`list`/`read`/`kill`/`wait` + `onJobDone`) gives progress and a kill switch on the board.
- **What:** Wrap the three ops in `jobs.start`; surface `onJobDone`/`onJobsChanged` to the board.
- **TDD Mode:** `strict` (wrapping) / `pragmatic` (live run). **RED:** `tests/jobs-tracking.spec.ts`. **GREEN:** `src/jobs-runner.ts` (new).
- **Acceptance:** a hung worktree-create or linter shows as a running job and can be killed from the board.

### T11 — Hook `fs/write-intent` / `fs/edit-intent` as an authoritative write gate · **SETTLED — not adopted**

Moved from `deviated` to **settled**. `fs/write-intent`/`fs/edit-intent` are single-slot waterfalls already occupied by the host `fs-observation-policy`, which never calls `next()`; a recursive listener would be order-fragile and could break observed-write semantics. Enforcement stays at the `tools/pre-execute` guard (strict-deniable via T6) plus `fs/observed` tamper.

**Independently confirmed by audit 1.** The harness's own module states the boundary outright: *"This module only stamps metadata and strips model-supplied scope — **the worker enforces the root and grants**."* Enforcement belongs at the tool boundary, not in a competing filesystem waterfall. Revisit only if a multi-slot or layered intent API appears.

### T12 — Register phase rules / review checklists as **skills** · **backlog**

- **Why:** Phase 8 writes skill memory to fs. The native `skills` registry makes phase rules discoverable in-catalogue and lets the board react to `skills/change`.
- **What:** `registerPhaseSkills(skills)` registering each phase's lint rules as a skill; read `skills.list()`/`get()`; surface `skills/change`.
- **TDD Mode:** `strict`. **RED:** `tests/skill-registration.spec.ts`. **GREEN:** `src/skills-phase.ts` (new).
- **Acceptance:** the recursive agent and children discover phase rules via the native catalogue rather than fs grep.
- **Interaction:** audit 1's *preloaded contracts* idea is the natural companion — preload the current phase's tool contracts and required sections into the prompt rather than making the model look them up. See T22.

### T13 — Integrate **planMode** for phases 0-2 · **backlog**

- **Why:** Requirements / AS-IS / TO-BE-Plan are non-mutating discovery. Running them under `planMode` enforces "plan before implement" at the harness level.
- **What:** `phaseUsesPlanMode(phase)` for 00-02; route `exit_plan_mode` as the phase-2→3 gate.
- **TDD Mode:** `strict` (mapping) / `pragmatic` (live integration). **RED:** `tests/plan-mode-integration.spec.ts`. **GREEN:** `src/plan-gate.ts` (new).
- **Acceptance:** the plan phases run non-mutating; the plan gate is enforced.

### T14 — Deepen recursion: retrieve memory into the review bundle · **backlog**

- **Why:** Phase-8 memory should be retrieved into the reviewer's context so the recursion compounds rather than resets.
- **What:** `retrieveMemory(memoryStore, query)` returning relevant entries (skills / patterns / episodes / incidents / domains); seed `buildReviewBundle`'s `Relevant Memory References`.
- **TDD Mode:** `strict`. **RED:** `tests/memory-retrieval.spec.ts`. **GREEN:** `src/memory.ts` (new), wired into `delegateReview`.
- **Acceptance:** each run receives prior-run memory; the reviewer sees it in the bundle and can cite it.
- **Note from audit 1:** the harness's equivalent is a `pre_generate` hook that injects rules once per session and recalls memories as one appended message, reading *whether an update is due from the window the step sends* — which removes the need for a delivery ledger entirely. Worth copying that trick.
---

### T15 — Repair the enforcement path: give the guard a runId, put the transition gate on the live path · **done**

- **Why:** This is a bug, not a design gap, and it invalidates §1 criterion 2 and the §3 Outer axis as written.
- `src/index.ts:222` calls `evaluateToolGuard(exec, root, '', …)` with an **empty runId** (line 197 before the T-1 message-source fix shifted the file). The locked-artifact write branch does not need it (it resolves the target path directly), so that half works — but the **monotonic lock-order** and **Phase-3 TDD evidence** branches resolve prerequisites against `<root>/.recursive/run`, which holds run directories, not artifacts. Both are therefore inert.
- `validateTransition` (`src/lifecycle.ts:60`) is imported at `src/runtime.ts:25` and **never called**. Every gate it implements — prerequisite blockers, TDD evidence, `Audit: PASS`, `Requirement Completion Status`, delegation-basis markers, `QA Execution Mode` sign-off, effective-inputs re-read — is enforced only by the linter and the lock tool, never by the transition gate.
- `detectTamper` (`src/enforcement.ts:153`) is exported and unit-tested with **no `index.ts` caller**, so the `tamper` enforcement mode surfaces only as prompt text and board facts.
- **What:** (1) Resolve the active run id per guard call — the `agent/pre-step` listener already does `enumerateRuns` + `getNextLegalPhase`, so the pieces exist; reuse them, cached on cwd. (2) Route the guard through `validateTransition` so one predicate serves both the tool call and the transition. (3) Return a typed `GuardDecision { kind, reason, rule, transition }`. (4) Persist a rolling decision log (git-ignored) and surface the last N in `recursive_status` and on the board card. (5) Wire `detectTamper` into the observed-write path.
- **TDD Mode:** `strict`.
- **RED:** `tests/guard-path.spec.ts` — with a temp run whose phase 3 is DRAFT, expect (a) `recursive_lock` on `03-implementation-summary.md` without TDD evidence to be denied or asked under strict; (b) a write to a LOCKED artifact to be denied; (c) `validateTransition` to be reached from the guard; (d) a decision record to be written with a reason.
- **GREEN:** `src/enforcement.ts` (use the runId parameter), `src/index.ts` (call site + observed-write listener), `src/runtime.ts` (wire `validateTransition`).
- **Files:** `src/enforcement.ts`, `src/index.ts`, `src/runtime.ts`, `src/lifecycle.ts`, `tests/guard-path.spec.ts` (new).
- **Acceptance:** the lock-order and TDD branches fire; every deny carries a machine-readable reason; the decision log shows what the guard decided and why.
- **Evidence:** audit 1 §Enforcement; verified by grep in this session.

- **RESULT — done, and independently audited.** Implemented by a delegated subagent against a RED contract written by the orchestrator; the contract (`tests/guard-path.spec.ts`, 10 tests) was **never modified** — its sha256 is byte-identical to the snapshot taken before the implementer started (`evidence/logs/red/T15-guard-path.spec.SNAPSHOT.ts`, sha256 `25FF9063…B7C4`). Verification was performed by the orchestrator, not taken from the implementer's report:
  - the bug was proved **by execution** before the fix: same function, same disk state, `runId=''` → `{"kind":"allow"}` while `runId='audit-probe'` → `deny 'monotonic lock-order: 00-requirements.md (DRAFT)'` (`evidence/logs/red/T15-empty-runid-proof.txt`);
  - the 10-test contract passes 10/10 (`evidence/logs/green/T15-audit-independent-run.txt`);
  - `pnpm typecheck` exits 0 and the regression set — every parity spec, `no-emission`, `enforcement`, `tools`, `smoke`, `lifecycle`, `policy-render` — is **15 files / 87 tests green** (`T15-audit-regression.txt`), with the full suite at **47 files / 293 tests** excluding the then-in-flight T25 spec (`T15-audit-full-suite-minus-T25.txt`).
  - **What shipped:** `src/guard-log.ts` (new — rolling, bounded-to-500, never-throwing JSONL evidence trace under `.recursive/config/`), the guard resolves the real active run with `resolveRunDir` and **no time-based cache** (a stale cached run id would reintroduce exactly this bug), `validateTransition` is consulted and attached but stays **advisory-only** so no verdict and no parity golden changed, every decision is logged including allows, the first-ever `fs/observed` listener records detected tampers synchronously and cannot throw, and `foldRunCard` now **derives** `tamper` facts from the folded `lockProblems` instead of hardcoding `{}` — derived, so it survives a cold resume and needs no store (§4.0).
  - **Two things the plan had wrong, found while doing this:** (1) the §2 gap map claimed `fs/observed` was "used"; there was **no listener at all** — the string appeared only in comments (row corrected); (2) `detectTamper` needed a listener created, not merely wired. The `reviewedFiles`-only hole this work exposed in the linter became **T33**.
  - **Deliberate deviation from the item spec:** "surface the last N decisions on the board card" was implemented as *derived tamper facts on the card* plus the decision log on `recursive_status`; the card's tamper row is derived rather than replayed from the log, because replaying would make cold resume show nothing.

### T16 — Declarative, ordered tool policy with `ask` as the no-match default · **backlog**

- **Why:** Enforcement today is a hardcoded `WRITE_TOOL_NAMES` set plus an `endsWith('.md') && includes('/.recursive/run/')` substring test. Both audited systems converged on a declarative rule list instead: **allow AND NOT deny, deny wins, an invalid pattern fails the whole policy closed, and no match means `needs_approval`** — not deny, not allow. A policy is auditable in a way a code path is not.
- **What:** `src/policy-globs.ts` — a glob matcher with exact, `worker::*` and catch-all forms; an ordered `Rule[]` of `{ pattern, verdict: allow | deny | ask, reason }`; `evaluate(id, args): Decision` with first-match-wins. Ship a default `.recursive/config/recursive-permissions.json` with the rule semantics documented in the file, the way the harness documents *why* each id is denied. Let `phase-rules.ts` supply a **per-phase baseline** — for example phase 3 denies `recursive_lock` until TDD evidence exists; phase 6 allows writes only under `.recursive/DECISIONS.md`; phase 8 only under `.recursive/memory/**`. `evaluateToolGuard` becomes a thin caller.
- **TDD Mode:** `strict`.
- **RED:** `tests/policy-globs.spec.ts` — deny-overrides-allow; an invalid pattern denies everything; an empty policy denies everything; no-match yields `ask`; first-match-wins ordering; a per-phase baseline narrows a global rule.
- **GREEN:** `src/policy-globs.ts` (new), `src/enforcement.ts` (delegate), `src/phase-rules.ts` (baselines).
- **Acceptance:** a reviewer can read the effective policy for a phase and predict the verdict for any tool call without reading TypeScript.
- **⚠ AMBIGUITY RESOLVED (found during implementation, and it is a safety property, not a wording nit).** This item's "Why" asks for **"allow AND NOT deny, deny wins"** while its "What" asks for **first-match-wins**. Those two cannot both hold under adversarial ordering, and implementation surfaced the conflict as a failing test: with plain first-match-wins, `[* allow, write deny]` yields **allow** for `write`. The ruling, which the engine and the shipped file must both state:
  - **PRECEDENCE = SPECIFICITY FIRST, THEN FILE ORDER.** A more specific matching pattern outranks a less specific one; among equally specific matching rules the earlier one wins. `*` is least specific, so a **catch-all `allow` can never shield a tool id from a specific `deny` listed after it**. A rule whose predicate abstains (returns `null`) does not participate.
  - Why not plain first-match-wins: it makes "deny wins" a property of the *file's ordering* rather than of the engine, so a hand-edit that puts a catch-all `allow` at the top silently disables every deny — precisely the failure the "deny wins" phrase exists to prevent. The shipped file's deny-first ordering is therefore a **readability convention, not the correctness mechanism**, and its own documentation must say so.
  - Why not "any matching deny always denies": it would stop an operator from opening a *specific*, deliberate hole with an exact-id `allow`, which is a legitimate use of a declarative policy.
- **Two consequences for the RED list and the docs:** the RED case called "deny-overrides-allow" must assert the *hard* form — an allow listed FIRST must still lose to a specific deny — and the shipped JSON's explanation must describe the engine's actual rule, not just the file's ordering.
- **Interaction:** T7 is where this policy becomes UI-editable; do not create two config paths.
- **Evidence:** audit 1 §Function policy; the root `iii-permissions.yaml` ordering semantics.

### T17 — Model the phase dependency as a **DAG**, not a flat sequence · **backlog — changes the data model**

- **Why:** Three core queries are graph operations run over a linear array. `getStaleDownstreamPhases` is a **reachability** query; `getPrerequisites` is an **in-edge** query; `getNextLegalPhase` is a **topological** choice — all implemented with `PHASE_SEQUENCE.indexOf` and `slice`. The real structure is not linear: an `upstream-gap` addendum creates an edge pointing **backwards** to a locked earlier phase, and receipt invalidation cascades **forwards** from wherever a change landed. The flattening is why the code needs `.addendum-` filename parsing, a bespoke `getRelatedAddendaPaths`, and a `Plan Drift Check` section whose job is to notice when the flattened model and reality disagree.
- **What:** Build the dependency set explicitly per run — nodes are the artifacts present on disk; edges are **prerequisite** (an earlier artifact exists and must be locked) plus **addendum** (this artifact amends that one, read from the filename convention already parsed). Answer the three queries against it. `Plan Drift Check` becomes a comparison rather than a prose obligation.
- **TDD Mode:** `strict` — this is pure data, ideal for unit testing.
- **RED:** `tests/phase-graph.spec.ts` — a linear run yields the same `getNextLegalPhase` as today; a run with an `upstream-gap` addendum yields a back-edge; invalidating a mid-chain receipt marks exactly the reachable downstream set; a cycle is rejected loudly.
- **GREEN:** `src/phase-graph.ts` (new); `src/lock.ts` delegates to it while keeping the existing exports so the parity specs keep passing.
- **Files:** `src/phase-graph.ts` (new), `src/lock.ts`, `src/status.ts`, `src/ts-lint.ts` (drift check), `tests/phase-graph.spec.ts` (new).
- **Acceptance:** `tests/lock.parity.spec.ts`, `tests/status.parity.spec.ts` and `tests/lint-parity.spec.ts` still pass unchanged, and a back-edge case the array model gets wrong is now correct.
- **Note:** Effect ships a stable, runtime-free `Graph` doing exactly this. **Do not adopt it** — a few hundred lines of local TS keeps the zero-dependency posture and the parity goldens intact. The *model* is what is wrong, not the implementation.
- **Evidence:** audit 2 §3.10; this session's reading of `src/lock.ts`.

### T18 — Quiescence rule for `recursive_lock`, and derive in-flight work by folding · **backlog**

- **Why:** A lock is only sound at a point where nothing is in flight. Tardigrade enforces this literally: a checkpoint *may not contain pending work* — capture returns nothing while any request lacks a settlement, the manual path **fails** with `Cannot checkpoint while work is pending or initialised atoms are unread`, and decoding throws `Effect checkpoint contains pending work`. The plugin has no equivalent check, so a phase can lock while a delegation or a repair is unresolved.
- **The second half is what makes the first cheap:** Tardigrade has **no separate queue**. Pending work *is* `EffectRequested` without `EffectSettled`, derived from the same log on replay.
- **What:** (1) One projection beside `foldRun` — `pendingWork(runDir)` — deriving unresolved work from what is already on disk: a delegation with `handoff.md` but no `reply.md`; a reopen plan without a completion marker; a closeout phase scaffolded without a receipt. No new structure. (2) `lockArtifact` refuses when that set is non-empty, naming the items. (3) Surface the set in `recursive_status` and on the board card.
- **TDD Mode:** `strict`.
- **RED:** `tests/quiescence.spec.ts` — a run with an unanswered handoff refuses to lock and names it; after the reply lands the same lock succeeds; a run with nothing in flight is unaffected, because the common case must not regress.
- **GREEN:** `src/status.ts` (`pendingWork`), `src/runtime.ts` (`lockArtifact` guard), `src/types.ts` (wire shape).
- **Substrate:** **none needed.** Per §4.0 this is derived on read, not stored — which is precisely what makes the quiescence rule cheap. Do not put it in `ctx.storageDomain`.
- **Acceptance:** no phase can lock with unresolved delegated or repair work; the refusal names the specific unresolved item.
- **Evidence:** audit 2 §4 and items (a) and (b).

### T19 — Deterministic operation identity from canonical inputs · **backlog**

- **Why:** `reopen` is the one genuinely destructive operation in the workflow, and a retry after a partial failure is currently indistinguishable from a fresh request. Two independent systems converged on the fix: Tardigrade's `InputDigest` (RFC 8785 canonical JSON — sorted keys, rejecting lone surrogates and non-finite numbers — then SHA-256 plus byte length, inline below 2 KiB and digested above) and Effect's `makeExecutionIdFromPayload` (SHA-256 over `tag.length:tag:idempotencyKey(payload)`, truncated), with `Activity.idempotencyKey(name, { includeAttempt })` applying the same rule to side-effecting calls.
- **What:** `canonicalInput(value)` and `operationId({ act, input })` in a new `src/identity.ts`. Use it for `recursive_reopen`, `delegateReview`, and each `auditToPass` round, so an identical retry is recognised as the same operation rather than executed again. Persist the id with the operation so a restart can match it.
- **TDD Mode:** `strict`.
- **RED:** `tests/identity.spec.ts` — key order does not change the id; an array order change does; a lone surrogate and a non-finite number are rejected; a re-submitted identical operation is recognised; a materially different one is not.
- **GREEN:** `src/identity.ts` (new); wired into `src/runtime.ts` (reopen, delegate) and `src/teams-loop.ts` (round).
- **Substrate:** the **operation-identity index** cannot be re-derived from files (that is the point — it records that an operation was already attempted), so it is a legitimate `ctx.storageDomain` use per §4.0. Degrade to no-op when the store is absent.
- **Acceptance:** repeating a `reopen` or a delegation round with identical inputs is a recognised no-op rather than a second execution.
- **Evidence:** audit 2 item (c) and §3.7 for Effect's independent convergence.

### T20 — Bound recovery on **no-progress**, not on round count · **backlog**

- **Reconcile with what DSH already ships.** `packages/guard/repeat-tool-reminder` (`@deepseek-ai/dsh-repeat-tool-reminder`) is an **existing no-progress guard**: *"helps a model escape loops in which it calls the same tool with identical arguments without making progress"*, with reminders at 3/5/8 repeats, enabled in the base bundle. It is **advisory and model-facing** — *"the reminder is advisory: it never blocks or delays a legitimate repeated call"* — and is tracked per agent, cleared by a new user message. This item is therefore **not** a duplicate: T20 is a *hard, durable, workflow-level* bound that terminates a phase loop and demands a resume, whereas the shipped guard nudges the model. Decide explicitly whether to complement it (recommended), reuse its repeat-counting, or invoke it — and do not build a parallel advisory.
- **Why:** `auditToPass` is bounded by `maxRounds ?? 3`. Round count is the wrong budget: three rounds that each find new problems, and three rounds that repeat the same finding, are not the same situation — one is progress and the other is a loop. Tardigrade's watchdog carries `attempts`, `consecutiveNoProgress`, `progressCursor`, `nextWakeAt`, exponential backoff, `maxAttempts: 20`, `maxNoProgressAttempts: 5`, and a `WatchdogTerminalError` that **blocks automatic recovery until an explicit resume**.
- **What:** Track a *progress cursor* per audit round — the finding set and the failing gate set — and reset `consecutiveNoProgress` only when it changes. Cap on consecutive no-progress rather than rounds alone, keep an absolute attempt cap, and make the terminal state **require an explicit resume** rather than silently retrying or silently giving up. Surface the counters in the task history and on the board.
- **TDD Mode:** `strict`.
- **RED:** `tests/audit-progress.spec.ts` — three rounds with identical findings terminate as no-progress and demand a resume; three rounds with distinct findings continue; a resumed run resets the counter; the absolute cap still applies.
- **GREEN:** `src/teams-loop.ts` (`auditToPass` budget), `src/recursive_audit_team.tool.ts` (surface the counters).
- **Acceptance:** a non-progressing audit stops and says why; a progressing one is not cut short by a round count.
- **Evidence:** audit 2 item (d) and §4 watchdog policy.

### T21 — Incremental fold with an append-only assertion, and one named `position` per phase · **backlog**

- **Why, incremental:** `foldRun` re-reads and re-parses every artifact on every call, and `snapshotWorkspace` does it for the whole run tree on **every board request**. Tardigrade's `durableAtom` keeps `{ source, position, state }`, steps only the tail when the source is unchanged, and **throws** `EventLog source must be append-only` if the source ever shrinks.
- **Why, position:** a phase is currently described by a `status` string plus separately-derived `lockValid`, `lockProblems`, `blockers`, `coverage`, `approval` and `audit` fields that every consumer must combine for itself — which is why the client already needs a `sameWorkspacePath()` guard against two consumers disagreeing. Tardigrade publishes exactly **one** named position per stateful atom: `idle`, `ready`, `running`, `waiting`, `stopping`, `settling`, `compacting`, `checking`, `configuring`, `failed`.
- **What:** (1) Cache the fold keyed by an artifact-set fingerprint, stepping only new or changed artifacts, and assert the set only ever grew. (2) Derive one `position` per phase from those fields, and make the board, the policy text and the guard read that single value.
- **TDD Mode:** `strict`.
- **RED:** `tests/fold-incremental.spec.ts` — a second fold over an unchanged run does no re-parse; an appended artifact is stepped incrementally; a **removed** artifact throws rather than silently returning a shorter state; every combination of the underlying fields maps to exactly one position.
- **GREEN:** `src/status.ts` (frame cache + `position`), `src/snapshot.ts`, `src/client/derive.ts` (consume `position`).
- **Substrate:** the fold frame is a **pure cache** — always rebuildable from the artifacts — so `ctx.storageDomain` is the right home per §4.0. An in-process cache is acceptable as a first cut; the store matters only across restarts.
- **Acceptance:** board and status cost does not grow with run-tree size, and no two consumers can disagree about a phase's state.
- **Evidence:** audit 2 items (e) and (g).
### T22 — Stable prompt prefix and preloaded contracts · **backlog — VERIFY THE PREMISE FIRST**

- **Why:** `renderRecursivePolicy` renders the *current phase*, its required sections and its gate checklist into one prompt section on **every step of every turn**. Because static contract text is interleaved with volatile text, the injected prefix changes on every phase transition and cannot be cached. The harness treats this as a first-class concern: the prompt is sent as `system_sections` — a byte-stable prefix with `cache_boundary: true` plus a per-session tail — with `cache_intent.surface_digest = sha256(stable)`, and when it cannot be delivered the **reason** is reported as `disabled`, `no_stable_prefix` or `prefix_rewritten`.
- **PREMISE NOT YET VERIFIED — resolve this before implementing.** The mechanism above is modelled on iii's `system_sections` + `cache_boundary: true` + `cache_intent.surface_digest`. A check of `D:\deepseek-harness\packages` finds **none of those concepts in DSH**: zero hits for `cacheBoundary`, `cache_boundary`, `surface_digest`, `promptCache`. DSH's `systemPrompt.section({ name, order, text })` is a **flat ordered concatenation** — *"Sections are concatenated in ascending order. Equal orders use code-unit name order"* — with no boundary marker and no cache-intent field. The only cache-adjacent surface found is `cacheControlFormat` in a per-provider catalog, and it concerns `cache_control` on **tool definitions**, not system-prompt prefixes.
- **Therefore:** the *split* is implementable and still worth doing (a byte-identical prefix is a precondition for any provider-side caching), and the digest is worth computing as a **local identity** for T26 and for detecting a rewritten head. The *boundary declaration* and the *cache-intent hint* are not expressible in DSH and must be dropped from this item.
- **The "largest cost lever" label is withdrawn.** Whether any provider actually caches the prefix is provider-side and unverified. **Step 1 of this item is to measure, not to implement:** register a stable section at a low order and the volatile tail at a high order, then determine empirically whether cache hits occur. If they do not, this item reduces to prompt hygiene and should be re-ranked accordingly.
- **What (rescoped):** (1) Split into `renderStableContract()` — phase vocabulary, gate vocabulary, marker names, lock rules; byte-identical for the whole run — and `renderPhaseTail()` — current phase, required sections, checklist, blockers. (2) Register the stable part at a low `order` and the tail at a high one, with no other section interleaved between them. (3) Compute and expose a `promptSurfaceDigest` on `recursive_status` as a local identity. (4) Add `<preloaded_functions>` and `<preloaded_skills>` blocks for the current phase's tool contracts and required sections, so the model does not spend a lookup per session — and correct a stale block with a **tail notice**, never by rewriting it.
- **TDD Mode:** `strict` for the split and the digest; `pragmatic` for the live prompt-layer assertion.
- **RED:** `tests/policy-sections.spec.ts` — the stable section is byte-identical across phases; the tail changes; the digest is stable within a run and changes when the contract changes; the two sections are registered at orders that leave no foreign section between them.
- **GREEN:** `src/policy.ts` (split + digest), `src/index.ts` (section registration), `src/status.ts` (expose).
- **Acceptance:** within a run the stable section never changes and its digest is stable; **and a measurement exists showing whether this produces provider cache hits** — if it does not, the item is prompt hygiene only.
- **Constraint:** everything is still rendered from the filesystem — fully compatible with the zero-emission invariant.
- **Evidence:** audit 1 §Caching seam and §Agent profiles.

### T23 — `recursive_ask`: structured decisions instead of prose · **backlog**

- **Why:** three points in the workflow genuinely block on a human, and all three are prose today: the `TDD Mode: strict|pragmatic` choice at phase-3 entry, QA sign-off at phase 5, and gate-block resolution. A prose question in chat can be missed. The harness models this properly: `harness::ask` renders a card with **hard limits** (1–4 questions, 2–4 options, header at most 16 characters, label at most 80, single-line, one per step), names the field and index in a validation error, and **ends the turn on the question** — the answer is simply the user's next message.
- **What:** a `recursive_ask` tool wrapping the DSH question seam with the same validation limits and refusal vocabulary, used at exactly those three points, writing the answer back as a durable artifact line so the artifact remains the record. Enforce the limits in the tool schema rather than trusting the caller.
- **TDD Mode:** `strict`.
- **RED:** `tests/recursive-ask.spec.ts` — an over-length header or label is rejected with the field path; a second ask in one step is refused; the accepted answer is written to the artifact as a marker line; the turn is not parked.
- **GREEN:** `src/recursive_ask.tool.ts` (new), `src/index.ts` (registration), `src/phase-rules.ts` (the three call points).
- **Acceptance:** the three human gates render as cards, and their answers land in the artifact.
- **Evidence:** audit 1 §Asking the user.

### T24 — Result caps, elision markers, and stable error codes · **backlog**

- **Why:** `recursive_lint` returns unbounded `errors[]` and `warnings[]`; `ts-lint.ts` is a 126 KB port that can emit hundreds of findings into one tool result. The harness caps at `max_result_bytes` (256 KiB) and replaces the excess with a **self-describing** marker that says what was removed and how to get it back — and its directory worker makes every error *one self-sufficient prose sentence* (`<code> <class>: <problem> Did you mean: … Next: call <fn> to …`) because a JSON envelope **arrives double-escaped and is unreadable to an LLM**.
- **What:** (1) Cap and elide in the lint tool's `render`, emitting `{ elided: true, total, shown, hint }` with a self-describing hint. (2) Add `mode: 'summary' | 'full'`. (3) Give every `recursive_*` tool error a stable code and class plus a `Next:` clause naming the exact call that resolves it.
- **TDD Mode:** `strict`.
- **RED:** `tests/result-caps.spec.ts` — an oversized lint result is elided with a retrievable hint; a small one is untouched; every tool error begins with a stable code; the marker states how to get the full result.
- **GREEN:** `src/recursive_lint.tool.ts`, `src/ts-lint.ts` (cap), new `src/errors.ts` (codes).
- **Acceptance:** no tool result is unbounded; every refusal says what to do next in a greppable form.
- **Evidence:** audit 1 §Result caps and §Error codes.

### T25 — Executable documentation tests · **done**

- **Why:** the harness enforces documentation with a test that **fails the build** if a shipped prompt names a removed id or a worker the agent is meant to discover — and it exists because *the removal originally missed all eight provider identity prompts; agents kept reaching for `react` because they were still being told to*. This repo has golden lint fixtures but nothing guarding its prose, and both audits found real drift in both codebases as a result.
- **The concrete bug this would catch today:** `writeActionRecord` emits `# Subagent action record: <id>` while `ts-lint.ts` requires the literal `# Subagent Action Record` plus `Run ID` and `Timestamp` in `## Metadata` and `Diff Basis` under `## Inputs Provided` — and every top-level `.md` under `subagents/` is linted as an action record. **Plugin-generated action records currently fail the repo's own lint contract.**
- **What:** `tests/docs-contract.spec.ts` asserting: (a) every file path that **purports to be an existing file of this repo** and is referenced from `PROPOSAL.md`, `STRENGTHENING-PLAN.md`, `HANDOFF-review-and-opine.md` and `skills/**` exists; (b) `package.json` description agrees with the registered tool count; (c) **every marker string the linter requires is emitted by the writer that produces it**, including the action-record headings and fields; (d) no shipped prompt or skill names a withdrawn tool, phase or verb.
  - **⚠ AMENDED — criterion (a) as originally written was unworkable, and measuring it is what showed that.** The first version demanded that *every* referenced path exist, naming `README.md` among the documents. Both halves are wrong: there is deliberately **no `README.md` at the repo root**, and a naive "every path exists" rule fails on the plan's own forward references. Measured on the rebuilt tree: `STRENGTHENING-PLAN.md` has **77** repo-relative references and **40** of them do not resolve — because they are this plan's own **planned deliverables**, `(planned)` by §6's tracker convention (`src/policy-globs.ts`, `src/identity.ts`, `src/hooks.ts`, `src/memory.ts`, `src/phase-graph.ts`, `src/recursive_preview.tool.ts`, `src/settings.ts`, `src/errors.ts`, `src/jobs-runner.ts`, `src/recursive_ask.tool.ts`, …). Requiring those to exist would force the backlog to stop describing the work it schedules. `PROPOSAL.md` has 7 repo-relative references and 5 unresolved, four of which are paths in the **parent methodology repo** (`skills/recursive-mode/scripts/recursive-status.py`, `skills/recursive-mode/references/agents-block.md`, `skills/recursive-mode/references/bootstrap/RECURSIVE.md`, `skills/recursive-review-bundle/SKILL.md`), i.e. cross-repo, not drift. `HANDOFF-review-and-opine.md` is clean: 18 references, 18 resolve.
  - So (a) enforces **class 1 only** — paths that claim to be existing files *of this repo* — and explicitly excludes **class 2** (planned/not-yet-built deliverables) and **class 3** (cross-repo and absolute paths). The spec must comment *why* those classes are excluded, so a later reader does not mistake the scoping for toothlessness, and must include a **non-vacuity self-check** (the class-1 set is non-empty, and a deliberately bogus repo path would be caught) so the test cannot pass by matching nothing.
  - **One real instance of class-1 drift the amended criterion catches:** `PROPOSAL.md` named the smoke harness with its old Python extension. Quoted rather than written inline, because naming a *missing* path in prose is exactly what the rule flags — and a quoted before/after is what a code block is for:

    ```text
    PROPOSAL.md said : scripts/test-recursive-mode-smoke.py
    repo ships       : scripts/test-recursive-mode-smoke.ts
    ```
- **TDD Mode:** `strict`.
- **RED:** `tests/docs-contract.spec.ts` written RED against the current tree — it must fail on the action-record mismatch and on any dead path reference.
- **GREEN:** fix `writeActionRecord` to the linter's contract; fix or remove dead references.
- **Acceptance:** the suite fails if prose and code drift apart in any of those four ways.
- **Evidence:** audit 1 §Documentation architecture; audit 2 §8.1 for the same class of drift in iii.

- **RESULT — done, and the headline finding is a CORRECTION to the review.** `tests/docs-contract.spec.ts` (15 tests, 4 blocks) now fails the build on four classes of prose/code drift. The item's premise — that `writeActionRecord`'s output fails the repo's own linter — was verified **by execution** rather than by the static reading the review used, and the count is **SEVEN violations, not the five** the handoff's §6.1 table claims. The full set, replaying the pre-fix writer byte-for-byte out of git and running the real `lintSubagentActionRecordFile`/`lintRun` over its real output:
  1. `Missing title: # Subagent Action Record` (the case mismatch — the table's row 1)
  2. `Metadata is missing Run ID` (row 2)
  3. `Metadata is missing Timestamp` (row 3)
  4. `Inputs Provided is missing Current Artifact` (row 4)
  5. `Inputs Provided is missing Diff Basis` (row 5)
  6. `Inputs Provided must cite upstream artifacts or the review bundle used for delegation` — **not in the table.** It is the composite of two defects: `Review Bundle` is read from `## Inputs Provided` but was emitted under `## Metadata`, and `Upstream Artifacts` was emitted as bare bullets where `extractPathsFromNamedField` needs a NAMED field, so the extracted set was empty.
  7. `Missing or empty section: ## Verification Handoff` — **not in the table, and not a writer error at all.** It is the `\Z` anchor bug, now tracked as **T33**.
  - **Two further corrections to the table's reasoning.** (a) The table's row 4 pairs `Current Artifact` with `Artifact Content Hash`; the hash check is *gated behind* `Current Artifact` resolving (`ts-lint.ts:1309`), so a missing hash is real but **invisible** until the placement is fixed. (b) The handoff justified the two placement failures by claiming `getMdFieldValue` "scans the whole document, not the section it was handed" — **that is wrong**: `getHeadingBody` terminates at the next `##` via lookahead, so the linter is properly section-scoped. The failures are real for the simpler reason that the field is under the wrong heading. **The shipped canonical template agrees with the linter, not with the old writer** (`references/artifact-template.md` lists `Diff Basis` as an INPUTS field), so the fix matches the template as well as the lint.
  - **What shipped:** the writer now emits the canonical H1, `Run ID` + `Timestamp` in Metadata, and `Current Artifact` / `Artifact Content Hash` (LF-normalized sha256 derived from `artifactPath` via the existing `contentSha256` — **no new caller input was needed, so no call site changed**) / `Diff Basis` / `Review Bundle` / NAMED `Upstream Artifacts` + `Code Refs` inside `## Inputs Provided`. `package.json`'s description now states the real tool count and names all nine, asserted bidirectionally against the counted `createRecursive*Tool` registration sites so a tenth tool breaks the spec instead of rotting. `PROPOSAL.md`'s smoke-harness reference was corrected from its old Python extension to the shipped one (the one genuine class-1 drift; the assertion was left alone).
  - **The T33 hole is PINNED, not hidden:** the `reviewedFiles`-only case is asserted with vitest's `it.fails`, so it passes while the limitation exists and will fail the moment T33 fixes the linter.
  - **Two things deliberately NOT done, with reasons:** `src/runtime.ts:362` still passes no file claims, so enforced-path records fail the DATA-ABSENCE checks (no artifact path / no created-modified-reviewed) — fabricating claims to satisfy a linter would be dishonest, and that gap is recorded rather than papered over; and `src/ts-lint.ts` was not touched (T33 owns it).
  - **Audit:** the orchestrator re-ran everything independently — `pnpm typecheck` exit 0, **`pnpm test` 48 files / 308 tests green** (`evidence/logs/green/T25-audit-full-suite.txt`), the four drift classes confirmed present as tests, and `(d)` verified as a *narrowing* (verbs read only from real advertised surfaces — the preset description, `commands.ts`'s `input.hint`, and `/recursive <verb>` inside code spans) rather than a deletion, so the English word "command" after `/recursive` no longer counts as an advertised verb.

### T26 — `recursive_preview`: a read-only view of what will happen · **backlog**

- **Why:** there is no way to see what `recursive:policy` will render, which policy rule will match, or what the next legal transition requires — until it fires. The harness ships `harness::system-prompt::get`, which previews every prompt layer *without making a model request*, distinguishes the **resolved** prompt from a rebuilt one, and explicitly states what a read-only preview **cannot** show.
- **What:** a `recursive_preview` tool returning the rendered stable and tail sections plus their digest (T22); the effective ordered rules for the current phase (T16); the next legal transition and exactly which gates it needs (T15, T17); and the effective enforcement modes. Mark the fields a read-only preview cannot compute.
- **TDD Mode:** `strict`.
- **RED:** `tests/preview.spec.ts` — the preview reflects the phase's real sections; it names the rule a probe tool call would match; it lists the gates the next transition requires; it makes no model request and writes nothing.
- **GREEN:** `src/recursive_preview.tool.ts` (new).
- **Acceptance:** a human can see the enforcement contract before it fires, making *enforce, don't just describe* checkable.
- **Evidence:** audit 1 §Read-only preview.

### T27 — Hook registry: named points with priority, timeout and failure policy · **backlog**

- **Why:** enforcement is two listeners inlined in `apply()`, with no ordering, no timeout, no failure policy, and no way for a sibling plugin to participate. The harness's version is the single most reusable idea in audit 1: six named points, a middleware chain ordered by `priority`, a `continue | deny | hold` decision, per-binding `timeout_ms`, and `on_error` defaulting to **fail-closed for gating points and fail-open for observing points** — with *hook logic lives in the sibling, never the harness* as the governing rule.
- **What:** `src/hooks.ts` exporting a typed `HookRegistry` over five points mapped onto DSH seams: `pre_turn` to `agent/pre-step` before `next()`; `pre_generate` to the policy section callback; `post_generate` to a post-step listener (**observe only** — never allow mutation, and say why in the doc comment, because the message has already streamed); `pre_trigger` to `tools/pre-execute`; `post_trigger` to `tools/post-execute`. Then re-express the plugin's own enforcement as built-in hooks.
- **TDD Mode:** `strict`.
- **RED:** `tests/hooks.spec.ts` — chain order by priority with ties broken deterministically; the first deny short-circuits; a hook that throws is denied under `fail_closed` and skipped under `fail_open`; a hook exceeding `timeout_ms` is handled by its policy; a retried step re-runs hooks, so the test asserts that idempotence is the caller's obligation.
- **GREEN:** `src/hooks.ts` (new); `src/index.ts` (registration); existing enforcement re-expressed as built-ins.
- **Acceptance:** a sibling DSH plugin can participate in a run without patching this one, and ordering and failure behaviour are declarative.
- **Caution to carry into the code comment:** hooks run on at-least-once paths and must be idempotent; mutations are silent, so return annotations; treat hook input as untrusted; never start a turn from a hook.
- **Evidence:** audit 1 §Hooks.

### T28 — Budgets · **backlog**

- **Why:** `auditToPass` has `maxRounds` and `delegateReview` has a hardcoded `maxDepth: 2`; nothing else is bounded. The harness bounds everything, and — importantly — a child can only **narrow** a budget, never widen it: *children cannot widen or replace their root turn's execution budget*.
- **What:** budget fields beside `EnforcementConfig` — `maxAuditRounds`, `maxRepairAttempts`, `maxDelegationDepth`, `maxChildrenPerPhase`, `maxResultBytes` — enforced in `auditToPass`, `delegateReview` and the tool render, with counters persisted on the run so a resumed session sees them, and surfaced in `recursive_status` and on the board. A budget nobody can see is a budget nobody trusts.
- **TDD Mode:** `strict`.
- **RED:** `tests/budgets.spec.ts` — each cap is enforced independently; a child delegation cannot exceed its parent's remaining budget; the counters survive a fold; an exceeded cap produces a specific, named refusal.
- **GREEN:** `src/enforcement.ts` (config), `src/teams-loop.ts`, `src/delegation.ts`, `src/recursive_lint.tool.ts`.
- **Acceptance:** every unbounded loop and every unbounded result has a named, configurable cap.
- **Evidence:** audit 1 §Budgets; audit 2 §4 watchdog and promise policies.

### T-1 — Recover the baseline: make the tree green before tracking anything new · **done**

- **Why:** This item did not exist in the previous revision because the baseline was assumed green. It is not. `pnpm typecheck` fails at **12 sites** and **5 of 45 spec files fail**. Every item below is written with the acceptance test "the suite stays green", so no item can be honestly marked RED→GREEN until this is done. The failures are **not** version drift: they reproduce identically at `0.1.1-rc.2` *and* at the newest upstream tag, so no dependency bump can fix them (see T31a).
- **What:**
  1. **Type-surface imports (12 sites).** `JsonValue` is *defined* in `@deepseek-ai/dsh-util-values` and only *imported* — never re-exported — by `@deepseek-ai/dsh-tools`; nine tool files do `import type { JsonValue } from '@deepseek-ai/dsh-tools'`. `@deepseek-ai/dsh-llm` exports `ToolCallId`, never `CallId`; three specs import `CallId`. Repoint both.
  2. **Dead dependencies.** `@deepseek-ai/dsh-code-runtime` and `@deepseek-ai/dsh-invariants` were **deleted upstream** (the whole `packages/code-runtime` and `packages/runtime-diagnostics` groups are gone). Nothing in `src/`, `tests/` or `scripts/` imports either — they are two stale `file:` devDependencies. Remove them.
  3. **Dead client peer.** `@deepseek-ai/dsh-client-runtime` is declared in `dsh.client.inject` **and** as an optional peer but **is not installed** and **does not exist at any tag from `0.2.0-rc.2` onward** — it was real at `0.1.1-rc.2` and was consolidated into `@deepseek-ai/dsh-client-modules`. Drop the entry or repoint it.
  4. **Record the baseline.** `pnpm typecheck`, `pnpm test`, `pnpm build` and the smoke script, green, on the pinned `dsh-v0.2.0-rc.2` revision — written into §7.0 so later items can prove they did not regress it.
- **TDD Mode:** `pragmatic` (no behaviour change; the suite *is* the test). Exception rationale: the only assertions available are the existing suite plus `tsc`, and creating new specs to observe a compile error would be theatre.
- **RED:** `pnpm typecheck` exits non-zero (12 × TS2614) and `pnpm test` reports `Test Files 5 failed | 40 passed`. Reproduce and record both verbatim **before** changing anything.
- **GREEN:** `pnpm typecheck` clean; `pnpm test` reports 45/45 files and the 257-test count (one assertion in `tests/init-templates.parity.spec.ts` is separately red — see below); the recorded evidence lands in §7.0.
- **Known second failure to fix or quarantine:** `tests/init-templates.parity.spec.ts` fails on `worktreeContent` emitting the literal placeholder `<resolve-before-locking>` where the golden holds a resolved git context. Decide explicitly whether this is a regression to fix or a golden to regenerate, and record the answer — do not leave it implicit.
- **Files:** `package.json`, the nine `src/recursive_*.tool.ts` headers, `tests/{smoke,tools,worktree}.spec.ts`, `tests/init-templates.parity.spec.ts` or its fixture.
- **Acceptance:** the four commands in `What` step 4 are green and their output is pasted into §7.0 as the frozen baseline.
- **Evidence:** this review session — `pnpm typecheck` (12 × TS2614), `pnpm test` (`Test Files 5 failed | 40 passed (45)`, `Tests 1 failed | 256 passed (257)`), and a package-name sweep of `packages/{code-runtime,runtime-diagnostics,client}` at `dsh-v0.2.1-alpha.1`.

- **RESULT — done, green, in the plugin's own repo.** All four steps landed. Evidence: `evidence/logs/green/T-1-typecheck-green.txt`, `T-1-suite-green.txt`, `T-1-build-green.txt`, `T-1-smoke-green.txt`.
  1. **Type imports — done, and there were 13 sites, not 12.** The 9 `JsonValue` imports were repointed to `@deepseek-ai/dsh-util-values` (which *defines* the type; `dsh-tools` only imports it) and `CallId` → `ToolCallId` in 3 specs (12 occurrences). Fixing those exposed a **13th, different error** that the old checkout could not show: `src/index.ts` stamped injected messages `source: { kind: 'plugin', plugin: … }`, and at rc.2 `MessageSourceMap` **no longer has a catch-all `plugin` kind** — it is merge-extensible and, in its own words, *"each producer declares its own `kind` in its own module"*. It vanished from the old measurements because that checkout's `node_modules` still held a stale `dsh-llm` where `plugin` still existed. Fixed with the shipped idiom from `@deepseek-ai/dsh-repeat-tool-reminder`: declare `'recursive-mode'` in `MessageSourceMap` and stamp `form: 'notice'` + a bounded `summary`. **This is the one error in the set that genuinely *was* a rebase problem.**
  2. **Dead dependencies — done, with one correction.** `dsh-code-runtime` was **not merely dead, it was unresolvable**: `packages/code-runtime` is an empty directory at rc.2, so `pnpm install` failed with `ENOENT` before anything else could run — T-1's "DO THIS FIRST" was literally true. `dsh-invariants` **still exists** at rc.2 (`@deepseek-ai/dsh-invariants@0.2.0-rc.2`) despite the plan's claim that both packages were deleted upstream; it was removed for forward-compatibility, not necessity. `@deepseek-ai/dsh-util-values` was added.
  3. **Dead client peer — done.** `dsh.client.inject` now names `@deepseek-ai/dsh-client-modules`; the `dsh-client-runtime` entry in `peerDependenciesMeta` is gone.
  4. **Baseline recorded** — §7.0 now carries the green output.
  - **The `init-templates.parity` failure — the explicit decision T-1 demanded: it was neither a regression to fix nor a golden to regenerate.** The spec called `detectGitContext('D:\DEV\tmp\r5-init-golden')`, an external temp repo left over from capture time. That directory still exists but is **no longer a repository** — its `.git` survived and `git rev-parse` reports *"not a git repository"* — so detection returned `{}` and the template fell back to `<resolve-before-locking>`: a **non-hermetic test depending on mutable state outside the repo**, which is why it read as a code regression. `worktreeContent` takes the context as a **parameter**, so the spec now supplies the facts the golden encodes as literals (root, `master`, `d1026ee7…`) and the assertion stays byte-exact with no ambient input. Two **hermetic** `detectGitContext` tests were added — one against a repo the spec creates itself, one for the placeholder degradation path — which is the coverage the old arrangement only provided by accident. **Nothing in `src/` was changed to make this pass.**

### T31a — Rebase the peer dependencies onto the pinned `dsh-v0.2.0-rc.2` baseline · **done**

- **Why:** The plugin pins its peers at `0.1.1-rc.2`. The pinned target is `dsh-v0.2.0-rc.2` — the **latest release** `639ed01539` — which is *already* what the local checkout `D:\deepseek-harness` contains, so **no checkout refresh is required**.
- **Corrected baseline facts (measured, not inferred).** The previous revision described the gap as "two release lines on, through `0.1.2`…`0.1.7`". Both halves of that are wrong:
  - The intermediate versions are **not releases** — the tag ladder runs `0.1.1-rc.2` → `0.1.2-alpha.1..5` → `0.1.3-alpha.1..2` → `0.1.5-alpha/rc` → `0.1.6-alpha` → `0.1.7-alpha/rc` → `0.2.0-rc.1/2` → `0.2.1-alpha.1`. There is no `0.1.2`/…/`0.1.7` *stable* release to march through.
  - `dsh-v0.2.1-alpha.1` (`5badb15009`, 2026-10-03) is a **pre-release**, one release-merge beyond the rc.2 baseline. It is *not* tracked.
- **What:** (1) Bump `peerDependencies` from `0.1.1-rc.2` to the `dsh-v0.2.0-rc.2` line. (2) Re-run the full suite against the new peers and record every break. (3) Point the `file:` devDependencies at the same revision the checkout is on. (4) Re-derive §2's gap map against `dsh-v0.2.0-rc.2` rather than `0.1.1-rc.2`, and cite the revision.
- **Package existence is confirmed good news at the target revision** — `core/{tools,session,system-prompt}`, `session/session-projection`, `client/{ui-slots,ui-conversation,ui-sidebar,ui-settings}`, `api/remotes` and `vendor/cordis` all still exist under the same names; `storage`, `storage-domain`, `storage-json`, `storage-sqlite`, `settings`, `plan-mode`, `repeat-tool-reminder`, `hook-protocol`, `workflow`, `goal` are all present, and the session-format migration chain `v0-to-v1`…`v3-to-v4` ships. `cordis` moves `^4.0.1` → `4.0.5-alpha.1`, which still satisfies the plugin's range.
- **TDD Mode:** `strict` for the bump (the suite is the test); `pragmatic` for the gap-map re-derivation (documentation work).
- **RED:** the suite fails against the new peers, or it does not — either way, record it. No new spec file.
- **GREEN:** `package.json` (peer and devDep pins), any call-site fixes the bump forces, and an updated §2 citing `dsh-v0.2.0-rc.2`.
- **Acceptance:** T-1's frozen baseline is still green after the bump, and §2's gap map cites the revision.
- **⚠ Measurement discipline:** the local clone is **shallow/grafted** (`.git/shallow` exists; `FETCH_HEAD` is a parentless root). `git diff --stat HEAD FETCH_HEAD` reports ~4190 files changed, which is an artifact of the graft and **not** a measure of the delta. Derive capability claims from the tag tree (`git show <tag>:<path>`, `git grep <symbol> <tag> -- <path>`), never from a local diff.
- **Evidence:** `git ls-remote --tags --refs origin` and the GitHub tags API; `git show dsh-v0.2.1-alpha.1:packages/<group>/<pkg>/package.json` for each peer; a package-name sweep at the latest tag. Verified in the review session.
- **RESULT — done (bump), open (gap-map re-derivation).** `peerDependencies` now pin `0.2.0-rc.2` for `dsh-session`, `dsh-session-projection`, `dsh-system-prompt` and `dsh-tools`; `cordis` stays `^4.0.1` (the checkout ships 4.0.4, which satisfies it). **One substantive change the plan did not anticipate, and it is a blocker-class finding:**
  - **The devDeps could not stay `file:`.** At rc.2 the DSH packages reference each other as `workspace:*` (`dsh-session` → `dsh-llm`, `dsh-brand`, `dsh-util-values`). Under `file:` pnpm installs the target *into our workspace*, so those specs must resolve **here** — and they cannot: `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND: "@deepseek-ai/dsh-llm@workspace:*" is in the dependencies but no package named "@deepseek-ai/dsh-llm" is present in the workspace`. The old checkout only ever installed because its lockfile predated the repointing and still recorded relative `file:../../../deepseek-harness/...` resolutions that **no longer matched its own `package.json`** (absolute paths) — i.e. it was installing from a stale lockfile, not from its declared pins. The fix is the `link:` protocol, which symlinks the target and leaves its dependencies to resolve from the checkout's own installed tree (the checkout *is* installed, and every package ships `lib/` + `lib/types/`). This is the same protocol the repo already used for `cosmokit`/`schemastery`. The stale lockfile was deleted and regenerated.
  - **Two verification steps of this item remain open** and are tracked as `T31a-tail`: (3) the `file:` devDeps are now `link:` rather than "pointed at the same revision" — equivalent in effect, different in mechanism, and worth one sentence in the README when one exists; (4) **§2's gap map is not yet re-derived against rc.2** — the rows touched by this build are corrected (see §2), the rest still cite the old revision and must be re-walked.

### T31b — Track beyond the baseline (`0.2.1-alpha.1`) · **deferred — explicit decision, not a gate**

- **Decision: do not track `dsh-v0.2.1-alpha.1`.** It is the newest *tag* but not the newest *release*; adopting a new line's first alpha immediately after a baseline recovery trades a known-green revision for an unbounded one. Revisit when `0.2.1` reaches rc.
- **What it would cost, if taken:** the delta is a single release merge, and the capability map is already verified against it — nothing the plan depends on is missing there except the three dead dependencies already handled in T-1, which are dead at *both* revisions. So this is a cheap future bump, which is precisely why it does not need to gate anything now.
- **Acceptance:** a recorded decision in §9.3 with the revision and date. No code change.
- **Evidence:** the tag ladder and the §2 verification in the review session.

### T29 — Inject memory at **run start** (the loader hook) · **backlog — temporal axis**

- **Why:** The plugin builds and lints the memory plane and **never reads it**. Every run therefore starts from zero, and the "temporal" axis of §3 is dead. The parent repo treats retrieval as a first-class step with an explicit **timing** rule — *"call the loader after reading `RECURSIVE.md` and `MEMORY.md`, but **before planning or implementation starts**"* — and enforces **progressive disclosure** in three steps: read the `MEMORY.md` router, run the loader with the current task description *and file paths*, then apply only the items that match.
- **What:**
  - `src/memory.ts`: `loadMemoryIndex(root)` reads `memory/MEMORY.md`; `selectMemory(root, { query, files, maxDocs, maxItems })` returns ranked shard refs, honouring the router's own retrieval rule (prefer `Status: CURRENT`; `SUSPECT` only as leads; `STALE`/`DEPRECATED` excluded unless doing historical analysis).
  - **Query = the run's `00-requirements.md` text plus the worktree's changed paths.** The parent passes `--query` and `--files`; both matter, and paths are the stronger signal.
  - **Inject once per run, at entry** — not once per turn. Reuse the existing once-per-`(root, runId, phase)` gate in `src/phase-rules.ts` rather than adding a second dedupe mechanism.
  - **Progressive disclosure is mandatory:** router first, then at most `maxDocs` shards (parent default 3, `--max-items` 10). Never inject the whole plane.
  - **If nothing is relevant, inject nothing** — the parent's rule verbatim: *"If the loader finds nothing relevant, continue normally rather than fabricating memory."*
  - Carry over the harness trick from audit 1: determine whether an update is *due* by reading back what the current context window already contains, rather than tracking delivery in a side ledger.
- **TDD Mode:** `strict`.
- **RED:** `tests/memory-load.spec.ts` — a repo with a populated plane returns the relevant shards ranked by the router's own rules; `STALE`/`DEPRECATED` are excluded; an empty plane returns nothing and does **not** error; injection happens once per run, not per turn; nothing is injected when nothing matches.
- **GREEN:** `src/memory.ts` (new), `src/index.ts` (wire into the entry path), `src/phase-rules.ts` (reuse the once-gate).
- **Acceptance:** a run started in a repo with populated memory receives the matching shards before planning begins; a run in an empty repo is unaffected and silent.
- **Sequencing caveat:** until T30 has run against **two or more** locked runs there is nothing to retrieve, so *T29 cannot be accepted on a repo whose memory plane is empty.* Implement T30 first, or land both and accept T29 against a repo that has been run twice.
- **Evidence:** `D:\DEV\recursive-mode\skills\recursive-training\references\phase8-and-loading.md` (progressive disclosure, loader timing, failure handling); audit 1's memory worker (*"files are the source of truth"*, *"degradation is explicit, never silent"*).

### T30 — Extract learnings at **run close** (the training hook) · **backlog — temporal axis**

- **Why:** The plugin builds and lints the memory plane and **never writes it**. Phase 8 scaffolds `08-memory-impact.md` as a receipt stub (`src/closeout.ts:59`) and nothing promotes its content into cross-run memory, so `memory/training/` holds only a `.gitkeep`. Even if T29 existed, there would be nothing to read. The parent repo's flow is explicit:

  ```text
  run completes Phase 8 -> Phase 8 locks -> recursive-training-phase8-trigger
    -> grpo extracts memory -> memory files update -> later runs load through the loader
  ```

- **What:**
  - `src/training.ts`: `runPhase8Trigger(root, runId, { auto })` — count **Phase-8-locked** runs; with fewer than two, skip and say why (the parent exits `3` and explains that extraction needs more evidence); otherwise build the extraction prompt and hand it to an extractor.
  - **Input is all markdown under `run/<id>/`, not just `00-08`** — the parent is explicit about this, and it is where the interesting failures live.
  - **Group by inferred subsystem** from changed paths and evidence. Contrastive when winners and losers exist; winner-only otherwise; refuse to train on a single-run group alone.
  - **The extractor must be pluggable and must not be embedded.** The parent never embeds an LLM client and delegates through `--response-file` or `RECURSIVE_TRAINING_EXTRACTOR_CMD`. **The TS version can do better than the parent here** by reusing `src/delegation.ts`: a capability-probed, schema-validated child with a `learnings` output schema, the existing self-audit fallback, and the same refusal discipline.
  - **Fail loudly, never claim success.** Parent contract: extractor unavailable → exit `2`; zero items or insufficient groups → exit `3`; in both cases *"do not claim memory updates"*. Preserve that as a typed result, not a log line.
  - **Write** `memory/domains/<subsystem>.md` and `memory/training/<task-type>.md`, then refresh the `MEMORY.md` registry markers.
  - **Trigger point: the *re-run* of closeout phase 08, not the first lock** — matching the parent, so a run that has just locked is not immediately training on itself.
  - **Hard rule to preserve verbatim: no parameter updates.** *"Learning happens through files, not model mutation."* This is what keeps the plugin TS-only and the memory plane reviewable in git.
  - Borrow audit 1's memory-worker discipline: **supersede, never delete** (updates append revisions, deletes append tombstones); a **pinned** entry is untouchable by every automatic path; and a `doctor`-style command that runs a **real** roundtrip rather than asserting health.
- **TDD Mode:** `strict` for gating, selection and grouping; `pragmatic` for the extractor round trip (it depends on a live delegated child).
- **RED:** `tests/training-trigger.spec.ts` — fewer than two locked runs yields a skip with a reason and **zero writes**; an unavailable extractor yields a typed failure and **zero writes**; a malformed extraction is rejected and **zero writes**; a valid extraction writes only under `memory/domains/` and `memory/training/` and refreshes the registry; a pinned entry is never rewritten.
- **GREEN:** `src/training.ts` (new), `src/closeout.ts` (trigger on 08 re-run), `src/recursive_closeout.tool.ts` (surface the result).
- **Acceptance:** a repo with two or more Phase-8-locked runs, on a closeout re-run, either writes a schema-valid learning set into the memory plane or fails with a typed reason and writes nothing. Never a silent success.
- **Evidence:** `D:\DEV\recursive-mode\skills\recursive-training\SKILL.md` and `references/phase8-and-loading.md`; audit 1's memory worker for the supersede/pin/doctor discipline.

### T32 — Verify the receipt hash chain on read · **backlog — small; closes an unowned finding**

- **Why:** the review's finding E, re-verified independently during the rebuild and still true: **`previous_receipt_hash` is declared (`lock.ts:55`) and written (`lock.ts:199`), and nothing ever reads it.** `validateChain` answers a different question — *which phase is the first mandatory non-LOCKED one* — so it never compares a receipt to its predecessor. Monotonic locking is described in PROPOSAL.md and in the handoff as a load-bearing property ("phases lock monotonically: a locked artifact is hash-stamped, and lock receipts chain by `previous_receipt_hash`"); today the chain is **emitted but not enforced**, so a receipt set that has been reordered, truncated or spliced reads as healthy. This is the same class of defect as T15 — a written-and-exported mechanism with no live consumer — and it had no owning item, which is why it is recorded here rather than left in a review appendix.
- **What:** in `validateChain` (or a sibling `validateReceiptChain`), walk the run's receipts in phase order and assert each receipt's `previous_receipt_hash` equals its predecessor's artifact hash; report the first break with both values and the two phase names. Surface it through the same channel T15 builds for guard decisions, so a broken chain is visible on `recursive_status` rather than only in a test.
- **TDD Mode:** `strict` — this is pure data over receipt files.
- **RED:** `tests/receipt-chain.spec.ts` — a clean chain validates; a receipt whose `previous_receipt_hash` is stale is reported with the offending pair; a chain whose first receipt carries a non-null `previous_receipt_hash` is reported; a run with a single receipt validates; a receipt set with a gap (a locked phase whose predecessor is not locked) is reported rather than passing silently.
- **GREEN:** `src/lock.ts` (`validateReceiptChain` + `validateChain` delegation), `src/status.ts` or `src/runtime.ts` (surface), `src/types.ts` (wire shape when surfaced).
- **Files:** `src/lock.ts`, `src/runtime.ts`, `tests/receipt-chain.spec.ts` (new).
- **Acceptance:** a run whose receipt chain has been reordered or spliced fails loudly and names the first broken link; an untouched run is unaffected, because the common case must not regress.
- **Constraint:** read-only. This item must not rewrite or "repair" receipts — the chain is evidence, and a verification that mutates what it verifies is worthless.
- **Evidence:** `src/lock.ts` read + repository-wide grep for `previous_receipt_hash` (2 hits: declaration and write) and `validateChain` (definition + re-export + one parity test that exercises the break phase, not the chain). Verified in the rebuild session.

### T33 — The lint section parsers cannot read a document's FINAL section (`\Z` is a literal `Z` in JS) · **done**

- **Why, with proof.** `getHeadingBody` (`ts-lint.ts:137`) and `getSubheadingBody` (`:145`) end their lazy capture with the lookahead `(?=^[ \t]*##\s+|\Z)`. That `\Z` was carried over from the canonical Python implementation, where `\Z` means *absolute end of string*. **In JavaScript `\Z` is an unrecognised escape and degrades to an identity escape, i.e. it matches a literal `Z` character.** Verified by execution: `/\Z/.test('nothing here') === false` but `/\Z/.test('a Z here') === true`. Consequences, both verified:
  - If the section is followed by another heading, the first alternative matches and everything works — which is why the bug hid for so long.
  - If the section is the LAST one in the string handed to the helper, the lazy capture can only terminate at a literal `Z`. With no `Z` present the match fails outright and the helper returns `''`. Measured: `getHeadingBody('## First\nbody one\n## Last\nbody two', 'Last') === ''`; appending a dummy section after it returns `"body two"`; a trailing newline does not help.
- **Why it matters here — it is the THIRD side of the T25 contract.** A section's *last* sub-heading is therefore always invisible. In `lintSubagentActionRecordFile` that means `getSubheadingBody(claimedFileImpact, 'Reviewed')` — `Reviewed` being the final sub-heading of `## Claimed File Impact` — always reads empty, so `claimedFileRefs.size === 0` and the record fails `Claimed File Impact must cite at least one created, modified, reviewed, or relevant untouched file`. **A read-only review delegation — a reviewer that creates and modifies nothing, which is this plugin's primary delegation use case — can therefore never produce a record the repo's own linter accepts**, no matter how correct the writer is. Independently reproduced by the orchestrator with a hand-built record (`reviewedFiles` set, `createdFiles`/`modifiedFiles` empty).
- **How it surfaced:** the T25 implementer hit the same root cause from the other direction and worked around it by appending a trailing `## Record Provenance` section (commented "LOAD-BEARING, do not delete") so `## Verification Handoff` is no longer the final section, and by keeping a `Z`-bearing ISO timestamp last in `## Metadata`. The workaround is honest and documented, but it only covers the whole-section case, not the last-sub-*heading* case.
- **What:** translate the anchor faithfully — `\Z` (Python, absolute end of input) is `(?![\s\S])` in JS, not `\Z`. Apply it in both helpers. Then re-examine the two workarounds and delete whichever are no longer needed.
- **⚠ Do not treat the parity goldens as an oracle for this change.** The goldens were captured in the old tree and (measured) contain four `Missing or empty section` verdicts whose headings are **genuinely absent** from the fixture, so they do not discriminate the bug either way. Because the canonical implementation is Python — where `\Z` is correct — fixing the port should move it **toward** canonical parity. If a golden does shift, analyse which behaviour is canonical before regenerating anything, and record the decision.
- **TDD Mode:** `strict`.
- **RED:** `tests/section-parser.spec.ts` — a heading followed by another heading reads its body; the **final** heading reads its body; a body containing a literal `Z` is not truncated at it; the final sub-heading of a section reads its body; a genuinely absent heading still reads `''`; a heading whose body is only `- none` reads `- none`.
- **GREEN:** `src/ts-lint.ts` (both helpers), plus whatever workaround comment in `src/delegation.ts` becomes obsolete.
- **Acceptance:** every section and sub-section of a document is readable regardless of its position; a read-only review delegation produces an action record the repo's own linter accepts with **zero** violations; `lint-parity` is green or its shift is explained and recorded.
- **Blast radius to check:** 63 call sites of the two helpers inside `ts-lint.ts` — many apply to documents whose last section is exactly the one being read (e.g. `## Diff Basis For Later Audits`, `## Plan Drift Check`), so expect previously-empty reads to become populated. Run the full suite and the parity goldens before believing the change is contained.
- **Evidence:** this session — execution probes of `/\Z/`, of `getHeadingBody`/`getSubheadingBody` on synthetic documents with and without a trailing section, and of `lintSubagentActionRecordFile` over a `writeActionRecord` output carrying only `reviewedFiles`.

- **RESULT — done, and the blast radius turned out to be nil.** RED first (`tests/section-parser.spec.ts`, 14 tests, **7 failing**), which also sharpened the diagnosis in two ways the item spec had not stated:
  1. **There are FOUR affected regexes, not two.** Besides `getHeadingBody` and `getSubheadingBody`, `extractPathsFromNamedField` (`:287`) and `getNamedFieldText` (`:302`) carry the same anchor on their NAMED-FIELD block form — so a named field block that is the last thing in its section was equally unreadable. That is the same class of hole the T25 writer had to work around by emitting fields in a safe order.
  2. **The truncation is not confined to final sections.** A body is cut at its first literal `Z` *wherever it appears*, so an ISO timestamp mid-document truncates the section: measured, `## Metadata` containing `- Timestamp: 2026-01-01T00:00:00Z` was read as `'- Timestamp: 2026-01-01T00:00:00'`, silently dropping every field after it. The final-section case is just the degenerate one where no `Z` exists at all and the capture fails outright.
  - **Fix:** all four now end with `(?![\s\S])`, the faithful JS translation of Python's absolute end-of-input `\Z`. Note the anchor is written in the source as a bare `\Z` inside a template literal, where JS drops the backslash — which is why the compiled regex contained a plain `Z` alternation rather than an invalid escape.
  - **Blast radius: measured, and bounded.** The item spec warned that 63 call sites could start reading content that previously read as empty, and that the parity goldens were not a reliable oracle. Ran the full suite: **no golden changed.** `lint-parity` 3/3, `r5-parity` 9/9, `bootstrap.parity` 5/5, `status.parity` 5/5, `delegation`/`continuable-delegate`/`review`/`no-emission` all green — consistent with the earlier measurement that the goldens' four `Missing or empty section` verdicts correspond to headings that are *genuinely absent* from the fixture, which the anchor fix cannot affect.
  - **The T33 hole is closed as a FACT, not an assumption:** the `it.fails` pin in `tests/docs-contract.spec.ts` flipped to failing the moment the fix landed ("Expect test to fail") — exactly the signal it was written to give — and was then converted to a real assertion. This is the first time a deliberate known-limitation pin in this repo has been observed to flip.
  - **Both workarounds in `writeActionRecord` were re-examined and kept, with their comments corrected rather than left lying:** `Timestamp` last in `## Metadata` and the trailing `## Record Provenance` section are no longer load-bearing, but both are still reasonable (a natural field order, and genuine provenance the audit trail wants). Their "LOAD-BEARING, do not delete" comments now say what T33 changed and why the ordering survives on convention alone. **Deleting them would have been the wrong call: they are harmless, and the information they carry is real.**
  - **Acceptance met:** a read-only review delegation's action record is now accepted by the repo's own linter with zero violations, and every section and sub-section of a document is readable regardless of position.

### T34 — Make the repo installable from any location (drop the checkout-relative `link:` trap) · **backlog — portability**

- **Why.** Every `@deepseek-ai/*` devDependency is a `link:` into the DSH checkout, and pnpm records local link targets **relative** in the lockfile (`version: link:../../deepseek-harness/vendor/cordis`). The consequence, measured: the repo installs and tests correctly at `D:\DEV\dsh-recursive-mode` (with the checkout at `D:\deepseek-harness`) but a clone to another drive makes **every** `@deepseek-ai/*` module unresolvable — `tsc` reports `TS2307: Cannot find module '@deepseek-ai/dsh-tools'` for all of `src/`, and six spec files fail to load. A public repo that cannot be cloned anywhere is a real defect, not a documentation gap; it is currently mitigated only by a setup note in `IMPLEMENTATION-NOTES.md` §0.
- **What (options, to be chosen with measurements):** either (a) a `postinstall`/`prepare` step that (re)creates the `node_modules/@deepseek-ai/*` links from an absolute, configurable root (`DSH_HARNESS_ROOT`, defaulting to the current pin), tolerating an absent checkout by degrading to "not linked" with a clear message; or (b) publish/consume the DSH packages as real tarball deps for CI while keeping `link:` for local development; or (c) pin an npm alias/registry source if the target revision is published. Any option must keep `pnpm install --ignore-scripts` working for the current layout, because that is what the rebuild and the clone-verification use.
- **TDD Mode:** `pragmatic` — the assertion is a second-clone run, not a unit test. Compensating evidence: a repeated clone→install→`typecheck`→`test` on a **different drive** reaching 48 files / 308 tests green.
- **RED:** a clone on a different drive reproduces `TS2307` for `src/**` and ≥6 spec files failing to load.
- **GREEN:** that same clone installs, typechecks and tests green with no manual path editing.
- **Acceptance:** a fresh clone at an arbitrary path on any drive runs `pnpm install && pnpm test` green, and the failure mode when the checkout is genuinely missing is a single clear message rather than 200 `TS2307` errors.
- **Evidence:** this session — the `E:\tmp` clone (`TS2307` on every `@deepseek-ai/*` import) versus the same commit at `D:\DEV\<repo>\.verify-clone` (typecheck 0), and the lockfile line above.

---

## 5. To-do checklist (ordered)

Ordered by value-to-risk, not by T-number. **T-1 is first because the tree is red**, and every item's acceptance test is "the suite stays green". T15 follows because it is a bug that invalidates a stated success criterion.

```
Sprint -1 — get back to green (nothing below is measurable otherwise)
[x] T-1 recover the baseline: 12 type imports, 3 dead deps, green typecheck + suite  ← DONE (45/45 files, 279/279 tests)

Sprint 0 — rebase onto the pinned baseline
[x] T31a rebase peer deps onto dsh-v0.2.0-rc.2 (+ file:→link: protocol)  ← DONE
[ ] T31a-tail re-derive §2's gap map against dsh-v0.2.0-rc.2   (documentation only)
[#] T31b tracking 0.2.1-alpha.1                        DEFERRED — not a gate (see §9.3)

Sprint 1 — make enforcement real (no new infrastructure)
[x] T15 repair the enforcement path — runId, validateTransition, detectTamper, decision log  ← DONE (audited: 10/10 contract, 47 files/293 tests)
[ ] T16 declarative ordered tool policy (ask as the no-match default)
[x] T25 executable documentation tests (catches the action-record mismatch today)  ← DONE (7 violations, not 5)
[x] T33 lint section parsers: `\Z` is a literal Z in JS — the final section is unreadable  ← DONE (4 regexes, no golden moved)
[ ] T24 result caps, elision markers, stable error codes

Sprint 2 — make the workflow legible
[ ] T18 quiescence rule for recursive_lock + derive in-flight work by folding
[ ] T21 incremental fold + one named position per phase
[ ] T22 stable prompt prefix + preloaded contracts   ← VERIFY PREMISE FIRST (no DSH cache seam)
[ ] T23 recursive_ask for the three human gates
[ ] T26 recursive_preview (read-only view of what will fire)
[ ] T17 phase dependency as a DAG

Sprint 3 — make it bounded and extensible
[ ] T34 make the repo installable from any location (the checkout-relative `link:` trap)
[ ] T32 verify the receipt hash chain on read (written but never read — closes review finding E)
[ ] T19 deterministic operation identity from canonical inputs
[ ] T20 bound recovery on no-progress, with explicit resume
[ ] T28 budgets (audit rounds, repair attempts, depth, fan-out, result bytes)
[ ] T27 hook registry (named points, priority, timeout, failure policy)
[ ] T7  settings namespace (UI-editable enforcement + router config)
[ ] T8  native reference resolution — wire validateReferences first

Sprint 4 — the original backlog, re-sequenced
[ ] T10 jobs tracking — long ops visible and killable
[ ] T9  per-role model routing (consider the agent-profile form)
[ ] T12 phase rules as skills (+ preloaded contracts)
[ ] T14 memory retrieval into the review bundle (narrower than T29 — land after it)
[ ] T13 planMode for phases 0-2
[ ] T2  workflowEngine fan-out — confirm cap semantics before building

Sprint 5 — close the temporal axis (the plugin currently has NO memory hooks)
[ ] T30 learnings extraction at run close   ← FIRST: T29 has nothing to read until this has run twice
[ ] T29 memory injection at run start

Done / settled (no action)
[x] T0  packaged recursive-mode skill
[x] T1  goals projection
[x] T3  agentTeams task loop                        (amended by T20)
[x] T4  continuable subagents
[x] T6  approval ask-policy bridge                   (HALF — see T15 and T11)
[#] T5  sessionProjections                           SETTLED, not adopted
[#] T11 fs write/edit-intent gate                    SETTLED, not adopted
```

---

## 6. Status tracker

Evidence paths marked `(planned)` do **not** exist yet — they are the spec that the item's RED phase must create. Only unmarked paths are real. This distinction was previously missing and made §7.2 unexecutable.

| ID | Item | TDD | Status | RED evidence | GREEN evidence | Notes |
|---|---|---|---|---|---|---|
| T0 | packaged `recursive-mode` skill | strict | **done** | `tests/skills.spec.ts` | full suite + smoke | bundled provider via `ctx.skills.registerProvider`, rank 600, body from shipped `SKILL.md` |
| T1 | goals as run/phase substrate | strict | **done** | `tests/goals-projection.spec.ts` (11) | full suite + smoke | `src/goals-projection.ts`; arm on init, block on gate, resume on reopen; never clobbers a foreign goal |
| T2 | workflowEngine fan-out | pragmatic | backlog | (planned) `tests/workflow-contract.spec.ts` | manual integration | integration-grade; contract mapping unit-tested. **Confirm cap semantics first** (audit 1) |
| T3 | agentTeams task loop | strict | **done** | `tests/teams-task-loop.spec.ts` (7) | full suite + smoke | pure `auditToPass`; lock never precedes APPROVE. **Amended by T20** (round count is the wrong budget) |
| T4 | continuable subagents | strict | **done** | `tests/continuable-delegate.spec.ts` (12) | full suite + smoke | one durable child; exact live-Agent authority; `fellBackToOneShot`; repair synthesized from `findings[].title` |
| T5 | sessionProjections | — | **SETTLED** | — | — | Not adopted. Zero-emission + per-workspace is the design; confirmed by Tardigrade's per-thread store. T21 takes the one useful idea (incremental fold) |
| T6 | approval ask-policy bridge | strict | **done (half)** | `tests/enforcement.spec.ts` | full suite + smoke | `coerceAskToDecision` shipped. The `tests/approval-bridge.spec.ts` named in the previous tracker **was never created**. Write-layer half is T11 (settled) + T15 |
| T7 | settings namespace | strict | backlog | (planned) `tests/settings-config.spec.ts` | (planned) same | UI-editable enforcement + router config. T16's policy file is what this exposes — one path, not two |
| T8 | native reference resolution | strict/pragmatic | backlog | (planned) `tests/native-reference-resolve.spec.ts` | (planned) same | **Rescoped:** `validateReferences` is not called inside `delegateReview` today — wire the call site first, then replace the implementation |
| T9 | per-role model routing | pragmatic | backlog | (planned) `tests/role-model-route.spec.ts` | manual integration | consider the larger agent-profile form (audit 1) |
| T10 | jobs tracking | strict/pragmatic | backlog | (planned) `tests/jobs-tracking.spec.ts` | manual integration | long ops visible and killable |
| T11 | fs write/edit-intent gate | — | **SETTLED** | — | — | Not adopted. Single-slot waterfall owned by the host `fs-observation-policy`. Confirmed by the harness: the fs module stamps metadata, **the worker enforces** |
| T12 | phase rules as skills | strict | backlog | (planned) `tests/skill-registration.spec.ts` | (planned) same | pairs with T22's preloaded contracts |
| T13 | planMode for phases 0-2 | strict/pragmatic | backlog | (planned) `tests/plan-mode-integration.spec.ts` | manual integration | plan-before-implement at the harness level |
| T14 | memory retrieval into bundle | strict | backlog | (planned) `tests/memory-retrieval.spec.ts` | (planned) same | copy the harness trick: read whether an update is due **from the window the step sends** |
| T15 | **repair the enforcement path** | strict | **done** | `tests/guard-path.spec.ts` (10) + `tests/guard-log.spec.ts` (4) | full suite 47 files/293 tests + typecheck 0 | runId was `''` at `index.ts:222`; `validateTransition` never called; `detectTamper` had no caller and **no `fs/observed` listener existed at all**. Now: real run id (no cache), advisory-only transition consult, capped never-throwing decision log, sync `fs/observed` listener, derived tamper facts. Contract never weakened (sha256 `25FF9063…`) |
| T33 | lint section parsers: final section unreadable | strict | **done** | `tests/section-parser.spec.ts` (14, RED 7) | full suite green; **no golden moved** | `\Z` in FOUR regexes (`getHeadingBody`, `getSubheadingBody`, `extractPathsFromNamedField`, `getNamedFieldText`) is a **literal `Z`** in JS — and it truncates a body at its first `Z` *anywhere*, not only at the end of a document. Fixed to `(?![\s\S])`. The T25 `it.fails` pin flipped to failing on the fix, then became a real assertion |
| T16 | declarative tool policy | strict | backlog | (planned) `tests/policy-globs.spec.ts` | (planned) same | deny wins; invalid pattern fails closed; **no match means ask**; per-phase baseline |
| T17 | phase dependency as a DAG | strict | backlog | (planned) `tests/phase-graph.spec.ts` | parity specs must stay green | changes the data model; back-edges from `upstream-gap` addenda are the motivating case |
| T18 | quiescence rule + in-flight by folding | strict | backlog | (planned) `tests/quiescence.spec.ts` | (planned) same | a lock may not happen with pending work; pending work is derived, not tracked |
| T19 | deterministic operation identity | strict | backlog | (planned) `tests/identity.spec.ts` | (planned) same | canonical JSON then SHA-256 + byte length; two independent systems converged on this |
| T20 | no-progress recovery bound | strict | backlog | (planned) `tests/audit-progress.spec.ts` | (planned) same | cap on `consecutiveNoProgress`; terminal state needs an explicit resume |
| T21 | incremental fold + named position | strict | backlog | (planned) `tests/fold-incremental.spec.ts` | (planned) same | `{source, position, state}` frame; append-only assertion; one `position` per phase |
| T22 | stable prompt prefix + digest | strict/pragmatic | backlog | (planned) `tests/policy-sections.spec.ts` | (planned) same | **largest cost lever**; fully compatible with zero-emission |
| T23 | `recursive_ask` | strict | backlog | (planned) `tests/recursive-ask.spec.ts` | (planned) same | three human gates render as cards |
| T24 | result caps + error codes | strict | backlog | (planned) `tests/result-caps.spec.ts` | (planned) same | self-describing elision; stable greppable codes with a `Next:` clause |
| T25 | executable documentation tests | strict | **done** | `tests/docs-contract.spec.ts` (15) | full suite 48 files/308 tests + typecheck 0 | **The execution proof found SEVEN writer violations, not the review's five** — rows 1-5 confirmed, plus a composite `Review Bundle`/`Upstream Artifacts` defect and the T33 `\Z` false positive. `(a)`'s criterion had to be scoped to class 1 (the plan's own 40 planned deliverables must not be required to exist). The `reviewedFiles`-only hole is pinned with `it.fails` |
| T26 | `recursive_preview` | strict | backlog | (planned) `tests/preview.spec.ts` | (planned) same | read-only; states what it cannot compute |
| T27 | hook registry | strict | backlog | (planned) `tests/hook-registry.spec.ts` | (planned) same | note: `tests/hooks.spec.ts` already exists for DSH hooks — use a distinct name |
| T28 | budgets | strict | backlog | (planned) `tests/budgets.spec.ts` | (planned) same | a child narrows, never widens |
| T29 | memory injection at run start | strict | backlog | (planned) `tests/memory-load.spec.ts` | (planned) same | the plane is scaffolded and linted but **never read**. Cannot be accepted on an empty plane — T30 must run twice first |
| T30 | learnings extraction at run close | strict/pragmatic | backlog | (planned) `tests/training-trigger.spec.ts` | (planned) same | the plane is **never written**; `memory/training/` holds only `.gitkeep`. Fail loudly, never claim success. **No parameter updates** |
| T32 | verify the receipt hash chain on read | strict | backlog | (planned) `tests/receipt-chain.spec.ts` | (planned) same | **review finding E, re-verified: `previous_receipt_hash` is declared + written and NEVER read.** `validateChain` answers a different question (first non-LOCKED phase). Read-only — must never repair what it verifies |
| T-1 | **recover the baseline** | pragmatic | **done** | `evidence/logs/red/T-1-{typecheck-before,suite-baseline}.txt` | `evidence/logs/green/T-1-{typecheck,suite,build,smoke}-green.txt` | 13 type-import sites (`JsonValue` ← `dsh-util-values`; `CallId` → `ToolCallId`; **+ the rc.2 `MessageSourceMap` break**), 3 removed deps (`code-runtime` unresolvable, `invariants` forward-compat, `client-runtime` → `client-modules`), and `init-templates.parity` fixed as a **non-hermetic test**, not a regression. See the T-1 RESULT block |
| T31a | rebase peers onto `dsh-v0.2.0-rc.2` | strict/pragmatic | **done** (bump) / open (gap map) | fresh `pnpm install` against the pinned checkout | green suite on the new baseline (§7.0) | peers now pin `0.2.0-rc.2`. **`file:` → `link:` was mandatory**: rc.2 packages use `workspace:*` internally, which a `file:` install cannot satisfy. Target is the **latest release** `639ed01539`. Shallow clone: never quote local diffs |
| T31b | track `0.2.1-alpha.1` | — | **DEFERRED** | — | — | Explicit decision not to track (§9.3). Cheap future bump; does not gate anything |

---

## 7. Verification steps

Run from **`D:\DEV\recursive-mode\dsh-recursive-mode`**. The gate is tests + build + manual verification (approval `never`, so nothing escalates).

### 7.0 The frozen baseline — record this before starting any item

Nothing in §6 may be marked RED→GREEN until these commands are green and their output is pasted here. **They are green as of the rebuild, in the plugin's own repo (`D:\DEV\dsh-recursive-mode`), 2026-10-05:**

```text
pnpm typecheck   ->  exit 0
pnpm test        ->  Test Files  45 passed (45)
                     Tests       279 passed (279)
parity+invariants->  Test Files   9 passed (9)    Tests   54 passed (54)   [green]
pnpm build       ->  exit 0  (declarations + ESM index.js 316.30 kB / CJS client.js 68.73 kB)
smoke            ->  SMOKE PASS  (npx tsx scripts/test-recursive-mode-smoke.ts)
```

**Superseded RED measurement, kept for the record** (review session, before T-1; it is what T-1 was written against):

```text
pnpm typecheck   ->  12 × TS2614, exit 2
                      9 × "Module '@deepseek-ai/dsh-tools' has no exported member 'JsonValue'"
                      3 × "Module '@deepseek-ai/dsh-llm' has no exported member 'CallId'"
pnpm test        ->  Test Files  5 failed | 40 passed (45)
                     Tests       1 failed | 256 passed (257)
                     failing suites: policy-render, worktree, smoke, tools (bad imports),
                                     init-templates.parity (placeholder vs resolved git context)
parity+invariants -> Test Files  7 passed (7)   Tests  46 passed (46)   [green]
```

**A warning for whoever re-measures.** That RED output was an **under-count**: it came from a checkout whose `node_modules` was installed against an older `dsh-llm`, which hid a 13th error that only appears against the true rc.2 type surface. Re-derive the baseline from a *fresh install against the pinned revision*, never from a tree that has been sitting on an old lockfile.

**Pinned DSH revision:** `dsh-v0.2.0-rc.2` (`639ed01539`), which is what `D:\deepseek-harness` already contains. The only newer tag is the pre-release `dsh-v0.2.1-alpha.1`; it is not tracked (§9.3).

**After T-1**, replace the block above with the green output and the date. Every subsequent item's GREEN evidence is a comparison against it.

### 7.1 Static + type + lint
```powershell
pnpm typecheck          # tsc --noEmit
pnpm build              # removes lib/, emits lib/*, registers via cordis.patch.yml
# anti_slop_lint over src/ and tests/
```

### 7.2 Unit + parity tests — **only paths that exist**
```powershell
# Everything
pnpm test               # vitest run  (45 spec files at the time of writing)

# Done items, by spec
pnpm exec vitest run tests/goals-projection.spec.ts tests/teams-task-loop.spec.ts tests/continuable-delegate.spec.ts
pnpm exec vitest run tests/enforcement.spec.ts tests/skills.spec.ts

# Parity goldens — these must stay green through every item, especially T17
pnpm exec vitest run tests/status.parity.spec.ts tests/run.parity.spec.ts tests/lint-parity.spec.ts
pnpm exec vitest run tests/lock.parity.spec.ts tests/phase-rules.parity.spec.ts tests/bootstrap.parity.spec.ts
pnpm exec vitest run tests/init-templates.parity.spec.ts tests/r5-parity.spec.ts

# Invariants that guard the settled decisions
pnpm exec vitest run tests/no-emission.spec.ts        # zero recursive/* emission (T5)
```

**When an item lands, add its spec to this section.** The previous revision listed eleven specs that did not exist (`projection-unit`, `approval-bridge`, `fs-intent-gate`, `settings-config`, `skill-registration`, `workflow-contract`, `role-model-route`, `jobs-tracking`, `native-reference-resolve`, `plan-mode-integration`, `memory-retrieval`), which made this section unexecutable as written. Planned specs belong in §6 marked `(planned)`, not here.

### 7.3 Smoke
```powershell
# Plugin smoke (bare-Context mount + tool read path; no live session needed).
npx tsx scripts/test-recursive-mode-smoke.ts
```

### 7.4 Recursive-run linter (the repo's own phase-engine parity check)
```powershell
# Use the in-process lintRun (ts-lint.ts) — via a one-off, or the recursive_lint tool
# if a recursive session is mounted. Do NOT shell out to python.
# No committed .recursive/run/<id>/ residue: lint against a temp scaffold, not the repo tree.
```

### 7.5 Manual board / workflow verification
1. Start a recursive session in a temp workspace (`recursive_init` a run).
2. `recursive_phase` — confirm the current-phase lint rules are injected **once** per phase.
3. **T15:** attempt `recursive_lock` on a phase-3 doc with no TDD evidence — confirm it is refused under strict and the refusal names the missing evidence. Write to a LOCKED artifact — confirm denial. Inspect the decision log.
4. **T18:** leave a delegation unanswered — confirm the lock is refused and names the open handoff; answer it and confirm the same lock now succeeds.
5. **T22:** change phase — confirm the stable section is byte-identical and only the tail moved; check `promptSurfaceDigest` is unchanged.
6. **T26:** call `recursive_preview` — confirm it names the rule a probe call would match and the gates the next transition needs, without a model request.
7. Open the Recursive board — confirm it renders from the live fs fold (T5 settled), no hook-order break, no SSE re-subscribe on visibility.

### 7.6 Definition of done (per item)
- RED spec exists at the path recorded in §6 and is evidenced under `evidence/logs/red/`.
- GREEN implementation exists (function + wiring) and the spec passes; evidenced under `evidence/logs/green/`.
- `pnpm typecheck`, `pnpm test`, `pnpm build` are green.
- No `.recursive/run/<id>/` residue in the repo tree.
- `anti_slop_lint` over `src/` and `tests/` reports no new findings.
- **All parity specs still pass** — in particular `lock`, `status`, `lint`, `phase-rules` and `no-emission`.

---

## 8. Sequencing rationale

- **T-1 first, ahead of everything — this is the change from the previous revision.** The plan previously assumed a green baseline and put the dependency rebase first. The baseline is not green: `pnpm typecheck` fails at 12 sites and five spec files fail. Because every item's acceptance test is "the suite stays green", a red baseline makes every item unverifiable. T-1 is ~20 lines of import and `package.json` repair and it is a *precondition*, not a backlog item.
- **T31a second, and it is smaller than previously claimed.** The target is `dsh-v0.2.0-rc.2` — the latest **release**, and already the revision in the local checkout, so there is no checkout refresh to perform. The previous revision called this "two release lines" and listed intermediate stable versions that do not exist as releases. It remains a real bump with a real re-derivation of §2, but it is bounded, and **the 12 typecheck errors were never a rebase problem** — they reproduce identically at `0.1.1-rc.2` and at the newest tag, which is exactly why T-1 comes first.
- **T31b is an explicit decision, not a gate.** `0.2.1-alpha.1` is a pre-release and is not tracked; §9.3 records the decision so it is not silently re-opened.
- **T15 next.** It is a bug, not a gap: the guard receives an empty runId and `validateTransition` is never called, so §1 criterion 2 is not met and the §3 Outer axis was mis-described. Everything else in the enforcement family (T16, T26) is a refinement of a path that must first exist.
- **T16 next** so that the repaired guard is a declarative, reviewable policy rather than a hardcoded set — and so T7 later has one config path to expose, not two.
- **T25 early despite being "just tests"** because it is the cheapest item here and it fails today, on a real contract mismatch between `writeActionRecord` and `ts-lint.ts`. It also protects every later item from prose drift.
- **T18 + T21 form one unit.** The quiescence rule is cheap only because in-flight work is *derived* rather than tracked; and the incremental fold is what makes deriving it on every read affordable. Landing one without the other buys little.
- **T22 is the largest single cost lever**, and it is independent of everything else — it can be pulled forward if the prompt size becomes a problem before Sprint 2.
- **T17 changes the data model**, so it sits after the enforcement and legibility work and before the remaining original backlog. Its acceptance test is the parity suite: if `lock`, `status` and `lint` parity stay green, the refactor is safe.
- **T19 + T20 are the recovery pair** — identity for retries, and a bound for progress. T20 amends T3's budget.
- **T27 before T7/T8** so that enforcement, and later reference resolution, can be expressed as ordered hooks rather than more inline branches.
- **The original backlog is re-sequenced** so that bounded, observable work (T10) precedes routing and integration work (T9, T12, T13, T2).
- **T29 and T30 close the temporal axis, and T30 goes first.** The plugin ships a memory plane that is created, linted, and otherwise dead — no reader, no writer. T30 is what produces memory; T29 is what consumes it. Since extraction requires **two or more** Phase-8-locked runs, T29 is untestable against an empty plane: land T30, run it twice, *then* accept T29. Landing them in the other order produces an item that appears to work and does nothing.
- **T5 and T11 are settled, not deferred.** Recording them as `deviated` invited someone to reopen a decided question; each audit independently confirmed both calls.

---

## 9. Inputs and provenance

### 9.1 Sources for the revision

| Source | What it contributed |
|---|---|
| **Audit 1 — iii `harness` + `workers.iii.dev`** (`D:\DEV\dsh-recursive-mode\iii-harness-full-audit.md`) | T22 (caching seam, agent profiles), T23 (structured ask), T24 (result caps, error codes), T25 (executable docs), T26 (read-only preview), T27 (hook registry), T28 (budgets); T2's open question; the confirmation for T5 and T11 |
| **Audit 2 — Effect TS v4 + Tardigrade** (`D:\DEV\dsh-recursive-mode\ADR-event-log-and-durable-queue.md`) | T17 (DAG), T18 (quiescence + derive-in-flight), T19 (canonical operation identity), T20 (no-progress bound), T21 (incremental fold + named position); the measurement that settled T5; the `Graph` note on T17 |
| This session's direct reading of `src/` | the empty-runId finding, the uncalled `validateTransition`, the uncalled `detectTamper`, the concurrency measurement, the spec-file inventory, and the finding that the memory plane has no reader and no writer |
| **Upstream `deepseek-ai/deepseek-harness` (`master` @ `5badb15`, tag `dsh-v0.2.1-alpha.1`)** | T31 (the version gap); the `ctx.storage`/`ctx.storageDomain` discovery behind §4.0; the `dsh-repeat-tool-reminder` reconciliation in T20; the session-format migration chain behind T5's re-verify; the correction that `packages/hooks/hook-protocol` is an *external bridge*, not an internal API |
| **The parent repo's `recursive-training` skill** (`D:\DEV\recursive-mode\skills\recursive-training\SKILL.md`, `references/phase8-and-loading.md`) | T29 and T30: the two hooks, their timing rules, progressive disclosure, the extractor contract, and the failure discipline (*"do not claim memory updates"*, *"no parameter updates"*) |
| **Independent review pass** (this revision) | T-1 (the red baseline); the T31 split; §7.0; the §2 baseline-health rows; the separate `init-templates.parity` failure; the `dsh-client-runtime` / `code-runtime` / `invariants` dead-dependency findings; the shallow-clone measurement warning. Open recommendations not yet applied are listed in §10 |

### 9.2 Superseded wording (preserved for review)

**§1 objective, previous revision — struck:**

> Make `dsh-recursive-mode` a **durable, native, resumable** recursion engine rather than a single-threaded controller that reconstructs state from the filesystem and does one-shot delegation.

Why it was wrong is argued in §1: the plugin has no concurrency to coordinate (0 `Promise.all`, 0 jobs, 22 synchronous writes), and filesystem reconstruction *is* the source-of-truth design, not a shortcoming. The durable-queue role is already filled by DSH's turn loop.

**§3 Outer axis, previous revision — corrected:**

> | **Outer** | phase advance through the lock chain | enforced purely in-process (`validateTransition`); not surfaced as a resumable object |

The corrected entry is in §3. "Purely in-process" understated it: `validateTransition` is imported and never called, and the live guard is invoked with an empty runId, so the gate is absent from the live path rather than merely local to it (T15).

**§6 T5 / T11, previous status — changed:**

> `deviated` … *"Revisit only with a per-workspace fs-backed unit API"* / *"Revisit only if a multi-slot or layered intent API appears"*

Both are now **settled**. The audits independently confirmed each call (§4, T5 and T11). Keeping them as open deviations implied the decisions were provisional.

### 9.3 Not adopted, with reasons

| Considered | Verdict | Reason |
|---|---|---|
| Effect TS v4 as a dependency for event log / durable queue | **declined** | every relevant module is `@stability unstable` (breaking changes in minor releases); the plugin has no concurrency; git makes a committed transition log churn |
| Tardigrade as a framework | **declined as a dependency, adopted as a reference design** | pre-release, every core service tagged `experimental/*`; but its event-log/projection/effect-settlement model is the best available reference |
| Effect's stable runtime-free `Graph` for T17 | **declined, model adopted** | a few hundred lines of local TS keeps zero dependencies and the parity goldens intact |
| A central event log replacing the artifacts | **declined** | the plugin is already event-sourced with coarse events; the artifacts are the log, and they are human-readable and diffable |
| A durable queue | **declined** | no producer/consumer pair; DSH's turn loop is the durable queue |
| Tracking `dsh-v0.2.1-alpha.1` | **deferred** | it is the newest **tag** but not the newest **release**; adopting a new line's first alpha immediately after a baseline recovery trades a known-green revision for an unbounded one. Its capability map is already verified and the delta is one release merge, so the bump stays cheap and can wait for rc. Revisit at `0.2.1-rc.*` |
| Refreshing `D:\deepseek-harness` to `master` | **unnecessary** | the checkout already sits on `dsh-v0.2.0-rc.2` — the pinned baseline — and the only commit beyond it is the `0.2.1-alpha.1` release merge |

---

## 10. Change log

| Revision | Change |
|---|---|
| previous | 14 items (T0–T14); objective "durable, native, resumable"; T5/T11 `deviated`; §7.2 listed ten non-existent specs |
| **this** | §1 rewritten; §2 given measured facts; §3 Outer and Inner corrected; T5/T11 → **settled**; T6 status corrected to **half**; T8 rescoped; T14 added; **T15–T28 added**; §5 re-ordered into four sprints; §6 marks planned specs; §7.2 restricted to existing paths; §8/§9/§10 added |
| **+ upstream baseline** | checked `deepseek-ai/deepseek-harness` at `master` rather than trusting the local checkout. **T31 added** (peers are two release lines stale). §4.0 added (the files-vs-`ctx.storageDomain` substrate rule) and T18/T19/T21 rescoped onto it. **T20 reconciled** with the shipped `dsh-repeat-tool-reminder`. **T5 re-opened for verification** — session-format migrations changed the risk profile behind zero-emission. §2 gap map corrected: `hook-protocol` is an external bridge, not the internal hook API T27 proposes. A `0.2.1-alpha.1` release exists beyond the latest rc |
| **+ review pass / baseline correction** | Independent review verified all §6 claims (the empty-`runId` finding, the uncalled `validateTransition`/`detectTamper`, the action-record contract mismatch — **confirmed live**, and under-reported: there are five violations, not three). Three new findings added: **the baseline is RED** (12 typecheck errors, 5 failing spec files — §7.0), **T0/T1/T3/T4's deliverables and this plan are untracked** so `git clean -fd` deletes them, and **receipt `previous_receipt_hash` is written but never verified**. Baseline claims corrected against upstream: the target is `dsh-v0.2.0-rc.2` (latest **release**; already in the checkout), the intermediate `0.1.2`…`0.1.7` versions are not releases, and the local clone is shallow so its diffs are meaningless. **T-1 added** (recover the baseline) and **T31 split** into T31a (rebase onto the pinned baseline) + T31b (defer `0.2.1-alpha.1`). §5 gained Sprint -1. **Not yet applied — open review recommendations:** deleting T27, merging T28→T20 / T12→T22 / T26→T15, narrowing T17 to a single-source-of-truth dedup (five parallel copies of the phase order exist), auditing the 256 committed files under `.recursive/run/` against the hygiene rule this plan states, and the falsifiability rewrites for the T21/T15/T16/T22/Q7 criteria |
| **+ temporal axis** | §1 criterion 8 corrected; §2 gained three measured facts and two gap-map rows; **§3 Temporal axis corrected** (it previously read "Unchanged (T14)", which understated an unimplemented axis); **T29 and T30 added** for the missing start-of-run and end-of-run memory hooks; §5 gained a fifth sprint; §8 sequencing note; §9 provenance. Found by the human operator, not by either audit |
| **+ rebuild in its own repo (T-1 + T31a GREEN)** | The plugin was re-created at `D:\DEV\dsh-recursive-mode` against the pinned `dsh-v0.2.0-rc.2` and T-1/T31a were executed. **§7.0 is now a GREEN frozen baseline** (typecheck 0; **45/45 files, 279/279 tests**; parity 54/54; build 0; smoke PASS), with the superseded RED block kept beneath it and a warning that the old measurement was an under-count. Four findings: **(1)** a **13th** typecheck error the old checkout could not surface — rc.2 deleted the catch-all `plugin` message-source kind in favour of per-producer kinds, fixed with the shipped `repeat-tool-reminder` idiom (`declare module` + `form: 'notice'`); **(2)** rc.2 packages use `workspace:*` internally, so devDeps **had to move `file:` → `link:`** — the old tree only installed from a stale lockfile whose relative resolutions no longer matched its own `package.json`; **(3)** `dsh-code-runtime` is an *empty directory* at rc.2 (its devDep blocked `pnpm install` outright, making T-1 literally first) while `dsh-invariants` **still exists** — the plan's "both deleted upstream" was half wrong; **(4)** the `init-templates.parity` failure was a **non-hermetic test** reading `D:\DEV\tmp\r5-init-golden` (a directory whose `.git` outlived its repository), not a code regression and not a stale golden — fixed by supplying the golden's git facts as literals, plus two new hermetic `detectGitContext` tests. §2's touched rows corrected; full gap-map re-derivation tracked as `T31a-tail`. **Line-number drift:** the guard call the plan cites as `src/index.ts:197` is now `:222` (the message-source fix shifted it) |
