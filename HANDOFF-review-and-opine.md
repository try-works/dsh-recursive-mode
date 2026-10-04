# Handoff — review, verify, and opine. **No implementation.**

> ## ✅ STATUS: CLOSED — the review has been delivered and acted on
>
> This handoff was **executed**. It is kept as the record of the review, not as an open task. See **§0.1 Outcome** for what the reviewer found, what the human authorised, and what remains open. **A new agent should read §0.1 first, then §11 (open work), and only then the rest of this document for context.**
>
> Summary in one line: the review confirmed the plan's three central factual findings, **confirmed and enlarged** its best evidence (the action-record contract bug), and found that the plan's **own baseline was RED and its deliverables untracked** — which reordered the whole plan.

**To:** a reviewing agent. **From:** the agent that produced the audits and the revised plan. **For:** the human operator.

---

## 0. Your task in one paragraph

Read three bodies of material — (a) the background research, (b) the current state of the `dsh-recursive-mode` plugin in the other repo, and (c) the revised `STRENGTHENING-PLAN.md` — then **give the human your opinion**. Specifically: is the plan's diagnosis right, which of its items should be deleted (the plan holds **32 tracked items**: 6 done/settled, 25 actionable backlog, plus T-1 and the T31 split added by the review), what is missing, is the sequencing defensible, and which of its load-bearing factual claims survive your own verification. You are the second pair of eyes on a document that another agent wrote about its own work, which is exactly the situation where an independent check is worth most.

⚠️ **The human wants your opinion BEFORE any implementation. Do not start work on any plan item.** See §1.

### 0.1 Outcome — what the review concluded `[completed]`

The review ran and delivered its opinion. Headline results, with the full evidence in §6.1:

1. **The plan's three central findings all replicate** — the empty `runId`, the uncalled `validateTransition`, the uncalled `detectTamper`. The author's method works.
2. **Its best piece of evidence was under-reported.** The `writeActionRecord` vs `ts-lint.ts` contract bug is real and live — but there are **five** violations, not the three claimed. T25's spec must assert all five.
3. **The plan's foundation was wrong in a way it could not see.** `pnpm typecheck` fails at 12 sites and 5 of 45 spec files fail, and **T0/T1/T3/T4's deliverables plus `STRENGTHENING-PLAN.md` itself are untracked** — a single `git clean -fd` deletes four "done" items and the plan. A new item **T-1 (recover the baseline)** now precedes everything.
4. **The baseline claims were wrong, in the plan's favour.** The target is `dsh-v0.2.0-rc.2` — the latest **release**, which the local checkout *already contains*. The "two release lines" framing and the intermediate `0.1.2`…`0.1.7` releases do not exist. **T31 was split** into T31a (the real, smaller bump) and T31b (defer `0.2.1-alpha.1`).
5. **The 12 typecheck errors were never a rebase problem** — they reproduce identically at `0.1.1-rc.2` and at the newest upstream tag. No dependency bump could have fixed them.

**Acted on:** the human authorised the plan updates, and they are **applied** — [STRENGTHENING-PLAN.md](D:\DEV\recursive-mode\dsh-recursive-mode\STRENGTHENING-PLAN.md) went 677 → 743 lines. T‑1 and the T31 split are in §4; the frozen baseline is §7.0; §5 gained Sprint ‑1.

**Not yet acted on:** the structural recommendations (delete T27; merge T28→T20, T12→T22, T26→T15; narrow T17; the hygiene audit; the falsifiability rewrites). These are enumerated in **§11** and in the plan's §10 change-log entry.

---

## 1. Hard stop — what you must not do `[lapsed — see note]`

> **Note:** this constraint applied to the *review*. It has been **partially lifted** by the human: one narrow, documentation-only edit was authorised and performed — the `STRENGTHENING-PLAN.md` baseline update. **Everything else still stands:** no item from the plan has been implemented, and no file under `src/`, `tests/`, `preset/`, or `cordis.patch.yml` has been touched. The original text is preserved below for the record.

**Do not implement anything.** No edits to `src/`, `tests/`, `preset/`, `cordis.patch.yml`, or any config. Do not begin T15 or any other item. Do not "just fix the obvious bug while you are in there."

**You MAY:** read anything; run read-only commands; run the existing test suite; run `tsc --noEmit`; use `git log`/`git show`; grep freely; inspect the clones.

**You should NOT** write anything into the plugin repo, including your opinion document. Deliver your opinion as your reply to the human.

If you believe the plan is so broken that the right move is to stop and re-plan, say that — that is a legitimate finding and more useful than a polite critique.

---

## 2. What you are being asked to opine on

Answer these directly. For each, give a verdict **and a confidence level** (high / medium / low), and say what would change your mind.

