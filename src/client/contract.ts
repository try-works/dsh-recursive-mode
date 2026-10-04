/**
 * Structural client seams (self-contained). The real @deepseek-ai/dsh-client-*
 * packages are HOST-INJECTED at bundle time via dsh.client.inject (never
 * installed in this package's dependency tree). We declare the minimal shapes
 * we consume so the pure client modules type-check and bundle in isolation;
 * the DSH loader links them to the real runtime identities at compose time.
 *
 * SP2 R1 (live route): the client now CALLS the host route (read-only GET
 * state + SSE events) instead of reading a session projection. The host serves
 * the per-workspace filesystem fold; this module never mutates the host and
 * never touches the filesystem (R9).
 */
import type { RecursiveProjection } from '../types.ts'

/** SessionEvent-like carrier (kept for the pure derive surface; the live route replaces the fold). */
export interface ClientSessionEvent {
  type: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
}

/** A session header (cwd is the session's canonical cwd). */
export interface ClientSessionHeader {
  cwd?: string
}

/** A session-list row (mirrors SessionSummary — cwd + agentPreset are the gate inputs). */
export interface SessionSummaryRow {
  id: string
  cwd?: string
  /** Agent preset this session was composed from; absent when the deployment has none. */
  agentPreset?: string
}

/**
 * The session-list snapshot (mirrors the REAL SessionListState). useSessions is
 * a SnapshotSelectorHook over this state; the identity selector `(s) => s`
 * yields the full value, which the gate reads directly (ids/byId/current).
 */
export interface SessionListStateLike {
  ids: string[]
  byId: Record<string, SessionSummaryRow>
  current: string | undefined
}

/**
 * The REAL selector-hook shape (ui-slots store.ts):
 *   SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?) => S
 * The selector is REQUIRED — useSyncExternalStoreWithSelector needs it. Calling
 * the hook with no selector passes sel=undefined and breaks the board mount.
 * This is the run 10 live bug.
 */
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S

/** The slots registry surface the client injects into. */
export interface ClientSlots {
  inject(seat: string, factory: (ctx: unknown) => () => void): () => void
  register(options: SlotOptions, component: unknown): () => void
}

/** A registered slot's options. */
export interface SlotOptions {
  name: string
  id?: string
  order?: number
  label?: string
  children?: unknown
  store?: unknown
  locale?: unknown
  registrant?: unknown
}

/** The client root context the bundle receives from the module loader. */
export interface ClientContext {
  slots: ClientSlots
  get(name: string): unknown
  /** Cordis effect: registers a disposer; returns a disposer. */
  effect(fn: () => () => void, label?: string): () => void
}

/** The live state payload the host route serves (mirrors host-api.ts). */
export interface LiveProjectionValue {
  root: string | null
  projection: RecursiveProjection
  revision: number
}

/**
 * The client-side preset gate (acceptance #3): the board/strip render ONLY when
 * the CURRENT session's row reports agentPreset === 'recursive'. A non-recursive
 * session (or a session whose preset is undefined) shows NOTHING — not an empty
 * board, not a spinner. Consumes the SessionListStateLike DIRECTLY (run 10 fix).
 */
export function isRecursivePreset(state: SessionListStateLike): boolean {
  if (state.current === undefined) return false
  return state.byId[state.current]?.agentPreset === 'recursive'
}

/** The current session's cwd (the client passes it as a fallback hint; the host resolves the root). */
export function currentSessionCwd(state: SessionListStateLike): string {
  return state.current === undefined ? '' : (state.byId[state.current]?.cwd ?? '')
}

/**
 * A workspace row — the structural mirror of the REAL WorkspaceView the host
 * injects. We consume only workspaceId/path/title/sessionIds.
 */
export interface WorkspaceViewLike {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

/**
 * The workspace-list snapshot — the structural subset of the REAL
 * WorkspaceListState we consume (items + recentWorkspaceId). The real state
 * also carries archivedSessionIds/state/phase/error/baselinesReady; those are
 * irrelevant here and the real value satisfies this subset.
 */
export interface WorkspaceListStateLike {
  items: readonly WorkspaceViewLike[]
  recentWorkspaceId?: string
}

/**
 * Resolve the CURRENT workspace path for a workspace-scoped board (run 14,
 * corrected run 16/0.1.14): the WORKSPACE owns the .recursive/ run-layer, not
 * the session. Resolution mirrors the harness's startSession precedence
 * (service.ts:183) — the CURRENT session's workspace wins over the
 * recentWorkspaceId (which the harness derives as the most recently ACTIVE
 * workspace by session updatedAt, NOT the workspace being viewed):
 *   1) the workspace whose sessionIds contains sessionList.current, else
 *   2) the workspace whose path === currentSessionCwd(sessionList), else
 *   3) recentWorkspaceId's item path (fallback ONLY when no current session resolves), else
 *   4) '' (empty -> the route returns null root -> board renders nothing).
 */
export function currentWorkspacePath(list: WorkspaceListStateLike, sessionList: SessionListStateLike): string {
  const current = sessionList.current
  if (current !== undefined) {
    const bySession = list.items.find((w) => w.sessionIds.includes(current))
    if (bySession !== undefined) return bySession.path
  }
  const cwd = currentSessionCwd(sessionList)
  if (cwd !== '') {
    const byCwd = list.items.find((w) => w.path === cwd)
    if (byCwd !== undefined) return byCwd.path
  }
  if (list.recentWorkspaceId !== undefined) {
    const recent = list.items.find((w) => w.workspaceId === list.recentWorkspaceId)
    if (recent !== undefined) return recent.path
  }
  return ''
}
