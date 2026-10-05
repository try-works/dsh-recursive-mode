# Proposal: dsh-recursive-mode — a DeepSeek Harness plugin for the recursive-mode workflow

> **Status:** Proposal (audit-backed, not yet implemented)
> **Date:** 2026-08-15 (session audit of both repos)
> **Audited checkouts:**
> - recursive-mode: `D:\DEV\recursive-mode` @ `ff75bc7` ("Fix recursive-training unattended pipeline and PowerShell wrappers."), upstream `https://github.com/try-works/recursive-mode`
> - DeepSeek Harness: `D:\deepseek-harness` @ `47f943859b` (merge PR #2519 "feat/npm-public", release `dsh 0.1.0-rc.5`), upstream `https://github.com/deepseek-ai/deepseek-harness`

---

## 1. Executive summary

recursive-mode is currently a **skill package** — a 2,362-line workflow spec (`.recursive/RECURSIVE.md`) plus ~31 Python and ~28 PowerShell helper scripts that any agent harness "adapts to" through `AGENTS.md` bridge files. It has no native runtime, no events, no UI, and no programmatic run state.

DeepSeek Harness (DSH) is a **plugin-first agent runtime** on Cordis where "everything is a plugin": bundles, profiles, patch overlays, dynamic in-session plugins, model-facing tools, slash commands, skills providers, background jobs, durable same-session goals, subagent delegation, and a browser client surface.

This document proposes **`dsh-recursive-mode`**: a DSH plugin bundle that makes recursive-mode a first-class harness citizen while **keeping the file-backed control plane as the single source of truth**. The workflow stays auditable and portable across harnesses; the plugin wraps the existing file contracts with native DSH affordances so the workflow is *enforced* rather than merely *described*.

---

## 2. Audit — current recursive-mode (D:\DEV\recursive-mode)

### 2.1 Repository layout

```text
D:\DEV\recursive-mode/
├── .recursive/                  # control plane (workflow truth)
│   ├── RECURSIVE.md             # canonical spec — 2,362 lines / 112,811 bytes
│   ├── README.md                # maintainer notes (160 lines)
│   ├── AGENTS.md                # internal router/index
│   ├── STATE.md                 # global current-state doc (12 lines)
│   ├── DECISIONS.md             # global decision ledger (10 lines)
│   ├── config/
│   │   └── recursive-router.json  # canonical routed-delegation policy
│   ├── memory/                  # durable memory plane
│   │   ├── MEMORY.md            # memory router/index + freshness policy
│   │   ├── domains|patterns|incidents|episodes|training|skills|archive/
│   │   └── (skills/{availability,usage,issues,patterns}/)
│   ├── scripts/                 # (runtime copies land here on bootstrap)
│   └── run/                     # per-run folders /.recursive/run/<run-id>/
├── skills/
│   ├── recursive-mode/          # installable root skill (SKILL.md + 31 .py + 28 .ps1)
│   ├── recursive-spec/
│   ├── recursive-worktree/
│   ├── recursive-debugging/
│   ├── recursive-tdd/
│   ├── recursive-review-bundle/
│   ├── recursive-router/
│   ├── recursive-subagent/
│   └── recursive-training/
├── scripts/                     # maintainer harness + tests (smoke, benchmark)
├── references/                  # benchmark add-on source + fixtures + plans
├── docs/                        # templates
├── AGENTS.md                    # root bridge (mirrors /.codex/AGENTS.md block)
└── .codex/AGENTS.md, .agent/PLANS.md, .cursor/, .benchmark-*/
```

### 2.2 The workflow contract (from `.recursive/RECURSIVE.md`)

The canonical spec is the single source of truth for how agents work in a recursive-mode repo. Key invariants:

| Invariant | Spec reference | Meaning |
|---|---|---|
| Repo docs are the source of truth | §"Non-negotiable recursive-mode rules" (1) | Prompts are commands, not specifications; requirements/plans live in repo files |
| One-way phases | Rule (3), §"No backtracking rule" | No editing prior-phase artifacts after advancing; gaps → addenda |
| Explicit gates | Rule (4) | Every artifact ends with Coverage Gate + Approval Gate; audited phases also end with `Audit: PASS` |
| Auto-bootstrap | Rule (5) | Missing `/.recursive/` scaffold → run the supported installer automatically |
| Audited phase loop | §"Mandatory audit loop for audited phases" | `draft → audit → repair → re-audit → pass → lock`; `Audit: PASS` prerequisite for Coverage/Approval PASS |
| Locking | §"Locking and immutability", §"Recursive Lock Verification" | `Status: LOCKED` + `LockedAt` + `LockHash` (SHA-256 of normalized content: LF newlines, `LockHash:` line removed) |
| Monotonic phase gating | `recursive-lock` contract | Cannot lock phase N until earlier phases are lock-valid; `--reopen` resets to DRAFT and invalidates downstream |
| Addenda | §"Addenda (mandatory)" | Stage-local `<base>.addendum-NN.md`; upstream-gap `<current>.upstream-gap.<prior>.addendum-NN.md`; effective input = base + addenda in lexical order |
| Requirement IDs | §"Requirement IDs and traceability" | R1…, OOS1…; downstream artifacts map each R# with machine-checkable `Requirement Completion Status` |
| Pre-run spec authoring | `recursive-spec` skill | Approval-gated, repo-aware `00-requirements.md` co-authoring before a run exists; draft stays temp-scratch until user approval; no run folder from an unapproved draft |
| Worktree isolation | §"Recursive worktree isolation (Phase 0)" + `recursive-worktree` skill | Git worktree under `.worktrees/<run-id>/`; Iron Law: never work on main/master without explicit consent; location order, ignore-check, setup, clean baseline, router-state sync |
| Delegation | §"Canonical review bundle", §"Canonical router policy", §"Canonical subagent action records" | Bundles under `evidence/review-bundles/`; router policy `config/recursive-router.json` + `recursive-router-discovered.json`; action records under `subagents/`; main agent must verify delegated claims |
| Memory plane | §"Separate memory plane" | `MEMORY.md` index + shards with `CURRENT/SUSPECT/STALE/DEPRECATED` freshness; Phase 8 maintenance |
| Single-command orchestration | §"recursive-mode single-command orchestration" | "Implement requirement '<run-id>'" auto-resumes at earliest non-lock-valid phase; strict sequential execution |
| TDD | §"recursive-tdd (Phase 3)" | Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST; `TDD Mode: strict|pragmatic` declared |
| Debugging | §"recursive-debugging (Phase 1.5)" | NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST; mandatory when requirement is a bug fix |
| Manual QA | §"Phase 5" | `QA Execution Mode: human|agent-operated|hybrid`; human/hybrid require explicit user sign-off |
| Hard gates | §"recursive-mode hard gates" | 12 non-negotiable checkpoints (HG-0 … HG-11), including HG-9 lock-chain and HG-11 TODO-completion |
| Workflow profiles | §"Workflow Profiles" | `recursive-mode-audit-v2` current; v1 + `memory-phase8` compat aliases |

### 2.3 The phases

| Phase | Artifact | Notes |
|---|---|---|
| 0R | `00-requirements.md` | User-created first; stable R#/OOS# IDs + acceptance criteria |
| 0W | `00-worktree.md` | Worktree isolation; normalized diff-basis metadata |
| 1 | `01-as-is.md` | AS-IS analysis; audited; v2 requires `## Source Requirement Inventory` |
| 1.5 | `01.5-root-cause.md` | Debug mode, optional; audited when present |
| 2 | `02-to-be-plan.md` | ExecPlan-grade TO-BE plan; audited; v2 requires `## Requirement Mapping`, `## Plan Drift Check`, plan-stage `## Requirement Completion Status` |
| 3 | `03-implementation-summary.md` | TDD discipline; audited; `TDD Mode` declared; sub-phase structure for large scope |
| 3.5 | `03.5-code-review.md` | **Mandatory in dsh-recursive-mode (deviation from upstream optional);** audited; canonical review bundle + `Review Bundle Path`; FAIL → back to `3` repair |
| 4 | `04-test-summary.md` | Tests/validation; audited; pre-test audit; Playwright evidence standard |
| 5 | `05-manual-qa.md` | Manual QA; audited; `QA Execution Mode` declared |
| 6 | `06-decisions-update.md` | DECISIONS.md delta receipt; audited |
| 7 | `07-state-update.md` | STATE.md delta receipt; audited |
| 8 | `08-memory-impact.md` | Memory maintenance delta receipt; audited; run-local skill-usage capture |

### 2.4 The helper-script surface

The installable root skill (`skills/recursive-mode/SKILL.md`) ships **31 Python + 28 PowerShell scripts**, including:

- `install-recursive-mode.{py,ps1,sh}` — bootstrap installer (scaffold, bridges, router policy, training memory)
- `recursive-init.{py,ps1}` — run scaffold
- `recursive-status.{py,ps1}` — run status / lock-chain scan
- `lint-recursive-run.{py,ps1}` — run linter (phase rules, gate sections, TODO checks)
- `recursive-review-bundle.{py,ps1}` — canonical review-bundle builder
- `recursive-closeout.{py,ps1}` — Phase 4–8 receipt scaffolds
- `recursive-lock.{py,ps1}`, `verify-locks.{py,ps1}` — lock write/verify with canonical hash normalization
- `recursive-router-{init,probe,configure,resolve,invoke,validate}.{py,ps1}` + `recursive-router-cli-*` — routed delegation
- `recursive-subagent-action.{py,ps1}` — durable action records
- `recursive-training-{grpo,extract,loader,sync,mcp,phase8-trigger}.{py,ps1}` — training memory plane
- `check-reusable-repo-hygiene.{py,ps1}` — reusable-skill repo cleanliness
- `recursive_phase_rules.py`, `recursive_router_lib.py`, `recursive_router_cli_lib.py` — shared libraries

Maintainer harness (`scripts/` at repo root): `test-recursive-mode-smoke.{py,ps1}`, `run-recursive-benchmark.{py,ps1}`, plus `test_*.py` unit modules.

### 2.5 Gaps / limitations of the current design (why a plugin is valuable)

1. **No structured run state** — status is derived by re-parsing files on every check; there is no service that can answer "what phase is run X in?" instantly or react to changes.
2. **No native UI** — progress, lock validity, gates, and evidence are only visible by opening files.
3. **No events** — nothing can react to a phase locking, a gate failing, or a lock hash drifting.
4. **Delegation is hand-assembled** — the agent must build context bundles from scratch; the "controller verification" loop is prose.
5. **Router is external-CLI oriented** — it does not natively leverage a harness's subagent/LLM routing primitives.
6. **Session-start reads are not enforced** — STATE/DECISIONS/MEMORY reads depend on the model following instructions.
7. **Worktree isn't wired to the harness** — the harness's active workspace/cwd doesn't follow the run's worktree.
8. **Lock enforcement is script-only** — nothing but the agent's discipline prevents editing a locked artifact or locking an un-gated one.

---

## 3. Audit — DeepSeek Harness plugin architecture (D:\deepseek-harness @ 47f943859b / dsh 0.1.0-rc.5)

### 3.1 The plugin model (from `docs/user/develop/basic/publish.md`, `apps/cli/reference/README.md`, `apps/cli/README.md`)

- **Bundle** — npm package declaring `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; contributes a config layer.
- **Profile** — `$DSH_HOME/profiles/<name>` with `package.json` (`dsh.profile.bundles` ordered list) + `cordis.patch.yml`; `dsh plugin --profile <name> add <pkg|git>` installs; `dsh --profile <name>` boots; `dsh web` = `--profile web` (auto-initialized from `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`).
- **Layering order:** bundle patches in list order → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays; later layers win per row; a patch replaces the whole `config` of a row (no deep merge).
- **Dynamic plugins:** the web surface ships `cordis-host-runner` + `tool-cordis` + `ui-cordis` (rows in `packages/bundle/web-app/cordis.patch.yml`), so an agent can define/run/stop plugins at runtime via `cordis_define`/`cordis_run` with plain-JS `code.host`/`code.client`. The CLI ships a `cordis-plugin-development` skill (`apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md`) documenting this.
- **Client plugins:** packages declaring `dsh.client` (platform web, optional `inject` edges, optional `immediately`) compose `window.__DSH_BOOT__` (`docs/subsystems/client-modules.md`); UI registers into slots (settings sections, sidebar, conversation nodes via `ConversationNodeDefinition`, tool cards, …). Client changes require the `pnpm run dev:web` watcher to rebuild bundles.

### 3.2 Extension points relevant to recursive-mode (verified in source)

| Seam | What it gives | Verified source |
|---|---|---|
| `ctx.tools.register(defineTool(...))` | Model-facing tools | `packages/core/tools`; `packages/skill/tool-skill/src/index.ts`; `packages/workflow/tool-workflow/src/index.ts` |
| `ctx.skills` + `SkillProvider` | Register skills natively; `tool-skill` renders `<skill_content>`, user-invocable via `/name` | `packages/skill/skill/src/index.ts`, `packages/skill/skill-filesystem/src/index.ts` |
| `ctx.systemPrompt.section()` | Prompt sections (identity, persona, tool guidance, mode policy) | `packages/core/system-prompt/src/index.ts` |
| `ctx.commands.register()` | Slash commands with direct handlers, no model round-trip | `docs/subsystems/commands.md`; `packages/interaction/commands` |
| `ctx.goals` + `goal-round-driver` | Same-session durable goal with automatic continuation rounds | `packages/goal/goal/src/index.ts`, `packages/goal/goal-round-driver/src/index.ts`; `docs/subsystems/goal.md` |
| `ctx.subagents` (spawn/fork providers) | Programmatic delegated audit/review with structured output | `packages/subagent/*`; `packages/workflow/tool-ralph/src/index.ts` (structured-output child pattern) |
| `ctx.workflowEngine` + `workflow` tool | Model-written JS orchestration fanning out subagents | `packages/workflow/workflow/src/index.ts`, `packages/workflow/tool-workflow/src/index.ts` |
| `agent/pre-step` waterfall | Inject skill bodies / memory shards / enforce reads at each step | `packages/skill/tool-skill/src/index.ts` (lines 177–250: skill invocation + catalog injection) |
| `agent/session-start`, `tools/pre-execute`, `tools/post-execute`, `tools/result` | Session-start bootstrap; phase-based tool guards; result observation | `docs/cookbook/extension-cookbook.md` (feature → mechanism map) |
| `ctx.jobs` | Background jobs for long test/QA runs | `packages/jobs/*` |
| `ctx.userQuestions` / `ctx.approval` | Human sign-off for Phase 5 QA | `packages/core/user-questions`, `packages/approval` |
| `ctx.workspaceRegistry` | Track worktree as workspace; session attach by cwd | `packages/workspace/workspace`; `docs/subsystems/workspace.md` |
| `ctx.storageDomain` | Durable KV for run registry/indices (optional) | `packages/storage/*` |
| `mcp-client` plugin | Connects an external MCP server and registers its tools as `mcp__<server>__<tool>`; effect-scoped, HMR-safe | `packages/mcp/mcp-client/src/index.ts` (NOT in base bundle — compose per-server) |
| Agent presets | `preset.yml` + `agent.cordis.yml` per-session composition | `apps/cli/config/agent-presets/{standard,cordis,code,minimal}/` |
| Events (`emit`/waterfall) | `recursive/*` events so UI/plugins react | Cordis core; `docs/cordis-primer.md` |
| Client slots + `dsh.client` | Run dashboard, phase strip, lock-tamper badge, evidence links | `apps/web`; `docs/subsystems/client-modules.md` |
| `cmdlineArgs` + `dsh-cmdline` | Surface bundle with its own CLI args | `packages/boot/cmdline`; `docs/user/develop/basic/publish.md` §"Give a surface bundle its own command line" |

### 3.3 Key architectural facts captured during the audit

- `ctx.skills` is a **layered registry**: providers register into the calling context's scope; a preset-mounted plugin registers for that preset's scope only (`packages/skill/skill/src/index.ts` lines 346–400). Skills resolve per-agent with `{ cwd, signal, scope: agent }` lookup (`packages/skill/tool-skill/src/index.ts` line 133).
- Skill catalog injection is **digest-cached** per agent: the catalog message is only re-injected when the visible set/digest changes (`tool-skill/src/index.ts` lines 213–250). This is the pattern to copy for STATE/DECISIONS/MEMORY injection.
- `goal-round-driver` is a **serialized per-agent driver** that awaits agent quiescence, checkpoints durability, and reserves at most one next round (`packages/goal/goal-round-driver/src/index.ts` lines 76–220). It is the exact machinery "Implement the run" needs for durable continuation.
- `tools/pre-execute` waterfall returns typed decisions (`{ kind: 'deny' | 'ask' | ... }`) and is the reorderable policy layer — the mechanism plan-mode-style mode guards use (`docs/cookbook/extension-cookbook.md` §"A hook plugin (permission-gate example)").
- `system-prompt/assemble` is an expert waterfall whose returned assembly is authoritative; `PERSONA_SECTION = 'deployment:persona'` + `PERSONA_ORDER = 0`; sections are concatenated in ascending `order` (`packages/core/system-prompt/src/index.ts` lines 128–131, 52–68).
- Client modules: the host scans packages declaring `dsh.client`, serves `/plugins/<id>/client.js`, and injects `window.__DSH_BOOT__` on every index render; `rebuilt(id)` is the only path by which bundle content reaches the graph (`docs/subsystems/client-modules.md`).
- Plugin hot-reload: every registration — provider, event listener, tool, prompt section, service — MUST go through `ctx.effect` (generator form: `yield` the disposer after each setup step) so vendored HMR unwinds/reapplies registrations cleanly (`vendor/cordis/src/fiber.ts`; `docs/cordis-primer.md` §"Practical Rules"; `docs/user/develop/basic/config.md` §"Work with HMR"). The rule is literal: `ctx.provide`, `ctx.on`, `ctx.commands.register`, `ctx.systemPrompt.section`, `ctx.tools.register` are all effect-backed, so our plugin's own `ctx.recursive` service, tools, prompt sections, and client-module registration must each go through `ctx.effect` to be unload-safe.
- **MCP bridge (missed in the original audit):** `@deepseek-ai/dsh-mcp-client` (`packages/mcp/mcp-client/src/index.ts`) is a namespace plugin (`inject: ['tools']`) that connects to an external MCP server and registers its tools as `mcp__<server>__<tool>`; one instance per server, effect-scoped disposal, HMR-safe. Not in the base bundle — compose it. This is the native path for recursive-mode's `recursive-training-mcp` and any external-tool integration, instead of py/ps1 wrappers.
- **Additional seams present but not yet in §3.2:** `ctx.sessions` + `ctx.sessionPersistence`, `ctx.sessionQuery` + `ctx.sessionProjections` + `ctx.sessionProjectionCache`, `ctx.agents`, `ctx.shell`, `ctx.appExit`, `ctx.fiber`, `ctx.logger`; events `system-prompt/change`, `agent/error`, `command/run`.
- The web profile's base bundle mounts the full tool stack an agent needs (fs, bash/pwsh, jobs, subagent control + spawn/fork/report, workflow + ralph, goal + driver + tool, plan-mode, commands, skills + tool-skill) — see `packages/bundle/base/cordis.patch.yml` and the `standard` agent preset at `apps/cli/config/agent-presets/standard/agent.cordis.yml`.

### 3.4 Ecosystem signals (from web research)

- Official [plugin scaffold RFC](https://github.com/deepseek-ai/deepseek-harness/discussions/1629) ("official plugin scaffold — template repo + pnpm create dsh-plugin").
- [create-dsh-plugin](https://www.npmjs.com/package/create-dsh-plugin) npm package.
- GitHub topic [dsh-plugin](https://github.com/topics/dsh-plugin) for discoverability (README §Community).
- Third-party bundles: [dsh-tui](https://github.com/openguardrails/dsh-tui) (terminal UI as out-of-tree bundle), [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) (multi-agent teams plugin), [dsh-hermes-memory](https://github.com/mbj733/dsh-hermes-memory) (cross-session memory preset+plugin), [dsh-plugin-cc](https://github.com/cpj-dev/dsh-plugin-cc) (Claude Code bridge).
- DSH README explicitly recommends adding the `dsh-plugin` topic to plugin repos for discoverability.

---

## 4. Proposal — `dsh-recursive-mode`

### 4.1 Guiding principles

1. **Keep the file-based control plane as the source of truth.** Requirements/plans/evidence stay in repo documents. The plugin is an execution surface, not a replacement store. (Preserves cross-harness portability and the anti-"context rot" rationale.)
2. **Do not rewrite the Python/PowerShell runtime in v1.** It is tested, cross-harness, and encodes hard-won parity (lock normalization, linter, training pipeline). Ship it as vendored assets; invoke via the shell/subprocess seam. Port hot paths to TS incrementally where DSH-native integration pays off (lock hash, status, effective inputs, review bundles).
3. **Wrap, don't duplicate.** Every recursive-mode capability maps to a DSH extension point; where the workflow says "the agent must…", the plugin turns that into a tool, a guard, an event, or a UI affordance.
4. **Enforce, don't just describe.** The plugin should make the hard gates hard: lock tool refuses un-gated locks, pre-execute guards block premature product writes, tamper detection fires on hash drift.

### 4.2 Package shape

A single npm package, e.g. `dsh-recursive-mode`, published as a **bundle**:

```text
dsh-recursive-mode/
├── package.json               # dsh.bundle → ./cordis.patch.yml; dsh.client (browser half)
├── cordis.patch.yml           # inserts recursive service, tools, commands, skills provider,
│                              #   prompt section, goal hook, client module
├── src/
│   ├── index.ts               # main plugin: name/inject/apply; owns the `ctx.recursive` service (class extends Service → `super(ctx, 'recursive')`; typed via `declare module '@deepseek-ai/cordis' { interface Context { recursive: RecursiveRuntime } }`)
│   ├── run.ts                 # run discovery, status, lock-chain validation, effective-input enumeration
│   ├── lifecycle.ts            # the run state machine: transitions, guards, serialized driver, events (§8.8)
│   ├── lock.ts                # canonical LockHash computation + lock write (LF, strip LockHash line)
│   ├── bootstrap.ts           # scaffold installer (port of install-recursive-mode.py apply-path)
│   ├── review.ts              # review-bundle builder (hash artifact, gather upstream + addenda + diff basis)
│   ├── router.ts              # recursive-router.json policy resolver → ctx.subagents provider (no vendored router CLIs; see §10.10)
│   ├── memory.ts              # MEMORY.md index read + relevant-shard selection for session-start injection
│   ├── tools.ts               # defineTool registrations (recursive_init/status/lock/lint/closeout/...)
│   ├── commands.ts            # /recursive … slash commands
│   ├── prompt.ts              # system-prompt section: "recursive-mode active" operating contract
│   ├── skills.ts              # SkillProvider serving the bundled recursive-* SKILL.md bodies
│   ├── goal.ts                # per-phase same-session goal wiring (continuation rounds)
│   └── client/index.ts        # browser half: run dashboard, phase strip, lock-tamper badge, evidence links
├── skills/                    # the 9 SKILL.md packages (bundled skill content)
├── scripts/                   # vendored .py/.ps1 runtime (lock/status/lint/closeout/etc.; NO benchmark, NO router CLIs — see §10.10)
└── tests/                     # vitest + cordis.yml overlay e2e (pattern: apps/web/tests + examples/*)
```

Install options:

```sh
# add to the web profile (or any profile)
dsh plugin --profile web add <package-or-git>
# or a dedicated profile
dsh plugin --profile recursive add <package-or-git>
dsh --profile recursive
```

### 4.3 Capability mapping (parity + enhancement)

| recursive-mode capability | Today | DSH plugin |
|---|---|---|
| **Bootstrap scaffold** | `install-recursive-mode.py` run manually/auto | Stage B of the §5.10 init phase: the `agent/session-start` hook resolves the worktree root, and if `/.recursive/` is missing it runs bootstrap (py via subprocess, or TS port) idempotently and injects a notice. `/recursive bootstrap` command as fallback. **Same auto-bootstrap guarantee, now native.** |
| **Run init** | `recursive-init.py` | Tool `recursive_init` + command `/recursive init <run-id> --template feature`. |
| **Status / lock chain** | `recursive-status.py`, `verify-locks.py` | Service method + tool `recursive_status <run-id>` returning JSON (phase, lock-validity per artifact, earliest failing check). **Enhancement:** `fs/observed` listener re-verifies hashes after any write and warns on tamper. |
| **Locking** | `recursive-lock.py` | Tool `recursive_lock` that refuses unless gates pass and prior phases are lock-valid (monotonic gating enforced in the tool layer, mirroring the script). Canonical SHA-256 logic lives in `lock.ts`; keep py for cross-harness parity. |
| **Audit loop gates** | prose rules + lint | Lint logic exposed as `recursive_lint` tool; `Audit/Coverage/Approval` PASS parsing is machine-checked before any lock tool succeeds. **Enhancement:** emit `recursive/gate-failed` event on FAIL so UI/other plugins react. |
| **Effective inputs / addenda** | agent re-reads files | Service enumerates `base + addenda/* + upstream-gap` in lexical order; `recursive_effective_inputs` tool returns the exact list; review bundles auto-include them (already the intent in RECURSIVE.md §Addenda). |
| **Worktree isolation (Phase 0W)** | `recursive-worktree` skill + git via shell | Tool `recursive_worktree` implements the full skill: branch `recursive/<run-id>`, `.worktrees/` default location (repo-doc preference → ask → global fallback), git-ignore verification, setup command per stack, clean-baseline test, router-state sync (`recursive-router.json` + `-discovered.json` copied/probed into the worktree), and the normalized diff-basis fields in `00-worktree.md`. **Enhancement:** register the worktree with `ctx.workspaceRegistry`; `/recursive worktree open <run-id>` creates a session with `cwd` = worktree. |
| **Pre-run spec authoring** | `recursive-spec` skill (prose) | `/recursive spec` + `recursive_spec` tool: repo-aware guided interview (reads STATE/DECISIONS/MEMORY + relevant code), temp-scratch draft (NOT the repo), approval gate, then hand off to `recursive_init`. Enforces the skill's "no run folder from an unapproved draft" rule in the tool layer. |
| **Delegated audit/review** | agent hand-assembles bundles, uses `subagent` tool or router CLIs | Plugin calls `ctx.subagents` programmatically with the full bundle (phase, upstream artifacts, diff basis, addenda, questions, required output shape, structured-output schema). `Subagent Capability Probe` uses the provider registry; `recursive_subagent_action` records to `subagents/`. **Enhancement:** the review-bundle is built by the plugin, not by the model. |
| **Router (policy)** | `recursive-router.json` (config) + `recursive-router-*.py` (CLI wrappers) | `router.ts` resolves the **policy JSON only** → maps roles to DSH subagent providers (spawn/fork/codex/claude-code/acp); the router **CLI scripts are NOT vendored** — the provider registry replaces probe/invoke, external CLIs ride the existing `codex`/`claude-code` providers, and the `success:false → repair → rerun → verify` contract + `evidence/router/` records live in the plugin service. **Decision + rationale: §10.10.** |
| **TDD discipline (Phase 3)** | RED-GREEN-REFACTOR prose | **Enhancement:** `tools/pre-execute` policy — during the active implementation phase, block product-file writes when no RED/GREEN evidence exists for the claimed requirement; `recursive_lock` requires `TDD Mode` declared. (Same enforcement idea plan-mode uses for its own rules.) |
| **Tests + evidence (Phase 4)** | shell runs, docs guidance | Runs through existing `bash`/`pwsh` tools; plugin adds `recursive_evidence <run-id>` to copy Playwright `test-results/`, traces, screenshots into `evidence/` (the policy already says to). **Enhancement:** long suites run as `ctx.jobs` with the jobs UI list. |
| **Manual QA (Phase 5)** | human pause in chat | `ctx.userQuestions`/approval seam for human sign-off; `/recursive qa <run-id>` renders scenarios; agent-operated mode records execution metadata via a tool. `QA Execution Mode` is machine-checked at lock time. |
| **Single-command "Implement the run"** | agent-driven resume loop | **Enhancement:** wire the active phase to `ctx.goals` + `goal-round-driver` so continuation is durable, round-numbered, cap-limited, and auto-paused at human-QA — exactly the semantics goal rounds already provide. |
| **DECISIONS / STATE / memory closeout (6–8)** | py scripts + prose | Tools `recursive_closeout --phase 06|07|08` (reuse existing scaffolding scripts); Phase 8 training triggers stay py-invoked. **Enhancement:** `memory.ts` injects relevant `MEMORY.md`/STATE/DECISIONS shards at `agent/session-start`/`agent/pre-step` (digest-cached like tool-skill's catalog) so the "read before work" rule is enforced, not hoped for. |
| **Skills integration** | `npx skills add` | `skills.ts` registers the bundled recursive-* skills as a `SkillProvider`; users get them in the session catalog and via `/recursive-mode` user invocation; model loads bodies through the standard `skill` tool. **Enhancement:** `recursive-training-mcp` (and any external tool) can ride the native `mcp-client` plugin instead of py/ps1 wrappers (§3.3). |
| **UI** | files only | **Enhancement (biggest win):** client module with a kanban run board + drill-down inspector (sidebar + details seats), conversation nodes, status strip — one column per workflow phase (`0` → `1/1.5` Analysis → `2` → `3/3.5` Impl+Review → `4` → `5` → `6–8` Closeout), one card per run with an in-phase status strip (draft/audit/repair/…/locked/blocked), click-through to phases/decisions/reasoning/subagents/evidence/scratch, live via a `recursive` session projection. **Decision + rationale: §11.** |
| **Events** | none | **Enhancement:** `recursive/run-created`, `recursive/phase-locked`, `recursive/gate-failed`, `recursive/lock-tampered`, `recursive/run-merged` (worktree branch → repo root) emits for cross-plugin and UI reactions. **Every run event carries `worktreeRoot`** so the UI/gates resolve file state against the run's worktree (§4.7 pt 0). |
| **Human commands** | prose prompts + scripts | `ctx.commands` slash commands: preset-scoped `/recursive status|spec|worktree|init|lock|qa|closeout|addendum|review` + global `/recursive bootstrap|list|help`, with a client popup for structured input. Zero-token, direct UI outcomes. **Decision + rationale: §6.** |
| **Code Mode** | n/a | `recursive` preset composes `tool-presentation mode: both` — native tools AND the Code Mode SDK (`run_code` programs) for round-trip reduction + concurrency. **Decision + rationale: §7.** |
| **Workflow enforcement** | instructions in `RECURSIVE.md` + bridge block; `recursive-lock.py` gates only | Layered gates: `agent/pre-step` phase-transition gate, `tools/pre-execute` allow/deny/ask guards, `recursive:policy` prompt section, `recursive/phase` log-folded state. **Decision + rationale: §8.** |
| **REPL / scratchpad** | none (prose prompts only) | Run-scoped scratch file (`/recursive scratch <run-id>`, `recursive_scratch` tool), git-ignored, disposable; state bridge for code mode; trajectory/log already cover the transcript role. **Decision + rationale: §9.** |
| **Subagents** | external-CLI routing (`recursive-router.json`) | First-class `ctx.subagents` delegation (native provider → external-CLI → self-audit fallback); context-in prompt + run-doc refs, context-out `report` + structured output + artifact refs; child-scoped scratch; action records + capability probe. **Decision + rationale: §10.** |
| **Presets** | n/a | Ship a `recursive` agent preset (`preset.yml` + `agent.cordis.yml`) that mounts the plugin's tools/skills/commands/prompt section per agent, so users pick "recursive mode" when creating a session. **Decision + rationale: §5.** |

### 4.4 Reference implementations to copy from in-tree (DSH checkout)

| Pattern | Reference |
|---|---|
| Durable continuation driver | `packages/goal/goal-round-driver/src/index.ts` + `packages/goal/goal/src/index.ts` |
| Skills provider + catalog + injection | `packages/skill/skill-filesystem/src/index.ts` + `packages/skill/tool-skill/src/index.ts` |
| Mode guard + prompt section + command | `packages/plan/plan-mode/src/index.ts` + `packages/bundle/base/cordis.patch.yml` rows 265–279 |
| Structured delegation | `packages/workflow/tool-ralph/src/index.ts` (structured-output fresh-child loop) |
| Model-facing tool + lifecycle recording | `packages/workflow/tool-workflow/src/index.ts` |
| Per-agent composition | `apps/cli/config/agent-presets/standard/agent.cordis.yml` |
| Dynamic plugin authoring workflow | `apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md` |
| Bundle/profile/publish mechanics | `docs/user/develop/basic/publish.md`, `apps/cli/reference/README.md` |
| Web client node registration | `docs/subsystems/client-modules.md`, `docs/cookbook/adding-a-conversation-node.md` |

### 4.5 Phased build plan

**Phase A — Parity shell (bundle + tools + commands).**
Package the bundle; mount `ctx.recursive` service (per-session, isolated); port lock-hash + lock-chain + status + effective-inputs to TS; register `recursive_init/status/lock/lint/closeout` tools; register the `/recursive` slash commands (preset-scoped + global sets, §6.3) incl. `/recursive scratch <run-id>` (§9.4) and the client popup; ship the vendored py/pwsh scripts; ship the `recursive` agent preset directory + install path (see §5.9); verify with a throwaway repo using the existing smoke harness (`scripts/test-recursive-mode-smoke.ts`).

**Phase B — Delegation native (see §10 for the full model).**
`review.ts` bundle builder → handoff docs (`handoff.md` + per-child `brief.md`/`reply.md`, §10.6) → context-in `prompt` referencing them (run-doc + code refs with line numbers); `ctx.subagents.start` with `outputSchema`/`toolFilter`/`maxDepth` + control/report rows; `router.ts` resolves `recursive-router.json` policy → native provider (no vendored router CLIs, §10.10); child-scoped scratch (§10.7); report + reference validation (§10.5) + action records; capability probe + `Delegation Decision Basis` fields still written to artifacts; self-audit fallback preserved.

**Phase C — Enforcement + goals (see §8 for the full model).**
`lifecycle.ts` run state machine (§8.8): the transition set + serialized per-run driver + `recursive/*` events, built on the §4.7 read path and `lock.ts`. Then Layer 1 `agent/pre-step` phase-transition gate (phase doc, linter evidence, TDD evidence, audit-closed, monotonic gating, QA sign-off) and Layer 2 `tools/pre-execute` guards (locked-artifact write denial, plan-phase read-only, TDD evidence gating, effective-inputs check) — both as *callers* of the lifecycle transition set, not duplicate predicates; Layer 3 `recursive:policy` prompt section; Layer 4 `recursive/phase` log-folded state + projection; goal-round driver for "Implement the run" with pause-on-block (coupled through the lifecycle manager); QA sign-off via user-questions/approval; session-start memory/skill injection; `fs/observed` lock-tamper warnings.

**Phase D — Client UI + events (see §11 for the full model).**
`recursive` client module (sidebar entry + details seat → kanban run board + drill-down inspector, §11.4–11.5), conversation node + status strip (§11.6), visualization catalog (§11.7); `recursive` session projection folding `recursive/*` events (§11.4); `recursive/*` events; verify the `recursive` agent preset in the Web picker + per-session selection lock AND preset-scoped command visibility (`/recursive` present in a recursive session's '/' menu, absent in a standard session's; e2e pattern from `apps/web/tests/agent-preset-selection.e2e.ts` + `packages/client/ui-commands/tests/`); e2e tests in the `apps/web/tests` + `examples/*` pattern.

### 4.6 Practical notes for this environment

- **Dev loop:** the GUI at http://127.0.0.1:3080 runs from this D:\deepseek-harness checkout. Host-side plugin changes need `pnpm run build` + restart; **client-side** changes need the `pnpm run dev:web` watcher running and a rebuild to appear in the GUI (the runtime note says that watcher isn't currently confirmed running). Iterate with `dsh web --patch ./cordis.patch.yml` from the repo root once built.
- **The sandbox here previously blocked esbuild spawns** (`EPERM` on `pnpm dsh` under read-only confinement); the session policy is now `danger-full-access`, so builds should run directly. Keep build temp pointed at D: (234 GB free) — C: is ~1.2 GB.
- **Pin versions:** DSH is developer-preview (`rc.5`) with breaking changes promised; declare `peerDependencies` on the `@deepseek-ai/*` packages you import and note the bundle's tested DSH version.
- **Publishing:** either ship built artifacts to npm (no install-time build permission needed) or ship a git repo with a self-contained `prepare` script + `allowBuilds` guidance (see `docs/user/develop/basic/publish.md` §"Installing from GitHub: the build-script catch").

---


### 4.7 Reading runs and the memory index (the plugin's read path, verified)

**Source of truth is the repo's `/.recursive/` tree — the plugin is a *parser + indexer* over files, not a second store.** Everything a tool, gate, command, or the UI needs is a deterministic function of those files. (Verified against `skills/recursive-mode/scripts/recursive-status.py` and `references/artifact-template.md`.)

**0. The control-plane root is worktree-resolved, never assumed to be the session cwd's repo root.** Recursive runs *execute inside a git worktree*, not the run folder: the worktree carries its **own** `/.recursive/` tree (verified — a real worktree here has `/.recursive/{run,memory,STATE.md,DECISIONS.md,RECURSIVE.md}` on branch `recursive/<run-id>`, while the run dir itself is **untracked** and exists only in that worktree; the main checkout's `/.recursive/run/` does not contain it). So every `/.recursive/…` path the plugin reads must resolve against the **worktree root** (the active run's `cwd` from `00-worktree.md`), not a naive repo-root guess. Resolution order: (1) if the session cwd is inside a worktree (a `.git` *file* pointing at the main repo, branch `recursive/<run-id>`), use that cwd as the control-plane root; (2) else the `00-worktree.md` `Worktree path`/branch fields; (3) else the repo root. The `recursive_worktree open`/`/recursive worktree` path (§4.3) sets the session `cwd` to that worktree so the fs sandbox and all reads agree.

**1. Discovering runs.** `run.ts` enumerates `/.recursive/run/<run-id>/` under the **resolved control-plane root** (lexical order; "latest run" = max `run_id`, matching `get_latest_run_directory` in `recursive-status.py`). A run is a folder; its identity is the folder name. No registry file is needed — presence of the folder *is* the run. Because a worktree's run dir is untracked and merge-driven, the *worktree* root is where live run state lives; the main repo root only sees a run folder after the worktree branch is merged and the run dir is carried across (or, for control-plane-doc merges, the phase receipts under `/.recursive/`). The enumeration is a **passive file scan**; the *ownership* of transitions and events lives in `lifecycle.ts` (§8.8), which calls this scan as its reconciliation input — `run.ts` reads, `lifecycle.ts` drives.

**2. Reading one run's state.** For a given `<run-id>`, `run.ts` walks the canonical `RUN_ARTIFACT_SEQUENCE` (12 files: `00-requirements.md`, `00-worktree.md`, `01-as-is.md`, `01.5-root-cause.md` (optional), `02-to-be-plan.md`, `03-implementation-summary.md`, `03.5-code-review.md` (optional, **mandatory in this plugin**), `04-test-summary.md`, `05-manual-qa.md`, `06-decisions-update.md`, `07-state-update.md`, `08-memory-impact.md`). For each present file it parses the **required header** — `Run`, `Phase`, `Status`, `Inputs`, `Outputs`, `Scope note`, and (when locked) `LockedAt` + `LockHash` — using the same field extractor the status script uses (`get_md_field_value`: a line `Field: value` or `- Field: value`).

**3. Lock-validity + tamper detection (the critical part).** `lock.ts` recomputes `LockHash` exactly as `recursive-lock.py` does: normalize to LF, strip the `LockHash:` line (regex `(?m)^LockHash:.*$`), then SHA-256 the remainder; compare to the stored hash. **Lock-valid ⇒ hash matches AND every earlier present phase is also lock-valid (monotonic chain).** A `Status: LOCKED` artifact whose hash mismatches is `TAMPERED`; the plugin emits `recursive/lock-tampered` and the board marks the card. This is the same computation the Python runtime performs — the plugin *re-derives* it in TS so the gate/UI never trust an unchecked `Status` field.

**4. The current/next phase.** Fold `{ file exists, status, lock-valid }` over the sequence in order: the first present-but-not-lock-valid (or missing non-optional) artifact is the current phase; if all present are lock-valid, the run is `COMPLETE` (or the next phase is the first absent non-optional one). This is exactly `recursive-status.py`'s `states`/`current_phase` loop. The plugin mirrors this fold so `/recursive status`, the pre-step gate (§8), and the board (§11.4) all agree with the py runtime. **This fold is the *derived state*, not the authority** — the authority for *changing* phase is the transition set in `lifecycle.ts` (§8.8), which validates first and only then drives the file write that the fold later reflects.

**5. Deeper artifacts the gate needs.** Beyond the header, `run.ts`/`lint.ts` reuse the status script's parsers for the machine-checked fields: `## Requirements` (R#/OOS# ids), `## Requirement Completion Status` (per-R# `Status`, `Changed Files`, `Implementation Evidence`, `Verification Evidence`), `TDD Mode`, `QA Execution Mode`, `Audit: PASS`, `Coverage: PASS`/`Approval: PASS`, the `## TODO` checkbox block, addenda under `addenda/<base>.addendum-*.md` (effective inputs = base + addenda in lexical order), `evidence/`, `subagents/`, and `00-worktree.md`'s diff-basis fields (`Baseline type`, `Baseline reference`, `Comparison reference`, `Normalized baseline`, `Normalized comparison`, `Normalized diff command`). These are read on demand, never cached across writes.

**6. Reading the memory index (`memory.ts`).** `/.recursive/memory/MEMORY.md` is the router: `memory.ts` reads it (UTF-8) and parses the **marker-fenced block** between `<!-- RECURSIVE-MODE-MEMORY:START -->` and `:END -->` — `## Registry` (shard kind → dir: `domains/`, `patterns/`, `incidents/`, `episodes/`, `training/`, `skills/`, `archive/`), `## Retrieval Rules`, and `## Freshness Rules` (freshness statuses). Shard selection is **two-stage**: (a) the optional `<!-- RECURSIVE-TRAINING-REGISTRY:... -->` refresh block (written only by a successful `grpo.py` run) lists CURRENT/SUSPECT shards; otherwise (b) `memory.ts` reads shard headers' `Status` + `Owns-Paths`/`Watch-Paths` metadata and matches them against the current task's touched paths (from the worktree diff basis). The selected shards are handed to `recursive-training-loader.py` (§12) for ranked retrieval — `memory.ts` *selects candidates*, the loader *ranks and returns items*; the Python stays the retrieval source of truth.

**7. Where reads are wired — and initialization is worktree-aware too.** `agent/session-start` (scaffold check + first loader injection), `agent/pre-step` (§8 gate, re-reads the current phase doc on each turn boundary), `tools/pre-execute` (§8 guards, check the active phase + lock-validity before fs writes), the `lifecycle.ts` transition driver (§8.8, re-reads the fold before every transition), and `recursive/*` log events (the folded state the UI projects). Every read is a fresh file read or a digest-cached read keyed on file mtime — never a long-lived in-memory mirror, so worktree/other-session writes are observed.

**8. Initialization (`recursive_init`/`bootstrap.ts`) must be worktree-aware.** `recursive-init.py` (verified) already detects the git context from the **caller's repo root** (`detect_git_context`: `rev-parse HEAD`, `symbolic-ref HEAD`, diff command prefill) — so it writes the run into *wherever it is invoked*, i.e. the worktree when invoked from the worktree. The plugin must not short-circuit that: `recursive_init` resolves the control-plane root via point 0, and the `recursive_worktree`/`/recursive worktree` step (§4.3) runs first so init lands in the worktree, not the main checkout. Bootstrap (`install-recursive-mode`) is the one exception: it seeds the *shared* `/.recursive/` scaffold (`RECURSIVE.md`, `config/`, `memory/`, `AGENTS.md` bridges) in the repo root, and the worktree inherits that scaffold via branch creation; per-run state then accumulates only in the worktree.
### 4.8 Repo documentation — DSH's agent-instructions vs recursive-mode's control plane (decision record)

> **Decision:** we implement STATE.md, DECISIONS.md, and MEMORY.md — DSH does not offer a replacement for them — but we split them by concern and reuse DSH's native read mechanism where it exists. AGENTS.md (the bridge) is already read natively by DSH; STATE/DECISIONS/MEMORY are injected by the plugin because DSH's native loader is read-only and knows nothing of the run-scoped selection recursive-mode needs.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.

**What DSH actually offers (verified against the agent-instructions package):**

- **agent-instructions is DSH's only native repo-documentation mechanism.** It discovers AGENTS.md and CLAUDE.md (default instructionFileCandidates) at the project root (.git marker), plus AGENTS.local.md/CLAUDE.local.md overlays, loads them as a baseline context message before the first request, and reconciles deltas on fs tool touches (read/write/edit). It is read-only: it injects guidance; it has no write path, no memory, and no run-scoped selection.
- **There is no native memory service.** ctx.memory / MemoryService do not exist in the shipped packages — every memory hit in the tree is a test helper or an in-memory settings stub. DSH has no durable learned-memory store.
- **The .agents/notes/ directory is DSH's internal convention, not a feature.** It is how DSH's own maintainers file architecture notes, referenced in code comments — not a user-facing repo-memory API. We do not adopt it; recursive-mode's control-plane docs already serve that role.

**The split:**

- **AGENTS.md (bridge block): keep, DSH already consumes it natively.** bootstrap.ts writes the bridge; the read path needs no plugin code.
- **STATE.md and DECISIONS.md: keep as control-plane docs, plugin-injected.** Phase 6/7 closeout tools write them (the write path DSH lacks); the recursive:policy prompt section and the spec/interview tools read them on demand.
- **MEMORY.md plus shards: fully implement — and the files stay harness-agnostic.** Phase 8 plus the recursive-training pipeline write them as plain repo markdown; memory.ts selects relevant shards and injects them. DSH has no memory service, so the file-based training pipeline stays the authority. **The harness-agnostic invariant (below) is non-negotiable:** the memory plane must remain readable and editable by any user in any harness or editor — DSH is only the most convenient reader.

**The harness-agnostic invariant (non-negotiable).** Memory is *repo-owned, not harness-owned*: `/.recursive/memory/` is plain markdown, read and written by the Python pipeline (which any harness invokes), and editable in any editor by any user. Nothing the DSH plugin adds may make the memory *depend* on DSH — no DSH-only schema, no DSH-managed cache that becomes the authority, no marker blocks that only the plugin understands. DSH's added value is strictly *tighter hooks around the same files*: faster shard selection at the right moment (`memory.ts`), a memory chip in the board (§11.7), and a `/recursive memory` command that reads the identical files any other tool reads.

**Why not add STATE/DECISIONS/MEMORY to DSH's instructionFileCandidates config:**

- **Double injection and byte-budget competition.** DSH's loader already consumes the bridge under its maxBytes budget; adding the full control-plane docs would crowd it out or duplicate what recursive:policy and recursive:memory already inject with run-scoped precision.
- **No run-scoped selection.** DSH's loader loads whole files at the project root, always; recursive-mode needs to inject the relevant memory shards for the active run/task, which is a selection DSH's loader cannot express.
- **No write path.** Even if DSH read them, it could never write them — and STATE/DECISIONS/MEMORY are exactly the docs whose point is that the workflow produces them at closeout. Reusing a read-only loader for a doc we must author gains nothing.

**So: wrap, don't duplicate.** The AGENTS.md bridge rides DSH's native loader for free (the one doc that is always-on and never run-scoped); the control-plane docs and memory stay on the plugin's prompt-section injection, which is the only surface that can both write them (via closeout tools) and select them (via memory.ts). This is the same principle as section 4.1: DSH owns delivery where delivery is uniform; the plugin owns the parts that are workflow-specific.
## 5. Mode strategy: a dedicated "recursive mode" agent preset (decision record)

> **Decision:** recursive-mode ships as its **own selectable agent preset** (`recursive`), chosen at session creation exactly like the existing `standard` / `code` / `minimal` / `cordis` (creator) presets — not as a fork of an existing preset, and not as a transient operating mode like plan mode.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.
> **Consequences:** new-session preset picker entry; `agent-preset-locked` identity per session; preset directory shipped/installed under `$DSH_HOME/.agent-presets/recursive/`; plan mode remains available *inside* recursive sessions; bundle remains installable in any profile.

### 5.1 Background — how DSH actually models "modes"

DSH uses "mode" for two distinct concepts, and the question "should recursive-mode be a mode?" conflates them:

1. **Agent presets** — what "creator / standard / code mode" actually are. A preset is a directory holding an `agent.cordis.yml` composition (plus optional `preset.yml` metadata), discovered by the `dsh-agent-presets` service (`packages/preset/agent-presets/src/discovery.ts`, `preset.ts`). The shipped roster lives at `apps/cli/config/agent-presets/` with four entries: `standard` (标准模式, order 1), `code` (PTC 模式, order 2), `minimal` (极简模式, order 3), `cordis` (创造模式, order 4). A preset is **per-session**: the new-session chip stages the choice beside the workspace picker; after session start the session header names the preset and the host answers `agent-preset-locked` to any change (`apps/web/tests/agent-preset-selection.e2e.ts`). Discovery re-reads its roots on every call, so a preset authored while the process runs is visible without a restart; a directory whose composition is missing or unloadable is reported as a broken roster row rather than skipped (`discovery.ts` lines 4–14).
2. **Operating modes** — an in-session policy that switches how the *same* agent behaves. The canonical example is plan mode (`packages/plan/plan-mode`): a prompt-section policy plus a mode guard, mounted as a *preset row* inside `standard/agent.cordis.yml` (and in the base bundle's `plan-mode` row, `packages/bundle/base/cordis.patch.yml` lines 265–279). Plan mode is not a preset itself.

**"Creator mode" is the `cordis` preset.** Its `preset.yml` description reads "用于创建自定义 Agent preset" (create custom agent presets); it mounts the dynamic-plugin tooling (`cordis_define` / `cordis_run`, via `cordis-host-runner` + `tool-cordis`) and the `cordis-plugin-development` skill. Its existence is the ecosystem's endorsement that **new modes are authored as presets** — creator mode is the tool for building exactly what this proposal ships.

### 5.2 Background — how recursive-mode currently relates to harness "modes"

recursive-mode today is harness-agnostic: it installs as a *skill* (`npx skills add try-works/recursive-mode`), bootstraps `/.recursive/` scaffold + `AGENTS.md` / `.codex/AGENTS.md` / `.agent/PLANS.md` bridge docs into any repo, and drives execution through prose prompts ("Implement requirement '<run-id>'"). There is no mode concept — any agent in any harness that reads the bridge docs can run it. The DSH plugin's job is to make that workflow **native** without breaking its portability.

### 5.3 Alternatives considered

| Option | Description | Verdict |
|---|---|---|
| **A. Dedicated `recursive` agent preset** | New preset chosen at session creation; mounts plugin tools/skills/commands/prompt section; `agent-preset-locked` identity | **Adopted** (see §5.4) |
| **B. Run inside `standard` / `code`** | Add recursive-mode rows to the general-purpose presets | Rejected — contamination + identity (see §5.5) |
| **C. Separate operating mode à la plan mode** | A togglable in-session policy (prompt section + mode guard) | Rejected — wrong scope/lifetime (see §5.6) |
| **D. Bundle-only (no preset)** | Plugin installable in any profile; users enable tools per-profile via patch; no preset picker entry | Rejected as the *only* surface — no per-session choice, no first-class UX; retained as a fallback/companion (§5.7) |
| **E. Multiple presets (one per template: feature/debug/review)** | Fork the preset by run template | Rejected — templates are run-level choices, not session-level; one preset + run templates covers them (§5.5) |

### 5.4 Decision — a dedicated `recursive` agent preset

**Ship a dedicated `recursive` agent preset** that users select exactly like standard/code/creator — from the new-session chip in the Web UI, or `preset.yml` `order` placement in the roster.

- **Id + metadata:** id `recursive`; display name e.g. "Recursive 模式" / "Recursive Mode"; description naming the stage-gated repo workflow (AS-IS → plan → TDD implementation → review → tests → QA → closeout); sensible `order` (e.g. 5, after `cordis`).
- **Composition (`recursive/agent.cordis.yml`):** mounts the `dsh-recursive-mode` surface — `recursive_*` tools, the skills provider (bundled recursive-* SKILL.md bodies), `/recursive` slash commands, the "recursive-mode active" system-prompt section, and the goal/QA wiring — plus the baseline rows the mode needs (fs, bash/pwsh, skills, subagent, workflow), following the `standard` preset's host-plane discipline (`apps/cli/config/agent-presets/standard/agent.cordis.yml`; `packages/preset/agent-presets/src/mount.ts` for the mount + proof-before-publish contract).
- **Ships as:** a directory in the installed package that the user (or an install script) copies into `$DSH_HOME/.agent-presets/recursive/`, or shipped with the deployment's shipped root for bundled users. Discovery re-reads roots live, so no restart is needed; a broken composition reports as a broken roster row rather than disappearing (`discovery.ts`).

### 5.5 Rationale — why not "run recursive-mode inside standard/code" (Option B)

- **Composability (scope leakage):** `standard`/`code` are general-purpose presets used for many unrelated tasks. recursive-mode adds workflow-specific tools, a policy prompt section, and phase guards that should not leak into every session created in that preset. A preset is per-session scope, so this is a *composability* argument, not a security one — but it is decisive: a user starting a plain coding session should not suddenly see `recursive_lock` / phase-guard denials.
- **Workflow identity:** recursive-mode IS a distinct mode of working — stage-gated, doc-driven, lock-validated, with its own vocabulary (runs, phases, addenda, gates, audit modes). It deserves its own picker entry and its own `agent-preset-locked` identity, not a hidden add-on to `standard`. Session composition is fixed at start; a dedicated preset makes the choice explicit and auditable in the session header.
- **No preset explosion:** debug vs. feature runs, `recursive-mode-audit-v2` vs v1, sub-phase vs single-pass are *run-level* choices expressed in run templates and `00-requirements.md` — not session-level forks. One preset + run templates covers them; forking presets per template would multiply maintenance without adding user value.

### 5.6 Rationale — why not a separate "operating mode" like plan mode (Option C)

- **Scope and lifetime mismatch:** plan mode is a *transient policy* a user toggles mid-session and that can be exited with `exit_plan_mode`. recursive-mode is a *whole workflow* that spans sessions and persists in repo documents; its enforcement surface is broader than a prompt-section policy — it includes tools, commands, skills, phase guards, goal wiring, and a client dashboard.
- **Plan mode is a *row inside* presets, not an alternative to them:** the correct composition is a preset that *includes* plan mode for its planning phases, not a mode that pretends to be a preset.
- **The harness's own vocabulary confirms it:** the shipped modes (standard/code/minimal/creator) are all presets; nothing in DSH models a whole workflow as an operating mode.

### 5.7 Rationale — bundle-only is not enough (Option D)

The bundle layer (installable in any profile via `cordis.patch.yml`) remains the correct **companion** mechanism — users who prefer standard/code sessions against a recursive-mode repo still get the tools without the preset. But bundle-only has no per-session choice surface, no preset picker entry, and no `agent-preset-locked` identity; it cannot be the *only* surface if recursive-mode is to be "a mode visible in the harness and selectable the same way."

### 5.8 Interaction with plan mode and other presets

- Inside a `recursive` session, the **plan-mode row remains available** (Phase 2 planning benefits from it); the plugin's own prompt section then declares the recursive-mode contract on top.
- Users can still use **standard/code** sessions against a recursive-mode repo — recursive-mode's repo docs (AGENTS.md bridge, `/.recursive/`) already make the workflow harness-agnostic. The `recursive` preset is the *optimized* surface, not a requirement.
- The plugin remains **installable in any profile** (bundle layer) for users who prefer standard/code + recursive tools; the preset is the *first-class* experience.

### 5.9 Consequences and follow-ups

- **Phased build plan impact:** Phase A additionally ships the `recursive` preset directory + install path (`$DSH_HOME/.agent-presets/recursive/`) **and the §5.10 two-stage init (mount-time capability registration + session-start workflow init)**. Phase D verifies the Web picker shows the preset, selection locks per session, the roster shows a healthy row, and both init stages fire (mount for stage A, first turn for stage B); e2e pattern from `apps/web/tests/agent-preset-selection.e2e.ts`.
- **Open decision (tracked in §13) — now effectively resolved:** the preset authoring API (`packages/preset/agent-presets/src/authoring.ts` lines 1–11) is a **whole-directory copy** of an existing preset — "No caller supplies composition text." It cannot author a new preset from a YAML/JSON blob. So the preset **must ship as a static directory** in the package; creator mode can only *copy* that shipped directory, not synthesize one.
- **Per-session service isolation (new, from the Cordis article):** any service the `recursive` preset provides that is *per-session* (not process-shared) must be declared inside a `cordis:group` with `isolate: { <serviceName>: true }`, exactly like the `minimal` preset's per-session `terminals` (`apps/cli/config/agent-presets/minimal/agent.cordis.yml:18-25`). Verified semantics (`vendor/loader/src/config/isolate.ts`): `isolate: { x: true }` = entry-local realm (`LocalRealm`, symbol suffix `#<id>`); a string = shared named realm (`GlobalRealm`, suffix `@<label>`). Without it, two `recursive` sessions in the same process would collide on the exclusive `provide` of `ctx.recursive` (`vendor/cordis/src/reflect.ts:290` throws "service has been registered"). Our `recursive` service is per-session (holds the run's in-flight state), so it MUST be isolated; process-shared reads (memory plane, `MEMORY.md` index) stay on the process-level service.
- **References for implementation:** `packages/preset/agent-presets/src/{discovery,preset,mount,session,authoring}.ts`; `apps/cli/config/agent-presets/{standard,cordis}/agent.cordis.yml` + `preset.yml`; `apps/web/tests/agent-preset-selection.e2e.ts`; `packages/bundle/web-app/cordis.patch.yml` lines 410–424 (roster config).

### 5.10 Initialization phase — preset-mount AND workspace-open (verified)

**The question "initialize when the user chooses the mode, or when they open a workspace?" has a single verified answer: both, because they are the *same* seam split into two stages.** In DSH (verified against `packages/client/runtime/src/client/workspaces/service.ts`, `packages/preset/agent-presets/src/{index,mount}.ts`, and the `agent/session-start` consumers in `packages/goal`, `packages/goal/goal-round-driver`, `packages/agent/agent-instructions`):

1. **"Open a workspace" = open or create a *session*.** `connectWorkspace(workspaceId)` reuses the workspace's existing *blank* session (same canonical cwd + workspace membership) or calls `sessions.create({ workspaceId })` to birth a fresh one. There is no separate "workspace opened" lifecycle event distinct from a session — the workspace entity is the registry row; the session is the live surface.
2. **"Choose the mode" = mount a preset *into* that session.** The session's agent is composed from a preset via `mountPreset(agentCtx, preset)` (`mount.ts:332`), which plugs the preset's `agent.cordis.yml` subtree under the agent's **scope context**. Two hard guarantees we must honor: the mount **rejects any row that leaked a process-global (root-realm) service** (`leakedServices`, `mount.ts:189/361`) and rejects any row that never activated (`inactiveRows`). That is why §5.9 requires our per-session `ctx.recursive` service to sit behind an `isolate` realm — it is a mount-time invariant, not a runtime nicety.
3. **The lifecycle events that matter:** `session/created` (a session is birthed, host-side), `agent/created` (the agent is published — `agent-presets` warns here if an agent joined no preset), and **`agent/session-start`** (fired at every session-start edge, including resume — `goal`, `goal-round-driver`, and `agent-instructions` all hook it). These are the two stages our initialization splits across.

**Design — two idempotent stages, one per seam:**

| Stage | Trigger | What it does | Idempotency / guards |
|---|---|---|---|
| **A. Capability init** | preset **mount** (`mountPreset` → our rows' `apply()`) | Register `ctx.recursive` (isolated service), `recursive_*` tools, `/recursive` commands, `recursive:policy` prompt section, skill provider, client module. No repo/run work here — just make recursive-mode *available*. | Mount-time only; the mount guard enforces no root leak + all rows activate. |
| **B. Workflow init** | **`agent/session-start`** (first turn of a new *or resumed* recursive session) | Resolve control-plane root (worktree-aware, §4.7 pt 0); check `/.recursive/` scaffold — auto-bootstrap if missing (idempotent install, not a re-init); read `MEMORY.md` + run the loader (§12); enumerate runs as **directory names only** (§8.9) — never a full read of every run's docs; inject the "recursive-mode active in repo X, current run Y" notice; arm the phase gate. | Skip bootstrap when scaffold present; never re-init a live run; on a non-repo, defer (register the command + a one-line notice) rather than fail. **Init is bounded O(#run-dir-names + the one active run), not O(#runs × #docs)** — safe at 100+ runs (§8.9). |

**Why not initialize *only* at preset selection:** a preset mount knows *what* the mode is but not *where* it runs — there is no cwd/repo at mount time (and one preset backs every session that names it).
**Why not initialize *only* at workspace open:** opening a workspace in `standard`/`code` must not bootstrap `/.recursive/` — the scaffold and the loader injection should happen only when the recursive preset is actually the session's composition (§5.7's "no contamination" rule). Stage B runs *because* the session is a `recursive` session; stage A made that true.

**Resume vs new.** `agent/session-start` carries `{ source: 'resume' }` for resumed sessions. Stage B keys on that: **new** session → full init (bootstrap-if-missing + loader + manifest-derived run discovery); **resume** → re-resolve the control-plane root, re-read only the **active** run's current phase doc (worktree may have moved or a merge landed), then re-inject the loader for the *resumed* task — but never re-bootstrap, never re-create a run, and never re-read every historical run's docs. This is exactly the `goal-round-driver` pattern (reset process-local scheduling state at the session-start edge, `goal-round-driver/src/index.ts:253`).

**Both stages are recoverable.** Stage A failure = the preset row fails to mount and the preset roster shows the broken row (the harness already reports it). Stage B failure = a `recursive/init-failed` event + a notice steering the next turn ("bootstrap failed because X"), never a hard session block — the user can still run `/recursive bootstrap` manually (§6).
## 6. Command surface: recursive-mode in the DSH slash-menu (decision record)

> **Decision:** the `recursive` preset registers a set of `/recursive` slash commands **scoped to its sessions** (visible only when running the preset), alongside a small set of **global** recursive-mode commands available in any session. Both sets plug into DSH's native command registry (`ctx.commands`), exactly like `/plan` and `/goal`.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.
> **Consequences:** preset-scoped commands appear in the '/' menu only for sessions running the `recursive` preset; global commands appear for all sessions; the plugin also registers a `/recursive` client-side popup (popupSelect) for structured sub-commands; no model tokens are spent on command discovery or execution; model-facing `recursive_*` tools remain the agent-facing surface alongside the user-facing commands (§6.6).

### 6.1 Background — how recursive-mode is invoked today (no native command surface)

recursive-mode's current invocation model is **prose prompts and the agent's own tool use** — there is no human-command surface at all:

- **Single-command orchestration** (§"recursive-mode single-command orchestration" in `.recursive/RECURSIVE.md`): the user types "Implement requirement '<run-id>'" and the agent resolves the run, reads repo docs, and drives the phases. The "command" is a *prompt* — it consumes a model turn, tokens, and context, and its interpretation depends on the agent having read the right docs.
- **Skill trigger examples** (`skills/recursive-mode/SKILL.md` §Trigger Examples): "Implement requirement '<run-id>'", "Run Recursive Phase 2 for .recursive/run/<run-id>/", "Resume requirement '<run-id>' after manual QA", "Verify locks for .recursive/run/<run-id>/". Every one of these is a **free-text prompt**, not a structured command.
- **Bridge docs** (`skills/recursive-mode/references/agents-block.md` §"How users can invoke the skill") repeat the same pattern: short prompts such as "Implement the run", "Implement run 75", "Create a new run based on the plan", "Start a recursive run".

The mechanical verbs — status check, lock, init, verify locks, closeout, bootstrap — are all **scripts with CLI flags** (`recursive-status.py --run-id …`, `recursive-lock.py …`, `verify-locks.py --run-id …`). A user can only reach them by (a) asking the agent to run them (model turn) or (b) running them in a shell themselves. Neither is a first-class harness UX. This is gap #2/#3 from §2.5 (no native UI, no events) manifesting at the interaction layer.

### 6.2 Background — how DSH's command concept works

The human-command registry (`@deepseek-ai/dsh-commands`, `packages/interaction/commands`) lets a plugin register a **slash command** — name, description, optional input hint, and a direct `handler` that executes against the receiving agent **without sending a model message** (`docs/subsystems/commands.md`):

- `ctx.commands.register({ name, description, input?, recordInput?, handler })` — the registration surface. Handlers return `CommandResult` (`{ kind: 'success', text?, sourceEventSeq? }` or `{ kind: 'error', text }`) rendered directly by the UI.
- **Scope is the key property:** *"Plain-context definitions are global; definitions registered through a command-injected child of an agent context shadow globals for that agent."* (`docs/subsystems/commands.md` §Cordis API `ctx.commands`). So a command registered inside a preset's agent-scoped context is visible **only to that preset's sessions**.
- The Web UI slash source (`packages/client/ui-commands/src/client/service.ts`) pulls the command directory **per session** (`ctx.remote.commands.list(sessionId)`), and explicitly handles preset switches: *"A preset switch changes which commands one session's agent resolves and registers nothing globally"* — it repulls the directory on `agent-preset/selected`. So the '/' menu is **already session/preset-aware**.
- Discovery + execution cost **no model tokens** (README: "Command discovery, execution, and UI output add no model tokens").

### 6.3 How existing commands do it

- **Global commands** (registered in the base bundle, `packages/bundle/base/cordis.patch.yml`): `/goal` (`command-goal`, `inject: ['commands','goals']`), `/feedback`, `/compact` (host). These appear in every session.
- **Preset-scoped commands**: `/compact` is re-registered *inside the `standard` preset* (`apps/cli/config/agent-presets/standard/agent.cordis.yml` lines 147–148) — proving commands mount inside presets. The web profile disables the host `command-compact` row so the preset's copy owns the name (`packages/bundle/web-app/cordis.patch.yml` lines 361–362).
- **Mode commands**: `/plan` (`@deepseek-ai/dsh-plan-mode`) registers through `ctx.inject(['commands'], (commandCtx) => { commandCtx.commands.register({ name: 'plan', ... }) })` (`packages/plan/plan-mode/src/index.ts` lines 268–303) — the canonical scoped-registration pattern. It has an input hint (`[off|message]`) and its handler reads `rawInput`, returns direct UI text, and can `agent.steer()` a user message for the optional free-form input.

### 6.4 Alternatives considered

| Option | Description | Verdict |
|---|---|---|
| **A. Preset-scoped `/recursive` commands + small global set** | Workflow verbs as slash commands; preset-scoped ones visible only in recursive sessions; a few global ones (bootstrap/list/help) anywhere; client popup for structure | **Adopted** (see §6.5) |
| **B. Model-facing `recursive_*` tools only (no slash commands)** | Agents drive the workflow via tools; users keep typing prose | Rejected as the *only* surface — no zero-token user path, no discoverability (see §6.6) |
| **C. Prompt/instruction-based commands only** | Continue today's "Implement the run" prompt model; document more trigger phrases | Rejected — leaves the §2.5 interaction gap; every command costs a model turn (see §6.6) |
| **D. All `/recursive` commands global** | No preset scoping; every session sees the full set | Rejected — clutter + conflicts with §5's composability decision (see §6.7) |
| **E. Many flat command names (`/recursive-status`, `/recursive-lock`, …)** | One command per verb, all top-level | Rejected — pollutes the slash namespace; no grouping (see §6.7) |
| **F. Client-only popup, no host commands** | A UI popup that submits prompts on the user's behalf | Rejected — the popup must dispatch to host commands; without them there is no direct execution (see §6.8) |

### 6.5 Decision — the `/recursive` command surface

**Ship a `recursive-commands` plugin (or register within the preset composition) that provides:**

1. **Preset-scoped commands** (visible only in `recursive` sessions, via `ctx.inject(['commands'], ...)` inside the preset's agent-scoped context):

   | Command | Input hint | What it does (direct handler, no model call) |
   |---|---|---|
   | `/recursive status [<run-id>]` | `[<run-id>]` | Run status + lock-chain summary (phase, lock-validity per artifact, earliest failing check) — direct UI text, no model tokens |
   | `/recursive spec` | `[<summary>]` | **Pre-run spec/requirements authoring** (`recursive-spec` skill): guided interview → temp-scratch draft → user approval → then `init`. Does NOT create the run or `00-requirements.md` until approved. |
   | `/recursive worktree <run-id>` | `<run-id>` | **Phase 0W worktree isolation** (`recursive-worktree` skill): create/verify `.worktrees/<run-id>` on `recursive/<run-id>`, git-ignore check, project setup, clean baseline, router-state sync, write `00-worktree.md`. |
   | `/recursive init <run-id> --template <t>` | `<run-id> [--template feature\|debug]` | Scaffold a run (parity with `recursive-init.py`) — only after spec approval + worktree if required |
   | `/recursive lock <phase>` | `<phase>` | Lock an artifact after machine-checked gates (parity with `recursive-lock.py` + monotonic gating) |
   | `/recursive qa <run-id>` | `<run-id>` | Manual-QA sign-off flow (Phase 5); routes to user-questions/approval when human mode |
   | `/recursive closeout --phase 06|07|08` | `--phase <n>` | DECISIONS/STATE/memory receipt scaffolds |
   | `/recursive addendum <base> <text>` | … | Append a stage-local addendum (parity with addenda policy) |
   | `/recursive review <run-id> <phase>` | … | Build a canonical review bundle + hand off to delegated audit |

2. **Global commands** (available in any session, registered on the host or bundle level — matching how `/goal` and `/feedback` are global):
   - `/recursive bootstrap` — bootstrap the `/.recursive/` scaffold in the current repo (parity with `install-recursive-mode.py`), with an auto-trigger on `agent/session-start` when missing.
   - `/recursive list` — list runs + their earliest incomplete phase (cheap read).
   - `/recursive help` — what recursive-mode is and where the docs live (points to `/.recursive/RECURSIVE.md`).

3. **Client-side popup for `/recursive`** (the `ui-commands` `register`/decorate path, `packages/client/ui-commands/src/client/service.ts`): a popupSelect showing the sub-command grammar (like the `/model` or `/goal` popups) so users get structured choices + hints instead of typing raw.

**Registration mechanics (parity with `/plan`):**

```ts
// preset-scoped: inside the recursive preset's agent-scoped context
ctx.inject(['commands'], (commandCtx) => {
  commandCtx.commands.register({
    name: 'recursive',
    description: 'Recursive-mode workflow commands',
    input: { hint: 'status|init|lock|qa|closeout|addendum|review|…' },
    handler: ({ agent, rawInput }) => parseAndExecute(agent, rawInput),
  })
})
```

### 6.6 Rationale — why slash commands *in addition to* model-facing tools (Options B/C)

- **Zero-token workflow control.** Command discovery/execution adds no model tokens (`packages/interaction/commands/README.md`). Checking run status, locking a phase, or starting QA are *mechanical* — a user shouldn't spend a model turn (and context) asking the agent to do them. The command plane makes them instant, deterministic UI actions. Today's prompt model ("Implement the run", "lock phase 3") burns tokens *and* depends on the agent's doc-reading; a slash command is deterministic.
- **The mode's "control panel" lives where users expect it.** Users already reach `/plan`, `/goal`, `/compact`, `/feedback` from the slash menu. Putting `/recursive …` beside them makes the workflow *discoverable* — a new user in a recursive session immediately sees the workflow verbs without reading docs.
- **Commands and tools are complementary, not competing.** Model-facing `recursive_*` tools remain the **agent-facing** surface (the agent drives phases, audits, and closeout autonomously); slash commands are the **user-facing** surface (the user drives the workflow directly). The commands dispatch to the same `ctx.recursiveRun` service the tools use, so behavior stays consistent — a `/recursive lock 3` enforces the same machine-checked gates as the agent calling `recursive_lock`.

### 6.7 Rationale — why preset-scoped + a small global set (Option D/E rejected)

- **Per-session correctness via scope.** A preset-scoped `/recursive` only appears in recursive sessions, so standard/code sessions stay uncluttered — consistent with §5's composability argument. The '/' menu is already session-aware, so this "just works." Registering all commands globally (Option D) would leak workflow verbs into every session and contradict the §5 decision.
- **Namespace hygiene.** A single `/recursive` command with a sub-grammar (Option A) keeps the slash namespace clean and groups related verbs; many flat names (Option E) pollute it and lose the workflow grouping. The `input.hint` + client popup supplies the structure that flat names would otherwise buy.
- **The global set is deliberately tiny** (bootstrap/list/help): bootstrap is needed before any recursive session exists (you bootstrap *into* the workflow), list/help are cheap discovery reads. Everything stateful or mutating stays preset-scoped.

### 6.8 Rationale — why a client popup *in addition to* host commands (Option F rejected)

A client-only popup (Option F) has no direct execution path — it would have to synthesize a prompt and pay a model turn, recreating today's gap. The popup is instead a *view* over the host command directory (`CommandUiRuntime` merges the host catalog with client contributions and dispatches `ctx.remote.commands.execute`), so the popup only exists because the host commands do. It adds structure (hints, grammar, fuzzy matching — `fuzzyScore` in `ui-commands/src/client/service.ts`) without changing the execution model.

### 6.9 Value for users — concrete what-it-enables

| User action | Today (no plugin) | With plugin |
|---|---|---|
| Check where a run is | Open files, ask the agent | `/recursive status <run-id>` — instant, zero tokens |
| Start a run | Type "Implement the run" | `/recursive init <run-id> --template feature` then the goal loop |
| Lock a phase | Ask the agent to run a script | `/recursive lock 3` — machine-checked gates, monotonic gating, immediate feedback |
| Sign off QA | Chat back and forth | `/recursive qa <run-id>` — routes to approval, records sign-off |
| Close out a run | Prose prompts | `/recursive closeout --phase 06` |
| Bootstrap a repo | Manual install | `/recursive bootstrap` (auto-triggers on session start when scaffold missing) |
| Discover the workflow | Read docs | `/recursive help` / `/recursive list` — what's available, where runs are |
| Delegate an audit | Assemble a bundle by hand | `/recursive review <run-id> <phase>` — builds the canonical bundle + dispatches |

### 6.10 Consequences and follow-ups

- **Build plan:** Phase A ships the command registrations (both sets) + the client popup. Phase D verifies preset-scoped visibility: a `recursive` session's '/' menu shows `/recursive`; a `standard` session's does not (e2e pattern: `apps/web/tests/agent-preset-selection.e2e.ts` shows how presets change the menu; `ui-commands` client tests cover the directory).
- **Open decision (tracked in §13):** exact sub-command grammar + which verbs are preset-scoped vs global, pending user feedback on the popup.
- **References for implementation:** `packages/interaction/commands/src/index.ts` + README; `packages/plan/plan-mode/src/index.ts` lines 268–303 (`/plan` pattern); `packages/goal/command-goal/src/index.ts` (`/goal` grammar + domain-event pattern); `packages/bundle/base/cordis.patch.yml` (global command rows); `apps/cli/config/agent-presets/standard/agent.cordis.yml` lines 147–148 (preset-scoped `/compact`); `packages/client/ui-commands/src/client/service.ts` (slash source + popup + preset-aware directory); `packages/bundle/web-app/cordis.patch.yml` lines 361–362 (host command disabled so preset owns the name).



## 7. Code Mode strategy: recursive-mode as a fork of the `code` preset? (decision record)

> **Decision:** recursive-mode does **NOT** fork the `code` preset. It ships as a **standalone `recursive` preset** with **`mode: both`** tool presentation (native tools *and* the Code Mode SDK) — not `mode: code`-only. This gives recursive sessions the Code Mode performance/accuracy benefits *without* forfeiting the native tool surface that audit/delegation/evidence workflows rely on.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.
> **Consequences:** the `recursive` preset composes `@deepseek-ai/dsh-agent-tool-presentation` with `mode: both` (or `code` as a user-selectable option); it depends on the host `codeRuntime` (`@deepseek-ai/dsh-code-runtime-worker-thread`, already in the web profile); the Code Mode collapse + SDK prompt sections render for recursive agents; native tools remain callable for audit/evidence/verification verbs.

### 7.1 Background — what the `code` preset and Code Mode actually are

- **The `code` preset** (`apps/cli/config/agent-presets/code/`) is literally *"the standard coding agent, presented as Code Mode"* — the file header says **"Everything in `standard` is here unchanged. What is added is the `tool-presentation` row"** (`code/agent.cordis.yml` lines 1–6). So `code` is not a different agent — it is `standard` with a different *presentation layer* on the same tool registry.
- **The presentation selector** (`packages/core/agent-tool-presentation/src/index.ts`) is one row: `mode: native | code | both` (`Config` schema lines 49–52). It calls `ctx.tools.presentAs(mode)` for the mounting scope; under `code` it waits for the host `codeRuntime` and fails the preset's activation audit if none is composed (lines 67–71).
- **What Code Mode does** (from `docs/tool-catalog.md` + `packages/core/tools/src/index.ts`):
  - The model sees **`run_code` only** plus a **generated SDK** in the runtime's language (TypeScript) declaring the other visible capabilities. `run_code` is a *reserved transport* outside filterable capability layers; you cannot `register`/`restrict`/`deny` it (`code-mode.spec.ts` lines 289–292, 1785).
  - A program calls SDK bindings that **re-enter the complete guarded tool pipeline** under the native concurrency contract (submission-ordered starts; bodies overlap up to `maxParallelSubCalls`, default 10 — `packages/core/tools/src/index.ts` line 792) and link each nested execution to the outer result (`tool-catalog.md` line 19).
  - **Under `mode: code`, a model-direct native tool call is denied as `UNKNOWN_TOOL`** (`code-mode.spec.ts` lines 1595–1607, 1640–1704). A `tools:code-only` collapse section states the rule so the prompt cannot contradict enforcement (`packages/core/tools/src/index.ts` lines 839–862).
  - **`mode: both`** sends both surfaces: native tools remain callable, and the SDK section renders for programs (`agent-tool-presentation/src/index.ts` lines 40–45, 63–71; `tools/src/index.ts` lines 833–836 renders collapse+SDK for any non-native mode, and `both` renders the collapse empty because native calls execute).

### 7.2 Background — why Code Mode is conceptually and practically valuable

The user's intuition is correct. Code Mode's value, grounded in the implementation:

- **Round-trip reduction:** *"instead of one tool call per action, the model writes a TypeScript program against a generated SDK and `run_code` executes it, so a sequence that would be five round trips becomes one"* (`code/agent.cordis.yml` lines 4–6). Fewer model-tool round trips = fewer scheduler hops, less per-call overhead, less context churn.
- **Composition + concurrency:** a program can express *dependent* multi-step sequences in one shot, and the SDK bindings schedule independent calls concurrently up to `maxParallelSubCalls` (10) under the native guarded pipeline — parallelism the native single-call loop does not offer.
- **Accuracy via structure:** writing a program forces the model to sequence steps explicitly (imperative, deterministic control flow) rather than improvising per-turn tool calls; the SDK's typed bindings reduce schema-shape errors (the model programs against generated signatures rather than recalling JSON schemas).
- **Reduced catalog pressure:** under `code`, the wire only carries `run_code`; the rest of the catalog lives in the SDK section — a much smaller prompt surface at request time.
- **It is cheap to adopt:** because `code` is *presentation-only* over the identical host tool registry, adopting Code Mode in recursive-mode costs one composition row, not a rewrite.

### 7.3 Alternatives considered

| Option | Description | Verdict |
|---|---|---|
| **A. Standalone `recursive` preset + `mode: both`** | Fork nothing; own preset; present native tools AND Code Mode SDK | **Adopted** (see §7.4) |
| **B. Fork the `code` preset** | Copy `code/agent.cordis.yml` into `recursive/` and add recursive rows | Rejected — couples to code's full surface; hard to maintain; `code` ≠ a base (see §7.5) |
| **C. `recursive` preset + `mode: code` only** | Code Mode only; native tools denied (UNKNOWN_TOOL) | Rejected — breaks audit/delegation/evidence verbs that need direct tool calls (see §7.6) |
| **D. `recursive` preset + `mode: native` only** | No Code Mode | Rejected — forfeits the round-trip/concurrency/accuracy wins (see §7.7) |
| **E. Ship `recursive` AND `recursive-code` presets** | Two presets, one native one code-only | Rejected — preset explosion; `both` covers both needs in one (see §7.5) |
| **F. Compose `standard` rows + `tool-presentation mode: code` inside recursive** | Keep standard as the base, add recursive rows, switch presentation | Rejected — equivalent to forking standard; same coupling problem as B (see §7.5) |

### 7.4 Decision — standalone preset, `mode: both`

**Ship a standalone `recursive` preset** (as decided in §5) whose `agent.cordis.yml` composes the recursive-mode rows **plus** the presentation row:

```yaml
- id: tool-presentation
  name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: both
```

- The `both` mode gives the model **both** the native `recursive_*` / fs / shell / subagent / workflow tools AND the Code Mode SDK for `run_code` programs — so phase work can batch multi-step sequences into one program when beneficial, while audit/verification/evidence verbs stay directly callable.
- It depends on the host `codeRuntime` (`@deepseek-ai/dsh-code-runtime-worker-thread`, already composed in the web profile — `packages/bundle/web-app/cordis.patch.yml` lines 48–49), so the recursive preset mounts wherever code mode does.
- **User-selectable option:** expose `code` vs `both` vs `native` as a preset config (Schemastery) so a user can harden to code-only if they want the strictest form for a particular session (e.g. a pure implementation run), defaulting to `both`.

### 7.5 Rationale — why NOT fork the `code` preset (Options B/E/F)

- **`code` is not a base — it is a presentation.** Forking it would mean copying standard's entire tool stack (`code/agent.cordis.yml` is ~260 lines and mirrors standard 1:1 plus one row). The recursive preset needs *its own* tool surface (recursive tools, skills, commands, phase guards), not standard's — so the copy would immediately diverge, and every upstream change to `code`/standard would need manual re-sync. Forking a *presentation* to get a *composition* is the wrong direction.
- **Composition, not inheritance.** DSH presets are compositions (agent-plane `agent.cordis.yml`), not class hierarchies. The right way to "get Code Mode" is to compose the `tool-presentation` row with the desired `mode` — exactly what `code` does, but *alongside* the recursive rows rather than instead of them. There is no "extends code" mechanism; a preset is a flat row list.
- **No preset explosion (Option E):** one `recursive` preset with `mode: both` covers both the native and code-oriented needs; shipping `recursive` + `recursive-code` duplicates the whole surface for a one-line difference.
- **Option F (standard + code presentation + recursive rows)** is forking standard by another name — same maintenance coupling, plus it re-imports standard's choices (e.g. its exact tool set) that recursive-mode may want to differ on.

### 7.6 Rationale — why NOT `mode: code`-only (Option C)

- **The audit/delegation loop needs direct tools.** recursive-mode's core value (§2.2, §4.3) is machine-checked gates, review bundles, subagent audits, evidence capture, and lock enforcement — verbs that execute *through the native tool pipeline* with structured schemas and guarded policies. Under `code`-only, a model-direct native call is **`UNKNOWN_TOOL`** (`code-mode.spec.ts` lines 1595–1607) — so the agent could only reach these via SDK bindings inside `run_code` programs, which is awkward for single-purpose deterministic verbs (lock, verify, status) and for *delegated subagent audits* that hand a bundle to a child agent whose own session may be native.
- **Deterministic policy verbs ≠ multi-step composition.** Code Mode shines at *sequences*; recursive-mode's gates are *single authoritative checks* (is the lock valid? do the gates pass? is the diff basis recorded?). Funneling those through a TypeScript program adds indirection with no compositional benefit.
- **Flexibility for the model.** The recursive workflow already asks the model to do both long multi-step implementation phases AND discrete audit/QA steps; `both` lets it choose the right form per task. Code-only would force the implementation form onto the audit steps too.

### 7.7 Rationale — why NOT `mode: native`-only (Option D)

- Forfeits Code Mode's concrete wins: round-trip reduction (5 calls → 1 program), concurrency up to `maxParallelSubCalls` (10), typed-SDK accuracy, and the smaller wire catalog. Given recursive-mode's phases involve substantial multi-step implementation (Phase 3) and test/evidence runs (Phase 4), the batch/concurrency benefit is directly relevant — a TDD sub-phase can express RED → code → GREEN in one program with dependent steps scheduled correctly.

### 7.8 Pros and cons of Code Mode (summary for the record)

| Pros | Cons / caveats |
|---|---|
| Fewer round trips: one `run_code` program replaces many native calls (`code/agent.cordis.yml` lines 4–6) | **`run_code` is reserved**: cannot `register`/`restrict`/`deny` it (`code-mode.spec.ts` lines 289–292) — policy must work around the transport |
| Concurrency: SDK bindings overlap up to `maxParallelSubCalls` (default 10) under the guarded pipeline | Under `code`-only, direct native calls are `UNKNOWN_TOOL` (`code-mode.spec.ts` lines 1595–1607) — a workflow needing deterministic single-purpose verbs must use `both` |
| Typed SDK: model programs against generated signatures — fewer schema-shape errors | SDK generation + program execution costs runtime; a program is code that can fail at runtime (types/JSON limits: "a bare function is a value JSON cannot represent" — `code-mode.spec.ts` line 1352) |
| Smaller wire catalog under `code` (only `run_code` + SDK section) | Model must write valid TS every time; for trivial single calls the overhead exceeds the saving |
| Imperative sequencing: explicit control flow = deterministic multi-step execution | Debugging a bad program is different from debugging a bad tool call; collapse rule must match enforcement (`tools/src/index.ts` lines 855–862) |
| Presentation-only adoption: one composition row, no rewrite | Requires the host `codeRuntime` composed (web profile has it; a custom profile may not — mount fails loudly, `agent-tool-presentation/src/index.ts` lines 67–71) |
| Proven in `code` preset: "everything in standard, presented as Code Mode" | Preset authoring still owns its own tool surface; `code` is not a reusable base (§7.5) |

### 7.9 Consequences and follow-ups

- **Build plan:** Phase A composes the `recursive` preset with `tool-presentation mode: both` (+ configurable code/native options). Phase D e2e-verifies both surfaces render and a `code`-option session denies native calls as `UNKNOWN_TOOL` while `both` allows them.
- **Open decision (tracked in §13):** default `mode` for the recursive preset — `both` (proposal) vs `code`-first with native escape; revisit after user feedback on the Code Mode UX in recursive sessions.
- **References for implementation:** `apps/cli/config/agent-presets/code/agent.cordis.yml` (the presentation row + "everything in standard" comment); `packages/core/agent-tool-presentation/src/index.ts` (mode config + codeRuntime wait); `packages/core/tools/src/index.ts` lines 783–862 (presentAs, collapse section, SDK section, reserved transport); `docs/tool-catalog.md` lines 19, 121–148 (`run_code` + Code Mode semantics); `packages/core/tools/tests/code-mode.spec.ts` (reserved transport, UNKNOWN_TOOL, concurrency contract, per-agent presentation); `packages/bundle/web-app/cordis.patch.yml` lines 48–49 (code-runtime composition).

## 8. Workflow enforcement: phase gates, tool guards, and durable state (decision record)

> **Decision:** recursive-mode enforces its workflow through DSH's native lifecycle seams — a phase-transition gate on `agent/pre-step` (the authoritative turn boundary), surgical tool guards on `tools/pre-execute` (scope-filtered to recursive agents), a `recursive:policy` prompt section that states the contract, and durable phase state folded from the session log (resume/fork-safe, UI-observable). Enforcement is layered so each mechanism covers what the others cannot.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.
> **Consequences:** a model turn that would advance a run without its gates passing is **blocked** (`{kind: 'reject'}` → turn ends `blocked`, no model call); individual tool calls that violate the active phase's policy (writes to locked artifacts, missing TDD evidence) are **denied or routed to approval**; the `recursive:policy` section makes the contract legible to the model; `recursive/phase` events make committed transitions observable; enforcement state survives resume/fork because it folds from the session log.

### 8.1 Background — the contract to enforce (from recursive-mode itself)

The canonical spec (this repo's `/.recursive/RECURSIVE.md` and the `AGENTS.md` bridge block) already defines the gates recursive-mode *requires* — today they are instructions, not enforcement:

- **Audited phases follow `draft → audit → repair → re-audit → pass → lock`** (bridge block, "Required recursive-mode audit behavior").
- **`recursive-lock` enforces monotonic phase gating**: all earlier phases that exist in the run directory must be `LOCKED` before the target phase can be locked (bridge block, "Locking rule"). This is the *one* gate that is already machine-enforced — by a Python script the agent must choose to run.
- **Phase docs and evidence**: audited phases must end with `Audit: PASS`, must include machine-checkable `Requirement Completion Status` entries for every in-scope `R#`, and must record `Subagent Capability Probe` + `Delegation Decision Basis`; `implemented`/`verified` dispositions must cite concrete `Changed Files`, and `verified` requires distinct verification evidence (bridge block).
- **TDD discipline (Phase 3)**: `TDD Mode: strict|pragmatic` must be declared; strict requires RED and GREEN evidence paths; pragmatic requires an explicit exception rationale plus compensating evidence.
- **Debugging discipline (Phase 1.5, `recursive-debugging`)**: `NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST` — when a requirement is a bug fix, `01.5-root-cause.md` is mandatory and must be audited before Phase 2/3; the pre-step gate blocks Phase 2/3 entry without it.
- **Worktree isolation (Phase 0W, `recursive-worktree`)**: before Phase 1+ work, a `recursive/<run-id>` branch worktree exists, the worktree dir is git-ignored, project setup completed, a clean/acknowledged baseline test state is recorded in `00-worktree.md`, and the router policy/discovery files are synced into the worktree; main/master work requires an explicit exception recorded in `00-worktree.md`.
- **Pre-run spec approval (`recursive-spec`)**: a new run's `00-requirements.md` originates from a user-approved draft (temp-scratch, not the repo) — no run folder or requirements artifact is written from an unapproved draft.
- **QA discipline (Phase 5)**: `QA Execution Mode: human|agent-operated|hybrid`; human/hybrid require user sign-off; agent-operated/hybrid require execution metadata + evidence paths.
- **Diff basis (Phase 0/2)**: `00-worktree.md` is the source of truth for diff basis; do not silently substitute a different basis later.
- **Addenda are authoritative effective inputs**: if relevant addenda exist, list them in `Inputs`, re-read them, and reconcile explicitly.

Today, satisfying these is the *agent's responsibility* — a prompt, a skill, a bridge doc. Nothing stops the agent from marking `Coverage: PASS` without `Audit: PASS`, or locking Phase 3 with no GREEN evidence, or skipping the linter. That is precisely the §2.5 gap ("enforce, don't just describe", §4.1) this section closes.

### 8.2 Background — the DSH seams that make enforcement possible (verified)

DSH exposes a lifecycle + tool-pipeline that recursive-mode can hang gates on:

- **`agent/pre-step` — the authoritative turn boundary.** Every proposed step passes `dispatch.waterfall('agent/pre-step', { messages, ...position, signal }, () => ({ kind: 'enter', messages }))` (`packages/core/agent-loop/src/agent.ts` lines 225–243). A listener may return `{ kind: 'reject' }`; the loop then ends the turn with `{ kind: 'blocked' }` and spends **no model call** (lines 266–269; `PreStepDecision` = `reject | enter`, `packages/core/agent/src/runtime-types.ts` lines 44–47). This is the single gate every model turn must pass — enforcement here catches "the agent is about to advance" no matter which tool it planned to use.
- **`tools/pre-execute` — allow/deny/ask per tool call.** *"Allow, deny, or ask before dispatch. `next()` delegates to allow; missing approval support turns `ask` into denial."* (`packages/core/tools/src/index.ts` line 152). **Scope-filtered dispatch**: an agent-scoped listener receives only that agent's calls — so guards bind to recursive sessions alone. Siblings `tools/execute` (around-dispatch, line 163) and `tools/post-execute` (accept/replace/enrich/block results, line 175) round out the pipeline.
- **Prompt sections — the "describe" half.** `ctx.systemPrompt.section()` renders deployment-owned policy; plan-mode's `plan:policy` section (order 50) renders guidance *while the state is active* (`packages/plan/plan-mode/src/index.ts` lines 225–233). The model sees the contract; the gates enforce it.
- **Session log as durable state.** Plan mode folds its state from the session log (`plan/mode`, last wins) so *resume and fork restore it without a live mirror* (`packages/plan/plan-mode/src/index.ts` lines 9–14, 129–138). Same pattern: `recursive/phase` events fold to the in-force phase.
- **Approval seam.** `ctx.userQuestions`/`approval` — plan-mode's exit tool presents an approve/keep-planning question and reads the answer (`REVIEW_ID`, `APPROVE_LABEL`, lines 76–82). QA sign-off and gate failures needing a human decision use the same seam.
- **Session-start + goal driver.** `agent/session-start` hooks bootstrap/injection; the goal-round driver serializes continuation per agent and can pause on a blocked gate rather than burning rounds.

### 8.3 Alternatives considered

| Option | Description | Verdict |
|---|---|---|
| **A. Layered enforcement (pre-step gate + tool guards + policy section + log state)** | Turn-boundary gate, surgical per-tool guards, legible prompt policy, durable folded state | **Adopted** (see §8.4) |
| **B. Prompt-only** | Stronger instructions; no machine gates | Rejected — "describe, not enforce"; exactly today's gap (see §8.5) |
| **C. Tool-internal only** | Only `recursive_*` tools validate internally | Rejected — the agent can bypass via fs/shell/pwsh tools (see §8.5) |
| **D. Command-only** | Only `/recursive` commands enforce | Rejected — misses autonomous agent turns (see §8.5) |
| **E. External watchdog process** | A sidecar watching the run dir and blocking | Rejected — not DSH-native; the runtime already has the exact seams (see §8.5) |

### 8.4 Decision — the layered enforcement model

**Ship a `recursive-enforcement` plugin (or service rows in the preset) implementing four cooperating layers:**

**Layer 1 — phase-transition gate on `agent/pre-step` (authoritative).**
A scope-filtered listener inspects the session log + run dir for a *proposed phase transition* (a `recursive/phase` intent, a `recursive_lock`/`recursive_lock_phase` tool call in flight, or a command). It delegates the gate check to the **lifecycle transition set (§8.8)** — Layer 1 is a *caller* of that set, not a second definition of it. Before the step may enter, the transition set verifies the target phase's gates:

- **Phase doc exists** (`/.recursive/run/<run-id>/phase-<n>.md`) with the required sections (Inputs incl. addenda, effective inputs, diff basis cited, changed files, R# completion status).
- **Linter ran**: `lint-recursive-run` evidence present in the run dir (a fresh, dated run record — not a stale one).
- **Tests ran (Phase 3)**: RED + GREEN evidence paths for `TDD Mode: strict`, or exception rationale + compensating evidence for `pragmatic`.
- **Audit closed (audited phases)**: artifact ends with `Audit: PASS`; `Requirement Completion Status` for every in-scope `R#`; `Delegation Decision Basis` recorded.
- **Monotonic gating**: every earlier phase present in the run dir is `LOCKED` (parity with `recursive-lock.py`'s own check — the DSH gate makes it un-skippable).
- **QA sign-off (Phase 5)**: `QA Execution Mode: human|hybrid` requires a recorded approval; `agent-operated|hybrid` requires execution metadata + evidence paths.

Failure → `{ kind: 'reject' }`: the turn ends `blocked`, **no model call is spent**, the plugin appends a log-only `recursive/gate-blocked` event (client renders it as a status row) and optionally steers a next-turn message stating exactly which gates failed. This is the same reject semantics plan-mode relies on — but instead of a user toggle it's a workflow predicate.

**Layer 2 — surgical tool guards on `tools/pre-execute` (scope-filtered).**
For recursive agents only (`@deepseek-ai/dsh-scope`), before dispatch:

- **Locked-artifact write denial**: fs-write/shell/pwsh calls targeting `*.md` under `/.recursive/run/<run-id>/phase-*.md` that carry `Status: LOCKED` → `deny` (or `ask` for an explicit reopen). Tamper detection: `fs/observed` events when a locked file changes outside a tool call → warn + `recursive/tamper` event.
- **Plan-phase read-only**: while a run is in Phase 2 (planning), mutation tools outside the run's worktree → `deny`; the plan artifact itself read-only until approved.
- **TDD evidence gating**: `recursive_lock` on a Phase-3 artifact without RED+GREEN evidence → `ask` (approval seam) or `deny` under strict mode.
- **Effective-inputs check**: a `recursive_lock`/transition that ignores relevant addenda (listed in `Inputs` but not re-read) → `deny`.

Layer 2 is *surgical* where Layer 1 is *whole-turn*: it lets the model keep working within the phase while stopping the specific violating operations, and it binds policy to individual tools without blocking unrelated work.

**Layer 3 — `recursive:policy` prompt section (legible contract).**
A `systemPrompt.section` named `recursive:policy` (order ~50, mirroring `plan:policy`) renders the *current phase's contract* from folded state: what must exist before advancing, which tools are denied/asked this phase, the strict/pragmatic TDD mode, the QA mode, and the lock chain. The model reads the same rules the gates enforce — no prompt/gate contradiction (the same pairing plan-mode documents: the `plan:policy` section + independent enforcement).

**Layer 4 — durable folded state + events (`recursive/phase`).**
Phase transitions append `recursive/phase` log events (`{ runId, phase, status }`, last-wins fold — the `foldPlanMode` pattern at `packages/plan/plan-mode/src/index.ts` lines 129–138). Resume/fork restore in-force phase from the log; UIs observe committed flips via `session/event`; the projection unit (session-projections) exposes `{ phase, pending }` to clients. Same log-only, no-live-mirror discipline as plan mode.

**Goal integration.** "Implement the run" runs as a goal; the round driver's continuation passes the same pre-step gate. When a gate blocks, the goal **pauses** (not burns rounds) and surfaces the `recursive/gate-blocked` reason via the approval seam — the user fixes the gap, resumes, and the gate re-checks.

### 8.5 Rationale — why layered, and why the rejected options fail

- **Prompt-only (B) is today's status quo.** The bridge block and `RECURSIVE.md` already *say* everything above; the agent routinely skips parts. Without a machine gate, "phase docs written, linter run" stays an aspiration. Enforcement is the entire point of "Enforce, don't just describe" (§4.1).
- **Tool-internal only (C) is bypassable.** If only `recursive_*` tools validate, the agent can write a fake `Audit: PASS` via `fs`/`shell`/`pwsh` and lock via a raw edit. The DSH tool pipeline is open — enforcement must sit *outside* the workflow's own tools, on the lifecycle/tool seams the harness owns.
- **Command-only (D) misses autonomous turns.** `/recursive lock` can validate, but the whole value of recursive-mode is the agent *driving phases autonomously*. The pre-step gate catches those turns; commands alone cannot.
- **External watchdog (E) reinvents the harness.** The runtime already provides `agent/pre-step` (turn boundary), `tools/pre-execute` (per-call), scope filtering, the session log, and the approval seam. A sidecar duplicates state, breaks resume semantics, and adds a failure domain for zero benefit.
- **Why the layers cooperate:** pre-step blocks *whole turns* (a runaway transition) but can't surgically allow work within a phase; tool guards do the surgical allow/deny but miss the "turn is about to advance" signal; the policy section makes both legible; the log makes state durable and observable. Each layer covers the others' blind spots — that is why it is a *layered* model, not a single hook.

### 8.6 The enforcement matrix (what is gated, where)

| Workflow rule (from §8.1) | Layer 1 pre-step (turn advance) | Layer 2 tool guard | Layer 3 policy section |
|---|---|---|---|
| Phase doc written | ✔ block advance without it | — | ✔ states requirement |
| Linter run (fresh evidence) | ✔ block advance without it | — | ✔ |
| Tests / TDD evidence (Phase 3) | ✔ strict: block; pragmatic: require rationale | `ask` on lock without evidence | ✔ mode declared |
| Audit closed (`Audit: PASS`, R# status, Delegation Basis) | ✔ block advance without it | — | ✔ |
| Monotonic phase gating | ✔ block advance past unlocked prior | `deny` lock calls out of order | ✔ |
| Locked-artifact immutability | — | `deny` writes to locked `*.md`; `fs/observed` tamper event | ✔ |
| Plan-phase read-only (Phase 2) | — | `deny` mutation outside worktree | ✔ |
| Effective inputs incl. addenda | ✔ block advance without reconciliation | `deny` lock ignoring addenda | ✔ |
| QA sign-off (Phase 5) | ✔ block advance without recorded approval | `ask` for sign-off | ✔ execution mode declared |

### 8.7 Consequences and follow-ups

- **Build plan:** this is the heart of **Phase C — Enforcement + goals** (§4.5). Expand it: the `lifecycle.ts` **run state machine (§8.8)** first (transition set + serialized driver + events), then the pre-step phase-transition gate and `tools/pre-execute` guards as *callers* of that transition set; `recursive:policy` section; `recursive/phase` events + projection; goal-round pause-on-block; `recursive/gate-blocked` UI row (Phase D renders it).
- **Ordering:** Layer 3 (policy section) is trivially first (Phase A prompt composition); Layer 4 (log state + events) second; Layers 1–2 (the actual gates) last, once the fold is right — gates without state are guesswork.
- **Open decision (tracked in §13):** enforcement strictness — hard-block (reject/deny) vs advisory (warn + `recursive/gate-blocked` without blocking) vs configurable `strict|advisory` per gate; and whether the pre-step gate reads the run dir synchronously per turn (cheap hash checks) or only on transition intent (fewer false positives).
- **References for implementation:** `packages/core/agent-loop/src/agent.ts` lines 225–243, 266–269 (pre-step waterfall + reject→blocked); `packages/core/agent/src/runtime-types.ts` lines 44–47 (`PreStepDecision`); `packages/core/tools/src/index.ts` line 152 (`tools/pre-execute` allow/deny/ask), 163/175 (execute/post-execute); `packages/plan/plan-mode/src/index.ts` lines 9–14, 129–138 (log-folded state), 205–222 (pre-step listener), 225–233 (`plan:policy` section), 76–82 (approval question); this repo's `AGENTS.md` bridge block + `/.recursive/RECURSIVE.md` (the contract); `recursive-lock.py` monotonic gating (the one existing machine gate to mirror).

### 8.8 The run lifecycle manager — a controller over the files, not a second store (decision record)

> **Decision:** ship a `lifecycle.ts` **run state machine** whose authority is **transitions and events only** — it never stores run *state* in a second place. It reconciles the file tree (§4.7), validates the target phase's gates (§8.4), performs the transition by delegating the *file* write to `lock.ts`/`run.ts` (which preserve the canonical lock-hash + monotonic chain), and emits the `recursive/*` log events the gate, board, and projection consume. State is *derived from files + session log*; the lifecycle manager is the **owner of the transitions**, not the **source of truth** for state.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.

**Why a lifecycle manager now.** The requirements record `Status:`/`Phase:` *per artifact*, but they do not express the *run-level* lifecycle that every downstream consumer needs:

- **Phase changes are multi-gate and non-local.** A Phase 3 → 3.5 transition validates RED/GREEN evidence, `Audit: PASS`, `Requirement Completion Status`, monotonic lock chain, and (in strict mode) the TDD contract. That predicate has no single home today — it lives scattered across §8.4's Layer 1/2 logic. The manager is that home.
- **`active`, `paused`, `blocked`, `complete` are a run's *durable* states**, not a per-artifact field. Phase 5 QA sign-off pending, a gate-blocked `Implement the run`, and a goal pause-on-block are all *run-level* conditions the board must render; per-artifact `DRAFT`/`LOCKED` cannot express them.
- **The audit loop is a run-level invariant.** `draft → audit → repair → re-audit → pass → lock` is a *sequence* across a phase's attempts, not a property of one file. A DRAFT artifact alone doesn't say whether we're mid-audit or just starting; the run-level state does.
- **A machine-checkable transition set is what makes enforcement *un-skippable*** (the §8.4 promise). The pre-step gate and tool guards must consult the *same* transition set the status tool uses — otherwise they disagree on what "advancing" means.

**What it owns — and what it deliberately does NOT.**

| Owns (authority) | Does NOT own (delegates/derives) |
|---|---|
| The **transition set**: `RUN_STATES = { new, active, paused, blocked, complete }` × the per-phase transitions (`draft→audit→repair→re-audit→pass→lock`, plus `reopen`) with their **gate predicates** (§8.4) | The **artifact bytes** — `lock.ts` writes `Status: LOCKED`/`LockedAt`/`LockHash`; the manager only *requests* the transition after validating |
| **Serialized per-run transition driver** (one transition at a time per run, coalesced — the `goal-round-driver` single-reservation pattern) | The **folded current phase** — `run.ts` re-derives it from files on every read; the manager consumes it, never caches it long-term |
| **Durability checkpoints** — flush the session after a committed transition so the event log and files stay consistent (mirrors `goal-round-driver`'s `ctx.sessions.flush`) | The **session log** itself — the harness owns it; the manager only *emits into* it via `recursive/*` events |
| **Run-level state flags** (`paused`/`blocked` with `reason`, `active`, `complete`) emitted as `recursive/run-state` events | **Per-artifact `Status`** — that stays in the phase docs, read via §4.7 |
| **Goal coupling** — translate a gate-block into goal `pause`/`block`, and arm a resume re-check (§8.4 goal integration) | **Goal creation** — `goal.ts` owns that; the manager only calls the pause/resume surface |
| **Lifecycle events** — `recursive/run-created`, `recursive/phase`, `recursive/phase-locked`, `recursive/gate-blocked`, `recursive/tamper`, `recursive/run-merged`, `recursive/run-state` — the single emitters the projection (§11) folds | **The projection itself** — session-projections is the harness's; the manager feeds it |
| **Bounded read policy** — enumerate runs as names, route to the active run, never scan all docs at init (§8.9) | **The run docs themselves** — `lifecycle.ts` reads them, it never caches a second copy |

**The transition driver (state machine mechanics).**

- Per-run transitions are **coalesced onto one serialized driver** keyed by `runId`, exactly as `goal-round-driver` keeps one `DriverState` per agent and serializes `drive()` with a `requested`/`run` fence — two concurrent "lock Phase 3" intents (e.g. the agent's own `recursive_lock` and the user's `/recursive lock` command) queue, and the second observes the first's committed state instead of racing the write.
- Each transition is `validate → commit → flush → emit`: validate the target gate predicate against the *current* file tree; if it fails, emit `recursive/gate-blocked` (and pause/block the run or the goal) and **do not write**; if it passes, delegate the artifact write to `lock.ts`, `ctx.sessions.flush`, then emit `recursive/phase`/`recursive/phase-locked` with `{ runId, worktreeRoot, phase, status }`.
- **State is derived on every transition**, not tracked incrementally: the manager re-reads the fold (§4.7 pt 4) as its input, applies the transition as a request against that fold, and the resulting files become the new fold. There is no `run.phase` field in memory to drift from disk — resume/fork/session-restart reconstruct the identical state by re-reading.

**Failure model — why a rejected transition is a feature, not an error.**

A gate rejection (`{ kind: 'reject' }`) is a **normal, logged lifecycle outcome** with three consumers: (1) the turn ends `blocked` (no model call spent) or the tool call is denied; (2) `recursive/gate-blocked` renders a status row / card badge in the board (§11); (3) the goal pauses/`blocks` with the concrete reason (§8.4). No rejection is silent, and no rejection advances state. An *unexpected* failure (fs error, hash recompute error, malformed header) is distinct: it emits `recursive/init-failed`/`recursive/transition-failed`, leaves the files untouched, and surfaces a steering message — the manager is **fail-stop on ambiguity**, never fail-through.

**Consequences & build plan.** `lifecycle.ts` is the spine that turns §8's passive seams into an owned state machine: the pre-step gate (Layer 1) and tool guards (Layer 2) become *callers* of the transition set instead of duplicating its predicates; the goal coupling and the board both consume its events. Build it in **Phase C** right after the read path (§4.7) and `lock.ts` are correct — the fold must be trusted before transitions are allowed — and before Layer 1/2 gates, which then reference it rather than reimplementing.
### 8.9 Bounded init at 100+ runs — the decision is "lifecycle.ts plus nothing new" (decision record)

> **Decision (revised):** `lifecycle.ts` is the entire answer to the 100+ runs problem. It already owns the two things that matter — (a) the **derived phase fold** over the run docs (§4.7 pt 4) and (b) the **`recursive/*` events** the board and projection consume (§8.8). We add **no manifest file, no index, no archiving step.** The only incremental change is a bounded read policy on top of the existing lifecycle machinery: enumerate runs as directory names (already O(#dirs) via `iterdir()`), route to the active run's current phase doc (already derived), and let the board consume the session projection of `recursive/*` events instead of re-reading files.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.

**Why the manifest was wrong (and is withdrawn).** A manifest is a *second store* for state that `lifecycle.ts` already derives and emits — the fold is re-derived on every transition, and the events are the projection's input. Writing that same information to `MANIFEST.json` buys nothing the session log doesn't already hold, and it re-introduces the exact drift problem we removed: two places to keep in sync. The mtime-validation mechanism was the tell — if we must constantly *prove* the cache hasn't drifted, the cache is doing net-negative work.

**Why archiving was wrong (and is withdrawn).** Archiving means moving run directories, and **agents are bad at moving files** — it's a destructive, irreversible operation with no read-back verification, and it breaks the worktree/branch/merge invariant (§4.7 pt 0) in ways that are hard to recover. The 100+ runs problem is a *read* problem (too many docs read at init), not a *write* problem (too many directories). Moving the directories to shrink `iterdir()` fixes the already-cheap part and adds risk to the expensive part. **Archiving is dropped; the directory listing is never reorganized.**

**What actually keeps init bounded, with nothing new:**

| Cost | Bound | Already provided by |
|---|---|---|
| Enumerate runs | O(#run-dir-names) | `iterdir()` — never opens a doc (verified in `recursive-status.py` `get_latest_run_directory`) |
| Current run's phase | O(#docs in the *one* active run) | `lifecycle.ts` derived fold (§4.7 pt 4) — reads only the run being worked |
| Cross-run overview / board | O(projection size) | `recursive/*` events folded by the session projection (§11.4) — the board never re-reads files |
| Historical run open | O(#docs in that run) | routed by id (§4.7 pt 1) — only on explicit request |

**The one thing we commit to:** a **bounded-read init contract** (§5.10 Stage B, already updated). Init reads the directory names, the active run's phase doc, and the memory loader — never all runs, never all docs. Resume reads even less (the active run only). Historical runs stay untouched on disk and cost nothing until opened. The board's cross-run overview comes from the event projection, not a file scan. That is the whole scaling story.

## 9. REPL / RLM strategy: a stateful scratchpad for the agent to reason over (decision record)

> **Decision:** add a **run-scoped, repo-file-backed reasoning scratchpad** ("/recursive scratch <run-id>") as a *complement* to the run docs — NOT a fork/port of the RLM REPL pattern, and NOT a persistent interpreter session. The run docs remain the source of truth (as decided in §2.2); the scratchpad is disposable working memory the agent can reason over in code mode, with commit-vs-local and lifecycle rules below.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.
> **Consequences:** a `/recursive scratch` command (preset-scoped, §6) creates a per-run scratch file under `/.recursive/run/<run-id>/scratch/`; the `recursive:policy` section (§8.3) declares it disposable and not a control-plane artifact; it is NOT committed to the repo by default (git-ignored); DSH's existing trajectory/log/event machinery (§9.2) is used *instead of* building a new REPL transcript store.

### 9.1 Background — what an RLM REPL is (from the references)

The two links are about **Recursive Language Models (RLMs)** — the Zhang/Kraska/Khattab line of work (arXiv:2512.24601), not generic scratchpads:

- **RLM = "context as an external variable"** (deeplearning.ai *The Batch*). Instead of the full conversation fitting in the context window, the model keeps a small **stateful program (REPL)** — a scratchpad holding notes, variables, and code — that persists *outside* the context and gets re-read across chunks. Each "chunk" of the long context is processed with the REPL state carried along, so information survives across context-window boundaries.
- **rlm_repl** (fullstackwebdev) is a reference implementation of the paper: a REPL where the model writes notes/code that persist, and the REPL state is passed between recursive calls.
- **DSPy RLM** (dspy.ai/diving-deeper/rlm) is the same idea in DSPy: a code module that "keeps state between chunks" — the model writes `state`/`notes` and the module carries them across iterations, letting the model process inputs much longer than the context window.

So the RLM REPL's *essence* is: **executable, persistent, model-owned state that survives across context boundaries** — the model reasons by mutating a small program + notes rather than by holding everything in its head.

### 9.2 Background — what DSH already gives us (verified, decisive)

The user's instinct is right — and the answer is that **DSH already has most of this, and what it lacks is exactly the *stateful scratchpad* piece.** Three existing mechanisms cover the "REPL" roles:

- **Trajectory / event log is the durable transcript.** Every step, tool call, and result is already logged: `step/start`/`step/end`, `user/message`, `tool/call` + `tool/result` (with the frozen lossless-JSON final outcome — `tools/result`, `packages/core/tools/src/index.ts` lines 197–207), and the session log itself (`session.append`). This is the RLM "notes/transcript" role — a complete, replayable record of what the agent did, folded by projections (plan-mode's `foldPlanMode`, `packages/plan/plan-mode/src/index.ts` lines 129–138). **We do NOT need a new REPL transcript store; the trajectory already is one.**
- **The run docs are the durable "state" (source of truth).** `/.recursive/run/<run-id>/` phase docs, `00-worktree.md` diff basis, DECISIONS/STATE — the RLM "state carried between chunks" role, already decided as the source of truth (§2.2, §4.3). The recursive workflow *already* persists reasoning across turns by writing these docs; that is the RLM loop, file-backed.
- **Code mode's `run_code` is stateless batch execution, NOT a stateful REPL.** This is the gap. Verified: *"a fresh worker runs each host-type-stripped TypeScript program"* (`packages/code-runtime/code-runtime-worker-thread/src/index.ts` docstring), and `runWorkerMain` compiles the program via `new AsyncFunction(...)`, runs it once, posts `done`, and the worker terminates (`packages/code-runtime/code-runtime-worker-thread/src/bootstrap.ts` lines 400–423). **Each `run_code` call is a fresh worker/V8 isolate with zero persistence between calls.** So code mode gives you batch composition + concurrency (§7.2) but *not* an interactive REPL whose variables survive.

This reframes the question precisely: the *transcript* (trajectory) and the *durable state* (run docs) already exist. What's genuinely missing is the **middle layer** — a lightweight, model-owned scratchpad the agent can read/write quickly *within* a phase without polluting the canonical run docs.

### 9.3 Alternatives considered

| Option | Description | Verdict |
|---|---|---|
| **A. Run-scoped scratch file + `/recursive scratch` (adopted)** | A disposable per-run markdown/TS scratch under `/.recursive/run/<run-id>/scratch/`, git-ignored, read/written via tools; RLM "state" role filled by run docs + trajectory | **Adopted** (see §9.4) |
| **B. Full RLM REPL port (persistent interpreter)** | Build a stateful interpreter session (like rlm_repl) whose variables/code persist across `run_code` calls | Rejected — DSH's code runtime is stateless by design (fresh worker/call); a persistent interpreter is a big build with security + isolation cost, and the RLM *state* role is already filled by the run docs (see §9.5) |
| **C. Workspace-global scratch** | One shared scratchpad for the whole workspace, not per-run | Rejected — runs are isolated (§2.2 worktree isolation); a global scratch crosses run boundaries and would need run-context tagging to be safe (see §9.6) |
| **D. Rely on trajectory/log only** | Use only the existing event log + run docs; no scratchpad | Rejected — trajectory is a *record*, not a *working surface*; the agent needs a place to keep intermediate notes/experiments within a phase without committing them to canonical docs (see §9.7) |
| **E. Commit the scratch to the repo** | Scratch files tracked in git | Rejected — pollutes the repo with run residue (bridge block: "do not leave committed run residue"); scratch is disposable (see §9.6) |
| **F. Interpreter-backed REPL via `run_code` persistence** | Extend the code runtime to keep a worker alive across calls | Rejected — violates the runtime's containment contract (fresh worker = isolation/budget); would be a DSH-core change, not a plugin (see §9.5) |

### 9.4 Decision — run-scoped, repo-file-backed scratchpad

**Add a `/recursive scratch <run-id>` command (preset-scoped, §6) that manages a per-run scratchpad**, and register a matching model-facing tool (`recursive_scratch`) so the agent can use it autonomously:

- **Location:** `/.recursive/run/<run-id>/scratch/scratch.md` (and optionally `scratch.ts` for runnable snippets). One scratchpad per run — never workspace-global.
- **Disposability:** the scratchpad is explicitly *not* a control-plane artifact: the `recursive:policy` section (§8.3) declares "scratch is disposable working memory — do not cite it as an input or evidence; promote anything durable into the run docs." This keeps it from becoming a second source of truth.
- **Enforcement integration (§8):** the enforcement gate ignores scratch for gate checks (a run can advance without scratch being tidy), but a `tools/pre-execute` guard *denies* citing scratch as an `Input` or evidence — it cannot masquerade as a phase doc.
- **Code-mode interplay:** because `run_code` is stateless (fresh worker/call), the scratchpad is the *state bridge* for code mode — the model reads scratch into a program, does batch work, and writes results back to scratch. This is exactly the RLM "state carried between chunks" role, file-backed, without a persistent interpreter.

**Why run-scoped (one per run), not one reusable workspace REPL:**
- **Run isolation (§2.2):** runs live in isolated worktrees; a shared workspace scratch would cross run boundaries, mix contexts, and invite cross-run contamination in evidence/inputs. The enforcement matrix (§8.6) scopes by run dir — a global scratch would need run-context tagging on every read/write to be safe.
- **Lifecycle alignment:** a scratchpad dies with its run (cleaned at closeout), matching the "runs are transient, docs are durable" model. A workspace-global one would accumulate stale notes and fight the diff/evidence hygiene the workflow depends on.
- **Cost is trivial:** a per-run file is the same cost as a global one; the only reason to share would be cross-run knowledge, which belongs in `/.recursive/memory/` (the memory plane, §2.2), not scratch.

**Commit vs local:**
- **Default: local-only.** `/.recursive/run/<run-id>/scratch/` is added to the run's `.gitignore` (or the plugin's bootstrap adds it), matching the bridge block's "do not leave committed run residue" rule. Scratch is disposable; committing it would pollute the repo and entangle the diff/evidence audit (§2.2 diff ownership) with notes.
- **Opt-in commit:** a `--persist <path>` flag on `/recursive scratch` lets the user explicitly promote a scratch section into the run docs (e.g. into `phase-<n>.md` Inputs or a decision note) when it earns durable status. Promotion is the *only* way scratch content enters the repo — deliberate, reviewed, and gated (the enforcement gate then treats the promoted content as a normal run-doc edit).

### 9.5 Rationale — why NOT a full RLM REPL / persistent interpreter (Options B/F)

- **DSH's code runtime is stateless by design.** *"a fresh worker runs each host-type-stripped TypeScript program"* — and `runWorkerMain` compiles + runs + terminates per call. That statelessness is a *containment contract*: each run gets a fresh V8 isolate, a heap cap, busy-time/wall-time budgets, and termination that stops synchronous loops (`packages/code-runtime/code-runtime-worker-thread/src/index.ts` docstring). A persistent interpreter (Option F) would keep a worker alive across calls — breaking isolation, budgets, and the "termination stops loops" guarantee. That is a DSH-core change, not a plugin's to make.
- **The RLM *state* role is already filled.** RLM's core value is "state survives across context boundaries." In recursive-mode that state is the run docs (phase docs, `00-worktree.md`, DECISIONS/STATE) — *file-backed, diff-auditable, enforcement-gated* (§8). A separate interpreter state would duplicate it in a form that's harder to audit and impossible to gate. The scratchpad (Option A) fills only the *working-memory* gap between transcript and docs, without duplicating either.
- **Build + security cost.** A real REPL (rlm_repl) is a substantial subsystem: parse/eval loop, state serialization, isolation, persistence. For recursive-mode's needs (intermediate notes/experiments within a phase) a file the agent reads/writes is strictly simpler and just as effective — the model already *has* file tools.

### 9.6 Rationale — why run-scoped, local-only (Options C/E)

- **Option C (workspace-global) breaks run isolation.** The workflow's whole point is isolated runs with machine-checked evidence (§2.2). A global scratch invites cross-run contamination — an Input accidentally citing another run's notes — which the enforcement gate would have to disambiguate. Per-run files keep the run boundary clean and the enforcement matrix (§8.6) trivially scoped.
- **Option E (committed) pollutes the repo.** The bridge block explicitly says "do not leave committed run residue such as concrete `/.recursive/run/<run-id>/` folders, evidence logs … or temp-path references." Scratch is the definition of residue. Local-only + opt-in `--persist` promotion gives the user full control over what earns durable, committed status — and promotion goes through the normal gate (a run-doc edit, auditable like any other).

### 9.7 Rationale — why a scratchpad at all (Option D rejected)

- **Trajectory is a record, not a working surface.** The event log tells you *what happened*; it doesn't give the agent a place to hold *in-progress reasoning* — a partial design, an experiment log, a list of things to check — without committing them to canonical docs mid-phase. Writing such notes into phase docs early is exactly what the draft→audit→lock discipline wants to avoid (premature durable claims).
- **Code mode needs a state bridge.** Because `run_code` is stateless, a multi-step reasoning chain in code mode must pass state *through something*. The scratchpad is that bridge — read → batch work → write back — giving code mode the RLM benefit (state carried between chunks) without a persistent interpreter.
- **It's cheap and low-risk.** A per-run markdown file + one command + one tool is minimal surface; the enforcement gate keeps it from becoming authoritative. The alternative (no scratch) pushes intermediate state into either the trajectory (unreachable as a working surface) or the phase docs (premature), both worse.

### 9.8 The full picture — how the pieces map to the RLM idea

| RLM concept (from the references) | recursive-mode equivalent | Where |
|---|---|---|
| Persistent REPL state (notes/variables) | **Scratchpad** (disposable, per-run) | `/.recursive/run/<run-id>/scratch/` (git-ignored) |
| Durable state carried between chunks | **Run docs** (source of truth, gate-enforced) | `/.recursive/run/<run-id>/phase-*.md`, DECISIONS/STATE |
| Transcript / what the model did | **Trajectory + event log** (already built) | session log, `step/*`, `tool/*`, `tools/result` |
| Executing code across chunks | **`run_code`** (stateless batch, §7) + scratch as state bridge | code-runtime worker per call |
| Cross-run knowledge | **Memory plane** (not scratch) | `/.recursive/memory/` (§2.2) |

### 9.9 Consequences and follow-ups

- **Build plan:** Phase A ships the `/recursive scratch` command + `recursive_scratch` tool + git-ignore of the scratch dir. Phase C wires the enforcement guard (scratch not citable as Input/evidence; `--persist` promotion is a gated run-doc edit). Phase D renders scratch status in the dashboard (a "scratch" chip) without treating it as authoritative.
- **Open decision (tracked in §13):** scratch format — markdown-only (notes) vs markdown + optional runnable `scratch.ts`; and whether the enforcement gate should *warn* (advisory) or *deny* (strict) when a phase doc cites scratch as an Input.
- **References for implementation:** `packages/code-runtime/code-runtime-worker-thread/src/index.ts` (fresh-worker docstring + config), `packages/code-runtime/code-runtime-worker-thread/src/bootstrap.ts` lines 400–423 (`runWorkerMain`: compile/run/done/terminate — stateless); `packages/core/tools/src/index.ts` lines 197–207 (`tools/result` frozen lossless-JSON); `packages/plan/plan-mode/src/index.ts` lines 129–138 (log fold pattern); this repo's `AGENTS.md` bridge block ("do not leave committed run residue"); upstream: https://github.com/fullstackwebdev/rlm_repl, https://dspy.ai/diving-deeper/rlm/.

## 10. Subagent strategy: first-class, optional, context-contract delegation (decision record)

> **Decision:** subagents are a **first-class capability** of dsh-recursive-mode via DSH's native `ctx.subagents` seam (providers + start request + `report` + control tools), **deeply integrated** into the workflow (router resolution, review bundles, action records, enforcement gates) but **strictly optional** — when no provider is composed or a capability probe fails, the workflow falls back to self-audit exactly as the bridge block requires today, never weakening or skipping the audit.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.
> **Consequences:** the `recursive` preset composes a `tool-subagent` row bound to a configured `ctx.subagents` provider plus the control/report rows; `router.ts` resolves each role to a native provider when available (else external-CLI route, else `self-audit`/`local-controller` fallback per `recursive-router.json`); every delegation carries an explicit context-in contract (prompt + run-doc references) and context-out contract (report + structured output + artifact references); children share the run workspace and get their own disposable scratch (§10.7); delegation stays optional — `self-audit` remains the guaranteed fallback.

### 10.1 Background — recursive-mode's current delegation model (external CLIs, not DSH-native)

recursive-mode already has a delegation discipline — but today it routes to **external CLIs**, not a native harness seam:

- **Router policy** (`/.recursive/config/recursive-router.json`): role routes (`analyst`, `planner`, `implementer`, `code-reviewer`, `tester`, `memory-auditor`, `orchestrator`) with `mode: external-cli | local-only`, a `cli` + `model` per role, probe/invoke timeouts, and `fallback: self-audit | local-controller`. The router *is* the delegation decision, keyed by role.
- **Review bundles** (`recursive-review-bundle` skill): before delegating, the main agent must package *minimum inputs* — repo root, run id, phase name, reviewer role, artifact path, exact upstream artifact paths, audit questions, required output shape — and the generator auto-discovers relevant addenda and skill-memory refs. This is the **context-in** contract today.
- **Bridge block obligations**: record a `Subagent Capability Probe` + `Delegation Decision Basis` in every audited phase; require a durable action record under `/.recursive/run/<run-id>/subagents/` verified against actual files; store routed transcripts under `evidence/router/`; if subagents are unavailable, perform the audit as **self-audit** — never weaken or skip it.
- **The gap**: delegation today means invoking an external CLI (e.g. `codex`) with a bundle; the harness itself (DSH) has no native role in it. The plugin's job is to make the *harness's* subagent capability the first-class transport, with the external CLI as a fallback.

### 10.2 Background — DSH's subagent seam (verified)

DSH's subagent capability (`docs/subsystems/subagent.md`, `packages/subagent/*`) is exactly the native seam recursive-mode's delegation should ride on:

- **`ctx.subagents` registry, providers coexist.** `spawn`/`fork`-in-process, `acp`, `codex`, `claude-code`, `dsh-sdk` all register by name; it is *one optional capability*, not part of the agent loop (`docs/subsystems/subagent.md` line 5). If no provider is composed, the seam is simply absent — which is the *optionality* guarantee recursive-mode needs.
- **The start request carries the context-in contract**: `{ label?, prompt: ContentBlock[], parent, signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }` (lines 47–96). **`prompt` is the child's user message** — the whole delegation context travels through it. Capability flags (`outputSchema`, `depthLimit`, `toolFilter`, `persona`) are checked *before* start and fail loud (`SubagentError('UNSUPPORTED_CAPABILITY')`, `packages/subagent/subagent/src/index.ts:490–493`), never accepted-then-ignored.
- **Children share the parent's workspace but not its transcript.** Verified from the `report` tool: *"The agent that started you shares your workspace but does not automatically receive your transcript, tool output, or reasoning"* (`packages/subagent/tool-subagent-report/src/index.ts` lines 57–61, 68–72). So a child can read/write the same run dir, but its result must be **reported** — the context-out contract.
- **`report` tool** (child-scoped, continuable children): "Deliver your result with the report tool before you finish … reference relevant shared paths" — a self-contained answer with **references to docs/code the child wrote**. `reportDelivery: wakeup|quiet` schedules a parent turn or just adds context.
- **Structured output**: `outputSchema` (object-rooted JSON Schema subset) makes the child return a matching value as `SubagentResult.structured` (lines 68–72) — forcing a *machine-checkable* report shape, not free prose.
- **`outputSchema` + `report` + `SubagentCapability Probe` align perfectly** with the bridge block's "verify action records against actual files" — the plugin can validate the child's claimed references against the run dir.
- **Continuable children**: durable child sessions with process-local activations; the parent can follow up via `send_message`/`interrupt_agent` (`tool-subagent-control/src/index.ts`) + `list_agents` (`tool-subagent-control/src/list-agents.ts`) — a durable delegation thread per audit, resumable across sessions.
- **Child options**: child inherits the parent's provider/model route unless overridden (`resolveChildAgentOptions`, `subagent/src/child-agent.ts` lines 68–83); depth = parent depth + 1 with a cap (`resolveChildDepth`, same file lines 48–57); `toolFilter` scopes the child's tools; `persona` shadows the deployment persona for that child.

### 10.3 Alternatives considered

| Option | Description | Verdict |
|---|---|---|
| **A. Native `ctx.subagents` layer (adopted)** | Compose `tool-subagent` + provider + control/report in the recursive preset; `router.ts` resolves role → provider; review-bundle builder emits the `prompt`; action records + capability probe retained | **Adopted** (see §10.4) |
| **B. External-CLI routing only (today's model)** | Keep invoking codex/claude via the router; no native DSH subagent use | Rejected — not first-class, no native context/control/report/structured output; the plugin should *upgrade* this, not freeze it (see §10.7) |
| **C. Always-delegate** | Subagents required; no self-audit fallback | Rejected — breaks optionality and the bridge block's mandatory self-audit fallback (see §10.8) |
| **D. Own subagent implementation** | Build a parallel delegation mechanism inside the plugin | Rejected — reinvents `ctx.subagents`; loses native context/continuable/control/report (see §10.7) |
| **E. No subagents in v1** | Ship Phase A/B without delegation | Rejected — audited phases (§2.2) require audit/review; delegation is core, not optional-for-shipping (see §10.8) |
### 10.4 Decision — native subagents, deeply integrated, strictly optional

**Ship a `recursive-subagent` service (or rows in the preset composition) that makes `ctx.subagents` the first-class delegation transport**, with the external-CLI router kept as the fallback tier:

- **Composition (preset `agent.cordis.yml`):** a `tool-subagent` row bound to the configured provider (`spawn`/`fork`-in-process by default; `acp`/`codex`/`claude-code`/`dsh-sdk` selectable via config), plus `tool-subagent-control` (`send_message`/`interrupt_agent`/`list_agents`) and `tool-subagent-report` (child `report`). **Config-level shape** (uniform for every agent-driven call): `maxDepth` default 3, `toolFilter` scopes children to run-relevant tools, optional `persona`, `agentOptions`. These are NOT per-call agent args — the model-facing `subagent` tool exposes only `{ description, prompt, run_in_background }`; the full request shape is the plugin-service path (§10.9).
- **`router.ts` native resolution:** each role in `recursive-router.json` (analyst, planner, code-reviewer, tester, memory-auditor, …) resolves in order: (1) native `ctx.subagents` provider → (2) external-CLI route (codex/claude, today's path) → (3) `self-audit`/`local-controller` fallback. The router's `mode: external-cli` gains a native tier *above* it; the capability probe decides which tier is live.
- **Review-bundle builder emits the context-in `prompt`:** `recursive-review-bundle.py` already packages the minimum inputs; the plugin's TS `review.ts` converts that bundle into the child's `prompt` (ContentBlock[]), *including explicit references to the run docs* (upstream artifact paths, diff basis from `00-worktree.md`, changed-file list, audit questions, required output shape, relevant addenda).
- **Context-out contract enforced:** child returns via `report` (+ `outputSchema` structured result when the provider supports it); the plugin validates the child's claimed references against actual files/run dir; writes the durable action record under `/.recursive/run/<run-id>/subagents/` (bridge block) and the routed transcript under `evidence/router/`; records `Subagent Capability Probe` + `Delegation Decision Basis` in the phase doc.
- **Optionality preserved:** when no provider is composed, capability probe fails, or the probe times out (`probe_timeout_ms`), the router falls back to `self-audit`/`local-controller` — the bridge block's mandatory behavior. Subagents are *available* and *deeply integrated* but never *required*.
- **Continuable audits:** `backgroundMode: continuable` + `reportDelivery: wakeup` gives each audit a durable child thread — the main agent can follow up (`send_message`), interrupt, or list descendants mid-run, and the child's session survives across parent sessions.

### 10.5 The delegation contract — references are REQUIRED, in both directions

**References are not optional.** The bridge block already demands verified references ("verify it against actual files, actual recursive artifacts, and the actual diff"); the plugin makes this the *enforced contract* — a delegation whose context-in lacks concrete references, or whose context-out report fails to cite them, is rejected and sent back, never accepted as a minor nit.

**Context-in — what the child always receives (the `prompt` the plugin builds), with mandatory references:**

1. **Role + objective**: "You are the `code-reviewer` for run `<run-id>` phase `<phase>`."
2. **Run-doc references (REQUIRED)**: every delegation cites the exact run docs the child must open — upstream artifact paths (`00-requirements.md`, `02-to-be-plan.md`, …), the diff basis from `00-worktree.md`, the current phase artifact, relevant addenda, and `/.recursive/RECURSIVE.md` + `AGENTS.md`. Bare mentions are not enough: each reference is a concrete path the child is told to read.
3. **Code references with line numbers (REQUIRED when the delegation concerns code)**: the changed-file list with **file paths AND line ranges** (e.g. `src/router.ts:120-156`) tied to the audit questions — the child must jump to the exact code under review, not rediscover it.
4. **Audit questions + required output shape**: the phase-specific checklist (`--audit-question`) and the exact result format (`--required-output`). On the agent-driven `subagent` tool this stays the `report` + reference-validation contract (the agent cannot set `outputSchema` per call — see §10.9); on the plugin-driven path (`ctx.subagents.start()`) it becomes the `outputSchema`.
5. **Constraints**: scope (toolFilter), depth, workspace (shared), and "reference relevant shared paths in your report".

**Context-out — what the main agent requires back, with mandatory references:**

1. **A self-contained `report`** (not "done") summarizing conclusions, with **references to the docs/code the child wrote** — every finding cites the run doc, file, and (for code) the line range it is based on ("reference relevant shared paths" is the built-in contract — `tool-subagent-report/src/index.ts`).
2. **Structured result** via `outputSchema` when the provider supports it (machine-checkable, not free prose) — the structured value carries the same references, not just a verdict.
3. **Reference validation (REQUIRED)**: the plugin checks every reference the child claims — run-doc path exists, code path exists, line range is within the file, and the content actually matches the diff/files before acceptance (bridge block: "verify it against actual files, actual recursive artifacts, and the actual diff"). A reference that fails validation fails the delegation.
4. **Durable record**: action record under `subagents/` + routed transcript under `evidence/router/`; the phase doc records `Delegation Decision Basis`.

### 10.6 Delegation handoff docs — file-backed contract (main-agent doc + per-child docs)

**The delegation contract is a set of markdown files, and the `prompt` references them** — rather than inlining everything into the prompt, the main agent writes its delegation info into a handoff doc, and each subagent has its own doc for receiving instructions and submitting work/replies. This is the durable, auditable, resumable form of §10.5: the prompt is the *pointer*, the files are the *substance*.

**Layout (per delegation, under the run):**

`/.recursive/run/<run-id>/subagents/<delegation-id>/`

- `handoff.md` — written by the **main agent**. The full delegation info: role, objective, run-doc references, code references with line numbers, audit questions, required output shape, constraints, and the delegation decision basis. This is the context-in source of truth.
- `child-<child-id>/` — one directory per subagent:
  - `brief.md` — the receiving instructions for THAT child: its slice of the handoff (which questions, which refs, what to return), written by the main agent.
  - `reply.md` — the child's submission: conclusions + references (run docs, code files, line ranges), written by the child.
  - `scratch.md` — the child's disposable working memory (§10.7); git-ignored, deleted at settlement.

**The delegation `prompt` is then short and reference-based:**

> "You are the `code-reviewer` for run `<run-id>` phase `<phase>`. Read `/.recursive/run/<run-id>/subagents/<delegation-id>/handoff.md` and `.../child-<id>/brief.md` — they contain the full delegation: run-doc references, code references with line numbers, audit questions, and required output shape. Do the work, write your findings with references into `.../child-<id>/reply.md`, then call `report` citing `reply.md` and the docs/code you referenced."

**Why file-backed:**

- **Prompt stays small** — the child's user message is a pointer, not a wall of context; the substance lives in the shared workspace (which the child shares by design, §10.2).
- **Durable + auditable** — `handoff.md`/`brief.md`/`reply.md` are real artifacts under the run; the bridge block's "verify against actual files" and "durable action record" apply literally. The audit trail is the files themselves.
- **Resumable** — a continuable child (§10.4) resumes by re-reading its `brief.md` and `reply.md`; the main agent follows up by editing `brief.md` or reading `reply.md`. No state is trapped in a transcript.
- **Per-child isolation** — each child gets its own brief/reply/scratch; children never share mutable docs, matching the scratch decision (§10.7).
- **Line-number discipline** — because the handoff and reply are written docs, the main agent must write precise code references (`src/router.ts:120-156`), and the plugin's validation (§10.5) checks them against the actual files.

### 10.7 How subagents and the main agent share scratchpads

**Decision: children get their OWN disposable scratch, plus read access to the parent's run scratch — never a shared mutable scratchpad.**

- **Because children share the parent's workspace** (verified: "The agent that started you shares your workspace" — `tool-subagent-report/src/index.ts`), a child *could* read/write the parent's scratch file directly. **We deliberately scope that.** The plugin gives each child a **child-scoped scratch** under `/.recursive/run/<run-id>/scratch/<child-id>.md` (or the child's own subdir), while the parent's `scratch.md` stays the main agent's working memory.
- **Why child-scoped, not shared:** (1) a shared scratch would let a child's intermediate noise overwrite the main agent's reasoning, and cross-contaminate what each agent believes is its own state; (2) the enforcement gate (§8) treats scratch as non-authoritative — a shared file would multiply the places that rule must be checked; (3) the RLM "state carried between chunks" idea (§9) is per-agent reasoning, and each agent's reasoning is its own. The child's scratch is *its* working memory; the parent's is the parent's.
- **Read access to the parent's scratch (not write):** the child may *read* the parent's `scratch.md` when the context-in prompt includes it (it often contains the parent's in-progress reasoning the audit must be consistent with), but writes go to the child's own file. This preserves the main agent's scratch integrity while giving the child the relevant context.
- **Promotion stays gated:** only the main agent can `--persist` a scratch section into the run docs (§9.4); a child's scratch dies with the child (deleted at child settlement) unless the main agent explicitly promotes it. Child scratch is never committed; the whole `scratch/` dir stays git-ignored.
- **What the child's report references:** the child reports conclusions + references to *docs/code it wrote* (shared workspace, durable paths), not its scratch. Scratch is disposable; the report cites the durable artifacts — exactly the context-out contract.

### 10.8 Rationale — why native, optional, and not reinvented

- **Native is first-class (Option B rejected):** routing to external CLIs works but leaves the harness out of the loop — no native child lifecycle, no `report`, no structured output, no continuable follow-up, no control tools. The plugin's whole thesis ("fully take advantage of plugin capabilities") demands riding `ctx.subagents`; the external CLI becomes the fallback tier, not the primary. This *upgrades* today's model rather than freezing it.
- **Optionality is non-negotiable (Option C rejected):** the bridge block makes self-audit the mandatory fallback ("when subagents are unavailable, perform the same audit as self-audit; do not weaken or skip it"). Making delegation required would violate the workflow's own contract and break the no-provider deployment. Optionality is not a compromise — it is the design the workflow already specifies.
- **Don't reinvent (Option D rejected):** a parallel subagent implementation would lose native context derivation (child inherits parent route/depth/workspace), the capability flags (fail-loud), `report`, continuable sessions, and the control surface. `ctx.subagents` is *the* seam; the plugin's value-add is the workflow integration (router, bundles, records, gates), not a new transport.
- **Ship with delegation, not without (Option E rejected):** audited phases *require* audit/review; delegation is core. But Phase B (native delegation) can land after Phase A (parity shell) — the ordering is in §4.5, not an omission.

### 10.9 The two native surfaces — and why the proposal uses BOTH

DSH exposes subagents through **two distinct seams**, and a correct integration must name which one each recursive feature uses. Conflating them is the one place a subagent design goes wrong.

| Surface | Who calls it | Per-call shape | Where per-delegation shape comes from |
|---|---|---|---|
| **`subagent` tool** (`tool-subagent`) | The **agent itself**, during a turn | `{ description, prompt: string, run_in_background? }` only | Uniform config in `agent.cordis.yml`: `provider`, `maxDepth`, `toolFilter`, `persona`, `agentOptions` (set once) |
| **`ctx.subagents.start()`** (`SubagentStartRequest`) | **Plugin/host code** (`router.ts`, `review.ts`, enforcement service) | Full request: `label, prompt: ContentBlock[], parent, signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona?` | Per delegation, chosen by the caller |

**Consequence — two correct delegation paths, matched to the caller:**

1. **Agent-driven (the model's own delegation, in-flow).** When the main agent decides *during a turn* to delegate ("audit this phase", "review this file"), it calls the `subagent` tool with a `prompt` string. It **cannot** set `outputSchema`, `toolFilter`, or `persona` per call — those are fixed by the preset composition. The contract it *can* enforce per call is the **file-backed handoff** (§10.6): the prompt is a pointer to `handoff.md`/`brief.md`, and the child returns via `report` + `reply.md`. Output discipline is *contractual* (references are required, §10.5), not schema-enforced.
2. **Plugin-driven (host-orchestrated, out-of-flow).** When the plugin's `router.ts`/`review.ts`/enforcement service resolves a role and starts the child itself (e.g. the Phase-3.5 mandatory review gate wants a guaranteed, machine-checkable result), it calls `ctx.subagents.start()` with the **full request**: a `ContentBlock[]` prompt, a per-delegation `outputSchema` (object-rooted, so the child must return the required report shape), `toolFilter` narrowed to that role, a `persona`, and an explicit `maxDepth`. This is where `outputSchema` becomes a real, enforced guarantee rather than a convention.

**Why the proposal needs both:**

- **Agent-driven covers in-flow judgment** — the main agent can't be forced to route every delegation through host code; it must be able to say "delegate this now" and have it work. The `subagent` tool + handoff files gives it that, with the reference contract carrying the rigor.
- **Plugin-driven covers enforced gates** — Phase 3.5 is **mandatory** (§11.10 deviation), so the enforcement layer must be able to *force* a review to happen and *validate* its result. `ctx.subagents.start()` + `outputSchema` + `toolFilter` is the only surface that guarantees the shape before accepting the audit; the agent-driven path alone would let a child report free prose and the gate would have to trust it.
- **The external-CLI fallback (§10.3 B) sits below both** — when no provider is composed, agent-driven calls surface as a missing tool, and plugin-driven calls short-circuit to the `recursive-router.json` external route or `self-audit`. The two surfaces share one router, one policy, one record format.

**So the honest answer to "are we implementing subagents properly?":** the prior §10 draft leaned on the *programmatic* request shape (`outputSchema`/`toolFilter`/`persona` per delegation) as if the agent set them per call — it cannot. The corrected design is **two paths**: the agent's `subagent` tool for in-flow delegation (prompt string + handoff files + report/reference contract), and the plugin's `ctx.subagents.start()` for enforced, schema-validated delegation (the Phase-3.5 gate and any host-orchestrated role). Both are native; neither reinvents anything; each is used where its caller actually lives.
### 10.10 Consequences and follow-ups

- **Router decision — policy stays, CLI wrappers don't (answering "is the router useful or redundant?").** The `recursive-router.json` **policy file is useful and stays**: it is the declarative delegation policy (roles, `mode`, `cli`+`model`, probe/invoke timeouts, `fallback: self-audit | local-controller`) that the bridge block's `Subagent Capability Probe` + `Delegation Decision Basis` records draw on, and `router.ts` resolves it to a native provider. The **router CLI scripts are redundant in the plugin and are NOT vendored**: upstream they exist to probe/invoke *external CLIs* with a bundle, but DSH's `ctx.subagents` seam replaces that whole job — the capability probe is the provider registry, invocation is `ctx.subagents.start()`, routing is `router.ts` reading the policy, and external CLIs (codex/claude) ride the existing `codex`/`claude-code` providers instead of py/ps1 wrappers. Net: keep `recursive-router.json` as config, implement `router.ts` against it, drop `recursive-router-*.{py,ps1}` from the vendored runtime (§4.2, §4.3, Phase B). The `success:false → repair → rerun → verify` contract and `evidence/router/` records are preserved in the plugin service, not the scripts.
- **Build plan:** Phase A composes the subagent rows + `router.ts` native tier stub. Phase B (Delegation native) is the heart: `review.ts` → context-in prompt builder; `ctx.subagents.start` with `outputSchema`/`toolFilter`/`maxDepth`; child-scoped scratch (§10.7); report validation + action records; capability probe → router fallback. Phase C adds the enforcement integration (delegation decision basis is a gate input). Phase D renders subagent activity in the dashboard + e2e.
- **Open decision (tracked in §13):** default provider (`spawn` vs `fork` vs an external one) and default `backgroundMode` (`one-shot` vs `continuable`) for recursive audits; and whether child-scoped scratch should be a sibling file (`scratch/<child-id>.md`) or a subdir.
- **References for implementation:** `docs/subsystems/subagent.md` (seam, request shape, capabilities, continuable); `packages/subagent/{tool-subagent,tool-subagent-control,tool-subagent-report}/src/index.ts` (tool/config/report); `packages/subagent/subagent/src/{types,child-agent,continuation}.ts` (request, child composition, continuable); `packages/subagent/subagent-spawn-in-process/src/index.ts` (in-process provider); this repo's `/.recursive/config/recursive-router.json` + `skills/recursive-review-bundle/SKILL.md` + `AGENTS.md` bridge block (the contract); §9 (scratch semantics) + §8 (enforcement) of this proposal.
## 11. Run-state UI: a kanban board + drill-down inspector (decision record)

> **Decision:** ship a **client-side UI plane** (`dsh.client` web module) that renders recursive run state as a **kanban-style board** — one column per workflow phase (`0` Worktree/Requirements → `1/1.5` Analysis (AS-IS + optional Root Cause) → `2` TO-BE → `3/3.5` Implementation + Code Review → `4` Tests → `5` QA → `6–8` Closeout (DECISIONS/STATE/Memory)), one card per run, each card showing its in-phase status — that is **clickable into a drill-down inspector** showing the run's phases, decisions, reasoning, subagents, evidence, and scratch. State comes from **session projections** (pure fold units over `recursive/*` events) pushed live through the session-query/projection frame; UI seats use the slot system (sidebar entry + details seat); per-run activity also renders as **conversation nodes** in the Chat view.
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.
> **Consequences:** a `recursive` client module (platform web) registers a sidebar slot entry + a details seat + conversation nodes; a `recursive` projection unit folds `recursive/phase`, `recursive/gate-blocked`, `recursive/tamper`, `recursive/subagent-*` events into per-run wire-JSON state (§11.4); the board is live (replays events, pushes updates), per-run cards open the inspector (§11.5); conversation nodes correlate run events into the Chat view (§11.6); visualizations for progress/decisions/reasoning/subagents (§11.7).

### 11.1 Background — recursive run state today (files only, no UI plane)

recursive run state is **entirely file-based** — `/.recursive/run/<run-id>/` phase docs with `Status: LOCKED`/`LockedAt`/`LockHash`, `00-worktree.md` diff basis, DECISIONS/STATE, memory — plus the bridge block's required artifacts (action records under `subagents/`, routed transcripts under `evidence/router/`). **And that file state lives in the run's worktree** (`.worktrees/<run-id>/.recursive/run/<run-id>/`), not the main repo — §4.7 point 0. A user inspecting a run reads markdown files in a file tree. There is **no visual plane**: no way to see at a glance which runs are progressing vs blocked, where each run is in its phase chain, what gates failed, or what subagents are doing. §2.5's gap list includes "no native UI, no events" — this section designs the UI plane that closes it.

### 11.2 Background — the DSH client-UI machinery (verified)

DSH's web client exposes exactly the seats a run board needs:

- **Client modules** (`docs/subsystems/client-modules.md`): a package declares `dsh.client` (`platform: 'web'`, optional `inject`, optional `immediately`) and exports a built bundle at `exports['./client']`; the host scans, composes `window.__DSH_BOOT__`, serves `/plugins/<id>/client.js`. The client module is how the plugin ships UI.
- **Slots** (`packages/client/runtime/src/client/slots.ts`): the UI is a slot tree — ui-layout's AppFrame declares `sidebar`, `conversation`, `details`, `shell.overlay` seats inside the `root` slot (all **single** seats except `shell.overlay`, which is a **list**). The `sidebar` seat is **single and already occupied** by ui-sidebar's `SidebarRoot`, so a plugin registers into its **inner seats** (`sidebar.workspaces`, `sidebar.settings`, `sidebar.footer.action` — `footer.action` is a list) or floats a surface in `shell.overlay`; the **`details` seat** hosts the drill-down. `slots/changed` bridges registration to the renderer.
- **Session projections** (`docs/subsystems/session-projection.md`): a pure fold unit maps `SessionEvent[]` → a wire-JSON whole value; clients read it via a hook; the host pushes changes (apiproxy `session/projection`). **This is how the board gets run state without scraping files** — a `recursive` projection folds `recursive/*` events.
- **Session query** (`docs/subsystems/session-query.md`): `SessionRecord`/`SessionEventRecord` cross-corpus list with filters — **this is how the board enumerates all runs across sessions** (a run's events live in its session's log). **Enumeration is worktree-scoped:** each run's `recursive/run-created` event carries its control-plane root (the worktree path, resolved via §4.7 point 0), so the board groups runs by `{repo, worktree-root}` — a run started in `.worktrees/<run-id>` is listed under that worktree, not under the main checkout, until its branch is merged.
- **Conversation nodes** (`docs/cookbook/adding-a-conversation-node.md`): a client registers a `ConversationNodeDefinition` that correlates a durable event family into a keyed Chat node with typed payload + replayable state — **per-run activity renders inline in the Chat view**.
- **`recursive/*` events (from §8.4):** `recursive/phase` (runId, worktreeRoot, phase, status), `recursive/gate-blocked` (runId, worktreeRoot, gates), `recursive/tamper` (runId, worktreeRoot, file), `recursive/subagent-*` (runId, worktreeRoot, childId, status), `recursive/run-merged` (runId, worktreeRoot → repoRoot) — these are the projection's inputs; `worktreeRoot` is the key that makes the whole plane worktree-aware.

### 11.3 Alternatives considered

| Option | Description | Verdict |
|---|---|---|
| **A. Kanban board + drill-down inspector (adopted)** | Sidebar slot entry opens a run board (one column per workflow phase `0→5` + `6–8 Closeout`, with `1.5` folded into the `1` lane and `3.5` into the `3` lane, one card per run, in-phase status on each card); clicking a card opens the details seat with phases/decisions/reasoning/subagents/evidence/scratch | **Adopted** (see §11.4–11.5) |
| **B. Chat-conversation-nodes only** | Only per-run nodes in the Chat view; no board/inspector | Rejected — nodes show one run's activity but no cross-run overview; the board is the overview (§11.6 complements, not replaces) |
| **C. File-browser pane only** | A tree view of `/.recursive/run/` files | Rejected — raw files, no phase/status/gate semantics; the board's value is the *derived* state, not the files (§11.4) |
| **D. Terminal/CLI only** | No web UI; status via `/recursive status` | Rejected — the ask is a UI plane; the board complements the CLI, it does not replace it (§11.9) |
| **E. Full custom page** | A standalone route/page outside the slot system | Rejected — breaks the slot/seat model; a sidebar + details seat is native and additive (§11.4) |
### 11.4 The board — kanban columns, one card per run, live from the projection

**Layout.** A `recursive` client module registers a **board entry** via `sidebar.footer.action` (list seat) or a floating `shell.overlay` surface ("Recursive runs") that opens the board; the board renders in the app frame (the `sidebar` seat itself is single/occupied — see §11.2). **Columns are the workflow's phase chain** (RECURSIVE.md §"Phase definitions"), not status labels — the board reads as runs moving down the lane through the real gates:

- **`0` Worktree / Requirements** — `00-worktree.md` isolation + `00-requirements.md` (Iron Law: never work on main without consent).
- **`1 / 1.5` Analysis** — `01-as-is.md` (audited) plus the *optional* `01.5-root-cause.md` (Root Cause, only when debugging is involved, audited when present); `1.5` nests inside the analysis lane because it consumes `01-as-is.md` as input and must be LOCKED before `2` when present.
- **`2` TO-BE plan** — `02-to-be-plan.md`, audited (Requirement Mapping, Plan Drift Check, plan-stage Requirement Completion Status).
- **`3 / 3.5` Implementation + Code Review** — `03-implementation-summary.md` (audited, TDD Mode: strict|pragmatic, RED/GREEN evidence) plus **mandatory** `03.5-code-review.md` (Code Review, audited, FAIL sends the run back to `3` repair) — a deliberate dsh-recursive-mode deviation from upstream's optional 3.5; `3.5` nests inside the implementation lane because it reviews the same change surface and gates `4`.
- **`4` Tests** — `04-test-summary.md`, audited (pre-test audit → parallelizable only inside the phase).
- **`5` Manual QA** — `05-manual-qa.md`, *not audited*; declares `QA Execution Mode: human|agent-operated|hybrid` (human/hybrid need sign-off).
- **`6–8` Closeout** — the three delta receipts `06-decisions-update.md` (updates `/.recursive/DECISIONS.md`), `07-state-update.md` (updates `/.recursive/STATE.md`), and `08-memory-impact.md` (updates `/.recursive/memory/*`), all audited; completion rule: the run is not complete until `8` passes. They share one lane because all three are concise delta receipts pointing at final control-plane docs (RECURSIVE.md §"Phase 6/7/8 receipts") — the drill-down inspector expands the lane into its three rows (§11.5).

**Each card carries its in-phase status as a sub-state strip** (the audit loop, not a column): `Draft → Audit → Repair → Re-audit → Pass → Locked`, plus `Blocked` (QA sign-off pending, subagent fallback, goal pause-on-block) and `Tampered` (lock-hash mismatch). A card sits in the column of its *current* phase and shows where it is inside that phase's gate loop; `Status: LOCKED` + `LockedAt` + `LockHash` per locked phase feed the lock-validity badge (§11.5).

**One card per run**, carrying the at-a-glance facts:

- **Run identity**: run id, title, template, repo, last activity time.
- **Progress**: phases locked / total over the core phases — 9 core + mandatory `3.5` (e.g. `3/10`); `1.5` optional, counted when present (e.g. `4/11`); `6`/`7`/`8` are three phases inside the Closeout lane — with a small progress bar (§11.7).
- **Status badges**: current phase, `Audit: PASS`/`Coverage: PASS`/`Approval: PASS`, `TDD Mode`, `QA Execution Mode`, lock-validity icon.
- **Tamper**: red badge when an `fs/observed` lock-hash mismatch fired (`recursive/tamper`).
- **Subagent activity**: dots/chips per active delegation + provider (running/done/failed/fallback) from `recursive/subagent-*` events.
- **Evidence & addenda**: counts + clickable evidence links, addenda count (effective inputs, §8).
- **Scratch chip**: run-scoped scratch exists + "disposable" (never authoritative, §9).

**Live updates — worktree-aware.** The board subscribes to the `recursive` session projection via the projection hook; `recursive/*` events fold deterministically into per-run wire-JSON, and the host pushes changes (apiproxy `session/projection`). **Every event that feeds a card carries the run's control-plane root** (the worktree path) — `recursive/phase`, `recursive/gate-blocked`, `recursive/tamper`, `recursive/subagent-*` all include `{ runId, cwd/worktreeRoot }` — so the fold resolves each run's file-backed state against the *same worktree the run executes in* (§4.7 point 0). Cross-run enumeration uses `session-query` with filters on `event.data.worktreeRoot` + `event.kind` + `runId`. The board never scrapes `/.recursive/run/` directly; when it needs a file fact (e.g. a lock-hash re-check, a fresh `Status:` read after a merge), it asks the **host-side service** (via a projection request or a dedicated query), which resolves the worktree root and returns the parsed value — the files stay the source of truth, the projection is the derived view, and the client is read-only (§11.8). After a worktree branch merges, the run's phase receipts become visible at the main repo root too; the board then shows the merged run under the repo root, not the stale worktree path.

### 11.5 The drill-down inspector — click a card, inspect the run

Clicking a card opens the **details seat** with a per-run inspector, sectioned to mirror the workflow's own control plane:

- **Phases** — the vertical phase chain `0` Worktree/Requirements → `1/1.5` Analysis → `2` TO-BE → `3/3.5` Implementation + Code Review → `4` Tests → `5` QA → `6–8` Closeout; the board's `1/1.5`, `3/3.5`, and `6–8` lanes expand into their full rows here (for `1/1.5`: `1` AS-IS + `1.5` Root Cause when present; for `3/3.5`: `3` Implementation + `3.5` Code Review, always shown — mandatory; for `6–8`: `6` DECISIONS / `7` STATE / `8` Memory), one row per phase: in-phase status (Draft/Audit/Repair/Re-audit/Pass/Locked/Blocked), lock badge + `LockedAt` + `LockHash` (truncated, copyable), `Requirement Completion Status` per `R#` (machine-checkable, §8), `Audit`/`Coverage`/`Approval` PASS marks, `TDD Mode`, `QA Execution Mode`. Clicking a phase opens its phase doc and audit trail.
- **Decisions** — run-relevant `DECISIONS.md` entries (the control-plane projection exposes the shards the memory injector already reads): what was decided, when, and by whom (self vs subagent).
- **Reasoning** — a timeline of log-folded `recursive/phase` events (turn/step coordinates, gate results), plus the scratch chip; deliberately *not* the raw transcript (trajectory/log already covers that role, §9).
- **Subagents** — per-delegation cards: role, provider, child id, status (running/done/failed/fallback), `Subagent Capability Probe` + `Delegation Decision Basis`, action-record link under `subagents/`, routed transcript under `evidence/router/` (bridge block). A simple lineage tree (main → child → grandchild) renders from the start request's `parent` + depth (§11.7).
- **Evidence** — evidence links (Playwright `test-results/`, traces, screenshots), diff basis from `00-worktree.md`, review-bundle path.
- **QA & closeout** — QA sign-off button (human/hybrid modes need it, §4.3 UI row), closeout receipts for Phases 6–8.
- **Tamper** — lock-hash mismatch warnings with the offending file path.

### 11.6 Chat integration — conversation nodes + a status strip

- **Conversation nodes (per run).** Following `adding-a-conversation-node.md`, the client registers a `ConversationNodeDefinition` over the event family `recursive/run-created` → `recursive/phase` → `recursive/gate-blocked` → `recursive/subagent-*`, keyed by the stable `runId` **plus its worktree root** (each event carries `worktreeRoot`, §11.4). Each run renders a compact, updating node in the Chat view — the same card facts as §11.4 (phase, badges, tamper, subagent dots) — so run activity is visible exactly where the user is already reading, without leaving the conversation. When the worktree branch merges, the node re-keys to the repo root (the `recursive/run-merged` event) so the conversation history stays attached to the run.
- **Status strip.** A thin always-visible strip (sidebar or app frame footer) for the *active* run: current phase, gate state, lock-validity, tamper badge. This is the "minimal first" surface from open question 8 (§12) — the board (Phase D) is the full plane; the strip is the zero-effort glance.
### 11.7 What else to display — the visualization catalog

The board, inspector, and nodes render these derived visuals (each one grounded in a real event or file):

| Visual | Renders | Data source |
|---|---|---|
| **Progress bars** | per-run `phases locked / total`; per-phase draft→locked steps; requirement completion (`R#` implemented+verified / total) | `recursive/phase` events; `Requirement Completion Status` in phase docs (§8) |
| **State** | column + status badges + lock-validity icon + tamper badge | `recursive/phase`, `recursive/tamper`; lock hash from phase doc — **resolved under the run's worktree root (§4.7 pt 0)** |
| **Decisions** | run-relevant `DECISIONS.md` feed (what/when/by-whom) | control-plane projection (memory-injector shards) |
| **Reasoning** | log-folded phase timeline (turn/step, gate results) + scratch chip | `recursive/phase` events; scratch dir (§9) |
| **Subagents** | delegation cards (role/provider/status/fallback) + lineage tree (main→child→grandchild) | `recursive/subagent-*` events; start-request `parent` + depth (§10) |
| **Gates** | per-phase gate checkmarks (pre-step, tool guards, TDD evidence, effective-inputs) with pass/fail | `recursive/gate-blocked` events (§8) |
| **Evidence** | clickable evidence links + diff basis line | `00-worktree.md`; `evidence/` paths — **worktree-relative, resolved by the run's control-plane root** |
| **Memory** | chip showing which `MEMORY.md` shards the run updated (Phase 8) | `recursive/phase` (phase 8); memory dir — **worktree `/.recursive/memory/` while active; merged to repo root after branch merge** |
| **QA** | sign-off button (human/hybrid), QA-mode badge | `ctx.userQuestions`/approval state; phase doc |

**Deliberately NOT shown:** raw transcripts (trajectory/log owns that), scratch content as authoritative input (it is disposable, §9), and anything that would require the client to *write* run state (the client is read-only; all mutation goes through tools/commands).

### 11.8 Coexistence with the baseline UI — layout, placement, and display rules

**Principle: recursive-mode is a *panel and an in-flow node* inside the baseline app frame, never a replacement page.** The baseline owns the app frame (sidebar / conversation / details / overlay seats); the plugin *adds* to those seats. Every recursive surface answers one question: **what is happening in my recursive runs, and how do I get to the underlying files.** This section fixes exactly where each surface lives, when it shows, and why.

**The baseline seats we mount into (verified):**

| Baseline seat | Kind / scope | Baseline occupant | Recursive usage |
|---|---|---|---|
| `sidebar.footer.action` | list / root | empty (footer actions) | **Board launcher** — a "Recursive runs" action button + unread/blocked badge. Always visible when ≥1 run exists; dimmed/empty when none. |
| `shell.overlay` | list / root | empty (floating overlay) | **Board panel (primary surface)** — the kanban board floats as an overlay/drawer over the conversation. Not a route; it is the run-level *overview*, shown on demand. |
| `conversation.view` | list (tab ring) / — | chat, trajectory | **No new tab.** We deliberately do NOT add a "Recursive" tab: the board is an overlay, the inspector is a details replacement, so a third tab would compete with trajectory for the same screen space. |
| `conversation.chat.node` | business renderer / session | text/tool rows | **Run node** — one compact, live node per run in the message flow (§11.6), always renderable inline. |
| `details` | single / session | DetailsPanel (tool-call I/O) | **Inspector swap** — when a user clicks a run card/node, the details column shows the **recursive inspector** instead of the tool-call details; a "back to tool details" affordance restores the baseline occupant. |
| `settings.section` | list / root | General / Plugins / … | **"Recursive" settings page** — policy (strict|advisory), scratch format, provider defaults, preset install path. Always present; no run needed. |
| `conversation.composer.dock` / `input.overlay` | list / session | (empty) | **Status strip** — the active run's phase/status/tamper chip docks above the composer (§11.6), only when the *current session* is a recursive session. |

**Display rules — what shows, when, and why:**

1. **Always on (global, no run needed):** `sidebar.footer.action` board launcher (dimmed when no runs) + `settings.section` recursive page. Rationale: users must discover the feature and configure policy before a run exists.
2. **On demand (overlay, any session):** the kanban board via the launcher. Rationale: run state is cross-session, so it must be reachable from any session, but it must not steal the conversation's screen by default. Overlay, not tab.
3. **In the active conversation (session-scoped):** the run node (inline in the flow) + the status strip (docked at the composer). Rationale: the conversation is where the agent is actually working; run progress belongs *next to* the work, not behind a panel.
4. **Details swap (session-scoped, click-driven):** clicking a run card/node makes the `details` seat show the recursive inspector. Rationale: the details column is already the "inspect the thing I clicked" surface (today tool-call I/O); a run is just another inspectable thing. Swap the occupant, keep the frame.
5. **Never shown:** raw transcripts in the board/inspector (trajectory owns that), scratch content as authoritative (disposable, §9), and anything that implies the client writes run state (read-only client, §11.9 rationale).

**Why this layout, not alternatives:**

- **Overlay for the board, not a tab** — the conversation already has a tab ring (chat / trajectory); a third "Recursive" tab would fragment the primary work surface. An overlay gives the cross-run overview *without* competing for the tab. The board is a *second-order* view (inspect runs), the conversation is the *first-order* view (do work).
- **Details swap for the inspector, not a new column** — the details seat is single-occupant and already means "the thing I clicked"; swapping its occupant for a run inspection reuses the muscle memory (click → details), and the tool-call details return when the user clicks a tool row again. No layout surgery.
- **`sidebar.footer.action` for the launcher, not `sidebar.workspaces`** — `sidebar.workspaces` is single and owned by ui-workspace (a session picker); hijacking it would break workspace selection. The footer action list is *meant* for exactly this kind of additive entry, and it can carry a badge (unread blocked runs).
- **Status strip at the composer dock** — the composer is where the user types the next turn; the strip is the glance that says "you are in run 75, phase 3, gates OK" *before* they type. It is the recursive equivalent of the plan-mode indicator, placed where the next action starts.
- **Run node inline, not a summary card in a panel** — the conversation node keeps the run's progress inside the flow where the agent's reasoning is already visible; a separate panel summary would duplicate what the board already shows. The node is the *in-flow* projection; the board is the *cross-run* projection.

**Baseline UI we explicitly reuse rather than reimplement:**

- **App frame + columns** (sidebar / center / details, width prefs, collapse) — `ui-layout` owns it; we only fill seats.
- **Tool-call details** — unchanged; the recursive inspector swaps in only for run clicks, then swaps back.
- **Trajectory view** — unchanged; recursive reasoning *references* the trajectory rather than re-rendering it (§11.7 "deliberately NOT shown").
- **Session picker / workspace switcher** — unchanged; runs are scoped to a repo workspace, but selection stays the baseline's job.
### 11.9 Rationale — native slots + projections, read-only client

- **Native seats, not a custom page (Option E rejected):** sidebar + details + conversation-node registration is the supported, additive way to extend the web client (`slots.ts`); a standalone page breaks the seat model and the shell's layout invariants. The board is a first-class peer of the built-in views, not a bolt-on iframe.
- **Projection over files (Option C rejected):** the board's value is *derived* state — phase, gate, tamper, subagent — which is exactly what a projection folds from `recursive/*` events. Scraping `/.recursive/run/` in the client would duplicate the parsing the host already does, race file writes, and couple the client to the file layout. Files stay the source of truth; the projection is the view (same pattern as session-projection's own design).
- **Read-only client:** the UI observes and navigates; every mutation (lock, QA sign-off, addendum, review) goes through the host tools/commands, so the enforcement gates (§8) stay the single enforcement path. The board can never be a bypass.
- **Kanban form fits the workflow:** the phase-chain lanes *are* the workflow's state machine (`0` → `1/1.5` Analysis → `2` → `3/3.5` Implementation + Code Review → `4` → `5` → `6–8` Closeout), the in-phase status strip is the audit loop (`draft→audit→repair→re-audit→pass→lock`), and a card per run gives cross-run overview with click-through depth. It is the minimum UI that answers "what is happening across my runs" and "what is happening inside this run".
- **Chat nodes keep the loop in-context:** the conversation node means the user does not have to leave the chat to see a run advance; the status strip is the always-on glance. Board + nodes + strip cover overview, detail, and inline.

### 11.10 Consequences and follow-ups

- **Deviation from upstream:** making Phase 3.5 (Code Review) mandatory is a deliberate deviation from upstream recursive-mode, which marks it optional. Consequence: every run must produce a reviewed `03.5-code-review.md` before `4` — the lock chain enforces it, and the `3/3.5` lane always shows the `3.5` row. The deviation is justified because (a) the audited-phase contract already *requires* review for Phase 3 and 3.5 is where that review is recorded, (b) the review bundle + delegated `code-reviewer` role are now first-class plugin capabilities (§10), and (c) a mandatory review gate strengthens the TDD/quality guarantees the workflow already declares. Revisit if upstream makes 3.5 mandatory or if the community objects.
- **Build plan:** Phase D is the full model: `recursive` client module mounts the §11.8 coexistence plan (`sidebar.footer.action` launcher + `shell.overlay` board + `details` inspector swap + `conversation.chat.node` run node + `settings.section` page + composer-dock status strip), the `recursive` projection unit folding §11.4 events, the visualization catalog (§11.7); e2e in `apps/web/tests/` + client tests mirroring `packages/client/ui-commands/tests/` and the conversation-node cookbook; verify the board enumerates runs via `session-query`, updates live via `session/projection` push, and that the details-seat swap restores the baseline tool-call details. Landing order stays "minimal first": status strip + run node first, board + inspector + settings page second.
- **Open decisions (tracked in §13):** (1) board placement is now **resolved** by §11.8 (`shell.overlay` for the board, `sidebar.footer.action` for the launcher); remaining open: (2) conversation node granularity — one node per run (proposal) vs one per phase; (3) reasoning timeline depth — log-folded phase events only (proposal) vs deeper step-level fold; (4) lineage tree v1 scope — flat delegation list (proposal) vs rendered tree; (5) whether the QA sign-off button is rendered in v1 or the command path only.
- **References for implementation:** `docs/subsystems/client-modules.md`, `docs/subsystems/session-projection.md`, `docs/subsystems/session-query.md`, `docs/cookbook/adding-a-conversation-node.md`; `packages/client/runtime/src/client/slots.ts` (seat registration); `packages/client/ui-commands/tests/` + `apps/web/tests/agent-preset-selection.e2e.ts` (e2e patterns); §8 (events + enforcement, the projection's inputs) + §9 (scratch chip semantics) + §10 (subagent events + lineage).
## 12. Training & in-context learning: adapting recursive-training to DSH (decision record)

> **Decision:** recursive-training stays **repo-local, file-based, in-context learning** — never parameter updates — and the plugin turns its six Python/PowerShell scripts into a **phase-anchored lifecycle**: *load before work* (Phase 0/1/2), *extract after work* (Phase 8 closeout), *sync on demand* (any phase), and *MCP as an optional transport* via the native `mcp-client` plugin. The plugin does NOT rewrite the extraction prompts — it wires the existing scripts into DSH lifecycle hooks and tool calls, with the extractor resolved through the subagent/router tiers (native provider → external CLI → manual/self-audit).
> **Status:** decided (proposal stage). **Owner:** dsh-recursive-mode maintainers.
> **Consequences:** the `recursive` preset gains (1) a session-start loader step that injects `recursive-training-loader.py` output as system-prompt context, (2) a `recursive_closeout --phase 08` post-hook that runs `recursive-training-phase8-trigger.py` (print by default, `--auto` under a config flag), (3) `/recursive train` + `/recursive memory` commands, (4) a `memory.ts` shard-selector that reads `MEMORY.md` for the dashboard; extraction never fabricates memory, never mutates bridges, never leaves the repo.

### 12.1 What "training" means here — and what it does NOT mean

recursive-training is **in-context learning, not weight training**. The SKILL.md's hard rule #2 is explicit: *"No parameter updates. Learning happens through files in `/.recursive/memory/`, not model mutation."* The training pipeline is:

```text
completed runs (Phase-8-locked)  →  parse all *.md  →  group by subsystem
  →  classify group (contrastive | winner-only | insufficient)
  →  extractor emits structured learning items
  →  write /.recursive/memory/domains/<subsystem>.md + training/<task-type>.md
  →  later runs load only relevant items via recursive-training-loader.py
```

So the plugin's job is **not** to train a model; it is to make the memory plane *load at the right moment* and *extract at the right moment*. The memory plane is the same one already in §2.2 and §4.2 — this section fixes the *timing and transport*. **And it stays harness-agnostic throughout (§4.8):** the loader/extractor read and write plain `/.recursive/memory/*.md`; DSH's hooks are strictly *tighter timing and selection around those files*, never a DSH-owned memory format. Any harness or editor can read and edit the same memory between DSH sessions without the plugin knowing.

### 12.2 The six scripts — what each one is for (verified)

| Script | Role | When the plugin calls it | Exit contract |
|---|---|---|---|
| `recursive-training-loader.py` | Retrieve relevant memory items for a task | **Before work** — Phase 0/1/2, after reading `RECURSIVE.md` + `MEMORY.md` | prints items to stdout; empty = continue, never fabricate |
| `recursive-training-sync.py` | Read-only startup guidance (what should I read) | **On demand** — `/recursive memory sync`, session start | read-only; never mutates the memory plane |
| `recursive-training-phase8-trigger.py` | Decide whether to extract after a run | **After Phase 8 locks** — closeout re-run hook | `3` = not enough runs; prints grpo command unless `--auto` |
| `recursive-training-grpo.py` | Build extraction prompts + write memory after extraction | **After Phase 8** (full or `--incremental --run-id`) | `0` = wrote items + refreshed registry; `3` = nothing extracted |
| `recursive-training-extract.py` | Evaluate an extraction prompt (the LLM step) | **During grpo**, as the extractor | `2` = extractor unavailable (grpo must fail, not claim success) |
| `recursive-training-mcp.py` | MCP convenience layer over the same memory files | **Optional transport** — replaced by native `mcp-client` (§12.4) | same reads as loader/sync |

### 12.3 The run lifecycle — when loading and extraction happen

**Loading (retrieve) — before work, not after:**

1. **Session start / run entry** (Phase 0 worktree + requirements): after the plugin confirms the `/.recursive/` scaffold, it reads `/.recursive/memory/MEMORY.md` and runs `recursive-training-loader.py --repo-root . --query "<task description>" --files "<touched paths>"`. The loader output is injected as **system-prompt context** (a `recursive:memory` section via `ctx.systemPrompt.section()`), exactly like the SKILL.md's progressive-disclosure step 3: *"Apply only the returned items that match the current task."*
2. **Phase 1 (AS-IS) and Phase 2 (TO-BE) re-load**: before planning/analysis, the plugin re-runs the loader with the *narrowed* query (now including the subsystem inferred from Phase 1 findings) so the plan sees the most relevant prior learnings. The loader is called **after reading RECURSIVE.md + MEMORY.md, before planning or implementation** — the SKILL.md's canonical timing.
3. **What the loader feeds**: only matched items (max-docs/max-items bounded), as system-prompt context or a pre-task context message — never all historical memory (progressive disclosure, §memory-architecture).

**Extraction (learn) — after work, gated on Phase 8 lock:**

4. **Phase 8 closeout re-run**: re-running `recursive_closeout --phase 08` after Phase 8 is locked invokes `recursive-training-phase8-trigger.py` (the SKILL.md's closeout hook). By default it *prints* the grpo command (no surprise writes); a config flag (`recursive.training.autoExtract: true`) passes `--auto` to run extraction immediately.
5. **Extraction scope**: full training (`grpo.py --repo-root .`) over all Phase-8-locked runs, or incremental (`--incremental --run-id <id>`) over the just-finished run + its subsystem peers. The extractor is the *bounded, resolvable* step below (§12.5).
6. **Write discipline**: grpo writes `domains/<subsystem>.md` + `training/<task-type>.md` and refreshes the `MEMORY.md` training-registry block only on success (`exit 0`). It never modifies locked earlier-phase artifacts, never touches `AGENTS.md` bridges, never leaves the git tree (§memory-architecture "Files never modified by training").

### 12.4 Transport — native MCP bridge replaces the MCP script

The SKILL.md ships `recursive-training-mcp.py` as an optional MCP convenience layer. In DSH the native `@deepseek-ai/dsh-mcp-client` (§3.3) is the better transport: compose one `mcp-client` instance per external MCP server, and it registers `mcp__<server>__<tool>` tools on `ctx.tools`. So the plugin:

- **does not vendor** `recursive-training-mcp.py` as the primary path (the loader/sync scripts are the canonical, work-everywhere path);
- **offers** an optional `recursive.training.mcp` config that composes `mcp-client` against a user-provided training MCP server, exposing the same memory reads through native tools;
- **never runs both** the MCP path and the loader for the same retrieval step (the SKILL.md's "use one or the other, not both").

### 12.5 The extractor — who evaluates the extraction prompts

`grpo.py` builds prompts; `extract.py` evaluates them. The extractor wiring (first match wins, per SKILL.md):

1. `--response-file` / sibling `<prompt>.response.json` (agent-operated offline evaluation),
2. `RECURSIVE_TRAINING_EXTRACTOR_CMD` env with `{prompt_file}`/`{repo_root}` placeholders (external command),
3. otherwise exit `2` (unavailable) — grpo must fail, not claim success.

The plugin maps this onto the **subagent/router tiers** (§10.9): when extraction is triggered, `router.ts` resolves the extractor role to a native `ctx.subagents` provider (a one-shot `subagent` with the extraction prompt), else an external CLI provider, else the `RECURSIVE_TRAINING_EXTRACTOR_CMD` path, else `self-audit` (the main agent evaluates the prompt itself). Whatever tier runs, the result is written as the response file and `extract.py` validates the items before grpo writes memory. **The plugin never embeds an LLM client** — that boundary (§memory-architecture "grpo never embeds an LLM client") is preserved.

### 12.6 Failure handling — never fabricate memory

The plugin surfaces the scripts' exit contract as tool results and, for extraction, as a run-state event:

- **No training scripts installed** → the scaffold bootstrap must run first (the plugin's `bootstrap.ts` installs them).
- **Fewer than 2 Phase-8-locked runs** → trigger exits `3`, the plugin explains that extraction needs more evidence, and no memory is written.
- **Extractor unavailable** → exit `2`; the plugin records the failure and does **not** claim memory updates.
- **No learnings extracted / insufficient groups** → exit `3`; same — no fabricated items.
- **Successful write** → exit `0`, the plugin emits a `recursive/training` event (so the dashboard's Phase-8 chip can show "memory updated") and the memory registry is refreshed.

### 12.7 Consequences and follow-ups

- **`memory.ts` (package layout §4.2) is the loader shard-selector**, not a reimplementation: it reads `MEMORY.md`, picks the relevant shard(s) for the current task, and hands the narrowed query to `recursive-training-loader.py`. The Python stays the source of truth for retrieval ranking.
- **Commands**: `/recursive train` (trigger/full/incremental) and `/recursive memory` (sync/status) map 1:1 to the scripts; both are preset-scoped (§6) so they only appear in the recursive preset.
- **Session-start injection order** (prompt sections): `recursive:policy` (§8.3) → `recursive:memory` (loader output) → role persona. Memory is advisory context, never authoritative — it sits below the control plane in authority.
- **Benchmark exclusion reaffirmed**: recursive-training is the *memory* pipeline, not the recursive-benchmark evaluation harness; the benchmark remains out of scope (§4.3).
- **Build plan**: Phase A vendors the six scripts + `bootstrap.ts` installs them; Phase B wires the loader into session-start + the extractor into `router.ts`; Phase C adds the Phase-8 closeout trigger hook + `recursive/training` event; Phase D renders the memory chip in the dashboard (§11.7 "Memory").
- **Open decision (tracked in §13):** whether `recursive.training.autoExtract` defaults to `false` (print-only, proposal) vs `true` (auto-extract after Phase 8 lock); and whether the extractor role is a dedicated subagent persona or reuses the `code-reviewer`/`analyst` role.
## 13. Open questions / decisions to make before implementation

1. **TS port vs py invocation — RESOLVED:** port **all** runtime scripts to TypeScript (lock, status, lint, effective-inputs, review-bundle, init, worktree, closeout, training loader/extractor/grpo/phase8-trigger/sync). The Python/PS1 stays vendored as the **cross-harness parity reference** (same algorithms, same `recursive-*.py` outputs) until the TS ports are proven byte-equivalent on fixtures; DSH ships the TS ports as primary, py/ps1 as fallback. **Consequence:** Phase A grows (full port), and every port needs a golden-fixture diff against the py output.
2. **Profile strategy — RESOLVED:** the package is a **bundle** that installs into the shipped **`web` profile** via `dsh plugin --profile web add dsh-recursive-mode` (and works in any profile). No new named profile. **Terms (verified):** a *profile* is a DSH install's bundle list + settings (`packages/boot/app-boot/src/profile.ts` — shipped templates are `web` = base + web-app, `headless` = base + headless); a *bundle* is a package whose `package.json` declares `dsh.bundle.patch` and is reconciled into the profile layer stack by `dsh plugin` (a pnpm forwarder). The **`recursive`** preset (our §5 agent preset) is *not* a profile — it is a directory under `$DSH_HOME/.agent-presets/recursive/` that mounts per session. So: bundle → web profile; preset → per-session mode inside it.
3. **Goal-round driver mapping — RESOLVED:** **one goal per run** (a single `ctx.goals` objective per `<run-id>`, advanced phase-by-phase inside that one goal). Resume semantics across sessions follow the goal driver's checkpointing.
4. **Phase guards' blast radius:** `tools/pre-execute` denials must be scoped to the active run's worktree to avoid breaking unrelated work in the same session.
5. **Enforcement strictness (§8.7) — RESOLVED:** **configurable `strict|advisory` per gate** (default advisory). The pre-step gate reads **on transition intent only** (not synchronously per turn), to avoid false positives on unrelated turns.
6. **Scratch format (§9.9) — RESOLVED:** **markdown + optional runnable `scratch.ts`**. Scratch is **never citable as an Input** for a phase doc — the enforcement gate **denies** (strict) a scratch path in a phase doc's Inputs, and `recursive:policy` declares scratch disposable and non-authoritative.
7. **Subagent defaults (§10.10):** default provider (`spawn` vs `fork` vs external) and default `backgroundMode` (`one-shot` vs `continuable`) for recursive audits; and whether child-scoped scratch should be a sibling file (`scratch/<child-id>.md`) or a subdir.
8. **Client UI scope for v1 (§11.10) — RESOLVED:** **full dashboard** (board + inspector + conversation nodes + status strip + tamper badge), implemented with proper UI components and theme in Phase D. (Replaces the earlier "minimal first" proposal; the strip still lands first as the zero-effort glance, but the board is the v1 target, not deferred.)
9. **Board placement (§11.8, resolved):** `sidebar.footer.action` launcher + `shell.overlay` board (decided); remaining UI decisions: conversation-node granularity (one per run vs one per phase); reasoning-timeline depth; lineage-tree v1 scope; whether the QA sign-off button renders in v1.
10. **Preset authoring path (§5.9) — RESOLVED:** static directory shipped with the package. Creator mode remains the manual-authoring/copy path; the user can restart the DSH runtime in creator mode when a copy-out step is needed (no synthesis — the authoring API is a whole-directory copy).
11. **Command grammar (§6.10) — RESOLVED:** the §6.5 split stands — preset-scoped `status|spec|worktree|init|lock|qa|closeout|addendum|review|scratch` + global `bootstrap|list|help`; the client popup renders exactly this grammar.
12. **Code Mode default (§7.9) — RESOLVED:** `mode: both` (Code Mode SDK + native tools) for the `recursive` preset.
13. **Naming — RESOLVED:** `dsh-recursive-mode` (bundle/package name); the preset directory id is `recursive`.

---

## 14. References

### recursive-mode (audited checkout D:\DEV\recursive-mode @ ff75bc7)
- `.recursive/RECURSIVE.md` — canonical workflow spec (2,362 lines)
- `.recursive/README.md` — maintainer notes; bootstrap layout; maintainer commands
- `.recursive/AGENTS.md` — internal router/index
- `.recursive/STATE.md`, `.recursive/DECISIONS.md` — global control-plane docs
- `.recursive/config/recursive-router.json` — routed delegation policy
- `.recursive/memory/MEMORY.md` — memory router/index + freshness policy
- `skills/recursive-mode/SKILL.md` — installable root skill entrypoint
- `skills/recursive-mode/scripts/` — 31 .py + 28 .ps1 runtime scripts
- `skills/recursive-mode/references/agents-block.md` — the AGENTS.md bridge block
- `skills/recursive-mode/references/bootstrap/RECURSIVE.md` — packaged non-hidden bootstrap copy of the spec
- `skills/recursive-{spec,worktree,debugging,tdd,review-bundle,router,subagent,training}/SKILL.md` — subskills
- `scripts/test-recursive-mode-smoke.{py,ps1}`, `scripts/run-recursive-benchmark.{py,ps1}`, `scripts/test_*.py` — maintainer harness
- `AGENTS.md`, `.codex/AGENTS.md`, `.agent/PLANS.md` — bridge docs
- Upstream: https://github.com/try-works/recursive-mode

### DeepSeek Harness (audited checkout D:\deepseek-harness @ 47f943859b / dsh 0.1.0-rc.5)
- `docs/architecture.md`, `docs/capability-seams.md` — system/extension-point map
- `docs/cordis-primer.md` — Cordis ideas (plugin/context/inject/events/effects)
- `docs/cookbook/extension-cookbook.md` — plugin shapes + feature→mechanism map
- `docs/user/develop/basic/publish.md` — bundle/profile/install/publish mechanics
- `docs/user/develop/basic/tool.md`, `docs/cookbook/adding-a-tool.md` — tool authoring
- `docs/user/develop/basic/config.md` — Schemastery config + HMR
- `docs/subsystems/{commands,goal,client-modules,workflow,workspace,skills,plan}.md` — service surfaces
- `packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml` — shipped composition
- `packages/skill/{skill,skill-filesystem,tool-skill}/src/index.ts` — skills registry/provider/tool
- `packages/goal/{goal,goal-round-driver,tool-goal}/src/*.ts` — goal domain + driver + tool
- `packages/workflow/{workflow,tool-workflow,tool-ralph}/src/*.ts` — workflow seam + tools
- `packages/core/system-prompt/src/index.ts` — prompt section registry
- `packages/plan/plan-mode/src/index.ts` — mode guard pattern
- `packages/interaction/commands/src/index.ts` — command registry
- `packages/extensions/{tool-cordis,cordis-host-runner}/src/*.ts` — dynamic plugin runner
- `apps/cli/reference/README.md`, `apps/cli/README.md` — CLI/profile/plugin behavior reference
- `apps/cli/config/agent-presets/{standard,cordis,code,minimal}/` — agent preset format
- `apps/web/tests/*.e2e.ts`, `examples/*/cordis.yml` — test/composition patterns
- Upstream: https://github.com/deepseek-ai/deepseek-harness

### Web sources
- [create-dsh-plugin (npm)](https://www.npmjs.com/package/create-dsh-plugin)
- [RFC: official plugin scaffold — Discussion #1629](https://github.com/deepseek-ai/deepseek-harness/discussions/1629)
- [dsh-plugin topic on GitHub](https://github.com/topics/dsh-plugin)
- [dsh-tui (out-of-tree bundle example)](https://github.com/openguardrails/dsh-tui)
- [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)
- [recursive-mode upstream](https://github.com/try-works/recursive-mode)
