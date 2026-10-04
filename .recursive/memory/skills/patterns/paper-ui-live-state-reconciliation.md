Type: pattern
Status: CURRENT
Scope: How the dsh-recursive-mode read-only client renders a Paper-styled taskboard + run detail over a LIVE filesystem fold (HTTP/SSE), and how to keep the UI correct across workspace switches: kebab-case inline CSS strings + `--rm3-*` tokens for Paper compatibility, a synchronous workspace-path stale-guard in front of the async snapshot, SSE-await on the host route, and NO `setState(null)` on scope change.
Owns-Paths:
- dsh-recursive-mode/src/client/use-live.ts
- dsh-recursive-mode/src/client/board.tsx
- dsh-recursive-mode/src/client/host-api.ts
- dsh-recursive-mode/src/client/theme.ts
- dsh-recursive-mode/src/client/styles.ts
Watch-Paths:
- dsh-recursive-mode/src/live-route.ts
- dsh-recursive-mode/src/client/inspector.tsx
- dsh-recursive-mode/src/client/slots.ts
- dsh-recursive-mode/src/client/derive.ts
Source-Runs:
- 07-parity-with-skill-based
Validated-At-Commit: promoted-from-run-07-parity-with-skill-based
Last-Validated: 2026-08-21T00:00:00Z
Tags:
- skills
- recursive-run
- client-ui
- dsh-client
- paper
- live-state
- workspace-scoping
- set-state-null

# Pattern: Paper-styled live board UI + scope-change state retention (run 07)

## When to use

When a DSH client renders a taskboard/run-detail over a per-workspace filesystem fold served by an HTTP/SSE route, AND the UI must survive a session/workspace switch without a blank-flash or stale cards.

## Pattern

- Render Paper-compatible CSS: kebab-case inline style strings, design tokens via `--rm3-*`, solid status pills (never React-object style props — Paper silently drops them).
- Serve state through `GET /.recursive/api/state` (no-store, fresh fs read) + `GET /.recursive/api/events` (SSE full frames + heartbeat), keyed per-workspace; the host resolves the root server-side from the session header (never trust a client path).
- In the board, hold the authoritative synchronous `workspacePath` and compare it against the async `snapshot.root` (case/trailing-separator tolerant) to suppress stale cards during a switch.
- In the hook, KEEP the previous snapshot on scope change (do NOT `setState(null)`); let the stale-guard hide the gap while the fresh fetch resolves. The only `setState(null)` is the empty-scope guard + `disposed` flag.

## Why

Run 07's Phase 03 UI FAILED user acceptance for exactly these reasons: React-object style props were silently dropped by Paper (unstyled render); the SSE handler serialized an unawaited async snapshot (empty board); `recentWorkspaceId` precedence + a missing scope reset left the board on the wrong workspace; and a redundant `setState(null)` on scope change blank-flashed the board ("click does nothing" / "delay then stops"). The five out-of-run fixes (0.1.13–0.1.18) map one-to-one to the five bullets above.

## Verified by

- 200 tests / 35 files GREEN (`pnpm test`); `tsc --noEmit` clean; `pnpm build` (lib/client.js 45.66 kB + lib/index.js 264.18 kB); smoke SMOKE PASS.
- User acceptance (Creator, 2026-08-21): taskboard triggers + displays runs, run detail works, inspector works, launcher opens the board, workspace switch shows the new workspace's runs (cold-read latency noted but no blank-flash/stale data).
