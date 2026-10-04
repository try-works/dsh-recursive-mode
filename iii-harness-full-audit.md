# Full audit — `workers.iii.dev` and `iii-hq/workers`

**Subject.** The iii worker registry entry for `harness` (https://workers.iii.dev/workers/harness) and its source monorepo (https://github.com/iii-hq/workers).

**Purpose.** (1) Describe the architecture, concepts and principles of the iii platform and the `harness` worker. (2) Derive concrete, TypeScript-compatible improvements for `dsh-recursive-mode`.

**Method.** Shallow clone at `D:/DEV/.tmp-iii-audit/workers` (working tree, HEAD `e5775db`). Read in full: the registry page and registry root; the repo `README.md`; `docs/architecture/*`; `docs/sops/*`; `tech-specs/2026-06-agentic/harness.md` (67 KB, the design of record); `harness/README.md` (35 KB); `harness/architecture/*`; `harness/iii.worker.yaml`, `Cargo.toml`, `Makefile`; the root `iii-permissions.yaml`; and the READMEs + function-id namespaces of the sibling workers. Rust internals (turn loop, policy, subagents, deferred calls, deletion) were read via targeted deep-dive passes over `harness/src/`.

**Reading order for a newcomer.** `tech-specs/2026-06-agentic/harness.md` §Definition → §The loop → §Durability & idempotency → §Hooks → §Sub-agents → §Boundaries. Then `harness/README.md` for the operator surface. Then `memory/README.md` for the clearest statement of the repo's philosophy anywhere in the tree.

---

# 1. The registry — `workers.iii.dev`

The site is a **package registry and catalog**, not documentation. It is the discovery and install surface for iii workers.

**Registry-level numbers (as fetched).** 96 workers; 442,680 installs all-time; 33,041 installs in the last 7 days (+222.2%); 2 verified authors. Collections: `data`, `agentic`, `ai`, `coding`, `frontend`, `integrations`, `devtools`. Views: `collections`, `leaderboard`, `publish`, plus GitHub stars.

**Per-worker page.** For `harness` (v1.8.43, 33 functions, 13 triggers, 2 skills, 15 dependencies, ~2,066 installs / 358 in 7d / 23 today):

- **install** — one command: `iii trigger compose::add worker=harness`
- **artifact** — `binary`, license Apache-2.0, per-platform targets (macOS arm64/x64; Linux arm64/armv7/x64; Windows arm64/x64), with the statement *"exact versions are immutable; binary and bundle artifacts are digest-pinned."*
- **provenance** — `repo iii-hq/workers`, author `iii`, `iii verified` badge.
- **tabs** — `readme` (with "open as markdown"), `api reference`, `skills`, `agent`, `context`, `versions`, `dependencies`.

The tabs are not decoration. `api reference` is the published **interface capture** (see §2.5) — the functions and trigger types the worker actually registers, collected from a running process at release time. `skills`/`agent`/`context` expose the worker's agent-facing payload: the `skills/SKILL.md`, the agent profiles, and the context-hint surfaces.

**Consequences of the model.** Because the registry is the install surface and artifacts are digest-pinned, a worker's *published* identity is a compiled, immutable descriptor built from three sources (private build entry + public manifest + package manifest) at a recorded source SHA — see §2.3.

---

# 2. The monorepo — `iii-hq/workers`

## 2.1 Shape and census

```
workers/
  <worker>/            ~80 top-level worker directories
  crates/              shared Rust crates (console-ui, judge-contract,
                       worker-paths, node-core, python-core, config-client,
                       llama-runtime, provider-integration-testkit)
  packages/            shared TS packages (console-ui, agent-terminal-ui,
                       terminal-font)
  docs/                adr/  architecture/  sops/
  tech-specs/          product-level specs (design of record)
  template/            a runnable local stack (compose + profiles + skills)
  scripts/  .github/  .deploy/
  iii-permissions.yaml the default agent permission rules
  pnpm-workspace.yaml  the UI workspace only
```

Census excluding `.git`/`node_modules`/`target`: **2,339 `.rs`**, 1,081 `.ts`, 923 `.tsx`, 863 `.json`, 303 `.md`, 214 `.yaml`, 88 `.py`, 58 `.feature`, 58 `.css`.

**Language distribution is not uniform and the README is wrong about one entry.** The Modules table lists `harness` as **"Node | TS port of the iii harness stack"**. The checked-out `harness/` is **Rust**: `iii.worker.yaml` declares `language: rust`, `deploy: binary`; `Cargo.toml` names `harness` v1.8.43 with `[[bin]] name = "harness"`; `src/turn_loop.rs` is 233 KB of Rust. There is no `turn-orchestrator`, `hook-fanout`, `llm-budget` or `context-compaction` directory anywhere in the tree; those names appear only in prose and in `ade`'s frontend. Treat that README row as stale or ahead of the tree.

Where TypeScript *is* real: `harness/ui` (injected React console UI), `ade/web` (React 19 + Vite SPA), `packages/*`, every worker's `ui/`, the `iii-sdk` npm package, and the Node **bundle workers** (`claude-code`, `cursor`, `pi`, `opencode`, `vscode`, `openwiki`, `opengantry`).

## 2.2 The worker contract

[`docs/architecture/worker-model.md`](<D:/DEV/.tmp-iii-audit/workers/docs/architecture/worker-model.md>) defines the lifecycle:

1. **Connect** — `iii_sdk::register_worker` (or the Node/Python equivalent) over WebSocket, default `ws://127.0.0.1:49134`.
2. **Register** — declare custom trigger types, then register functions; optionally subscribe to engine trigger types.
3. **Serve** — handle invocations until SIGINT/SIGTERM.
4. **Shutdown** — clean disconnect.

**The engine is a bus, not a call graph.** *"Workers do not call each other directly; they invoke functions via `iii.trigger('worker::namespace::function', payload)` and subscribe to trigger types for reactive updates."* Function ids are `::`-separated and prefixed by the worker's domain (`shell::exec`, `session::append`, `shell::fs::read`). Binary workers support `--manifest` to print registry metadata and exit.

The public manifest is [`iii.worker.yaml`](<D:/DEV/.tmp-iii-audit/workers/harness/iii.worker.yaml>):

```yaml
iii: v1
name: harness
language: rust
deploy: binary
manifest: Cargo.toml
license: Apache-2.0
bin: harness
tags: [agent, harness, loop, autonomous]
description: Thin durable turn loop that wires session-manager, context-manager, and llm-router into an agent loop; spawns sub-agents as child sessions.
dependencies:
  state: latest
  queue: latest
  cron: latest
  configuration: latest
  ...
```

The `dependencies` map is what makes `iii trigger compose::add worker=harness` install the whole stack in one command.

## 2.3 Deploy modes and the release boundary

Three kinds ([`deploy-modes.md`](<D:/DEV/.tmp-iii-audit/workers/docs/architecture/deploy-modes.md>)): **binary** (one cross-compiled CLI per target triple), **image** (OCI for Node/Python daemons), **bundle** (single-file archive; esbuild for Node monorepos). The public kind in `iii.worker.yaml` must agree with the private catalog, and *"the compiler rejects mismatches before release build jobs can run."*

The release boundary is explicit and load-bearing:

> **"Release Control is the exclusive operator interface. This repository builds; it never publishes."** ([`docs/sops/release.md`](<D:/DEV/.tmp-iii-audit/workers/docs/sops/release.md>))

[`deployment_compiler.py`](<D:/DEV/.tmp-iii-audit/workers/docs/architecture/worker-compose.md>) "joins the private release entry, public manifest, package manifest, and source SHA once" and emits an immutable `deployment-descriptor.json` consumed by every later phase. Bundles "reject tests, documentation, caches, `node_modules`, and traversal."

## 2.4 Repo conventions and SOPs

**Required for every worker** ([`docs/sops/new-worker.md`](<D:/DEV/.tmp-iii-audit/workers/docs/sops/new-worker.md>)):
a folder + catalog slug matching `^[a-z0-9][a-z0-9_-]*$`; one package manifest owning the version; a consumer-facing `README.md`; a non-empty `tests/`; `iii.worker.yaml`; and a private `.deploy/workers.yaml` entry containing **exactly** `source`, `artifact`, `publish`.

**The contract doctrine** ([`template/agents/backend-engineer.md`](<D:/DEV/.tmp-iii-audit/workers/template/agents/backend-engineer.md>)) is the clearest expression of the repo's values:

> - **"The contract is the product."** Every capability is a registered function with a `description`, `request_format` and `response_format`, named `<worker>::<resource>::<action>`.
> - **"One function per action."**
> - **"Reactive triggers, never polling."**
> - **"Never block on long work."**
> - **"Idempotency is not optional."**
> - **"One home per fact."** Engine `state` for small values others watch; the `database` worker for records — never both.
> - **"Configuration is data"** — never a secret in a default.
> - **"Errors are part of the contract"** — "Never swallow an error into a success-shaped response."
> - **"A green build proves nothing about a runtime contract"** — verify with a real call, and "never `curl`, even on localhost."

**Security rule:** "Never put API keys, tokens, `III_*` connection settings, or mutable external references in public defaults; the compiler rejects them before producing the immutable Registry projection."

**Other hard rules.** "Never write the worker's entry into `worker-compose.yaml` by hand." Consumer READMEs must not show `cargo build` / "From source" blocks; required sections are Install → Quickstart → Configuration.

**Compose** is "a public iii Compose document […] it is not a worker catalog and must not contain top-level `workers` or `stacks` mappings." Fields: `namespace`, `containers`, `worker`, `version`, `start_after`, `config_override`, `environment`, `scripts`.

**Node/TS worker layout** is deliberately one package, not two: `package.json`, `tsconfig.json`, `iii.worker.yaml`, `scripts/dev.mjs`, `src/`, `test/`, `ui/`, generated `dist/` + `dist/ui/`. Node workers ship `deploy: bundle`, `language: javascript`, `runtime.kind: javascript`, with semver `dependencies`. Repo lint is **Biome**.

## 2.5 CI gates

[`docs/architecture/testing-and-ci.md`](<D:/DEV/.tmp-iii-audit/workers/docs/architecture/testing-and-ci.md>). Discovery: a directory is a worker "when it is owned by a `source.path` entry in the private `.deploy/workers.yaml` build catalog." When `harness/` changes, its in-repo dependencies join the matrix. Metadata-only PRs downgrade the version/tests/README gates to notices.

**Per changed worker (`pr-checks`):** README exists and is non-empty; the private catalog entry parses; `iii.worker.yaml` agrees with the catalog on identity, manifest, deploy shape and semver deps; package version ≥ base branch; `tests/` exists and is non-empty. *"Skill documentation is optional and is not part of this validation gate."*

**Language jobs:** Rust `cargo fmt --check` + `cargo clippy --locked -D warnings` + `cargo test --locked --all-features`; Node `biome ci` + `npm test`; Python `ruff` + `pytest`. Toolchain pinned by `rust-toolchain.toml`; `--locked` everywhere.

**The interface boot smoke** is the interesting one, and it exists for a stated reason:

> *"Registry discovery is generated from the functions and trigger types a worker registers. A successful build cannot prove that this metadata is present or typed."*

Flow: build → install CLI, start engine → start the worker from `./target/debug/<bin>` → `collect_worker_interface.py` with a **120 s wait, assert non-empty interface**. Opt-out only via `registry_interface: false` in the manifest, which compiles to an immutable `interface_capture: skipped`. Release prepare repeats capture from the *prepared artifact* and binds `deployment-interface.json` to descriptor + inventory digests — and *"it never invokes worker functions or validates an external backend… Behavioral coverage remains in the dedicated E2E workflows."*

**Dedicated E2E workflows** exist for `ide`, `database`, `storage`, `rbac-proxy` — "Add a dedicated workflow when integration with the full harness stack is release-blocking and too slow for the per-PR matrix." A `_harness-integration.yml` builds the complete stack once and fans out to Integration, Playwright and scenario-validation jobs in parallel.

## 2.6 Documentation architecture

Three layers, with an explicit divergence rule:

| Layer | Role |
|---|---|
| `tech-specs/2026-06-agentic/<worker>.md` | design of record, before/during build |
| `<worker>/architecture/` | as-built reference aligned with the code |
| `tests/features/*.feature` | behavioural truth |

> *"When they diverge, fix the code or update architecture docs in the same PR."*

Per-worker architecture folders are recommended only when a worker "has non-obvious storage, event, or security model" or "other workers or clients integrate via many function ids + trigger types." The recommended layout — taken from `session-manager` — is exactly three files:

```
<worker>/architecture/
  README.md       # index: one paragraph, diagram, vocabulary, doc map
  internals.md    # maintainers: storage, pipelines, invariants
  integration.md  # consumers: function ids, triggers, permissions, sequences
```

Both `harness/architecture/README.md` and `session-manager/architecture/README.md` state the standard: *"These documents are written to be sufficient on their own: a reader (human or LLM) should be able to maintain the worker or integrate against it without opening the source."*

**Executable documentation.** [`harness/tests/prompts.rs`](<D:/DEV/.tmp-iii-audit/workers/harness/tests/prompts.rs>) asserts that every shipped identity prompt describes the surface the harness actually serves:

- a `REMOVED` list (`harness::react`, `harness::notify_agent`, `harness::trigger-call`) — "A prompt naming one sends every agent into a registration error";
- an `UNDISCOVERABLE` list — "Prompts must not name a worker the agent is meant to DISCOVER: naming one preempts discovery and skews any evaluation of whether the agent finds it";
- an assertion that the retired `prompts/subagent.txt` **stays removed**, and that no `provider-*/prompts/identity.txt` reappears.

Its existence is explained in [`harness/architecture/reactive-triggers.md`](<D:/DEV/.tmp-iii-audit/workers/harness/architecture/reactive-triggers.md>): *"That test exists because the removal originally missed all eight provider identity prompts. Agents kept reaching for `react` because they were still being told to."*

---

# 3. The platform model

Five words carry the whole system. The harness README states it:

> iii is a language agnostic runtime where services, agents, and tools are composed of the same things: **workers, triggers, and functions**. One engine holds a live registry of every connected worker, their functions, and the triggers bound to them. Calls route worker to engine to worker, so the language, runtime, and location of a worker are invisible; **the function id is the only contract.**

| Term | Definition | Source |
|---|---|---|
| **worker** | a process that connects to the engine over WebSocket (default `ws://127.0.0.1:49134`), registers functions + triggers, serves until SIGINT/SIGTERM | `docs/architecture/worker-model.md` |
| **engine** | the message bus and the live registry. "Workers do not call each other directly" | ibid. |
| **function** | a registered handler with a `::`-separated id, "conventionally prefixed by the worker's domain" | ibid. |
| **trigger type** | a declared event class a worker registers (`registerTriggerType`) | `DOCUMENTATION_GUIDELINES.md` |
| **trigger** | a *binding* of `{type, function_id, config}` | ibid. |
| **compose** | a running namespace and its containers — "not a worker catalog" | `docs/architecture/worker-compose.md` |
| **directory** | the introspection + registry-proxy worker; also serves skills, system prompts and agent profiles from the filesystem | `iii-directory/README.md` |

**Discovery is the primary UX, and the docs are emphatic that the engine — not memory — is the truth.** From the harness README's "Working with iii" section:

> **"TL;DR: list, info, call. The engine tells you the truth; trust it over memory."**

The runtime catalogue surfaces are: `engine::functions::list` (filter by `prefix`/`search`/`worker`), `engine::functions::info` (*"the request/response schema for ONE function (this is your API reference)"*), `engine::workers::list`/`info`, `engine::triggers::list`/`info`, `engine::registered-triggers::list`. Registry (installable-but-not-installed) discovery goes through `directory::registry::workers::list`/`info`, which proxies `api.workers.iii.dev` and *"mirrors the engine's `engine::workers::list` search input so callers can switch between local and registry surfaces."* Function search is `directory::search_functions` — "one to six external capabilities, returning compact function-id candidates (installed, plus registry workers under `installable`), with a conditional pre-generate hint".

**Installation is one command and is dependency-driven:** `iii trigger compose::add worker=harness` "installs every worker the loop needs; you do not add them one by one."

---

# 4. The `harness` worker

## 4.1 Definition and boundaries

> `harness` is the thin worker that wires the other three into an agent loop. It owns sequencing and nothing else: take an incoming message, persist it, assemble a context, stream a completion, persist the result, execute any function calls, and repeat until the turn stops.
>
> It is deliberately minimal. The rule of thumb: **if a concern grows real logic, it becomes its own worker** rather than living in the harness.

It wires three siblings — `session-manager` (transcript), `context-manager` (token budgeting, a *soft* dependency), `llm-router` (generation) — and carries a fourth hard dependency on `queue` for the durable turn loop.

**Explicitly out of scope**, each delegated to a sibling that binds a hook or subscribes to an event:

| Deferred concern | Sibling | Mechanism |
|---|---|---|
| approval policy + decision surface | `approval-gate` | a `pre_trigger` hook returning `hold`, plus `harness::function::resolve` |
| spend caps | `llm-budget` | `pre_turn`/`pre_generate` hook + `turn-completed` for per-tree aggregation |
| *when* to compact | `context-scheduler` | a reactive trigger; the harness only compacts inline on overflow |
| orchestration beyond spawn/join | — | "agent-to-agent messaging, shared blackboards, workflow graphs, supervisor pools" |
| named per-send option bundles | — | "Consumers own their per-send options; a preset sibling can resolve a name into a `SendRequest` and call `harness::send` itself — **the harness resolves nothing**" |

**Stated boundaries:** it does not store the transcript, build context, or talk to providers; does not gate approvals, meter cost, or schedule compaction; does not orchestrate beyond spawn/join; and **does not define functions** — "functions are the iii substrate."

One design note worth recording: `hook-fanout` was a planned sibling and is now **superseded** — "synchronous lifecycle interception is the core Hooks surface, and async observation is the turn events. **Siblings that need to sit inside the critical path bind a hook; everything else binds events.**"

## 4.2 The loop

`harness::send` is the entry point. It ensures the session (applying `session.metadata`, the tenancy hook), persists the user message, CAS-seeds a turn record, enqueues the first `harness::turn` step, and returns immediately — *or merges into a turn that is already running* (steering; the response carries `merged: true`).

Each `harness::turn` step does:

1. **Mark working + open the turn.** `session::set-status working`, emit `harness::turn-started` (first step only), then run the `pre_turn` hook chain. *"a `deny` ends the turn (`failed`, with the hook's reason) before any model spend."*
2. **Load the active path** — `session::messages` with `include_custom: true` (custom entries carry the compaction record).
3. **Assemble context.** Resolve output strategy and invocation surface *first*, read the latest compaction entry, reduce the candidate window to it, call `context::assemble` with `previous_summary`, the final invocation schemas, deterministic system aids and non-message request overhead. **Context budgeting is fail-closed**: an absent context manager, `context/overflow`, or an empty assembly fails the turn before generation — *"raw history is never substituted."* If `applied.compacted`, persist the new summary. Then run the `pre_generate` chain over the assembled context; a `deny` ends the turn as in step 1. After hooks and call/result repair, **the complete final request is counted again**, and if it exceeds the assembly's `usable` budget the turn fails with `harness.context_overflow` and `router::chat` is never called.
4. **Generate.** Open a channel, call `router::chat` with `request_id = <turn_id>:<step>` (recorded as `stream_request_id` so `harness::stop` can abort it) and, when the output contract rides provider-native structured output, `response_format`. Append an assistant message, then `session::update-message` as deltas arrive. After the final update, run the read-only `post_generate` chain.
5. **Dispatch.** A `submit_result` call is consumed by the harness itself. Everything else is an `agent_trigger` call, unwrapped and triggered **sequentially in content order** — each runs the glob policy, then `pre_trigger`, then the target, then `post_trigger` over the result — appending each `function_result` and **checkpointing per call**. A trigger may report **pending** (a `pre_trigger` hold, or `harness::spawn`): the call checkpoints `pending` and, once the pass ends, the turn **parks**.
6. **Steering check, then finalise.** Re-read the transcript for user-role entries after the turn record's `watermark_entry_id`; if present, take another generate step. Otherwise resolve the turn `result` per the output contract, mark `completed`, set session status `done`, emit `harness::turn-completed`, and — for a sub-agent turn — resolve the parent's pending call.

**Guards.** `max_turns` caps runaway loops (the turn ends `completed` with a synthetic notice). Cancellation is *cooperative between steps and explicit during generation*: `harness::stop` sets an abort flag the next step observes and, when a stream is in flight, also calls `router::abort` with the `stream_request_id`. When the turn has live spawned children, the stop **cascades to them** before the turn finalises. An engine dispatch in flight is raced against the stop: the step stops awaiting, closes the call with a `cancelled` error result (*"the target may still be running; its effects are unknown, not undone"*), and finalises — the dispatch is *detached, not dropped*.

The harness maps its fine-grained `TurnStatus` onto the session's coarse status: `working` while running or awaiting functions, `done` on completed/cancelled, `error` with a short reason on failure.

**Turn state machine** (`types/turn.rs`): `Running | AwaitingFunctions | Completed | Cancelled | Failed`, with `is_terminal()` = Completed | Cancelled | Failed. Transitions: `seed_new` writes `Running, step 0` and enqueues; `advance()` persists `step + 1` and re-enqueues; a deferred call moves to `AwaitingFunctions` and **returns without re-enqueueing**; the finalisers are `finalize_completed` / `finalize_failed` / `finalize_cancelled`.

**Per-call state machine**: `CallState { Triggered | Pending | Done }` carried by `CallCheckpoint { state, function_id, entry_id, child_session_id?, child_turn_id?, child_session_reused?, held_by?, held_arguments?, reconciled?, pending_timeout_ms?, pending_at? }`.

**Named failure phases** — useful vocabulary for anyone instrumenting this: `context_assembly`, `budget_preflight`, `pre_turn`, `pre_generate`, `output_validation`, `generation`, `execution`, `scheduling`.
## 4.3 Function surface

| Function | Role |
|---|---|
| `harness::send` | entry point: persist the incoming message and kick off a turn; returns fast |
| `harness::spawn` | spawn a sub-agent in a child session; the model-facing pending trigger |
| `harness::turn` | internal durable loop step (enqueued); never called by consumers |
| `harness::function::trigger` | internal: unwrap an `agent_trigger` call, invoke the target, capture the result or report it pending |
| `harness::function::resolve` | internal: deliver a pending call's result and resume the parked turn |
| `harness::stop` | request cancellation of an in-flight turn (cascades to spawned children) |
| `harness::status` | read the current turn status for a session |
| `harness::ask` | put 1-4 discrete questions to the user as a card (registered like `spawn`, answered in-process like `submit_result`) |
| `harness::metrics` | aggregate turns / function calls / tokens / cost over the session tree |
| `harness::delete-session-tree` + `…-status` | safe subtree teardown as a durable queue operation |
| `harness::system-prompt::get` | read-only preview of every prompt layer, no model request |
| `harness::context-policy` | read-only: does the destination model permit aged function-result pruning |
| `harness::sweep-pending` | cron-bound: expired pending-call sweep + orphan redrive |

**Agent exposure is deny-by-default and explained per entry.** Denied to in-run agents: `send` (*"a model that can start arbitrary turns can fork unbounded loops outside any `max_turns` guard"*), `turn`, `function::trigger` (*"forged call ids, policy re-entry"*), `function::resolve` (*"forged results for parked calls"*), `stop`. Allowed but gated: `spawn` — *"the controlled alternative to `send`: the harness itself enforces depth / fan-out / turn budgets and policy subsetting, and the fail-closed dispatch policy still applies. A deployment turns it on per agent by adding `harness::spawn` to the `allow` globs."* Safe: `status`.

## 4.4 Triggers

**Emitted (async, observe-only).** Five types: `harness::ready`, `harness::turn-started`, `harness::turn-completed`, `harness::message-queued`, `harness::triggers-changed`. The turn pair is "the **orchestration surface** — they fire at turn boundaries so consumers and siblings react without polling `harness::status`." Delivery is `TriggerAction::Void` — *"fire-and-forget… at-least-once, and unordered"* — filtered per binding by `session_id` / `parent_session_id`.

`turn-completed` carries `status: completed|cancelled|failed`, `result`, `result_error`, `reason`, `parent`, `timestamp`, **and the context snapshot**. `message-queued` carries a *pointer*, not the message; `triggers-changed` is a doorbell. The console-visible `terminal: bool` is `false` *"while the session still owns an armed wake (a one-shot notify), meaning a later turn carries the run's real outcome; consumers finalize a logical exchange only on `terminal: true`."*

Also emitted: `harness::session-tree-deletion` (terminal statuses `completed` / `failed`). Worker-bindable only — *"the agent path (`engine::register_trigger`) refuses harness-internal types in every shape."*

**A stated limitation worth internalising:** *"The loop guard is the consumer's: `max_turns` bounds one turn, not a chain of turns; an event loop (completed to send to completed…) must carry its own termination condition — a hop counter in `session.metadata`, a budget sibling, or a terminal check in the handler."*

**Hook trigger types (synchronous).** **Six**, not the five the design-of-record lists: `harness::hook::{pre_turn, pre_generate, post_generate, pre_trigger, post_trigger, post_turn}`. `post_turn` gates completion — a deny re-prompts through `max_validation_retries` — and is additionally **the only agent-bindable hook point**, because it is force-scoped to the caller's own session and children.

**Bound (optional).** `harness::on_steering` bound to `session::message-added` folds a mid-turn user message into the running turn, or kicks a fresh turn if none is running. *"This is opt-in; the default harness binds no triggers."*

## 4.5 State scopes

| Scope | Key | Value |
|---|---|---|
| `harness_turn` | `<session_id>` | the turn record: `turn_id, status, step, turn_count, depth, abort?, watermark_entry_id?, stream_request_id?, options, calls, parent?, result?, result_error?` |
| `harness_idem` | `<idempotency_key>` | `{session_id, turn_id, entry_id, ts}` — webhook dedupe, TTL ~24 h |
| `harness_queue` | `<session_id>:<id>` | parked queued messages |
| `harness_binding` + `harness_binding_owner` | `<binding_id>` | the durable trigger-binding record and its per-owner id index |
| `harness_context` | `<session_id>` | the per-generation context snapshot |
| `harness_usage` | — | milestones/outcomes already announced |
| `harness_budget` | `<root_session_id>` | the token/cost ledger |
| `harness_filesystem_grants` | `<session_id>` | grant roots |

The state doc states the lifecycle rule: *"Neither scope expires on its own: `harness_idem` rows are TTL-bound by contract, and a deployment that deletes sessions can purge the corresponding `harness_turn/<session_id>` record from a `session::deleted` binding — the same cascade pattern `approval-gate` mandates for its own scopes."*

## 4.6 Dependencies

Required: `session-manager` (persist, stream via `session::update-message`, set status), `llm-router` (`router::chat`), `context-manager` (`context::assemble`, `context::count-tokens`; *"failures are fail-closed so an unbudgeted request is never sent to a provider"*), and `queue`. The bootstrap **must** call `queue::define` and fail before ready if it cannot ensure the `harness-turn` queue. Optional: `judge` — *"When it is absent, only the lossless repairs run."* Plus the engine itself for `iii.trigger`, the registry reads, and custom trigger-type registration *"with subscriber sets rebuilt from the engine after a restart."*

---

# 5. Concepts in depth

## 5.1 Durability and idempotency

The `harness-turn` queue is **at-least-once**, so any step may be redelivered after a crash and *"every step must tolerate it."* Three mechanisms carry the load:

- **Stale-step guard.** Each dequeue compares `payload.step` to the record's current `step`; a lower step is acked and dropped. The guard only catches *old* steps — *"redelivery of the current step while it is still executing is indistinguishable from a resume, so the queue's visibility/processing timeout MUST exceed the worst-case step duration."* Hook chains run inside the step, so their `timeout_ms` budgets count toward that bound; a `pre_trigger` hold does not, because it *parks* rather than blocks.
- **Deterministic entry ids.** Every entry a step writes uses an id supplied via `session::append`'s `entry_id`, and appending an existing id is a no-op: the assistant message of a generate step is `e_<turn_id>_<step>_assistant`; a `function_result` is `e_<turn_id>_<function_call_id>`. *"A redelivered step therefore writes into the same entries instead of duplicating them: if the deterministic assistant entry already exists, the resumed generate step streams into it rather than appending a second message — a crash never yields two assistant messages."*
- **Per-call checkpoints.** The record carries `calls: Record<function_call_id, { state: "triggered" | "pending" | "done"; entry_id?; child_session_id?; child_turn_id?; held_by? }>`. The loop checkpoints `triggered` **before** invoking the target, `pending` when the trigger defers, and `done` after the result entry is appended. On redelivery: `done` calls are skipped; `pending` calls stay parked; a call found `triggered` but not `done` is **not re-invoked** — *"the side effect may or may not have happened"* — and the harness appends a synthetic error result reading `interrupted: executed at most once, result unknown (restart during execution)` and lets the model decide whether to retry.

> **The invariant, stated exactly:** *"Step delivery is at-least-once; function side effects are at-most-once."*

**Status writes** (`session::set-status`, turn-record transitions) are naturally idempotent — re-setting the same value is a no-op and fires no event. **Step advance is persisted before enqueue**, with bounded in-place retry (5 attempts, 500 ms backoff).

**Streaming.** An empty assistant entry is appended under the deterministic id, deltas are written into *that same entry*, and the final update writes the complete `AssistantMessage`. The router may batch deltas (`coalesce_ms`) to throttle update frequency. The transcript's own contract is that a consumer reconciles content by `revision` (highest wins) and order by the `parent_id` chain — *never* by arrival or timestamp.

**Generation recovery** (`max_transient_resumes`: 1 in the shipped README, 3 in the type default). On a failed generation *that produced real partial output*, the partial is preserved, a `recovery` custom entry is appended (*"Stream interrupted; preserved partial output and resuming ({attempt}/{max})"*), a synthetic user nudge is appended (*"Resume from the transcript and return the complete deliverable … Do not repeat function calls that already have successful results"*), and the loop advances — **recovery costs a step** and therefore consumes `max_turns`. Eligibility requires a retryable error kind (`RateLimited` | `Transient`) and remaining budget. Scope is explicit: *"Recovery continues a partial response. Retrying a failed startup is the router's responsibility."* A failure with **no** output ends the turn with a durable failure notice and does not consume the recovery budget. The failure record carries `recovery: { attempted, max_attempts, outcome: exhausted | not_attempted }`.

**Queue model.** `{"type":"fifo","message_group_field":"session_id","concurrency":10,"max_retries":3,"backoff_ms":1000,"poll_interval_ms":100,"redeliver_on_engine_restart":true}` — *"Grouping provides per-session ordering with cross-session parallelism; a single global FIFO would head-of-line block every session behind one long stream step. Sub-agent turns are ordinary entries under their child `session_id`, which lets spawned children run in parallel."* Two honest caveats from the queue worker's own docs: FIFO ordering holds only for **first-attempt successes** (a retried message re-queues with a delay and can be overtaken), and pending **in-memory** jobs are lost on an adapter swap or restart (file-backed ones survive).

## 5.2 Deferred calls and parking

*"Some calls cannot resolve inside a dispatch: a sub-agent that runs for minutes, or an approval that waits for a human. Holding the queue step open would break the durability contract and would serialise independent work."*

- `harness::function::trigger` may return `{ pending: true }`. The call checkpoints `state: "pending"` and the pass continues with the remaining calls.
- When the pass ends with unresolved pending calls the turn **parks**: the step ends **without re-enqueueing**, the turn stays `awaiting_functions`, and **no queue step is held** while the deferred work runs — *"pending calls never stretch the visibility-timeout bound."*
- `harness::function::resolve` settles later — **delivering** a result (same deterministic entry id, checkpoint flipped to `done`) or, for hook-held calls, **releasing** it for execution (`action: "execute"` resumes the trigger pipeline after the holder). When it settles the last pending call — or a release needs the loop — it re-enqueues `harness::turn`. **Duplicate resolves hit the existing entry id and are no-ops.**
- Every pending call carries `pending_timeout_ms` (default 30 minutes). A periodic sweep resolves expired calls with an error — `pending call timed out` — *"so a lost child or an abandoned approval can never park a turn forever."* A hold's owner typically settles expiry itself with a richer denial; **the sweep is the backstop when no owner is alive, and double resolution is a no-op either way.**
- Steering still works while parked: user messages appended in the meantime sit after the watermark and fold in on resume.

Two details that matter in practice. First, **hook holds never expire** — `pending_call_expired` is false whenever `held_by` is set, because only a human decision should end an approval hold. Second, the sweep is cron-driven (`0 0 0 * * *`, daily) and runs *before* orphan redrive so *"a failed orphan scan must not hide the pending-call result."*

**Why it's general:** *"`harness::spawn` is the built-in pending trigger. The mechanism is deliberately general: an approval sibling implements hold by returning `hold` from a pre-trigger hook and calling `harness::function::resolve` on the human decision — no new loop machinery."*
## 5.3 Hooks

*"Hooks are the **synchronous** counterpart to the turn events: iii functions the harness calls in-path at fixed points of the loop, which can veto, hold, or mutate what happens next."*

**The rule for choosing:** *"if you only need to know, bind an event; if you must block or change something, bind a hook. Every hook adds latency and a failure mode to the hot path — events are always the cheaper tool."*

| Point | Runs | May do |
|---|---|---|
| `pre_turn` | first step of a turn, after `working` is set, before any model spend | veto (`deny` ends the turn with the reason) |
| `pre_generate` | after `context::assemble`, before `router::chat` | replace/extend `system_prompt`; **append-only** message injection; veto |
| `post_generate` | after the final `AssistantMessage` update of a generate step | **observe only** |
| `pre_trigger` | after the fail-closed glob policy passes, before the target is invoked | `deny`, `hold`, rewrite `arguments` |
| `post_trigger` | after the target returns, before the `function_result` is appended | rewrite result `content` / `details` / `is_error` |
| `post_turn` | at completion | gate the turn; a deny re-prompts through `max_validation_retries` |

**The asymmetries are deliberate and documented:**

- `post_generate` **cannot mutate** — the message already streamed to consumers (`session::message-updated` fired per delta); *"redacting after the fact would lie to the UI. Strip secrets where they enter instead: `post_trigger` runs before the result is persisted, so the transcript and the model both see the rewritten version."*
- `pre_generate` injection is **append-only** (plus the system prompt): *"rewriting history would break the call/result pairing invariants `context::assemble` guarantees and invalidate provider prompt caches."* Injected content rides the `reserved_tokens` headroom of the token budget (default `min(20000, 10% of context_window)`) — *"keep it small and bounded."*
- `pre_trigger` runs **after** the globs: *"a hook can narrow the policy, never bypass it."*
- A hook may declare **static** prompt text in trigger metadata `inject_prompt` and is then **never invoked** — the harness appends the text directly and skips the compatibility call. This is a pure latency optimisation with no behavioural difference.

**Registration is the trigger pattern itself** — *"installing the worker is installing the hook; there is no hook block in any configuration entry"*:

```typescript
iii.registerFunction("approval::gate", gateHandler);
iii.registerTrigger({
  type: "harness::hook::pre_trigger",
  function_id: "approval::gate",
  config: { functions: ["shell::*", "harness::spawn"], timeout_ms: 5000 },
});
```

**Contract.** `HookTriggerConfig = { functions? (target globs), sessions? (glob), priority?, timeout_ms? (default 5000), on_error?, payload? + result_into? (template mode), retry_prompt? }`. Defaults: `priority` 0, `timeout_ms` 5000, and `on_error` **fail-closed for `pre_turn`/`pre_generate`/`pre_trigger` AND `post_turn`, fail-open for `post_generate`/`post_trigger`**. `HookInput` carries an envelope (`point`, `session_id`, `turn_id`, `step`, `depth`, `metadata`) plus the point-specific payload. `HookOutput` is `{decision:'continue', mutations?, annotations?} | {decision:'deny', reason} | {decision:'hold', pending_timeout_ms?} | void`. Additions beyond the documented five-point contract: a `sessions` glob, a template mode where the caller's own object is sent instead of the hook envelope and the verdict is read from a `valid` field, and an invocation budget of `timeout_ms + 1000 ms`.

**Chain, hold, failure.**

- **Middleware chain:** ascending `priority` (ties by `function_id`); each receives the payload **as mutated by the previous one**; the first `deny` or `hold` short-circuits. *"Mutations from different hooks can conflict — keep chains short and set `priority` deliberately."*
- **Deny:** at `pre_turn` / `pre_generate` the turn ends `failed` with the reason; at `pre_trigger` the call is answered with an `is_error` result — *"the model sees it and can adapt."*
- **Hold** (`pre_trigger` only) reuses the deferred-trigger machinery wholesale: the call checkpoints `pending` with `held_by: <hook function_id>`, the turn parks, and the decision owner calls `resolve`. Mutated arguments are checkpointed with the hold, so the released call runs with the repaired arguments.
- **Failure policy:** *"`fail_closed` treats it as `deny` (default for `pre_*` — a crashed approval hook must not wave calls through); `fail_open` skips it (default for `post_*` — a logging outage must not kill the agent)."*
- **Replays:** *"Hooks run inside at-least-once steps: a redelivered step re-runs its hooks. Hooks MUST be idempotent; key side effects on `turn_id + step` or `function_call_id`."*
- **Provenance:** *"Hook invocations carry the agent provenance mark of the work they wrap, and the engine propagates it through any nested triggers the hook makes — a hook cannot launder an agent-gated call."* Mutations return through `annotations`, merged into the written entry's `origin`, so the audit trail records that a rewrite happened.

**The six operational cautions** are the most transferable part of the whole design:

1. **You are on the hot path.** Hook time extends step duration, which the queue's visibility timeout must cover — *"and a spawn tree pays your chain on every child step. Keep hooks fast; never wait for a human inline — return `hold`."*
2. **`on_error` is a security decision.** *"Fail-closed on an observability hook turns a logging outage into a dead agent; fail-open on a policy hook turns an approval outage into a bypass. The defaults encode the safe choice per point — change them knowingly."*
3. **Treat hook input as untrusted.** *"`arguments`, generated text, and function output are model-controlled. Never execute or forward them blindly from hook code — the hook runs with worker privileges and is a textbook confused-deputy target."*
4. **Mutations are silent.** *"The transcript stores the effective (rewritten) values. Return `annotations` or log originals yourself, or audits will show data that never matched what actually ran."*
5. **Don't start turns from hooks.** A hook calling `harness::send` can loop (hook to turn to hook). *"If a hook must trigger follow-up work, emit through a queue or carry a hop counter in `session.metadata`."*
6. **Reach for events first.**

## 5.4 Function policy

`CompiledPolicy { allow: GlobSet, deny: GlobSet, allow_empty: bool }`. Resolution is `allow.is_match(id) && !deny.is_match(id)` — **deny wins.**

- **Deny-by-default is structural:** an absent `FunctionPolicy` on a send denies every call (*"with no `functions.allow` globs, every model-requested call is refused and the harness is a plain chat loop"*).
- **An invalid glob fails the whole policy closed** — it logs `rejecting policy with invalid function glob` and the policy compiles to `deny_all()`.
- **Glob semantics** are ordinary `globset`: `shell::*` covers `shell::run` *and* `shell::fs::read`, but not `fs::read`.
- **Subsetting** uses a separate, conservative `glob_covered(child, parent)` check: a child's `allow` keeps only globs covered by the parent's, or inherits the parent's verbatim; **denies are unioned**; a `None` parent yields `None` (*"an un-empowered parent cannot empower a child"*). A requested `"*"` under a parent `"shell::*"` collapses to an empty allow.
- **The leaf wall** is exactly four globs — `harness::spawn`, `harness::send`, `engine::unregister_trigger`, `engine::registered-triggers::*` — with `engine::register_trigger` **deliberately excluded** because *"walling it off left a leaf with no way to wait, so a leaf may arm its own wake."* The control-plane half is instead refused *by shape* (a leaf may not bind a mechanical call to an explicit target) and a leaf's wake deadline is capped at `now + pending_timeout_ms`. Leafness is `has_parent && !policy.allows(SPAWN_ID)` — **both halves load-bearing** — and *"what makes a child a leaf is its POLICY, not its prompt."*
- **Two grants** are unioned into any *non-empty* child allow-list: `engine::functions::list`, `engine::functions::info`, and `directory::skills::get`. They are recorded in `dispatch_only` so they're callable by id but **never become native tools**. A request cannot remove them.
- **Exposure mode:** `agent_trigger` (default — one generic schema; function discovery is runtime) or `native` (one schema per allowed function). *"Both modes enforce the same fail-closed allow/deny policy at dispatch time; `expose` changes only how the model sees them."*
- **Profile baseline:** `default_functions` (default `allow: ["*"]`) applies *only* to a parentless spawn with no `options.functions`, and to a send naming `options.agent` with no `options.functions`. *"An identity picked to DO something must be able to dispatch."* A plain new send stays deny-all.

**Permissions at the deployment level** are a separate, ordered rule list in `iii-permissions.yaml`:

```yaml
# Default agent permissions (first match wins).
#   bare string        -> allow (exact id, or glob when pattern contains *)
#   '*'                -> allow any function_id (catch-all; order matters)
#   'worker::*'        -> allow any id matching that glob
#   '!function_id'     -> deny (quote required - bare ! is YAML tag syntax)
#   no match           -> needs_approval
# Harness loads via config `permissions_path` and hot-reloads on save.
```

Read the last rule carefully: **no match means `needs_approval` — not deny, not allow.** The file is also a policy *document* — most rules carry a comment explaining why the id is denied (`!router::chat` *"bypasses the harness loop's accounting"*; `!provider::*` *"the router invokes these worker-to-worker; agents never call them"*; `!configuration::ensure` *"the atomic register/seed twin — deny it too so an agent cannot bypass the register deny above"*).

## 5.5 Prompt assembly, agent profiles, and skills

**The identity prompt.** Every agent — top-level and spawned children alike — is seeded with **one** shared prompt: `harness/prompts/default.txt`, *"a deliberately minimal prompt carrying only the basic engine functions and the discovery loop (list, info, call)."* A `default` entry in the directory's system-prompt store overrides it for every new composition, resolved through a span-clean ladder, and *"any store failure (directory absent, entry missing, blank body) falls back to the embedded prompt."*

The retired `prompts/subagent.txt` is asserted **absent** by test, and the README states the principle behind that:

> **"What makes a child a leaf is its POLICY, not its prompt."**

**Strategy.** `SystemPromptStrategy = enrich | override | disabled`. `enrich` (default) appends the caller's prompt to the built-in; `override` uses it verbatim; `disabled` drops it. A profile's resolved prompt, by contrast, is the whole identity with nothing underneath.

**Assembly.** Per step the prompt is `[base, skills baseline, runtime aid]` joined by a blank line. The runtime aid adds the session id, the working directory when a filesystem root is set, a policy aid when the policy is narrowed, and a child's seeded `<preloaded_functions>` block. The policy aid *"prints at most 30 allowed ids (plus the deny list)"* and states that the narrowing **overrides** the general discovery requirement. *"Context assembly and hooks may only append after that."*

**Stickiness.** *"The resolved prompt is STICKY per session, like `model`/`provider` and the dispatch policy: a send to an existing session that names neither `system_prompt` nor `system_prompt_strategy` inherits the prior turn's resolved prompt verbatim (a prior `disabled` turn's absent prompt inherits too). Naming either field resolves fresh — an explicit bare `system_prompt_strategy` (e.g. `"enrich"`) is the reset-to-default escape hatch."*

Reasoning is sticky the same way, with a stated reason: *"so an omitted field never silently resets the effort (which would also bust the provider's messages cache)."*

**Agent profiles.** `options.agent` names a directory profile (`directory::agents::*`, one markdown file per profile). *"The harness resolves it ONCE via `directory::agents::get` and freezes the result onto the turn."* The directory composes `extends` chains **root-first**, so `tech-lead` extending the bundled `iii` base arrives as the full iii doctrine followed by the tech-lead body — and that resolved text **is** the session identity: *"Nothing built-in sits underneath it and no prefix is added."* A profile whose `extends` chain does not resolve is refused as an invalid request with the directory's **D415** text. Chains are capped at 8 hops; `skills` and `functions` inherit additively; `model`/`reasoning_effort` fall back to the nearest ancestor.

A profile declares `name`, emoji `logo`, `skills`, `functions`, and optional `model` + `reasoning_effort` in required frontmatter. Its **skills are preloaded** — each body fetched once and frozen into a `<preloaded_skills>` block of `<skill id="…">` sections; ids the directory can't serve are *named as unavailable*, not failures. Its **functions are preloaded contracts** — each one's current description and compacted request schema rendered into a `<preloaded_functions>` block, *"so the model calls them on the first step instead of spending a search and a contract lookup per session."* Ordering is fixed: `<preloaded_functions>` first, `<preloaded_skills>` after.

Three rules make this safe:

- **The frozen block is never rewritten** ("it is the shared cache prefix"); when a preloaded contract later changes, disappears, or an unavailable one appears, *"every step carries a tail notice naming exactly those ids until a new session resolves the profile afresh."*
- **A profile's skills never narrow the session's skills index** — the README calls this *"curation, not authorization."* Only an explicit `options.skills` narrows it, and the turn's function policy must still allow `directory::skills::get`.
- **Only effectively-authorised ids are frozen**: an id the policy denies renders as unavailable and gets no digest.

**Skills.** New sessions freeze a *names-and-descriptions-only* index into the system-prompt prefix. `plan_sync` has three outcomes: identical acknowledgement (nothing), same fingerprint with a new generation (acknowledge), otherwise **append** either `The available skills have changed. This list supersedes the previous available skills list.` or `Skill guidance is no longer available. Do not use any previously listed skill.` The **exact split**: *"the frozen baseline is the stable prefix's skill half; corrections are the tail."* A failed catalog reload *"preserv[es] the last admitted snapshot"* rather than emptying the catalog. Unknown filter ids are warned and omitted.

## 5.6 The caching seam

The prompt reaches `router::chat` in two forms: flat `system_prompt`, and `system_sections` — the **stable prefix** (frozen profile/identity prompt plus frozen skills index, `cache_boundary: true`) followed by the **per-session tail** (session id, working directory, policy aid, and whatever context assembly and hooks append).

`split_prompt_sections(final, stable)` returns a value **only** when the stable part is non-empty and the final prompt literally *starts with* `stable` followed by a blank line. When `prompt_cache_sections` is true the request carries the two sections plus `cache_intent.surface_digest = sha256(stable)`, *"so cache-aware providers can keep one prefix entry for all of them — when the provider supports it and the prefix meets its minimum cacheable size."* Anthropic and Claude Code put their cache marker on the boundary block; OpenAI, Codex, xAI and Kimi derive a shared `prompt_cache_key` from the digest. If both the flat string and the sections are sent they must agree byte-for-byte or the request is rejected.

When sections can't be delivered, the **reason is reported** as `context.prompt_sections_fallback`, one of: `disabled` (`prompt_cache_sections: false`), `no_stable_prefix`, or `prefix_rewritten` — *"a `pre_generate` hook replaced the prompt head — the hook's prompt still wins, it just shares nothing."*

> **"The digest is a local identity, never evidence of a hit — `usage.cache_read` is."**

The deeper bookkeeping is the strongest hint that this is a real cost problem: a `ContextSnapshotV1` records `PrefixDivergenceV1` entries naming **the first already-sent row a request rewrote** — the point where a prefix-matching provider cache stops reusing — capped at 32, with the in-process `sent_rows` map deliberately forgotten on restart.
## 5.7 Sub-agents

*"A sub-agent is an ordinary harness run in a **child session**, spawned as a function call from a parent turn. Each child gets its own goal (the spawn task), its own policy, and — via the output contract — its own typed deliverable."*

**Spawning is fire-and-forget.** The caller gets `ChildIds { session_id, turn_id, reused }` immediately and *never* the child's result. `ParentLink` is kept *"for event filters and console nesting, not for result delivery."* The dispatch, step by step:

1. **Guards.** Violations *"fail the call with an `is_error` function_result, never a throw"* so the model can adapt: `harness::spawn` must match the parent's allow globs (fail-closed like any target); `depth + 1 > max_depth` (default 3) gives `harness/spawn_depth_exceeded`; non-terminal children of this turn at or above `max_children` (default 8) gives `harness/spawn_fanout_exceeded`. **The cap is PER TURN**, and *"re-tasking an existing session does not consume another slot"* — at capacity the harness first tries to resolve an explicitly named session for reuse.
2. **Policy subsetting.** *"A child can narrow, never escalate."* The child's `max_turns` is capped at the parent's remaining turn budget.
3. **Create the child session** with linkage metadata merged into `SessionMeta.metadata` — `{ parent_session_id, parent_turn_id, function_call_id, depth }` — *"so UIs reconstruct the tree and trigger configs can filter on it."*
4. **CAS-create the child turn** through the same seed path as `harness::send`, recording `calls[call_id] = { state: 'pending', child_session_id, child_turn_id }` on the parent. The parent parks.
5. **Child completion.** The child's finalise step reads the parent linkage and calls `harness::function::resolve` on the parent: `completed` delivers the child's result (*structured result in `details`, text rendering in `content`*); `failed`/`cancelled` deliver an error with the reason. *"The deterministic entry id makes a redelivered child step unable to double-resolve."*

**Inheritance rules** — the most instructive part, because each one has a stated reason:

| Aspect | Rule | Reason |
|---|---|---|
| provider | inherited **only** when the model is also inherited | *"model and provider must stay a coherent pair"* |
| model | profile, then explicit, then parent; a parentless spawn naming none **errors** | *"only an IN-TURN spawn inherits its parent's"* |
| reasoning | requested effort, else the parent's pair; an explicit child effort **clears** thinking/reasoning in every provider namespace | avoid a stale cross-namespace leftover |
| max_turns | `min(requested, parent.max_turns minus parent.turn_count)`, floor 1 | a child cannot outlive its parent's budget |
| **token / cost budget** | **from the parent only** | *"Children cannot widen or replace their root turn's execution budget"* |
| filesystem scope | explicit absolute root wins, else the parent's, unchanged | |
| agent profile | the parent's continues unless the spawn names one **or** brings `options.system_prompt` (naming both is refused) | |
| prompt | one shared identity unless a profile replaces it | *"what makes a child a leaf is its POLICY"* |

**Context inheritance is fresh by default:** *"the child sees only its `system_prompt` and `task`. A caller that wants parent history can `session::fork` first and spawn into the fork — supported, not default (inherited transcripts inflate child context and cost)."*

**Cancellation cascade.** `harness::stop` on the parent walks `calls` for non-terminal children and stops each child session, recursively. A child stopped this way resolves its parent call with `is_error: true` (`cancelled`).

**Display metadata.** `display: { name, icon?, color? }` is **display-only** — *"never affects ids, policy, or routing."* `name` is trimmed, at most 48 characters (counted in characters, not bytes), and becomes the child session's title. Icons are a **strictly closed** nine-token set (`agent, code, search, terminal, database, test, review, docs, design`); an unknown icon *fails deserialization of the whole spawn*. Colors are a closed seven-token set (`neutral, blue, purple, teal, green, amber, rose`) with a **hand-written deserializer that maps anything else to neutral**, for a stated reason: *"a colour outside it (models like to say orange) falls back to neutral instead of failing the whole spawn on a display-only field — a rejected spawn cost a live orchestrator a step and a re-dispatch."* That asymmetry — strict on the semantically meaningful field, forgiving on the cosmetic one — is a nice piece of judgement.

**What spawn is not:** *"Not agent-to-agent messaging, not a workflow engine, not a shared blackboard — those compose on top as siblings. One parent turn fans out to bounded children and joins on their results; that is the whole feature."*

## 5.8 Output contract

A turn can declare what it must produce: `{ type: "text" }` (default) or `{ type: "json", schema? }`. *"This is what turns a sub-agent or a backend `harness::send` call into a typed unit of work instead of 'parse the transcript yourself'."*

- **Provider-native** when the model supports `structured_output`: `response_format` on `router::chat`, and the final assistant text is parsed as the result.
- **`submit_result` fallback** otherwise: a synthetic invocation schema whose `parameters` *are* the output schema. The model ends the job by calling it; the harness validates and consumes it — *"never dispatched through `iii.trigger`."* It is terminal: *"other calls in the same message trigger first (their results still land in the transcript), then the turn finalises."*
- **Validation retries:** *"if the model stops without a valid result […] the harness appends a synthetic user nudge carrying the validation errors and re-enqueues a generate step, at most `max_validation_retries` times (default 2). After that the turn ends `completed` with `result_error` set and the raw final text as a best-effort `result`."*

The result is stored on the turn record, returned by `harness::status`, carried on `harness::turn-completed`, and — for sub-agents — delivered to the parent in the `function_result`.

## 5.9 Asking the user (`harness::ask`)

*"`harness::ask` lets the model put a decision with discrete options to the user as a clickable card instead of a question written in markdown. It is registered in the catalog like `harness::spawn`, but it is a harness control like `submit_result`: the turn loop answers it in-process, never dispatches it to a target, and never parks the turn."*

**Limits, exactly:** 1-4 questions; 2-4 options per question; `header` 1-16 characters; `label` 1-80 characters and unique within its question; `header` and `label` must not contain line breaks (*"the answer is one line per question"*); limits count **characters, not bytes**; a whitespace-only value counts as empty; labels are compared after trimming. `multi_select` defaults false. *"The UI adds a free-text 'Other' choice, so the model must not include one."* Validation errors *"name the field and the limit"*: `questions[1].header must be at most 16 characters (got 17)`.

**The turn ends on the question:** *"A step that accepted an ask finalizes the turn without another model call, through the same path as a text-only step: `completed`, with the step's assistant text as the result."* Three exceptions: a `submit_result` in the same step is handled first; a user message that arrived during the step advances the turn as usual; a step whose *other* calls parked waits for them. The accepted step is recorded on `ask_step` *"so a redelivered step still ends on the question and still refuses a second ask."* The model is told, verbatim: *"Do not repeat the questions in text. End your turn now."*

**Refusals come back as `is_error` results and the turn continues**, with a documented table covering: a sub-agent (depth > 0) or a structured-output turn (*"needs a human to answer and none is attached to this turn; report blocked with your question instead"*), a second ask in the same step (*"only one `harness::ask` per step; put all your questions (up to 4) in one call"*), unparseable arguments, and a broken limit. Note the ordering in the decision function: no-human, then one-per-step, then shape, then validation — so the most structural refusal always wins.

**Answering is deliberately universal:** *"The answer is simply the user's next message, so any client that can send one can answer."* The console renders radio buttons/checkboxes and a Send that submits through the composer, one line per question (`Approach: End the turn`; `Channels: Console, Slack`). *"The card stays open while `harness::status` reports the same `turn_id`. Once the session has moved to a later turn, it becomes read-only and is marked answered."* Typing a reply in the composer works the same way.

## 5.10 Reactive triggers and bindings

Three consecutive redesigns collapsed the reactive surface, and each is explained by what it deleted. `harness::react` — *"a second control plane: a function agents could not call, bound as a trigger target, carrying a spec in `metadata` that it interpreted at fire time"* — implemented payload mapping, conditions, loop breaking, a fire-rate gate with coalescing, joins, `once`, cleanup, observability and dispatch in **about 2,450 lines**, and was deleted.

The replacement is **one durable binding, one delivery hop**. The engine's `Trigger` holds *"`{trigger_type, function_id, config, worker_id, metadata}` and nothing else: no owner, no lifecycle, no capability. Everything the harness needs at fire time therefore lives HERE."* The engine-side metadata is exactly `{"__binding": "<id>"}`; owner, target, conditions, lifecycle, frozen capability, fire count and the canonical registration live in a durable record. **"Agent-authored metadata is never trusted for routing or authorization."**

Delivery order: resolve the binding, deletion guard, stale-target check (*"a pre-removal spawn record retires loudly"*), exhausted check, declared conditions, **claim the fire (a compare-and-set, before dispatch)**, project the payload, dispatch, retire, record.

Four consequences worth naming:

- **Bindings survive a harness restart.** They previously did not: *"spawn bindings kept firing with no bookkeeping, notify bindings stopped delivering entirely, and a startup reconciler existed only to clean up after that."*
- **Non-deliveries are recorded.** *"Every skip — a gate, a condition, a spent lifecycle — appends a model-invisible `trigger_fired` entry to the owner's transcript with the reason. 'Why did this never fire?' is answerable."* `TriggerOutcome` is one of `delivered | delivery_failed | skipped | expired | unregistered | invalidated`; `RetirementReason` is one of `once_consumed | max_fires | expired | unregistered | invalidated | exhausted`.
- **Durability is bounded by the state worker.** *"The dev default is in-memory: a state restart drops binding records even though a harness restart does not."* And the store is deliberately cache-free: *"No in-memory cache, deliberately… The store IS the authority, and every fire pays one private state read for it."*
- **The guarantee is at-most-once, and the docs say so plainly.** *"The engine fires and forgets — `tokio::spawn`, result discarded, no retry, no outbox. A harness crash between the engine's fire and the claim loses the event."* Recovery is not retry but *reconstruction*: startup re-arm, state catch-up (wakes whose key was written while the trigger was dead are delivered on boot, marked `replayed: true`), compose snapshot recovery, and wake expiry as a deadline.

Two supporting pieces make this humane. **A never-fired wake wakes its parked owner** with a notice naming the watch, the deadline and *"Nothing else will wake this session"*, and `is_armed_wake` deliberately ignores the clock so the session stays parked until the notice is on its way. And the **startup GC** is explicit about uncertainty: orphan triggers, owner-gone records, stale spawn targets retired loudly, legacy targets, then survivors re-armed — with `should_gc` carrying the rule *"Never GC on doubt."*

**Scoping is per session, not per worker:** the owner is the registering session, there is a cap of 64 bindings per session, unregister is owner-checked, and an identical same-session re-registration returns the standing binding rather than creating a second one.

**Conditions** replace the engine's own `condition_function_id`: they are evaluated in order, short-circuit on the first skip, and an `allow` may **replace the event payload** downstream. An erroring condition *skips with a recorded reason* rather than passing or stalling silently, and a starving binding surfaces an owner notification. The built-in reaction gates were deliberately removed: *"There are no built-in reaction gates anymore."*

## 5.11 Session-tree deletion

`harness::delete-session-tree { session_id }` *"accepts work and returns a snapshot after the admission/conflict check, without waiting."* The root is exactly the named session and *"never resolve[s] … to the global root."* `operation_id = delete_<sha256 hex of the session id>`; a dedicated queue grouped by `operation_id`; a 120 s deadline per attempt.

- **(a) Admission close.** The operation is persisted *before* admission closes. `reserve_root` conflict-checks ancestors and every member; a rejected unplanned operation releases its own root guard so *"a rejected ancestor must not stop its own work or surviving siblings."* `prepare` claims the guard for every member and then drops the topology lock, *"after which any send, spawn or binding that takes the topology lock is refused."*
- **(b) Cancel descendants.** *"Signal EVERY member first, even when the selected root is terminal. **Never interpret a stop acknowledgement as terminality.**"* Then, per member, the loop arms the change notification *before* reading terminal state, takes the activity guard plus the session lock, and **fails closed on any `Triggered` call** (*"has a tool with unknown completion; data retained"*). Deletion is stricter than `harness::stop`: any unconfirmed stop fails the deletion.
- **(c) Consolidate message.** One message to the surviving direct parent, deduped on a deterministic entry id, queued durably first, then either re-enqueueing the running parent's step or seeding a new turn for a terminal parent. *"Missing/tombstoned parents are never created or woken."* The text tells the parent the user requested cancellation/deletion and says *"Do not await their results and do not recreate them automatically."*
- **(d) Child-first deletion.** Members are iterated deepest-first because *"a partial failure leaves the surviving root metadata available, and the saved plan retains already-deleted members for retry."* Each member requires a boolean `deleted` from the delete RPC; *"malformed replies fail without recording that member as deleted."* Cleanup unregisters owned bindings, clears the owner index, deletes parked queued messages, purges filesystem grants, budget and context snapshot, then calls `approval::on-session-deleted` and **verifies** `approval::list-pending` is empty and settings report `source: 'defaults'`.
- **(e) Fail-closed posture.** *"Partial cleanup is never reported as success."* Retries reuse the operation id, keep partial progress, and get a new deadline. `attempt` starts at 1 and increments **only** on an explicit failed-to-deleting transition. Tomstones survive completion *and* failure — *"a deleted id is not reusable."* Unknown remote completion is retained as a *durable witness* rather than reclassified as cancellation. Boot recovery *"logs and skips malformed rows while leaving their guards in place, so that subtree remains fail-closed."* And: **"There is intentionally no unsafe force-delete."**

## 5.12 Inflight and liveness

**`inflight.rs` is orphaned-turn recovery.** A turn record can be `Running` with no `harness::turn` step on the queue if the enqueue failed after the record was persisted — *"the session stays 'working' forever and even `harness::stop` cannot finish it — stop only sets the abort bit the next step observes."* `is_orphan_candidate = Running && !executing_here && now minus updated_at >= 120_000 ms`; `redrive_orphans` re-enqueues the current step, re-checking under the session lock against the freshest record. Re-enqueue is safe *precisely because* steps are at-least-once and a stale `(turn_id, step)` is acked. The loop waits 30 s after boot and then runs one pass per window, *"because the daily pending sweep alone would leave a wedged session stuck for up to a day."*

**`liveness.rs` memoizes the negative tombstone check** — "this session and its durable ancestors carry no deletion guard" — because `guard_owner` walks the lineage on every step, every dispatched call, and every send/spawn/wake. The correctness discipline is the interesting part: **only "live" is memoized**, an owner is always read from state, the epoch stamp is taken *before* the walk's first read, and a memo entry whose stamp has moved is refused — *"so no memoized live answer outlives a tombstone write."* TTL 2 s; 4096 entries; deletion's own checks use the uncached walk. Net cost of a live dispatch: two compare-and-set calls and, while the memo holds, no lineage reads.

**Status is a projection.** `session_status.rs` keeps `session::status` a projection of the durable turn record — *"never a second source of truth"* — and re-derives it from the finalizers, `stop`, the status RPC and a boot sweep *"so a status write lost while the session-manager was down cannot leave a session working forever."*
## 5.13 Budgets

| Budget | Default | Enforcement |
|---|---|---|
| `default_max_turns` | 16 | per-turn generate-step cap; the turn ends `completed` with a synthetic notice, then the post-turn gate still runs and can FAIL it |
| `max_depth` | 3 | `harness/spawn_depth_exceeded` |
| `max_children` | 8 | per turn; `harness/spawn_fanout_exceeded` |
| `max_result_bytes` | 262144 | result content+details over the cap become an elision marker; 0 disables; values under 1 KiB are raised to 1 KiB |
| `max_transient_resumes` | 1 (README) / 3 (type default) | recovery generations after a partial stream failure |
| `max_validation_retries` | 2 | output-contract nudges |
| `default_pending_timeout_ms` | 1 800 000 | parked-call wait guard |
| token / cost ledger | opt-in | see below |

The **token/cost ledger** is the most carefully reasoned piece: `prepare_root` validates and **freezes limits when a root session starts** (*"execution budgets are frozen when a root session starts and cannot be changed"*), refuses to add a budget to an existing unmetered session, and **fails a cost budget closed at send time when the catalog has no pricing**. `reserve` reserves worst-case input+output **before** the router call, using the most expensive input class. `reconcile` replaces the reservation with actual usage — and *"missing or partial usage consumes the FULL reservation so a provider cannot bypass the hard limit."* All mutations serialize on a per-root lock. Children copy `max_total_tokens`, `max_cost_usd` and `budget_root_session_id` from the parent.

Window tokens are delegated to `context-manager`: `context::assemble` returns `token_count`, `usable` and `effective_max_output_tokens`, and the harness fails the turn when the assembled count exceeds `usable` — either immediately or after post-assembly additions.

## 5.14 Context snapshots and the window

**`ContextSnapshotV1`** is per-generation accounting stored per session — *"what the last generation's model window held, by category, plus the provider usage that came back for it"*: `system_prompt`, `skills`, `tools`, `messages` (split into user / assistant / function_result / custom), `overhead`, `hook_guidance`, plus `usable`, `effective_max_output_tokens`, `compacted`, `summarized_head_tokens`, `usage`, `session_cost_usd`, `prompt_surface_digest`, `prompt_sections_fallback`, `prefix_divergences`. It is *built from the assembly the loop already performed*, not recomputed, then stamped with provider usage and exactified against a tokenizer probe. Read by `harness::metrics` and pushed on `turn-completed`.

**`Window`** is *"the model-facing message window, derived from the durable log alone so every step replays exactly the prefix earlier steps sent."* Its `build` drops custom rows, strips file refs, replays notices as user messages, applies persisted ordering, cuts at the compaction anchor, moves messages that arrived during the previous generation past the reply they interrupted, and **hides the turn's own reply while none of its calls has a logged result** — *"so a redelivered step cannot regenerate against a dead attempt's stale reply."* `unsent_notices` makes step notices exactly-once per request; `binds_thinking` disables pruning for prefix-binding models.

**Compaction persistence** is the clearest example of the sibling-boundary discipline in the whole system: *"context-manager is stateless — if nobody persists its compaction output, every turn past the budget re-summarises the whole head (one extra LLM call per turn) and summaries never converge. The harness is the caller, so the harness persists."* It appends a `custom` session entry with `{summary, tail_start_entry_id, tokens_before}`, reduces the next candidate window to that anchor, passes `previous_summary` so a re-compaction updates in place, and always uses `session_id` as the lease key *"so concurrent compactions of one session are mutually excluded across workers."* Result: *"one summarisation per overflow, amortised — not one per turn."* The context-manager side confirms the split: it *"binds no session triggers and never reaches into a session itself, which is exactly what keeps it store-agnostic."*

## 5.15 Call reconciliation

*"Repair a model's malformed function-call arguments against the target's request schema BEFORE the call is dispatched, instead of spending a generation step on the error."* Config `call_reconciliation: off | coerce | judge` (default `judge`), **fail-open throughout**. Three layers:

- **Layer A — coerce (lossless).** Parse a string holding JSON the schema rejects; a parse is kept *"only when the violation at that path disappears."* No judgement, bounded passes (4) and violations (64).
- **Layer B — judge.** Only when the `judge` worker is deployed and its provider isn't paused. Typed questions (`Rename`, `Enum`, `Drop`) go to `judge::evaluate`; repairs are kept **only if the result validates**; 2 s timeout, 0.8 threshold. *"It classifies, it never writes arguments."* The judge sees arguments with secret-keyed values masked and long strings cut, and a failing provider is paused for 30 s rather than retried in a loop.
- **Layer C — diagnose.** When a failed result looks like an argument error (seven markers), name each schema violation **by path** (max 5) so the model knows which argument to fix.

Every repair is recorded as `Change { path, kind, from, to }` with `ChangeKind { Parsed, Renamed, Replaced, Dropped }` and noted on the result text and the entry origin under `reconciled` — *except* `engine::functions::info`, *"whose result must stay byte-identical because the contract ledger digests it."* That single exception is a good illustration of how carefully the frozen-prefix invariant is protected.

## 5.16 Filesystem scope and grants

The harness **stamps** a trusted `fs_scope = {root, grants, boundary}` onto outbound calls for scoped functions (`shell::*` except `shell::filesystem::*`, `coder::*`, plus `fp::pipe` because `fp` forwards the stamp per scoped step). *"A model-supplied `fs_scope` is overwritten; a null root REMOVES the field."* The stamp is applied **before** the `pre_trigger` chain and re-applied to whatever the chain returns, *"so a hook rewrite can never widen it."* The boundary is `Workspace` or `ConfiguredRoots`, chosen by whether a grant-watch hook holds a binding for that function id. The module's own boundary statement is a model of restraint: *"This module only stamps metadata and strips model-supplied scope — **the worker enforces the root and grants**."*

Grants are a per-session set of roots in their own state scope, read once per dispatch batch, stamped into `fs_scope.grants`, and purged on session deletion. The control functions are *"registered harness functions for orchestration code, but intentionally excluded from the model-facing catalog."*

## 5.17 Anonymous usage reporting

Worth documenting because the shape is a restrained telemetry design and a useful counterexample to the usual pattern. The harness announces on the durable `harness:usage` topic; the engine subscribes and sends one anonymous product event per message. Two moments: `harness_session_progress` at root turn 1, 2, 5, 10, 25 and 50 (each superseding the last, carrying cumulative turns / function calls / tokens / cost); and `harness_turn_failed`, once per session per failed / cancelled / max_turns outcome. **One session reports at most 9 messages**, and *"sub-agent turns report nothing of their own."* The payload carries model name, provider name, the counters and a fixed failure class — **"no message text, no prompt, no file path and no function id."** A `harness_usage` state row records what was already announced *"so a restart does not announce one again."* Every step is best-effort. Opt-out is `III_TELEMETRY_ENABLED=false`, and *"the engine then takes the messages from the topic and discards them, so an opted-out deployment stores nothing."*

The criticism that stands is not the payload but the default: reporting is **on** unless an environment variable is set, which for a self-hosted developer tool is a defensible-but-debatable choice.
---

# 6. The sibling workers

`compose::add worker=harness` installs these; harness boot blocks until `queue` defines the `harness-turn` queue.

## 6.1 Contract table

| Worker | One-line contract | Principal ids | Stored state |
|---|---|---|---|
| **session-manager** | append-only transcript store; every mutation fires a trigger | 21 ids: `session::create/ensure/get/list/set-meta/set-draft/set-status/delete/append/append-many/update-message/messages/get-message/messages-tail/messages-range/fork/set-active-leaf/put-attachment/get-attachment/list-attachments/delete-attachment` | one JSONL file per session + attachments dir |
| **context-manager** | pure `(messages, model) to model-ready context` fitting a token budget; owns nothing durable | 4 ids: `context::assemble/compact/prune/count-tokens` | compaction leases only (scope `context_lease`, TTL 300 s) |
| **llm-router** | one front door for every provider: routing, registry, credentials, catalog, streaming relay, retries, one failure contract | `router::chat/complete/abort/route/embed/transcribe/speak/count_tokens`, `router::models::*`, `router::provider::*` | scope `llm-router`; credentials in the config entry |
| **queue** | durable function queues; registers `durable:subscriber` | `queue::define`, `engine::queue::*`, `iii::durable::publish`, `iii::queue::*` | `data/queue` (file-backed, persists per mutation) or redis/rabbitmq |
| **state** | distributed KV by scope+key with reactive change triggers | `state::set/get/delete/update/list/list_keys/list_groups`, `state::compare-and-set`, `state::barrier`, `state::claim-namespace` | rkyv `.bin` per scope, or redis; **reserved** scopes refuse public access and emit no events. `claim-namespace` is the isolation primitive: it grants `<prefix>::state::{get,list,compare-and-set}` accessors authorized by the engine-stamped `_caller_worker_id`, which is how the harness owns `harness_*` scopes without a second store |
| **memory** | cross-session memory: banks of *rules* (injected whole) and *memories* (recalled on demand) | `memory::bank::*`, `save/get/list/update/delete/pin/supersede/tags/preview/recall`, `rule::*`, `doctor`, `reload` + hook functions | `<data_dir>/<bank>/{bank.yaml, rules/*.md, memories.jsonl, vectors.jsonl}` + `.trash/` |
| **memory-consolidate** | scheduled hygiene: merge near-duplicates, supersede-only | `memory-consolidate::run/status/on-tick` | scope `memory_consolidate`: `last_run`, `last_report` |
| **iii-directory** | registry proxy + filesystem-backed skills, system prompts, agent profiles | `directory::skills::*`, `directory::system-prompts::*`, `directory::agents::*`, `directory::registry::workers::*`, `directory::search_functions` | **files only** — "nothing is ever cached or mirrored to iii-state" |
| **approval-gate** | policy/decision surface for human-held calls | `approval::gate`, `filesystem-access-watch`, `resolve`, `list-pending`, `get-pending`, `set-mode`, `add-always-allow`, `approve-always`, `evaluate`, `get-settings`, `on-session-deleted` | ephemeral — **no resolved-approval history** |
| **judge** | provider-neutral hub forwarding Noul / Choice / Score questions to a `judge-<provider>` worker | `judge::evaluate`, `judge::models::list`, `judge::cancel` | none — "the hub holds no credentials" |
| **workflow** | deterministic DAG orchestrator; nodes fan out as child harness sessions with deterministic ids | `workflow::start/tick/status/node-result/stop` + hooks `wake / stamp-reply / inject-guidance / sweep` | scopes `workflow_run / _def / _node_result / _session_index / _idem` |
| **eval** | live comparison of 2–5 root sessions + advanced prompt A/B; does not score or persist | `eval::start/list/rerun/status/result/cancel/delete/step/sweep/compare-sessions`, `eval::assert::*` | scopes `eval_job` / `eval_session`; queue `eval-run` |

## 6.2 session-manager — the transcript

**Format.** One append-only JSONL file per session; the filename encoding passes `[A-Za-z0-9._-]` and percent-encodes the rest, which *"keeps filenames portable and blocks path traversal."* Five line-discriminated record types: `meta`, `entry`, `leaf`, `append` (entry+leaf+meta in one line), `commit` (one marker per committed entry). **Replay is last-wins per key.** Attachments are deliberately *not* in the log — written atomically with metadata last, *"so a listed attachment always has its bytes."* A crash mid-append is tolerated: the next append removes only the invalid trailing partial line before retrying.

**Partial outputs.** Streaming is not a record type — it is repeated `session::update-message`. The request replaces content wholesale and carries an optional `expected_revision`; a mismatch *"writes nothing, fires nothing, and returns `{ updated: false, revision }`."* The canonical loop: append an **empty** assistant message, then update it per token batch; the consumer renders from `message-updated` snapshots (highest revision wins) and drives its spinner from `status-changed`. Terminal usage/cost rides the same call.

**Ordering is by the parent chain, never by time.** *"The chain is the transcript order — never timestamps, never insertion order."* A session is an append-only log plus an **active leaf** pointer; the *active path* is the walk from leaf to root, which is what `session::messages` returns. Forking is copy-on-fork into a new session with fresh entry ids.

**Recovery, three layers.** Storage: crash-tolerant JSONL replay. Delivery: triggers are fire-and-forget, **at-least-once and unordered**, so reconcile content by `revision` and order by the `parent_id` chain — *"never by arrival or timestamps."* Writer: on redeliverable paths use `session::append` with a deterministic `entry_id` so replays return the original entry and fire nothing — and note the documented asymmetry, `append_many` is **not** idempotent.

**Blocked reactions.** session-manager has no "blocked" concept, deliberately. A held call is recorded by the *harness* as an ordinary entry (a `function_result` with `is_error`, or a placeholder carrying `details: { error: 'interrupted' | 'elided' }`). approval-gate confirms the split: *"The transcript's `function_result` and the `pending_resolved` event are the audit trail"* — the gate keeps no history of its own. Long non-message state (compaction summaries) rides `custom` entries that don't pollute `message_count` or role filters.

## 6.3 context-manager — budgeting and aged pruning

**Budget.** `usable = max(0, (input_limit ?? (context_window - max_output_tokens)) - reserved - thinking_budget)`, saturating throughout. `reserved` defaults to `min(20000, 10% of context_window)`. Model limits resolve **inline, then `router::models::budget`, then a conservative 8192/1024 fallback**, and the response's `model_resolved` field tells the caller which ran — a nice touch: the caller never has to guess whether it got real limits. Tokens are heuristic: `chars/4` plus a fixed 4096 per image.

**Aged pruning** is *replace, never remove*: the message, its `function_call_id` linkage and the message order all survive; only the content is rewritten, newest to oldest. Eligibility is a five-part conjunction: the newest `protected_user_turns` (2) are never touched; outputs inside the newest `protect_recent_tokens` window (40 000) are kept; `protected_functions` are never pruned; outside that window an output is eligible when it exceeds `max_output_chars` (2 000) **or** has reached `decay_user_turns` age; and if everything prunable would free under `min_free_tokens` (20 000), **nothing is touched at all**. The placeholder is self-describing — `[output of {function_id} pruned: was ~{tokens} tokens; re-call it if still needed]` — and is recognised on re-run, so pruning is idempotent. `assemble` additionally runs an unconditional cap pass and an emergency pass that replaces oversized results with bounded references to the transcript.

**Degraded modes are explicit:** without `llm-router`, limits fall back, `compact` returns `overflow`, and `assemble` can prune but not summarise.

## 6.4 llm-router — the chat contract and prompt caching

**`router::chat`** takes the caller's channel write-endpoint plus `ChatCall`: `request_id?`, `session_id?`, `model`, `provider?`, `system_prompt?`, `system_sections?`, `cache_intent?`, `messages`, `tools?`, `response_format?`, `thinking_level?`, `max_output_tokens?`, `provider_options?`. Pipeline: validate, decide, gates, budget, attempt loop, **exactly one terminal frame**. When the router itself kills a stream (idle timeout, provider crash) it synthesises the terminal frame **with the partial content attached**, *"so consumers never hang on a half-open stream."* Errors are stable `router/<code>` ids with `kind`, `retryable` and optional `detail` — *"automation branches on code, never prose."*

**Caching.** `system_sections` is an ordered list of `{ text, cache_boundary }`; the boundary marks the end of a cumulative prefix worth its own provider cache entry. `cache_intent.surface_digest` is the caller's `sha256:<hex>` identity for the text before the boundary — *"a routing/accounting hint only — never a provider cache handle, and never evidence of a cache hit."* Sections-only requests flatten to a joined `system_prompt`; when **both** are sent they must agree byte-for-byte or the call is rejected — a nice guard against a subtle inconsistency. Both are forwarded verbatim, *"so a provider that knows nothing about sections keeps reading `system_prompt`.` Cache-aware providers put their prefix marker on the boundary block (Anthropic, Claude Code) or derive a shared `prompt_cache_key` from the digest (OpenAI, Codex, xAI, Kimi), *"so every session on the same frozen prefix lands on one cache entry."* The only evidence of a hit is `usage.cache_read`.

**Provider-native options** are **namespaced by provider id** and narrowed to the resolved provider's slice before forwarding. `messages`, `tools`, `response_format` and `thinking_level` stay untyped and are forwarded verbatim — *"the router intentionally does not re-validate their shape."* Providers self-register as separate workers through a token-gated protocol (a token issued at registration is required on every later call), so *"the router never compiles against a provider, and removing a provider worker removes the provider."* Only the read surface is agent-callable; chat/spend and the credential protocol are denied to in-run agents, though worker-to-worker calls bypass that gate.

## 6.5 queue — the guarantees, stated honestly

- **Fan-out:** each `(topic, id)` subscription gets its own internal queue; `enqueue` pushes a **separate copy** to every subscription — N subscribers each receive every message, they do not compete. With **no** subscribers, a message buffers on the bare topic name rather than being dropped.
- **FIFO per key:** `type: fifo` + `message_group_field` (the harness uses `session_id`): same group runs in order, different groups run concurrently up to `concurrency` (default 10; 0 pauses). *"fifo without `message_group_field` is rejected."* **Known gap:** `durable:subscriber` FIFO remains globally serial with no grouped partitioning.
- **Durability:** file-backed mode persists on mutation rather than on an interval, so those jobs survive restart; **pending in-memory jobs are lost**. After a restart a delivery waits until its target function registers and *"does not consume retry budget while the target worker boots."*
- **Retries/DLQ:** 3 retries with exponential backoff, then a per-function DLQ with redrive / redrive-message / discard. **Ordering holds only for first-attempt successes** — a failed FIFO message re-queues with a delay and can be overtaken.
- **Admission control:** there is none. The levers are `concurrency` (0 = pause), `condition_function_id` (only an explicit `false` skips the handler), and RabbitMQ prefetch/priority.
- **Redis is pub/sub only:** no DLQ, no retries, no durability; a message published with no subscriber is lost, and a persisted `queue_configs` entry fails boot. An unreachable redis/rabbitmq target at boot fails the boot outright with **no fallback to builtin**.

## 6.6 iii-directory — files, and the D-codes

The filesystem is the single source of truth: skill files are re-read from disk on every resolve and *"nothing is ever cached or mirrored to iii-state."* Four roots: writable `skills_folder`, project-scoped `local_skills_folder`, writable `agents_folder`, and a **read-only** `agents_skills_folder` scanned shallowly. Precedence is `local > skills > agents_skills`.

Layout is by convention, not configuration: `<skills_folder>/<ns>/index.md` is a skill, any `*/system-prompts/*.md` path is a system prompt (a magic marker, classified first), and `<agents_folder>/<id>.md` is an agent profile. Skill ids are the relative path minus `.md`, each segment constrained to `[a-z0-9_-]{1,64}`.

Reads go through the `list`/`get` pairs; writes are the `download*` family plus per-kind `create`/`update`/`delete`, all atomic, all fanning out an `on-change` trigger with `op: create|update|delete` — and **a direct edit on disk fires the same trigger with `op: "external"`**, so a hand-edited file and an API-written one are indistinguishable to a subscriber.

Three agent profiles ship **in the binary** (`default`, `iii`, `iii-minimal`); a local file shadows one, deleting the shadow falls back to the bundled copy, and **no file is ever seeded on disk**. Profiles inherit via `extends:` capped at 8 hops, with the resolved prompt composed as ancestor bodies root-first followed by the child's.

**The D-code error design is worth stealing outright.** A bus handler error is a plain string the engine rewraps as `handler error: <string>`, so directory errors are *one self-sufficient prose sentence* — `<code> <class>: <problem> Did you mean: … Next: call <fn> to …` — **never a JSON envelope, which would arrive double-escaped and be unreadable to an LLM**. The leading code and class word are stable and greppable so non-LLM consumers can branch without parsing prose. Codes observed: `D110` skill not found (with ranked suggestions), `D111` generic invalid input, `D112` id looks like a *function* id, `D113` content over the byte limit, `D114` create target exists, `D115` reserved path segment (the file would be invisible to every scan), `D116` read-only system-installed skill, `D210` system prompt not found, `D213` frontmatter name mismatch, `D214` target exists though the scanner skips it, `D310`/`D311` registry lookup and traversal guard, `D410` profile not found, `D414` profile already exists, **`D415` extends chain does not resolve — the profile still serves its own file so an editor can fix it, while the harness refuses to run it**, `D416` no valid function ids.

That D415 split is the same pattern as the harness's "refuse loudly but leave the artifact readable" approach, and it is the right one for anything a human has to repair.

## 6.7 approval-gate — the hold and the release

`approval::gate` is a `pre_trigger` hook. It **never errors** — *"every failure mode resolves to a fail-closed `deny`"* — and it is idempotent under at-least-once steps because the pending write is keyed on `function_call_id`. Evaluation order: (1) an `approval::*` or `configuration::*` target is denied as **`human_only_function`** even under `full` mode — the self-escalation defence; (2) ids that cannot key a pending record are denied; (3) mode `full` allows; (4) an `approved_always` hit allows in **every** mode; (5) mode `auto` **and** an `always_allow` hit allows; (6) otherwise configured `rules` decide first-match-wins, and **no match means hold**. With no `rules` configured, only the worker's own `approval::*` surface is denied and everything else holds.

**The hold.** The pending record is written **synchronously before the hook returns hold** — *"a held call must never be invisible to the inbox"* — and a write failure becomes a fail-closed deny rather than a blind hold. The `pending-created` event emits only after the record lands, so notification fan-out never blocks the trigger hot path. **Holds never expire.** A redelivered step that finds the record already present returns hold again with no second event.

**The release.** A human or console calls `approval::resolve`. Resolve persists **no decision record** — the decision flows straight into `harness::function::resolve`, the harness re-runs the call through trigger, and the record dies with the resolution. The crash ordering is deliberate and worth quoting: harness resolve **first**, then delete, then emit — *"so a crash in between leaks at most one record until cleanup and can never lose a decision."* After a successful release the worker re-reads the key and deletes only if it still holds the *same* record, because executing an approved call can synchronously hit a follow-up hold that replaces the record under the same key. Duplicate decisions race benignly and return `{ resolved: false }`.

**Folder-access grants.** A `filesystem_access` hold carries an `access_duration` that decides how the approval is applied: `once` rides the release as a one-shot grant on the dispatch's `fs_scope.grants`; `session` and `always` first install a durable `harness::filesystem::grant` (falling back to a once-style grant if that fails); `always` additionally best-effort persists the root into shell config. UIs bind two events — `approval::pending-created` (redacted arguments, self-sufficient for notification copy) and `approval::pending-resolved` (exactly once per record, with `outcome: allow|deny|aborted`) — and after a restart reconcile with a single `approval::list-pending` call. Cleanup is driven by `approval::on-session-deleted` and `approval::on-turn-completed`.

**Stated caveat, from the worker's own README:** it codes against greenfield harness contracts (`harness::hook::pre-trigger`, `harness::hook::post-trigger`, `harness::function::resolve`, `harness::turn-completed`, `harness::workspace::grant/grants`) that the *current* harness does not yet implement. Without them it still boots and serves its RPCs, logging `trigger_type_not_found` for absent bindings, and only the grant watch degrades.

## 6.8 memory and memory-consolidate

**memory's own principles are the clearest philosophy statement in the repo.**

- *"Files are the source of truth."* `rules/*.md` and `memories.jsonl` under the data dir; edit them in any editor and a reload picks it up. The search index is a RAM-only cache rebuilt from files at boot, *"so store and index can never diverge across restarts."*
- *"Crash-safe by construction."* Every mutation appends one fsynced JSONL line **before** touching RAM. *"There is no shutdown flush to get wrong. An unwritable data dir is boot-fatal: this worker never silently runs in RAM."*
- *"Supersede, never delete."* Updates append revisions; deletes append tombstones; trashed banks move to `.trash/`. *"Any state is recoverable."*
- *"Pinning."* A pinned memory ranks higher in recall and is *"untouchable by every automatic path."*
- *"One LLM call per turn, zero at query time."* Extraction is triggered by `harness::turn-completed`, which spawns **one** background `router::complete` pass over the last `extraction_window` user/assistant messages. It is ADD-only and content-fingerprinted *"so redelivery reinforces instead of duplicating"*, and the job rides the durable `memory-extraction` queue so a pass is retried rather than lost; a `memory_cursor` state scope tracks progress. Recall itself costs zero LLM calls — BM25 + entity match + corroboration + recency, plus a semantic signal when embeddings are available — and is sub-millisecond at this scale.
- *"Rules learn from corrections."* Extraction classifies standing instructions (style directives, workflow corrections) separately from memories and appends them to the bank's auto-managed `learned` rule — *"correcting the agent in chat reaches every later turn."* Hand-authored rules are never touched; dedup is by content fingerprint.
- *"Honest health."* `memory::doctor` runs a *real* save to recall to trash roundtrip and reports sibling reachability. `memory::recall` names the retrieval mode it ran. *"Degradation is explicit, never silent."*

**Injection** is a `pre_generate` hook, fail-open, priority 100: the bank's rules extend the **system prompt once per session** and are sent verbatim after that, while recalled memories arrive as **one appended message on a turn's first step only**. Both keep the prefix append-only. Whether an update is due is read back *from the window the step sends* — *"so a lost or compacted-away update is sent again and a delivered one never is."* That is a genuinely elegant solution to at-most-once delivery without a side ledger.

**memory-consolidate** never touches memory's files; every mutation goes through memory's public supersede and save functions. Scheduling is an hourly heartbeat that runs a pass only when `interval_hours` (default 24) have elapsed since the last one, with the last completed pass persisted in state — giving **catch-up-on-boot**: *"a pass missed while this worker was down runs shortly after boot instead of waiting for the next heartbeat."* Detection is deliberately conservative: automatic writes only on normalized-text equality; token-set equality (word-order shuffles) is **report-only**, because *"'Alice manages Bob' and 'Bob manages Alice' share a token set but mean opposite things."* That single comment is a better argument for conservative automation than most design docs manage in a page.
---

# 7. Design principles, consolidated

These are stated in the repo's own words, across docs, specs and inline comments.

## 7.1 Contract discipline

1. **"The contract is the product."** Every capability is a registered function with `description`, `request_format` and `response_format`, named `<worker>::<resource>::<action>`.
2. **"One function per action."**
3. **"Errors are part of the contract."** *"Never swallow an error into a success-shaped response."* Errors carry **stable, greppable codes** (`router/<code>`, `D415`) that non-LLM consumers can branch on without parsing prose.
4. **"One home per fact."** Engine `state` for small values others watch; the `database` worker for records — *"never both."*
5. **"Configuration is data"** — never a secret in a public default, and every field hot-reloads.
6. **"The engine tells you the truth; trust it over memory."** Discovery is `list, info, call` — never a hardcoded id.

## 7.2 Runtime discipline

7. **"Reactive triggers, never polling."** Bind a trigger; do not loop on a status call. Where an operation is async, the pattern is *arm a one-shot wake with an operation id, call, then read status once for race recovery*.
8. **"Never block on long work."** Park, do not hold. A parked turn holds **no queue step**.
9. **"Idempotency is not optional."** At-least-once delivery plus deterministic ids plus per-call checkpoints; the only at-most-once hop is the target invocation, resolved conservatively as an error on restart.
10. **Fail closed on anything that gates, fail open on anything that observes.** And *"a crashed gate is not an open gate."*
11. **Every refusal has a reason, and the reason is recorded.** Non-deliveries, skips, condition failures and retirements are all first-class recorded outcomes.
12. **Recovery must not depend on retry.** Startup re-arm, catch-up, replay and deadline-notification are preferred over an outbox.

## 7.3 Boundary discipline

13. **"If a concern grows real logic, it becomes its own worker."** The harness owns sequencing and nothing else.
14. **"Wrap, don't duplicate"** in practice: the harness *stamps* filesystem scope and says *"the worker enforces the root and grants."*
15. **"Hook logic lives in the sibling, never the harness."** The extension point is a typed seam, not interpreted configuration — which is exactly why the ~2,450-line `harness::react` was deleted.
16. **Siblings that need to sit inside the critical path bind a hook; everything else binds events.**
17. **Specify what a thing is *not*.** Every major doc has a "What spawn is not" or "Boundaries" section. *"Not agent-to-agent messaging, not a workflow engine, not a shared blackboard."*

## 7.4 Safety discipline

18. **Deny by default; ask when unsure.** An absent allow-list denies every call; a deployment permission file's *no match* is `needs_approval`.
19. **A child can narrow, never escalate** — and the rule is enforced by a conservative glob-coverage check, not by trusting the request.
20. **"Children cannot widen or replace their root turn's execution budget."**
21. **Budgets are frozen at root start and cannot be changed.** Missing or partial usage *consumes the full reservation*.
22. **"Treat hook input as untrusted… the hook runs with worker privileges and is a textbook confused-deputy target."**
23. **"Agent-authored metadata is never trusted for routing or authorization."**
24. **Destructive operations are idempotent, resumable, child-first, tombstoned, and have no force mode.** *"There is intentionally no unsafe force-delete."*
25. **Mutations must be visible in the audit trail** — a hook returns `annotations` because *"the transcript stores the effective (rewritten) values."*

## 7.5 Evidence and documentation discipline

26. **A green build proves nothing about a runtime contract** — hence interface capture from a running process.
27. **Documentation is tested.** A repo-wide test fails if a shipped prompt names a removed id or a worker the agent is meant to discover.
28. **Three doc layers with a divergence rule:** design of record, as-built architecture, behavioural truth — *"when they diverge, fix the code or update architecture docs in the same PR."*
29. **Architecture docs must be sufficient on their own** — *"a reader (human or LLM) should be able to integrate against the worker without opening the source."*
30. **"Honest health": degradation is explicit, never silent** — and a doctor command runs a *real* roundtrip rather than reporting a boolean.
31. **State the ceiling.** The queue worker documents that retried FIFO messages can be overtaken; the trigger subsystem documents that delivery is at-most-once with no outbox. Documenting the limit is treated as part of shipping the feature.

## 7.6 Epistemic discipline (the most distinctive trait)

32. **"The digest is a local identity, never evidence of a hit — `usage.cache_read` is."** A derived identifier is never allowed to stand in for the observation it approximates.
33. **"Never GC on doubt."** Unknown state is retained, not cleaned.
34. **Unknown remote completion is a *durable witness*, not a cancellation.**
35. **Frozen means frozen.** Directory edits never reach a live session; a stale frozen block is corrected by a **tail notice**, never by rewriting the block.
36. **Conservative on meaning, forgiving on cosmetics.** An unknown icon fails the spawn; an unknown colour becomes neutral.
37. **"Never interpret a stop acknowledgement as terminality."**

---

# 8. Observations, drift and risks

Findings from this audit that are not in the docs' own words.

## 8.1 Documentation drift (all verified against the working tree)

1. **The README's Modules table describes `harness` as "Node | TS port of the iii harness stack."** The tree is Rust: `iii.worker.yaml` declares `language: rust` / `deploy: binary`, `Cargo.toml` names the crate at v1.8.43, and `src/turn_loop.rs` is 233 KB of Rust. There is no `turn-orchestrator`, `hook-fanout`, `llm-budget` or `context-compaction` directory anywhere in the repo.
2. **`harness/architecture/integration.md` does not exist.** Both `harness/README.md` ("Start with the integration contract in architecture/integration.md") and `harness/architecture/README.md` (which lists it as "the handoff contract") point at it. `git ls-files harness/architecture` returns only `README.md`, `reactive-triggers.md`, `session-tree-deletion.md`, `trigger-bindings.md`. The same applies to `harness/agents/worker-builder.md`, referenced by the README as a shipped profile.
3. **The design of record lists five hook points; the code has six.** `harness.md §Hooks` omits `post_turn`, which is not only implemented but is *the only agent-bindable* hook point.
4. **Event names disagree between spec and code.** The spec writes `harness::turn_started` / `harness::turn_completed`; the code emits the dashed forms `harness::turn-started` / `harness::turn-completed`.
5. **`trigger-bindings.md` documents three built-in reaction gates** (`not-self-caused`, `causal-depth`, `upstream-failure`) that no longer exist; `conditions.rs` says outright that *"There are no built-in reaction gates anymore."* The same doc presents `causation` (depth, registered_by_turn) as live; it is written as a default at every construction site and read nowhere. Its file-map line counts are stale by 2–3x.
6. **`approval-gate` codes against contracts the harness does not yet implement** (`harness::hook::pre-trigger`, `harness::function::resolve`, `harness::turn-completed`, `harness::workspace::grant/grants`). Its README states this candidly; it is still worth noting that a shipped, registry-published sibling targets an interface that is only partly present.
7. **`package.json`-level metadata drifts too** — the description of the registry entry advertises 33 functions and 13 triggers while the code registers more.

The pattern in items 1-5 is consistent: **the design-of-record layer and the code have diverged, and the repo's own rule — fix both in the same PR — was not applied.** That the rule exists and is stated three times makes the drift a process observation rather than a mystery.

## 8.2 Real architectural limitations (documented by the authors, worth knowing)

- **Trigger delivery is at-most-once with no outbox.** *"A harness crash between the engine's fire and the claim loses the event."* Recovery is reconstruction, not retry.
- **Binding durability is bounded by the state adapter**; the dev default is in-memory, so a *state* restart drops binding records while a *harness* restart does not. That asymmetry is subtle and could bite.
- **Queue FIFO holds only for first-attempt successes**, and pending in-memory jobs are lost on adapter swap.
- **No queue backpressure.** `concurrency: 0` is a pause switch, not a flow control valve.
- **Redis as a queue adapter is a footgun**: no durability, no retries, no DLQ.
- **`append_many` is not idempotent**, in a system whose entire redelivery story is "use deterministic ids."
- **A hook must be idempotent** because it re-runs on redelivery, but the harness offers no dedup primitive for hook side effects beyond "key on turn_id + step".
- **The registry has 96 workers and 2 verified authors** — the `iii verified` signal covers very little of the catalog.
- **Anonymous usage reporting is on by default** with an environment-variable opt-out.

## 8.3 What is genuinely excellent

- **Parking without holding a queue step** is the single best idea in the system, and it is what makes both sub-agents and human approvals first-class without special cases.
- **Deterministic entry ids + at-most-once target invocation** is a small, complete answer to distributed execution that does not require exactly-once semantics anywhere.
- **Injection as an append-only tail with the frozen prefix never rewritten** solves the caching/updating tension without a special case.
- **Reading update-due state back from the window the step sends** (memory) removes the need for a delivery ledger entirely.
- **The `on_error` defaults per hook point** encode a security decision in a default, and the docs explain why.
- **The tolerance asymmetry** (closed icons, forgiving colours) and **the conservative consolidation rule** ("Alice manages Bob") both show judgement rather than mechanism.
- **The D-code prose errors** and the **two-sided refusal on profile resolution** (refuse to run, keep the file readable) are directly reusable patterns.
---

# 9. Application to `dsh-recursive-mode`

## 9.1 The framing that matters

The two projects solve the same problem from opposite ends.

| | iii `harness` | `dsh-recursive-mode` |
|---|---|---|
| owns | the loop | a policy over repo artifacts |
| loop source | its own durable queue + turn record | borrowed from DSH |
| state | session transcript + state scopes | Markdown files under `.recursive/` |
| extension | 6 hook points, typed seams | 2 ad-hoc listeners |
| enforcement | glob policy + hooks | 3 mode flags + a hardcoded path test |

So the valuable transfer is **not** the execution layer. DSH already provides turns, streaming, subagents, goals, tools, an approval seam and a web server. Copying `turn_loop.rs` would be precisely the "duplicate, don't wrap" failure that `dsh-recursive-mode`'s own PROPOSAL warns against — and the harness's own principle ("if a concern grows real logic, it becomes its own worker") argues for keeping the loop where it is.

What *is* transferable is the layer the harness had to invent because it also wanted to be **legible and trustworthy**: declarative policy, a hook contract, prefix discipline, and idempotent operations. Those are all pure TypeScript work.

## 9.2 Mapping

| iii concept | `dsh-recursive-mode` today | Verdict |
|---|---|---|
| Durable turn loop, queue, streaming, providers, session store | provided by DSH + `ctx.goals` + `ctx.agentTeams` | **do not copy** |
| Multi-worker decomposition, bus, registry, compose | DSH is the host | **do not copy** |
| Deny-by-default glob policy with `needs_approval` as the no-match default | hardcoded `WRITE_TOOL_NAMES` set plus a path substring test in `enforcement.ts` | **copy** |
| Hook contract: named points, priority, timeout, `on_error` | two inline `ctx.on(...)` listeners | **copy** |
| Stable prefix + `cache_boundary` + surface digest + fallback reason | one per-phase-varying prompt section | **copy** |
| Agent profiles: markdown, `extends`, preloaded skills and contracts, frozen + sticky | one static preset | **copy** |
| `max_result_bytes` elision with a self-describing marker | unbounded lint output | **copy** |
| `harness::ask` structured cards with enforced limits | prose sign-off inside artifacts | **copy** |
| `operation_id` + `attempt` idempotency, child-first, tombstones | `reopen` cascades synchronously | **copy** |
| Durable binding records + recorded non-delivery reasons | two **in-memory** once-guards | **copy** |
| Executable documentation tests | golden lint fixtures only | **copy** |
| D-code prose errors, stable and greppable | marker strings only a linter reads | **copy** |
| Self-describing pruning placeholders | n/a | **copy** (cheap) |
| Telemetry on by default with an env opt-out | nothing | **do not copy** |
| `harness::react` — a control plane interpreted from metadata | n/a | **do not copy** (negative lesson) |

## 9.3 Tier 1 — small, high leverage

### 1. A declarative, ordered tool policy with `ask` as the no-match default

**iii does:** `allow && !deny`, deny wins, `None` denies all, an invalid glob fails the whole policy closed, and the deployment file is first-match-wins with **no match meaning `needs_approval`**.

**You have:** `src/enforcement.ts` — a `WRITE_TOOL_NAMES` set and a `endsWith('.md') && includes('/.recursive/run/')` test. Two of its three branches are inert at runtime (§9.7).

**Concrete change.** A new `src/policy-globs.ts`: a small glob matcher (`*`, `worker::*`, exact), an ordered `Rule[]` with `{ pattern, verdict: allow | deny | ask, reason }`, and `evaluate(id, args): Decision`. Ship `.recursive/config/recursive-permissions.json` with a documented default, and let `phase-rules.ts` supply a **per-phase baseline** — for example: phase 3 denies `recursive_lock` until TDD evidence exists; phase 6 allows writes only under `.recursive/DECISIONS.md`; phase 8 allows writes only under `.recursive/memory/**`. `evaluateToolGuard` becomes a thin caller.

**Why first:** ~200 lines of pure TS, trivially unit-testable, and it replaces a heuristic with a contract a human can read. It also makes the currently-dead lock-order and TDD branches expressible again, because a policy matches on *tool id + arguments* rather than on a `runId` the guard does not have.

**Watch out:** the iii design deliberately keeps **two** allow-lists with different semantics (agent dispatch vs human approval). If you add both, document the difference or you will recreate the confusion the iii docs warn about.

### 2. Fix the live guard path and make every decision visible

**iii does:** every hook decision is bounded by `timeout_ms` + `on_error`, and every skip appends a model-invisible entry **with the reason**.

**You have:** `index.ts` calls `evaluateToolGuard(exec, root, '', ...)` with an **empty runId**, so the lock-order and TDD branches resolve prerequisites against `<root>/.recursive/run` (a directory of run folders) and never match. `validateTransition` and `detectTamper` — both exported and unit-tested — have **no caller in `index.ts`**. The `tamper` enforcement mode therefore exists only as prompt text and board facts.

**Concrete change.** Resolve the active run id per call — the `agent/pre-step` listener already does `enumerateRuns` + `getNextLegalPhase`, so the pieces exist. Route the guard through `validateTransition`. Return a typed `GuardDecision { kind, reason, rule, transition }`, persist a rolling decision log (`.recursive/run/<id>/guard-decisions.jsonl`, git-ignored), and surface the last N in `recursive_status` and on the board card.

**Why:** it is a bug fix that simultaneously makes the enforcement layer auditable — which is the plugin's stated purpose.

### 3. Result caps and elision markers

**iii does:** `max_result_bytes` 256 KiB; over the cap, content and details are replaced with `<omitted: result was ~N KB, over the M KB harness result cap; re-call with narrower arguments…>` and `details.result_capped`.

**You have:** `recursive_lint` returns unbounded `errors[]` / `warnings[]`; `src/ts-lint.ts` is a 126 KB port that can emit hundreds of findings into one tool result.

**Concrete change.** Cap in the tool's `render`; emit `{ elided: true, total, shown, hint }`; add `mode: 'summary' | 'full'`. Make the marker self-describing — say how to get the rest.

### 4. `recursive_ask` — structured decisions instead of prose

**iii does:** `harness::ask` — 1-4 questions, 2-4 options, `header` ≤16 chars, `label` ≤80, single-line, one per step; the turn ends on the question; refusals name the field and index; the answer is simply the user's next message.

**You have:** `QA Execution Mode: human` sign-off, `TDD Mode: strict|pragmatic`, and every gate-block resolution are prose lines a human has to answer in chat. DSH exposes an `ask_user_question` tool; the plugin never calls it.

**Concrete change.** A `recursive_ask` tool with the same validation limits and the same refusal vocabulary, used at exactly three points: TDD mode at phase 3 entry, QA sign-off at phase 5, and gate-block resolution. Write the answer back as a durable artifact line so the artifact remains the record.

**Why:** these are the only three places the workflow genuinely blocks on a human. Turning them into cards removes the "the agent asked in prose and the user missed it" failure mode — and the fixed limits are what stop a card from becoming a wall of text.

## 9.4 Tier 2 — structural

### 5. A hook registry: named points, priority, timeout, `on_error`

**iii does:** six named points, a middleware chain ordered by `priority`, `HookOutput = continue | deny | hold`, per-binding `timeout_ms`, and `on_error` defaulting to fail-closed for gating points and fail-open for observing points. Hook logic lives in the sibling.

**You have:** exactly two listeners inlined in `apply()` — a `tools/pre-execute` guard and an `agent/pre-step` reminder — with no ordering, no timeout, no failure policy, and no way for a sibling plugin to participate.

**Concrete change.** `src/hooks.ts` exporting a typed `HookRegistry` with five points mapped onto DSH seams:

| Point | DSH seam | May do |
|---|---|---|
| `pre_turn` | `agent/pre-step`, before delegating to `next()` | veto |
| `pre_generate` | the `recursive:policy` section callback | extend the prompt; veto |
| `post_generate` | post-step listener | **observe only** |
| `pre_trigger` | `tools/pre-execute` | deny, ask, rewrite args |
| `post_trigger` | `tools/post-execute` | rewrite the result |

Then express recursive-mode's *own* enforcement as built-in hooks. Same behaviour, but now ordered, bounded, failure-policied, and **extensible by other DSH plugins** — which is what would let `dsh-anti-slop` or `dsh-zero-trust` participate in a run.

**Copy the six cautions into the module doc**, especially: hooks run on at-least-once paths and must be idempotent; mutations are silent so return annotations; never start a turn from a hook; and treat hook input as untrusted.

### 6. A stable prompt prefix with a cache seam and a digest

**iii does:** `system_sections = [{text: stable, cache_boundary: true}, {text: tail}]`; `surface_digest = sha256(stable)`; and when it cannot be delivered the **reason** is reported (`disabled` | `no_stable_prefix` | `prefix_rewritten`). Plus the honesty clause: the digest is a local identity, never evidence of a hit.

**You have:** `src/policy.ts` renders the *current phase*, its required sections, and its gate checklist into one section — so the injected text changes on every phase transition, and static contract text is interleaved with volatile text. For a plugin that injects long policy text on every step of every turn, this is the single largest avoidable cost.

**Concrete change.** Split `renderRecursivePolicy` into `renderStableContract()` — phase vocabulary, gate vocabulary, marker names, lock rules; byte-identical for the whole run — and `renderPhaseTail()` — current phase, required sections, checklist, blockers. Emit as two sections with a boundary marker on the first. Add `promptSurfaceDigest` and `promptSectionsFallback` to `recursive_status`. Report `prefix_rewritten` if any hook replaced the head.

**Why:** it is strictly compatible with your zero-emission rule — everything is still rendered from the filesystem — and it makes "did the prefix change?" a one-field answer instead of a guess.

### 7. Phase and role profiles: markdown, `extends`, preloaded skills and contracts, frozen and sticky

**iii does:** one markdown file per profile; `extends` composed root-first **by the directory**; resolved **once** and frozen onto the turn; `skills` and `functions` preloaded into `<preloaded_skills>` and `<preloaded_functions>` blocks *"so the model calls them on the first step instead of spending a search and a contract lookup per session"*; directory edits **never** reach a live session; a profile's skills never narrow the index ("curation, not authorization").

**You have:** one static preset, and `recursive-router.json` role names (`orchestrator`, `analyst`, `planner`, `implementer`, `code-reviewer`, `tester`, `memory-auditor`) that only ever affect *tier selection*, never identity.

**Concrete change.** Ship `agents/*.md` in the package — `recursive-base`, `recursive-implementer` (phase 3, TDD contract preloaded), `recursive-auditor` (phase 3.5, the review output schema preloaded), `recursive-qa` (phase 5) — with `extends: recursive-base`. Resolve once on phase entry, freeze onto the run's step record, and preload that phase's required sections, gate checklist and the exact `recursive_*` tool contracts. Profile `functions` is also the natural home for the Tier-1 policy baseline, which is how the harness resolves the "an identity picked to DO something must be able to dispatch" tension.

**Why:** your phase contract is currently *looked up* by the model every turn; preloading makes it present on the first step. It is pure Markdown plus TS, and the "frozen once, corrected by a tail notice, never rewritten" discipline is what keeps it cache-friendly.

### 8. Budgets

**iii does:** `max_turns`, `max_depth`, `max_children` (per turn), `max_result_bytes`, `max_transient_resumes`, `max_validation_retries` — and execution budgets a child can only shrink. Missing or partial usage consumes the full reservation.

**You have:** `auditToPass({ maxRounds ?? 3 })` and nothing else. No depth cap on `delegateReview` beyond a hardcoded `maxDepth: 2`, no fan-out cap, no repair-attempt cap.

**Concrete change.** Add budget fields beside `EnforcementConfig` — `maxAuditRounds`, `maxRepairAttempts`, `maxDelegationDepth`, `maxChildrenPerPhase`, `maxResultBytes` — enforce them in `auditToPass`, `delegateReview` and the tool render, and persist the counters on the run so a resumed session sees them. Make the counters visible in `recursive_status`; a budget nobody can see is a budget nobody trusts.

### 9. A read-only preview surface

**iii does:** `harness::system-prompt::get` previews every prompt layer — *"the truth for what ran"* — without a model request, distinguishes the **resolved** prompt from a rebuilt one, and explicitly states what a read-only preview **cannot** show.

**You have:** no way to see what `recursive:policy` will render, or which policy rule will match, until it fires.

**Concrete change.** `recursive_preview` returning: the rendered stable and tail sections plus their digest; the effective ordered rules for the current phase; the next legal transition and exactly which gates it requires; and the effective enforcement modes. Mark the fields a read-only preview cannot compute.

**Why:** "enforce, don't just describe" only lands if a human can **see** the enforcement. This is the cheapest legibility win available.

## 9.5 Tier 3 — bigger, but the right long-term shape

### 10. A durable step record for the in-flight phase

**iii does:** a `TurnRecord` with `step`, `calls`, a watermark and a result, CAS-seeded; per-call checkpoints; a stale-step guard; and orphan redrive after 120 s.

**You have:** run state correctly re-derived from files on every read — but **no record of in-progress work**, so a crash mid-audit loses the draft/repair state and the loop restarts from zero.

**Concrete change.** `steps/<phase>.step.json` alongside `locks/`, holding `{ phase, step, status, attempts, lastFindings, watermark }`, written before each mutating step and cleared on lock. A redrive sweep on `agent/session-start` — the scaffold-repair listener already runs once per root, so the hook exists.

**Constraint to respect:** the step file is **bookkeeping, not state**. The artifact Markdown stays the source of truth; a step file that disagreed with the artifact must lose. Say that in the module doc, or the next maintainer will make it authoritative.

### 11. `operation_id` + `attempt` for `reopen`

**iii does:** deterministic operation id, `attempt` incrementing **only** on an explicit failed-to-retrying transition, subscribers correlating on `(operation_id, attempt)`, a plan persisted before execution, child-first ordering, tombstones, and no force mode.

**You have:** `reopen` deletes the artifact receipt and every stale downstream receipt in one synchronous pass. A retry after a partial failure is indistinguishable from a fresh request.

**Concrete change.** `recursive_reopen` gains `{ operationId, attempt }`; write `locks/reopen/<op>.plan.json` **first**; execute deepest-phase-first with each step idempotent; a tombstone prevents a stale receipt resurrecting. `reopen` is the one genuinely destructive operation in the workflow and the lock chain is already a hash tree — this is what makes it safe to retry.

### 12. Durable binding records instead of in-memory once-guards

**iii does:** a binding is a durable record; every skip appends a model-invisible entry **with the reason**; the store is deliberately cache-free because *"the store IS the authority."*

**You have:** `repairedRoots: Set<string>` and `ReminderOnceGate` — both in-memory, both lost on restart, both invisible.

**Concrete change.** `.recursive/bindings.json` recording `{ id, kind, scope, once, firedCount, lastReason }`, with the same discipline: writes are authoritative, reads are cheap, and *"why didn't the reminder fire?"* becomes answerable across restarts. Roughly 80 lines.

## 9.6 Tier 4 — cheap and disproportionately valuable

### 13. Executable documentation tests

**iii does:** `tests/prompts.rs` fails the build if a shipped prompt names a removed id (`harness::react`, `harness::notify_agent`) or a worker the agent is meant to *discover* — *"naming one preempts discovery and skews any evaluation of whether the agent finds it"* — and asserts a retired prompt **stays** removed. It exists because *"the removal originally missed all eight provider identity prompts. Agents kept reaching for react because they were still being told to."*

**Concrete change.** `tests/docs.spec.ts` asserting: (a) every file path referenced from `README.md`, `PROPOSAL.md` and `skills/**` exists; (b) `package.json.description` agrees with the registered tool count; (c) **every marker string the linter requires is emitted by the writer that produces it**; (d) no shipped prompt names a withdrawn tool or phase.

**Why this is the best value-per-line item on the list:** it would have caught bugs in *both* codebases. On the iii side it would have caught findings 8.1.1 and 8.1.2. On yours it would have caught a real divergence — `writeActionRecord` emits `# Subagent action record: <id>` while `ts-lint.ts` demands the literal `# Subagent Action Record` plus `Run ID` and `Timestamp` fields, and every top-level `.md` under `subagents/` is linted as an action record. **As written, plugin-generated action records fail your own lint contract.**

### 14. Stable, greppable error codes in the D-code style

**iii does:** a directory error is *one self-sufficient prose sentence* — `<code> <class>: <problem> Did you mean: … Next: call <fn> to …` — **never a JSON envelope, because it would arrive double-escaped and be unreadable to an LLM**. The code and class word are stable so non-LLM consumers can branch without parsing prose.

**You have:** marker strings a linter greps for, and tool errors that are plain sentences with no stable prefix.

**Concrete change.** Give each `recursive_*` tool error a code and class (for example `R210 gate: coverage not PASS`, `R410 tool: locked artifact write denied`) plus a `Next:` clause naming the exact tool call that resolves it. Stable prefixes let the board, the linter and any future consumer branch without prose parsing.

### 15. Self-describing elision and repair records

**iii does:** the pruning placeholder says what was removed, how much, and **how to get it back** (`re-call it if still needed`); a reconciled call notes each change (`Change { path, kind, from, to }`) on the result and the entry origin.

**Concrete change.** When you elide lint findings or truncate evidence, say what was elided **and how to retrieve it**. When the plugin repairs a delegated result or normalizes a phase doc, record the change explicitly instead of silently writing the effective value. This is the practical antidote to the harness's own caution that *"mutations are silent… or audits will show data that never matched what actually ran."*

## 9.7 Sequenced plan

**Sprint 1 — make enforcement real (all pure TS, no new infrastructure).**

1. Fix the guard path and wire `validateTransition` + `detectTamper` (#2).
2. Add the ordered policy engine with an `ask` default (#1).
3. Cap and elide tool results (#3).
4. Add `tests/docs.spec.ts` (#13) — this immediately covers the action-record divergence.

**Sprint 2 — make the workflow legible.**

5. Split the prompt into a stable prefix and a phase tail; add the digest (#6).
6. Add `recursive_ask` for the three human gates (#4).
7. Add `recursive_preview` (#9).
8. Add D-code error classes (#14).

**Sprint 3 — make it extensible.**

9. Introduce the hook registry and re-express existing enforcement as built-in hooks (#5).
10. Ship phase/role agent profiles with preloaded contracts (#7).
11. Add budgets and surface the counters (#8).

**Sprint 4 — make it survive crashes.**

12. Step records with session-start redrive (#10).
13. `operation_id` + `attempt` for `reopen` (#11).
14. Durable binding records replacing the in-memory guards (#12).

## 9.8 What deliberately does not transfer

- **The bus, registry, compose and multi-worker decomposition.** DSH is the host. Your PROPOSAL principle 3 — "wrap, don't duplicate" — applies to the harness's loop exactly as it applies to the harness's siblings.
- **Telemetry on by default with an environment-variable opt-out.** That is a hosted-registry product decision. If you add metrics, make them opt-in via plugin config, and copy the payload restraint (counters only, never text, paths or ids).
- **A metadata-interpreted control plane.** iii shipped ~2,450 lines of payload mapping, conditions, coalescing, joins and dispatch inside a spec interpreted at fire time, then deleted all of it. The lesson belongs in your design doc next to the retired Layer-1 gate: **extension points must be typed seams, not interpreted configuration.**
- **Exactly-once ambitions.** Both systems get by on at-least-once plus deterministic ids. Do not reach for more.

## 9.9 Two constraints to carry into any implementation

**Keep the file-backed control plane authoritative.** Nothing in this transfer changes that. Every new artifact proposed above — a step record, a binding record, a reopen plan, a guard-decision log — is *bookkeeping about* the workflow, never *the workflow*. If a step file and a phase doc disagree, the phase doc wins. Write that rule down before writing the code.

**Keep it TypeScript-only.** Everything here is implementable in TS with no new runtime: a glob matcher, an ordered rule list, a hook registry over existing DSH seams, a string split for the prompt prefix, a JSON step record, a plan file, and a test that reads the repo's own markdown. None of it requires a subprocess, a sidecar, or a second store — which is also why none of it threatens the zero-emission and read-only-client invariants you already hold.

---

# Appendix A — Vocabulary index

**Platform:** worker, engine, function, function id, trigger type, trigger, compose, namespace, registry, directory, deploy kinds (binary / image / bundle), interface capture.

**Loop:** turn, step, `TurnRecord`, `TurnStatus` (`Running / AwaitingFunctions / Completed / Cancelled / Failed`), `TurnStepPayload`, `CallCheckpoint`, `CallState` (`Triggered / Pending / Done`), watermark, steering, merge, `advance`, `skipped`, park, `pending`, resolve (`deliver` / `execute`), transient resume, recovery, orphan redrive, `failure phase`.

**Policy:** `FunctionPolicy`, `CompiledPolicy`, allow/deny globs, `allow_empty`, `subset_policy`, `glob_covered`, `CONTROL_PLANE_DENY`, leaf vs orchestrator, exposure mode (`agent_trigger` / `native`), `dispatch_only`, `default_functions`, `needs_approval`, permission rules.

**Prompt:** identity prompt, stored default, `enrich / override / disabled`, stickiness, stable prefix, `cache_boundary`, `system_sections`, `cache_intent`, `surface_digest`, `prompt_sections_fallback` (`disabled` / `no_stable_prefix` / `prefix_rewritten`), `prefix_divergence`, `<preloaded_functions>`, `<preloaded_skills>`, `<available_skills>`, `<discovery_assist>`, agent profile, `extends`, D415.

**Hooks and triggers:** `pre_turn`, `pre_generate`, `post_generate`, `pre_trigger`, `post_trigger`, `post_turn`, `HookTriggerConfig`, `HookInput`, `HookOutput`, `annotations`, `inject_prompt`, middleware chain, `fail_closed` / `fail_open`, hold, binding, `OwnerScope`, `TriggerFired`, `TriggerOutcome`, `RetirementReason`, condition, `claim_fire`, `arm`, wake, `armed wake`.

**Sub-agents and safety:** `spawn`, `ChildIds`, `ParentLink`, depth, fan-out, `orchestrator`, `SubagentDisplay`, `subagent_display`, output contract, `submit_result`, validation retry, `ask`, `pending-created`, `pending-resolved`, tombstone, `deletion guard`, `turn_activity`, `InflightSteps`, `LivenessMemo`, admission close, child-first, consolidated message, `attempt`.

**Budgets and accounting:** `max_turns`, `max_depth`, `max_children`, `max_result_bytes`, `max_transient_resumes`, `max_validation_retries`, `default_pending_timeout_ms`, `reserved_tokens`, `usable`, `ContextSnapshotV1`, token reservation / reconcile / release, `result_capped`, elision marker.

**Siblings:** `session::*` (transcript, revisions, active leaf, fork), `context::*` (assemble, prune, compact, count-tokens), `router::*` (chat, models, provider, abort), `queue::*` and `durable:subscriber`, `state::*` (compare-and-set, barrier, claim-namespace), `memory::*` (banks, rules, memories, supersede, pin, doctor), `memory-consolidate::*`, `directory::*` (skills, system-prompts, agents, registry, search_functions), `approval::*`, `judge::*`, `workflow::*`, `eval::*`.

# Appendix B — Source index

**Registry pages read:** the `harness` worker page and the registry root at `https://workers.iii.dev`.

**Repo (shallow clone at `D:/DEV/.tmp-iii-audit/workers`, HEAD `e5775db`):**

- Platform: `README.md`, `worker-readme.md`, `DOCUMENTATION_GUIDELINES.md`, `iii-permissions.yaml`, `pnpm-workspace.yaml`, `package.json`, `rust-toolchain.toml`, `biome.json`
- Docs: `docs/README.md`, `docs/architecture/{README, worker-model, per-worker-architecture, iii-worker-yaml, worker-compose, deploy-modes, testing-and-ci, skills-and-permissions, agent-profile-storage}.md`, `docs/sops/{README, new-worker, binary-worker, release, injectable-console-ui}.md`, `docs/adr/0001`
- Spec: `tech-specs/2026-06-agentic/harness.md` (the design of record)
- Harness: `iii.worker.yaml`, `Cargo.toml`, `Makefile`, `README.md`, `DEVELOPMENT.md`, `prompts/default.txt`, `skills/{SKILL.md, orchestration.md}`, `architecture/{README, reactive-triggers, trigger-bindings, session-tree-deletion}.md`, `tests/prompts.rs`, `tests/manifest.rs`, `tests/schemas.rs`, and the `src/` modules behind every claim above
- Siblings: each worker's `README.md`, `architecture/` and `src/` function registrations

**Method note.** Rust internals were audited through targeted source passes rather than exhaustive reading of every file; claims about identification, ordering and defaults are cited against the module that defines them. Nothing was executed, and no worker was started — every claim is static.

# Appendix C — Corrections to the earlier briefing

This document supersedes the brief delivered earlier in the session. Three corrections are material:

1. **Hook points: six, not five.** The earlier brief listed five. The code registers `harness::hook::post_turn` as well, and it is the only agent-bindable hook point. The design-of-record lists five, so the spec is the thing that is out of date.
2. **Trigger delivery is at-most-once, not exactly-once.** The harness's *step* delivery is at-least-once; durable-trigger delivery has no outbox and loses events across a crash between fire and claim. The earlier brief conflated the two.
3. **`src/trigger.rs` is the tool-call pipeline, not the reactive subsystem.** The reactive machinery lives in `bindings/*`, `functions/subscribe.rs`, `functions/trigger_deliver.rs`, `subscriptions/*`, `conditions.rs` and `hooks/*`.

Two additions: the sibling-worker contracts (section 6) and the doc-vs-code divergences (section 8.1), which were not in the earlier brief at all.