**Q1 — The objective rewrite.** `STRENGTHENING-PLAN.md` §1 was rewritten from *"a durable, native, resumable recursion engine rather than a single-threaded controller that reconstructs state from the filesystem"* to *"legible, enforced, crash-resumable over a file-backed control plane"*. The argument is: the plugin has zero concurrency, so there is nothing to schedule, and filesystem reconstruction is the source-of-truth design rather than a shortcoming. **Is that inference sound, or did the rewrite throw away a real requirement?** The specific risk: a plugin mounted in more than one session against one workspace, or any future DSH path that invokes plugin tools concurrently, would invalidate the single-writer premise. Is that hypothetical or already reachable?

**Q2 — Is T15 really first?** It claims the enforcement path is effectively dead code (empty runId; uncalled `validateTransition`; uncalled `detectTamper`). Verify it. Then judge: is repairing it the highest-value move, or does it risk destabilising the parity goldens for a capability nothing currently depends on? Is there a cheaper fix that gets most of the value?

**Q3 — Is T17 worth its blast radius?** It proposes replacing the flat `PHASE_SEQUENCE` array with a real dependency graph, on the argument that `getPrerequisites` (in-edges), `getStaleDownstreamPhases` (reachability) and `getNextLegalPhase` (topological) are graph queries run over a list, while `upstream-gap` addenda create back-edges. **Trace every consumer of `PHASE_SEQUENCE` and the addendum filename conventions** — `src/lock.ts`, `src/ts-lint.ts`, `src/status.ts`, `src/init-templates.ts`, `src/closeout.ts`, `src/phase-rules.ts`, the client — and say whether the flat array is load-bearing somewhere the plan does not mention. If it is, say so and propose a narrower version.

**Q4 — Force a cull.** Fourteen items were added (T15–T28). **Which would you delete outright, and which would you merge?** A backlog that is too long is a backlog that does not get worked. Be willing to say "this one is speculation" or "this one is already satisfied."

