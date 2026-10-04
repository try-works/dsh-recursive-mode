Type: pattern
Status: CURRENT
Scope: How the dsh-recursive-mode plugin resolves the recursive-mode control-plane root, and how that workspace-scoping invariant is preserved across its surface (tools, commands, preset, two-stage init) without ever scanning other open workspaces.
Owns-Paths:
Watch-Paths:
- /.recursive/run/
- /.recursive/memory/skills/SKILLS.md
Source-Runs:
- 03-phase-a-completion
Validated-At-Commit: promoted-from-run-03-phase-a-completion
Last-Validated: 2026-08-16T12:00:00Z
Tags:
- skills
- recursive-run
- workspace-scoping
- plugin
- preset
- two-stage-init

# DSH Plugin Workspace Scoping + Two-Stage Init

The dsh-recursive-mode plugin must never read runs from a workspace it is not currently
serving. The control-plane root is resolved strictly from the session workspace, and every
surface shares that resolver. This is the binding invariant that keeps the plugin safe when
multiple workspaces are open in the same DSH session.

## Rule 1 — Root resolution is session-scoped only

- Resolve `agent.session.header.cwd` through `ctx.workspaceRegistry.resolveByPath(cwd)`
  (fall back to `get(id)` only when the caller already has a workspace id). The returned
  workspace `path` IS the control-plane root.
- Never call `workspaceRegistry.list()` to find "the" workspace, and never enumerate or read
  another workspace's `.recursive/` tree.
- Resolve the root fresh per call (or digest-cache keyed on `cwd`), never a long-lived global,
  so a workspace switch mid-session is observed.
- If the session `cwd` is not a registered workspace, return `null` and defer — do not fail
  hard and do not guess a workspace.

## Rule 2 — Every surface shares the resolver

- Tools (`recursive_status`/`recursive_list`/`recursive_init`/`recursive_lock`/
  `recursive_lint`/`recursive_closeout`/`recursive_scratch`) resolve runs ONLY under the
  current session's workspace root, refusing a `runId` outside that root.
- The `/recursive` command handlers dispatch through the same workspace-scoped service, so a
  command in workspace A can never touch workspace B.
- The client/projection (Phase D) shows only the current workspace's runs — it is a view over
  the same workspace-scoped service, not a second execution path.

## Rule 3 — Two-stage init keeps Stage B bounded

- Stage A (`apply()`, mount time): register the isolated service, tools, commands, prompt
  section, skills provider, and client module. No repo work at mount time.
- Stage B (`agent/session-start`): resolve the root via Rule 1, bootstrap the `/.recursive/`
  scaffold idempotently if missing, and enumerate runs as directory names only (bounded
  O(#run-names), never full doc reads).
- On `source: 'resume'`, re-resolve the root and re-read only the active run's current phase
  doc; never re-bootstrap, never re-create a run, never re-read historical runs.
- The per-session `ctx.recursive` service sits in a `cordis:group` behind
  `isolate: { recursive: true }` so two sessions' realms do not collide and no root-realm
  service leaks.

## Why It Matters

- A global scan (`list()`) makes the plugin read runs from unrelated open workspaces, which
  is exactly the failure the user forbade. Session-scoped root resolution is the only safe path.
- Unbounded Stage B (full reads of every run) would make session-start O(#runs x #docs); the
  dir-names-only enumeration keeps it cheap, and resume semantics keep it from re-doing work.

## Application

- Implement `src/workspace.ts` (`resolveControlPlaneRoot`/`sessionCwd`), thread it through
  `src/runtime.ts`, and let tools/commands/Stage B all resolve the root from `exec.agent`/
  `agent` before touching the filesystem. Prove the invariant with a two-workspace unit test
  (A sees A only, B sees B only) and the smoke harness.
