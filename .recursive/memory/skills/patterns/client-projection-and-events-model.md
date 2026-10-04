Type: pattern
Status: CURRENT
Scope: How the dsh-recursive-mode plugin turns its `recursive/*` event surface into read-only client UI through DSH's native seams: a pure worktree-scoped `recursive` session projection unit, a self-contained read-only `dsh.client` web bundle (sidebar launcher + kanban board + inspector + conversation run node + status strip + settings), and a worktree-keyed event vocabulary where emitters are the scope authority and `recursive/phase-intent` stays internal-only.
Owns-Paths:
- dsh-recursive-mode/src/events.ts
- dsh-recursive-mode/src/projection.ts
- dsh-recursive-mode/src/client/derive.ts
- dsh-recursive-mode/src/client/contract.ts
- dsh-recursive-mode/src/client/slots.ts
Watch-Paths:
- dsh-recursive-mode/src/client/board.tsx
- dsh-recursive-mode/src/client/inspector.tsx
- dsh-recursive-mode/src/client/node.ts
- dsh-recursive-mode/src/client/settings.tsx
- dsh-recursive-mode/src/client/strip.tsx
- dsh-recursive-mode/src/runtime.ts
- dsh-recursive-mode/src/index.ts
- dsh-recursive-mode/src/workspace.ts
Source-Runs:
- 06-phase-d-client-ui-events
Validated-At-Commit: promoted-from-run-06-phase-d-client-ui-events
Last-Validated: 2026-08-17T00:00:00Z
Tags:
- skills
- recursive-run
- projection
- session-events
- client-ui
- dsh-client
- workspace-scoping

# Pattern: client-projection-and-events-model

- **Type:** pattern
- **Status:** CURRENT
- **Source-Runs:** 06-phase-d-client-ui-events
- **Summary:** the projection unit, the read-only client bundle, and the worktree-keyed event vocabulary cooperate through DSH native seams, never through a second state store.

## Rules

1. **Emitters are the scope authority.** Every `recursive/*` event carries `{ runId, worktreeRoot }` and its constructor rejects an empty key; the projection groups runs by that control-plane root and never re-derives scope by reading another workspace's `.recursive/` tree.
2. **The projection unit is pure and synchronous.** `init()` takes no session/agent context (so the fold cannot depend on which workspace is active); `apply()` returns the same reference for unrelated events; `view()` emits wire-JSON per run. `recursive/phase-intent` is emitted internally but excluded from the observable fold.
3. **The client half is read-only and seam-based.** `src/client/**` carries no filesystem or session imports (read-only-client principle); structural seams in `src/client/contract.ts` stand in for host-injected `dsh-client-*` packages (which are not installable standalone), so the bundle typechecks and builds in-repo and composes into `window.__DSH_BOOT__` at runtime.
