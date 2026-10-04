Type: pattern
Status: CURRENT
Scope: How the dsh-recursive-mode plugin coordinates cross-slot client board UI through DSH's native slot seams using ONE shared module-level open-state store: the sidebar launcher opens the board, the shell.overlay entry renders it gated on open + recursive preset, the board selects a run, and the inspector drills in and goes back — all reading/writing the same `open-state.ts` store, with slot components staying stateless renderers and the store emitting no `recursive/*` session events.
Owns-Paths:
- dsh-recursive-mode/src/client/open-state.ts
Watch-Paths:
- dsh-recursive-mode/src/client/slots.ts
- dsh-recursive-mode/src/client/board.tsx
- dsh-recursive-mode/src/client/inspector.tsx
Source-Runs:
- 08-ui-board-launcher
Validated-At-Commit: promoted-from-run-08-ui-board-launcher
Last-Validated: 2026-08-19T00:00:00Z
Tags:
- skills
- recursive-run
- client-ui
- dsh-client
- open-state
- use-sync-external-store

# Pattern: Shared module-level open-state for DSH client board UI (run 08)

## When to use

When a DSH client bundle needs cross-slot coordination — a launcher that opens a panel, an overlay slot that renders it, a board that selects an item, an inspector that drills in and goes back — where per-slot state cannot express the open/select/back flow.

## Pattern

- One module-level store owns `{open, selection}` + subscribe (`src/client/open-state.ts`).
- Slot components stay stateless renderers: the launcher calls `openBoard()`, the overlay gates on `overlayContent(state, sessions)` (open + preset), the board calls `openInspector({worktreeRoot, runId})`, the inspector calls `backToBoard()`.
- React binding via `useSyncExternalStore(store.subscribe, store.get, store.get)`.
- The store is client-local: it emits NO `recursive/*` session events (zero-emission invariant) and does no host mutation (read-only client, R9).

## Why

Run 08 found the launcher had no onClick (dead button), the overlay had no open-state (unconditional render), and the inspector was never mounted (unreachable). Per-slot state cannot coordinate launcher->overlay->board->inspector; a shared store fixes all three at once and keeps renderers pure.

## Verified by

- 16 new vitest specs (open-state 5 + slots 5 + board 6) using structural fakes (slot registration capture + React element tree walks — no jsdom/react-test-renderer).
- Full suite 29 files / 166 tests GREEN; `tsc --noEmit` clean; SMOKE PASS; built bundle carries `onClick: () => boardState.openBoard()`.