**Q5 — What is missing?** The list came from two external audits (iii's `harness` worker; Effect v4 and Tardigrade) plus direct reading of the plugin. **What is absent that should be there?** Consider especially: what a human operator actually needs to trust a run; what breaks the reusable-repo hygiene rules; and anything about the client/board that the plan ignores.

**Q6 — Are T5 and T11 correctly "settled"?** Both were marked `deviated` and are now **settled — not adopted**, each with an independent confirmation from an audit. Is that right, or were doors closed that should stay open? In particular: does the zero-emission invariant still hold as a *requirement* rather than a historical accident?

**Q7 — Are the acceptance criteria falsifiable?** Several items assert things like "no two consumers can disagree" or "a non-progressing audit stops and says why." **Flag any criterion that cannot actually be tested**, and rewrite it.

**Q8 — Is the sequencing defensible?** §5 orders four sprints and §8 justifies them. T15 first, T25 third despite being "just tests", T18+T21 as a deliberate pair, T17 after enforcement and before the original backlog. **Does the order hold**, given that every item must keep the parity suite green?

**Q10 — Should T31 (rebase the dependency baseline) really gate everything?** It is now Sprint 0, ahead of T15. The argument: every other item is written against `0.1.1-rc.2` APIs while upstream ships `0.2.1-alpha.1`, so building first risks rework. The counter-argument: an unbounded version bump is itself a risk, it may break the parity goldens, and the plugin's own history (run 09) shows ports of this kind are large. **Judge whether rebasing first is right, or whether the cheaper path is to fix the live bug (T15) on the current baseline and rebase afterwards.** Also judge whether to track `0.2.1-alpha.1` (alpha) or hold at `0.2.0-rc.2` (latest rc) — and note that nothing in the plan has been validated against either.

**Q9 — The temporal axis (T29/T30) — added late, by the human.** The plugin scaffolds a memory plane at `/.recursive/memory/`, **lints** it (`ts-lint.ts:1928 lint_memory_plane`), and otherwise never touches it: nothing reads `MEMORY.md` to inject context when a run starts, and nothing writes `memory/training/` when a run ends. The parent repo ships two hooks for exactly this (`recursive-training-phase8-trigger` on Phase-8 lock, `recursive-training-loader` before planning), and both were **deliberately excluded** from the plugin as run-09 OOS2 (*"dsh has no training pipeline"*). T29 and T30 were added to recover them. **Judge whether they are the right shape** — in particular whether the extractor should be a DSH subagent rather than a pluggable external command, and whether T29 (injection) is worth building before T30 (extraction) has produced anything. Also: **is there anything else the parent repo has that the plugin silently dropped?** See §7 item 0.

---

## 3. Reading list — in this order

### 3.1 Orientation (10 minutes)

| Path | What it is |
|---|---|
| `D:\DEV\recursive-mode\README.md` | the methodology repo: what recursive-mode is as a skill package |
| `D:\DEV\recursive-mode\dsh-recursive-mode\PROPOSAL.md` §1–§4 | why the plugin exists and what it is trying to be. **Note: there is no `README.md` at the plugin root** — do not go looking for one. `CHANGELOG.md` and `IMPLEMENTATION-NOTES.md` are also there and are short |
| `D:\DEV\recursive-mode\dsh-recursive-mode\src\index.ts` | the whole plugin surface in one file: 9 tools, 1 command, 1 prompt section, 2 listeners, 1 HTTP route, client registration |

### 3.2 The plan under review

| Path | Note |
|---|---|
| `D:\DEV\recursive-mode\dsh-recursive-mode\STRENGTHENING-PLAN.md` | **the plan — the primary artefact under review.** §1 objective, §2 gap map, §3 axes, §4 the 32 items, §5 order, §6 tracker, §7 verification (incl. §7.0 frozen baseline), §8 sequencing, §9 provenance, §10 change log. **Updated by the review: 677 → 743 lines** — T-1 added, T31 split into T31a/T31b, baseline pinned to `dsh-v0.2.0-rc.2` |
| `D:\DEV\dsh-recursive-mode\STRENGTHENING-PLAN.original.md` | the pre-revision version, kept for diffing. Read §1 and §3 of it to see what changed and judge whether the change was an improvement |

### 3.3 Background research — the two audits

| Path | What it is | Authority |
|---|---|---|
| `D:\DEV\dsh-recursive-mode\iii-harness-full-audit.md` | full audit of the iii `harness` worker and the `workers.iii.dev` registry: 9 sections, 17 concepts, 12 sibling-worker contracts, 37 principles. Source of T22–T28 | external, read-only, not about this repo |
| `D:\DEV\dsh-recursive-mode\ADR-event-log-and-durable-queue.md` | decision memo on whether to adopt Effect v4 / Tardigrade for an event log or durable queue. Verdict: decline both as dependencies. Source of T17–T21 | external, read-only |
| `D:\DEV\dsh-recursive-mode\effect-v4-persistence-cluster-audit.md` | supporting raw audit of Effect's persistence and cluster modules | external, read-only |

**Read the audits sceptically.** Their findings are about *other platforms*. Every recommendation that reached the plan was mapped by analogy, and an analogy that reads well can still be shallow. Part of your job is to spot a mapping that does not survive contact with DSH's actual APIs — see §6, where one already failed.

### 3.4 The code the plan talks about

| Path | Why |
|---|---|
| `src\index.ts` | the live wiring: guard call site, pre-step listener, prompt section, route |
| `src\enforcement.ts` | the guard predicates; `detectTamper` |
| `src\lifecycle.ts` | `validateTransition` — the gate that is never called |
| `src\lock.ts` | `PHASE_SEQUENCE`, prerequisites, receipts, chain validation — central to T17 |
| `src\status.ts` | `foldRun` and the phase fold — central to T21 |
| `src\ts-lint.ts` | the 126 KB canonical lint port. **Large.** Read the marker contracts and the addendum parsing, not the whole file |
| `src\delegation.ts` | `writeActionRecord` (relevant to T25) and `validateReferences` (relevant to T8) |
| `src\teams-loop.ts` | `auditToPass` — relevant to T20 |
| `src\policy.ts` | `renderRecursivePolicy` — relevant to T22 |
| `tests\no-emission.spec.ts` | the guard for the zero-emission invariant |

### 3.5 The parent repo's own hooks — **do not skip this**

| Path | Why |
|---|---|
| `D:\DEV\recursive-mode\skills\recursive-training\SKILL.md` | the end-of-run and start-of-run hooks the plugin did **not** port |
| `D:\DEV\recursive-mode\skills\recursive-training\references\phase8-and-loading.md` | the flow, the loader timing rule, progressive disclosure, the extractor contract, the failure discipline |
| `D:\DEV\recursive-mode\skills\recursive-training\references\memory-architecture.md` | the memory plane's intended shape |
| `D:\DEV\recursive-mode\skills\recursive-mode\scripts\recursive-training-*.py` (six of them) | the reference implementations. **Python — the plugin is TS-only, so these are a contract to port, not code to vendor** |

### 3.6 Supporting material, only if a question sends you there

- `D:\DEV\recursive-mode\.recursive\RECURSIVE.md` (or the packaged copy at `dsh-recursive-mode\references\bootstrap\RECURSIVE.md`) — the canonical workflow spec the plugin implements. **Long** (~113 KB); grep it, do not read it linearly.
- `D:\DEV\.tmp-iii-audit\workers\` — the iii clone, if you want to check an audit claim at source.
- `D:\DEV\.tmp-effect-audit\effect\`, `D:\DEV\.tmp-effect-audit\tardigrade\` — the Effect and Tardigrade clones.

---

## 4. Orientation — what this thing is

Two repos matter.

**`D:\DEV\recursive-mode`** is the methodology repo: a large workflow contract (`/.recursive/RECURSIVE.md`), a set of installable skills, and the maintainer test/benchmark harness. It is harness-agnostic. **Do not change it as part of this review.**

**`D:\DEV\recursive-mode\dsh-recursive-mode`** is the plugin — a DeepSeek Harness bundle, TypeScript only, package `@try-works/dsh-recursive-mode` v0.3.1, 53 source files / ~10.4k lines / 45 vitest spec files. It implements a gated, staged workflow over **Markdown artifacts in the target repository**:

- a **run** is `/.recursive/run/<run-id>/` holding twelve ordered artifacts (`00-requirements.md` … `08-memory-impact.md`)
- gates are **machine-readable lines inside those Markdown files** (`Audit: PASS`, `Coverage: PASS`, `Approval: PASS`, `TDD Mode`, `QA Execution Mode`, `Requirement Completion Status`)
- phases **lock monotonically**: a locked artifact is hash-stamped, and lock receipts chain by `previous_receipt_hash`
- corrections arrive as **addenda**, never as rewrites of locked history

Five properties are load-bearing and recur throughout the plan:

1. **Files are the single source of truth.** No second store, no manifest cache. Every derived fact is folded from disk on read.
2. **Zero emission.** The plugin appends **no** session events. This was a fix for a real resume crash; `tests/no-emission.spec.ts` statically enforces it. It constrains several otherwise-attractive designs.
3. **The client is read-only**, served by an HTTP+SSE fold of the filesystem.
4. **TypeScript only**, with no runtime framework dependency (zod is bundled). No Python at runtime.
5. **Reusable-repo hygiene**: no `/.recursive/run/<id>/` residue may be committed.

---

## 5. Constraints you must treat as non-negotiable unless you argue otherwise explicitly

- TypeScript only; no new runtime dependency without an explicit argument.
- **The zero-emission invariant holds.** Any proposal that requires emitting session events must say so loudly.
- **The file-backed control plane stays the single source of truth.** Proposals may add derived, git-ignored bookkeeping, never a competing store.
- The client stays read-only.
- **All parity specs must stay green** — `lock`, `run`, `status`, `lint`, `phase-rules`, `bootstrap`, `init-templates`, `r5`. These compare behaviour against the canonical implementation; breaking them means the plugin has diverged from the workflow contract.
- No `/.recursive/run/<id>/` residue in the repo tree.

---

## 6. The load-bearing claims — **verified** `[completed]`

The plan rests on factual claims the author made and asked to have checked rather than trusted. **They were checked. This table now records the verdicts, not the instructions** — the original "how to check" column is superseded, and the commands it named are preserved in git history of this file if a re-run is ever wanted.

**Result: 7 confirmed, 2 confirmed-with-correction, 1 half-verified, 0 refuted.** The author's method holds up. The one claim that did not survive intact is #10, and it failed in the plan's *favour* (the job is smaller than described).

| # | Claim | Result | Evidence / how it was checked |
|---|---|---|---|
| 1 | `evaluateToolGuard` is called with an **empty runId** | ✅ **Confirmed, with a correction.** `index.ts:197` passes `''` — true. But there is a **second** call site, `runtime.ts:711 guardTool(…)`, which passes the real runId and **has zero callers repo-wide**. The dead wrapper, not the live path |
| 2 | `validateTransition` is **imported but never called** | ✅ **Confirmed.** Three refs in `src/`: the import (`runtime.ts:25`), a comment, the definition. Only tests and the smoke script call it |
| 3 | `detectTamper` has **no caller in `index.ts`** | ✅ **Confirmed.** Only `runtime.ts:716` (itself uncalled) plus tests/smoke |
| 4 | The plugin has **zero concurrency** | ⚠️ **Confirmed as a measurement; the inference drawn from it is not.** 0 matches in `src/`. But DSH ships **parallel tool-call execution** (default cap 10) and delegation opts in. Plugin tools omit `isConcurrencySafe`, so they are exclusive today — no live race — but see §11 |
| 5 | **Eleven** spec files named in the old §7.2 never existed | ✅ **Confirmed.** The current §7.2 lists only real paths; all 17 referenced specs exist. The revision fixed this |
| **6** | **`writeActionRecord` output fails the repo's own linter contract** | ✅ **CONFIRMED — and under-reported: FIVE violations, not three.** This is the plan's best evidence and it undersold itself. Full detail in §6.1 |
| 7 | DSH has **no prompt cache-boundary seam** | ⚠️ **Half-verified.** 0 hits for `cacheBoundary`/`cache_boundary`/`surface_digest` across `packages` — confirmed. The *upstream* half (iii's `system_sections`) could **not** be checked: `web_search` was unavailable to the reviewer too. Treat as unverified, not refuted |
| 8 | 45 spec files in `tests\` | ✅ **Confirmed.** 45 |
| 9 | **The memory plane has no reader and no writer** | ✅ **Confirmed — but smaller than stated.** No read/write path exists in `src/` (create + lint only). **However the plane is not empty:** `memory/skills/patterns/` holds **11 real shards** authored by agents following the shipped `SKILL.md`. This **refutes the plan's claim that T29 cannot be accepted on an empty plane** — see §11 |
| 10 | The plugin's peer deps are stale, and capabilities were recorded as "absent" from a stale tree | ✅ **Confirmed, but the framing was wrong.** The pinned target is `dsh-v0.2.0-rc.2` — the latest **release**, **already in the local checkout**. There are no `0.1.2`…`0.1.7` releases; that ladder is alpha/rc tags. `0.2.1-alpha.1` is a pre-release. **The checkout is shallow, so local diffs are meaningless** |

### 6.1 Claim 6 in full — the exact violation set

The author claimed three violations. Reading `delegation.ts:570‑628` against `ts-lint.ts:1284‑1341` — including the helper semantics, which matter — yields **five**:

| Linter requirement | Emitter | Violation |
|---|---|---|
| `ts-lint.ts:1287` `# Subagent Action Record` | `delegation.ts:588` `'# Subagent action record: ' + id` | ✗ case mismatch |
| `:1297` Metadata `Run ID` | never emitted | ✗ |
| `:1297` Metadata `Timestamp` | never emitted | ✗ |
| `:1302‑1313` Inputs `Current Artifact` + `Artifact Content Hash` | emitted under **Metadata** (line 597) | ✗ |
| `:1316` Inputs `Diff Basis` | emitted under **Routing** (line 604) | ✗ |

The last two are genuine *placement* failures because `getMdFieldValue` (`ts-lint.ts:117`) scans the **whole document**, not the section it was handed — so a field present under the wrong heading is still not found where the contract requires it.

**Why it is live:** `runtime.ts:362` calls `writeActionRecord` on the delegation path, and `ts-lint.ts:2084` feeds **every** `.md` under `subagents/` to this validator. So every delegated review writes a file the repo's own linter rejects.

**What that means for the plan:** the method — *read both sides of a contract, find where they disagree* — **is validated by finding a live bug**. T25's spec must assert all five, not three, and should be built by constructing one action record and running `lintRun` over it: the reviewer verified this by static analysis plus helper semantics, **not** by executing the linter, so the execution proof is still outstanding and is a one-command check.

### 6.2 Findings that were not in this list

| # | Finding | Evidence |
|---|---|---|
| A | **The baseline is RED.** `pnpm typecheck` → 12 × TS2614, exit 2; `pnpm test` → `Test Files 5 failed \| 40 passed (45)`, `Tests 1 failed \| 256 passed (257)`. Parity + invariants are **green: 46/46** | Full runs in the plugin dir |
| B | **The 12 typecheck errors are not version drift.** `JsonValue` is *defined* in `@deepseek-ai/dsh-util-values` and only *imported* by `dsh-tools`; `dsh-llm` exports `ToolCallId`, never `CallId`. Both hold **identically** at `0.1.1-rc.2` and at the newest tag — so no rebase could have fixed them | Type-tree inspection at three tags |
| C | **The plan and its "done" items are UNTRACKED.** `git clean -nd` would delete `STRENGTHENING-PLAN.md`, `src/{skills,goals-projection,teams-loop,recursive_audit_team.tool}.ts`, four specs, `skills/`, **and the lock receipts** under `.recursive/run/*/locks/` for runs 07–09 | `git status --porcelain`, `git clean -nd` dry run |
| D | **Three dead dependencies.** `dsh-code-runtime` and `dsh-invariants` were **deleted upstream** (whole package groups gone) and are imported nowhere; `dsh-client-runtime` is declared in `dsh.client.inject` but **not installed** and **absent from every tag ≥ 0.2.0-rc.2** — consolidated into `dsh-client-modules` | Package-name sweep at `dsh-v0.2.1-alpha.1` |
| E | **Receipt chaining is written but never verified.** `previous_receipt_hash` is emitted (`lock.ts:199`) and `validateChain` (`:289`) never reads it | `lock.ts` read + grep |
| F | **Five parallel copies of the phase order** — `lock.ts:19`, `status.ts:6`, `ts-lint.ts:70`, `runtime.ts:520/532`, `client/derive.ts:33` — plus two hand-written edge tables (`ts-lint.ts:636‑655`, `:2104‑2108`). `OPTIONAL_PHASES` already contradicts `status.ts` and `client/derive.ts` about `03.5` | Full consumer trace, §11 |
| G | **The repo violates its own shipped hygiene rule.** `references/agents-block.md:61` forbids committed run residue; **256 files under `.recursive/run/` are committed**, including evidence logs and review bundles. `check-reusable-repo-hygiene.py` (which would flag this) was never ported | `git ls-files`, parent script read |
| H | **The zero-emission guard has a hole.** `tests/live-route.spec.ts:34‑41` scans a **hardcoded** file list, so new `src/*.ts` files added by T17/T21/T29 would not be scanned at all | Spec read |
| I | **A cheaper T28 exists.** `ctx.subagents.resolveMaxDepth(configured?: number \| 'provider-managed')` makes delegation depth a one-line config change instead of bespoke budget plumbing | Generated API catalog at the latest tag |

---

**Claim 6 is the highest-value check.** If it holds, the plan's central method — read both sides of a contract, find where they disagree — is validated by finding a live bug. If it does *not* hold, say so plainly, because the plan leans on that method repeatedly.

---

## 7. Where I am least confident — ranked, worst first

Be hardest on these.

0. **The method itself has two blind spots, and both have already produced misses.** → **First:** both audits looked **outward** — at iii's harness, at Effect and Tardigrade — and neither looked at **what the parent repo has that the plugin dropped.** The human operator found that one: the plugin scaffolds and lints a memory plane but never reads or writes it, while `D:\DEV\recursive-mode\skills\recursive-training\` ships two hooks for exactly that. → **Second: the DSH baseline was never checked.** Capability claims were derived from a local checkout assumed current, and it is not — three capabilities (`ctx.storage`/`ctx.storageDomain`, `dsh-repeat-tool-reminder`, the session-format migration chain) were recorded as absent or unconsidered purely because the tree was stale. **Both blind spots share a shape: the plan reasoned about the plugin and about other systems, but not about the two things it depends on — its parent project and its host platform.** Both audits looked **outward** — at iii's harness, at Effect and Tardigrade. Neither looked at **what the parent repo has that the plugin dropped.** The human operator found that gap, not the audits: the plugin scaffolds and lints a memory plane but never reads or writes it, while `D:\DEV\recursive-mode\skills\recursive-training\` ships two hooks for precisely that. **The general question — *what else from the parent repo did not make the crossing, and was that deliberate?* — is unanswered.** Run-09's out-of-scope list is the place to start: `D:\DEV\recursive-mode\dsh-recursive-mode\.recursive\run\09-ts-only-runtime-and-scaffold-repair\00-requirements.md`, and the Out-of-Scope sections of the other runs. **This is the highest-value thing you could contribute**, because it is a class of gap that neither audit could have found.
1. **T22's premise — already found wrong once.** The original version asserted DSH could take a stable prompt prefix with a cache boundary and a cache-intent digest, modelled on iii. **DSH has no such API.** The item is now rescoped to "split stable from volatile and register them at separated orders," with the *measurement* made step one and the "largest cost lever" label withdrawn. The residual claim — that a byte-identical prefix buys anything — is **unverified**, and I never measured whether provider caching happens at all.
2. **The "no concurrency → no queue" inference.** It is an inference from a **static** measurement, not an experiment. If DSH's loop ever invokes plugin tools concurrently, or the plugin is mounted for two sessions over one workspace, the single-writer premise fails and several conclusions soften. I did not test either scenario.
3. **T17's blast radius.** I read `lock.ts` carefully and know `ts-lint.ts` parses addendum filenames. I did **not** trace every consumer of `PHASE_SEQUENCE` or the filename conventions. The plan's acceptance test for T17 is *"the parity suite stays green"*, which is a good signal but not a proof of completeness. **✅ RESOLVED — and it is worse than feared.** The full trace was run over `src/`, `tests/`, the client and the goldens. The graph-shaped queries (`getPrerequisites`, `getStaleDownstreamPhases`) are **already set-shaped**, so a DAG wins little there. What a bare `{nodes, edges}` **cannot** reproduce: `phaseIndex(): number` is public, `policy.ts:50` stringifies the array into a model-visible prompt, `getNextLegalPhase`/`breakPhase` mean *"first of a total order"*, and **`OPTIONAL_PHASES` is a node attribute, not an edge**. Sharpest unmentioned risk: any change to the **edge set changes `receipt_hash`** and will start flagging already-written receipts under `.recursive/run/*/locks/`. **The real defect is not flat-vs-DAG — it is five parallel copies of the same list (finding F, §6.2).** Recommendation: narrow T17 to that dedup.
4. **T18's pending-work signal.** Deriving in-flight work from "a `handoff.md` with no `reply.md`" assumes the pairing is always created before anything can fail. **If a delegation can fail before writing its handoff, the signal is silently empty** and the quiescence rule would pass when it should not. Verify against `src\handoff.ts` and `src\delegation.ts`. **✅ RESOLVED — the concern was misplaced.** The `handoff.md` is written at `runtime.ts:269`, **before** the bundle and before the subagent starts (`:330‑353`), so the pairing is created early in the happy path. The real exposure is the window between the handoff and the reply, which is where a crash or hang actually leaves residue. The signal is sound; the item's acceptance test should name that window explicitly.
5. **Whether the audits' recommendations actually fit DSH.** Two of the three bodies of research are about *other systems* (iii on a WebSocket bus with SQLite-backed state; Effect/Tardigrade with real durable stores). The mappings are by analogy. **Some are probably superficial.** T27 (a hook registry) and T28 (budgets) are the ones I would scrutinise hardest — they are the most "framework-flavoured" and the least tied to a specific observed defect.
6. **T25's "would fail today".** I inferred the mismatch by reading both sides; **I did not run the linter over a plugin-written action record.** If you can cheaply construct one and run `lintRun`, that converts an inference into a fact. **⚠️ STILL OPEN — but it is now a one-command check, not an inference.** The reviewer verified the mismatch statically **including helper semantics** (`getMdFieldValue` scans the whole document, which is why the two placement failures are real) and found **five** violations. What remains unexecuted is constructing one action record and running `lintRun` over it. **Do that first when work resumes** — it converts the plan's best evidence into a fact.

---

## 8. Environment facts

- **Working repo for the plugin:** `D:\DEV\recursive-mode\dsh-recursive-mode`. The session workspace `D:\DEV\dsh-recursive-mode` is a **different, mostly-empty directory** holding the research artefacts. Do not confuse them.
- **`STRENGTHENING-PLAN.md` is UNTRACKED in git.** `git checkout` will not restore it. A backup of the pre-revision version exists at `D:\DEV\dsh-recursive-mode\STRENGTHENING-PLAN.original.md`. **Do not overwrite or delete either without asking.**
- **Approval policy is `never`** in the reference session: actions requiring approval are auto-rejected. Do not request sandbox escalation.
- **`web_search` is unavailable** (credential-binding error). `web_fetch` works. Prefer the local clones over the network anyway.
- **Clones:** `D:\DEV\.tmp-iii-audit\workers` (iii/workers), `D:\DEV\.tmp-effect-audit\effect`, `D:\DEV\.tmp-effect-audit\tardigrade`.
- **✅ DSH baseline — CORRECTED AND SETTLED.** The plugin pins `@deepseek-ai/*` at **`0.1.1-rc.2`**. The pinned target is **`dsh-v0.2.0-rc.2`** (`639ed01539`) — the **latest release** — and the local checkout `D:\deepseek-harness` **already sits on it**, so **no checkout refresh is required**. `dsh-v0.2.1-alpha.1` (`5badb15009`, 2026-10-03) is a **pre-release** one release-merge beyond the baseline and is **not tracked**; the plan records that decision in §9.3.
  - **The "two release lines" framing that used to be here was wrong.** There are no `0.1.2`…`0.1.7` **releases**; that ladder is alpha/rc tags (`0.1.2-alpha.1..5` → `0.1.3-alpha.1..2` → `0.1.5-alpha/rc` → `0.1.6-alpha` → `0.1.7-alpha/rc` → `0.2.0-rc.1/2` → `0.2.1-alpha.1`).
  - **⚠ The clone is SHALLOW/GRAFTED** (`.git/shallow` exists; `FETCH_HEAD` is a parentless root). `git diff --stat HEAD FETCH_HEAD` reports ~4190 files changed — **an artifact of the graft, not a measure of the delta.** Derive every capability claim from the tag tree: `git show <tag>:<path>`, `git grep <symbol> <tag> -- <path>`. Never from a local diff.
  - **To inspect upstream without disturbing the checkout:** `git -C D:\deepseek-harness fetch --tags --force origin master`, then `git show dsh-v0.2.1-alpha.1:packages/<group>/<pkg>/package.json`. `FETCH_HEAD` resolves to `master` after a fetch.
  - **Verified at `dsh-v0.2.1-alpha.1`** (so also true of the rc.2 baseline): `ctx.storage`/`storage-domain` exist **and are mounted by `packages/bundle/base`**; `@deepseek-ai/dsh-repeat-tool-reminder` ships in the base bundle; the session-format chain `v0-to-v1`…`v3-to-v4` exists; `hook-protocol` is the **external** Claude Code/Codex bridge (its own description says so); `ctx.subagents.startContinuable` + `drainContinuableDescendants/Children` exist; `ctx.agentTeams` lives in **`packages/experimental`** (publish name `@deepseek-ai/dsh-experimental-agent-team`); `ctx.subagents.resolveMaxDepth()` exists. **No `cacheBoundary`/`surface_digest` anywhere.**
- **Test commands**, from the plugin directory:
  - `pnpm test` — full vitest suite (~45 spec files; counts drift, so trust the runner not the plan)
  - `pnpm typecheck` — `tsc --noEmit`. **Currently RED: 12 × TS2614.** The suite is **5 failed / 40 passed files**; parity + invariants are **46/46 green**. The plan's §7.0 holds the frozen baseline to beat.
  - `npx tsx scripts/test-recursive-mode-smoke.ts` — plugin smoke
- Some directories under `D:\deepseek-harness\packages` are large; a recursive `Get-ChildItem` there can exceed a two-minute budget. Use ripgrep-style searches with a narrow path instead.

---

## 9. Output format for your opinion

Deliver this as your reply to the human. Keep it tight — a long opinion will not be read.

1. **Bottom line** — two or three sentences: is the plan sound, and what is the single change that matters most?
2. **Verification results** — the table from §6, each claim marked confirmed / refuted / could-not-verify, with what you actually did.
3. **Answers to Q1–Q8**, each with a verdict and a confidence level.
4. **Disagreements, ranked** by how much they change the plan. For each: what the plan says, what you think, and why.
5. **A proposed diff to the plan** — add / delete / rescope / reorder. Name T-numbers.
6. **What you could not verify**, and what you would need to.

**Then stop and wait.** The human will decide what to act on. Do not begin implementing, and do not treat this review as authorisation for any item.

---

## 10. A note on tone

The plan was written by an agent reviewing its own earlier work, and it has already had one premise falsified mid-flight (T22's cache seam). It is a draft that expects to be wrong somewhere. **A review that finds nothing is not a useful review** — the most valuable outcome is a specific, checkable claim that the plan got wrong.

---

## 11. Open work — what is left, in priority order `[for the next agent]`

Everything below is **unstarted**. No plan item has been implemented, and no file under `src/`, `tests/`, `preset/` or `cordis.patch.yml` has been changed. The only edit ever made to the plugin repo was the authorised documentation update to `STRENGTHENING-PLAN.md`.

**0. Commit the work — 30 seconds, highest value.** `STRENGTHENING-PLAN.md`, `src/{skills,goals-projection,teams-loop,recursive_audit_team.tool}.ts`, the four T0/T1/T3/T4 specs, `skills/`, and the lock receipts for runs 07–09 are **untracked**. One `git clean -fd` destroys four "done" items and the plan that certifies them. Do this before anything else on the list.

**1. Prove the action-record bug by execution.** Construct one action record via `writeActionRecord` and run `lintRun` over it. Static analysis says it fails with five violations (§6.1); executing it makes that a fact and validates the plan's whole method. One command.

**2. T-1 — recover the baseline.** 12 type imports, 3 dead dependencies, plus the separate `init-templates.parity` placeholder failure. Until this is done, **no other item can be marked RED→GREEN**, because every item's acceptance test is "the suite stays green". Specification: plan §4 T‑1.

**3. Decide the structural recommendations the reviewer made but the human has not yet ruled on.** All are recorded in the plan's §10 change-log entry:
   - **Delete T27** (hook registry) — no observed defect, and the plan's own §2 disowns the API it was modelled on.
   - **Merge** T28→T20 (both bound `auditToPass`), T12→T22 (both preload contracts), T26→T15 (a preview of the guard *is* its read path).
   - **Narrow T17** to collapsing the five parallel copies of the phase order (finding F) rather than introducing a DAG.
   - **Reorder T29 before T30** — the reviewer refuted the plan's premise that the memory plane is empty; **11 real shards already exist**, so a reader has material to read today.
   - **Rewrite the unfalsifiable acceptance criteria** (T21's cost claim, T15's "every deny", T16/T26's "a reviewer can predict", and T31's "typecheck is green" — which was red before the item started).

**4. Audit the hygiene breach.** 256 files under `.recursive/run/` are committed against the rule the plugin itself ships (`references/agents-block.md:61`) and the checker it never ported (`check-reusable-repo-hygiene.py`). Decide explicitly: purge, or grandfather with a recorded reason. Then wire the checker in so it cannot recur.

**5. Close the parent-repo gap.** The reviewer confirmed four parent capabilities that silently did not cross: `check-reusable-repo-hygiene`, receipt-chain verification (`verify-locks`), the training extract/sync/mcp scripts, and the router CLI surface. **A full diff of the parent's `scripts/` inventory against the plugin's `src/` is a half-day and closes the blind spot both audits shared** (§7 item 0). This is the single highest-value *process* action remaining.

**6. Cheaper T28 / safer T15, once the above lands.** `ctx.subagents.resolveMaxDepth()` makes delegation depth a config change; and `validateTransition` should be surfaced **advisory-first** in `lockArtifact` rather than made blocking, because the parity fixtures carry none of its markers and enabling it takes `lock.parity` red.

**Standing caveats for whoever continues:**
- The local DSH clone is **shallow** — do not quote local diffs as measurements (§8).
- Approval policy is `never`; do not request escalation.
- `STRENGTHENING-PLAN.md` remains untracked until item 0 is done. **Do not overwrite it, and do not delete either it or `STRENGTHENING-PLAN.original.md` without asking.**

