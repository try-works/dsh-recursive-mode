/**
 * useLiveProjection(scope): the client bridge to the live host route (SP2 R1).
 *
 * Reads the per-workspace filesystem fold served by the host HTTP/SSE route
 * instead of the (removed) 'recursive' session projection. The scope carries
 * sessionId PRIMARY (the host resolves cwd from the attached session header)
 * plus cwd as a fallback hint. Returns { root, projection, revision } or null
 * while the first state fetch is in flight. The hook never mutates the host
 * (R9 read-only).
 *
 * If the scope has neither sessionId nor cwd the hook renders nothing — the
 * caller gates on the recursive preset BEFORE this so a non-recursive session
 * shows NOTHING (acceptance #3).
 */
import { useEffect, useState } from 'react'
import { fetchLiveState, subscribeLiveEvents, type LiveRecursiveFrame, type LiveRecursiveState, type LiveScope } from './host-api.ts'

/** Snapshot shape the board/strip consume (null = not loaded / no recursive root). */
export type LiveProjectionSnapshot = LiveRecursiveState | null

/** Empty scope — nothing to key on. */
function isEmpty(scope: LiveScope): boolean {
  return !scope.sessionId && !scope.cwd
}

/** Options for {@link useLiveProjection}. */
export interface LiveProjectionOptions {
  /**
   * Skip the route entirely (default true).
   *
   * ⚠ THIS EXISTS FOR THE PER-CALL SEATS, NOT THE PANELS. A `tool.call.toolview` entry mounts once per Tool
   * call in the transcript, so a seat that always subscribed would open one `/state` fetch and one SSE
   * stream per call row. A row that has nothing to show passes `enabled: false` and asks nothing. The hook
   * itself stays UNCONDITIONAL at every call site — a conditional hook is the run 13 crash, and the flag is
   * how a caller keeps the call order fixed while making the request conditional.
   */
  enabled?: boolean
}

/**
 * Subscribe to the live route for one scope. Returns the current state. The SSE
 * feed pushes full frames on every fs change; a dropped stream (sleep/error)
 * triggers one refetch so the board never serves a stale fold.
 *
 * @param scope - sessionId PRIMARY + cwd fallback hint (host resolves the root).
 * @param options - `enabled: false` clears the snapshot and never fetches.
 */
export function useLiveProjection(scope: LiveScope, options: LiveProjectionOptions = {}): LiveProjectionSnapshot {
  const { enabled = true } = options
  const [state, setState] = useState<LiveRecursiveState | null>(null)

  useEffect(() => {
    if (!enabled) { setState(null); return }
    // Empty scope = no resolvable session row yet — render nothing, never fetch.
    if (isEmpty(scope)) { setState(null); return }
    // 0.1.18 (LIVE BUG 5): do NOT null the snapshot on scope change. 0.1.16
    // added board.tsx's synchronous stale-workspace guard (workspacePath vs
    // async snapshot.root), which already suppresses stale cards; nulling here
    // blanked the board on every session/workspace switch (the "delay then
    // stop" symptom). Keep the previous snapshot until the fresh fetch resolves.
    let disposed = false
    const apply = (frame: LiveRecursiveFrame) => { if (!disposed) setState(frame) }

    // Initial state + every refresh: a no-store fetch (cold resume = fresh fs read).
    void fetchLiveState(scope).then(apply).catch(() => { /* no recursive root yet — stay empty */ })

    // Live deltas over SSE.
    const disposeEvents = subscribeLiveEvents(scope, apply, () => {
      if (!disposed) void fetchLiveState(scope).then(apply).catch(() => {})
    })

    return () => { disposed = true; disposeEvents() }
    // `enabled` belongs in the deps: it is read inside the effect, so leaving it out would keep a stale
    // closure's verdict and mount the very stream the flag exists to avoid.
  }, [scope.sessionId, scope.cwd, enabled])

  return state
}
