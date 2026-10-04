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

/**
 * Subscribe to the live route for one scope. Returns the current state. The SSE
 * feed pushes full frames on every fs change; a dropped stream (sleep/error)
 * triggers one refetch so the board never serves a stale fold.
 */
export function useLiveProjection(scope: LiveScope): LiveProjectionSnapshot {
  const [state, setState] = useState<LiveRecursiveState | null>(null)

  useEffect(() => {
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
  }, [scope.sessionId, scope.cwd])

  return state
}
