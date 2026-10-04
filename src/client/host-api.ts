/**
 * Live recursive board/strip feed (SP2 R1): the browser half of the host
 * HTTP/SSE route. Replaces useProjection('recursive') — the board reads the
 * FILESYSTEM FOLD served by the host, keyed per-WORKSPACE. The client passes
 * its sessionId (PRIMARY — the host resolves the cwd from the attached
 * session header) plus cwd as a fallback hint while hydrating; the host
 * resolves the recursive root server-side, never trusting a client path.
 *
 * READ-ONLY (R9): GET state + GET events only; this module never mutates the
 * host and never touches the filesystem.
 *
 * Mirrors the dsh-web-ui task-board + DSH-better-sidebar host-api pattern:
 * fetch /state with no-store, EventSource /events with a visibilitychange
 * re-listener, and an AbortController timeout on the initial fetch.
 */
import { RECURSIVE_API_PREFIX } from '../live-route.ts'
import type { RecursiveProjection } from '../types.ts'

/** The state payload the host serves. */
export interface LiveRecursiveState {
  root: string | null
  projection: RecursiveProjection
  revision: number
}

/** A single SSE frame. */
export interface LiveRecursiveFrame extends LiveRecursiveState {}

/** The client scope the host keys on: sessionId PRIMARY, cwd fallback hint. */
export interface LiveScope {
  sessionId?: string
  cwd?: string
}

const FETCH_TIMEOUT_MS = 15_000

/** Query-string encoder for the two params. */
function scopeQuery(scope: LiveScope): string {
  const parts: string[] = []
  if (scope.sessionId) parts.push('sessionId=' + encodeURIComponent(scope.sessionId))
  if (scope.cwd) parts.push('cwd=' + encodeURIComponent(scope.cwd))
  return parts.length === 0 ? '' : '?' + parts.join('&')
}

/** Fetch the current state for one session scope (host resolves the workspace root). */
export async function fetchLiveState(scope: LiveScope, signal?: AbortSignal): Promise<LiveRecursiveState> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(RECURSIVE_API_PREFIX + '/state' + scopeQuery(scope), { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new Error('recursive live state: HTTP ' + res.status)
    return (await res.json()) as LiveRecursiveState
  } finally {
    clearTimeout(timer)
  }
}

/** One doc fetch request: the host-known workspace root + run id + phase doc file. */
export interface PhaseDocRequest {
  root: string
  runId: string
  file: string
}

/**
 * Fetch one per-phase run doc (0.2.4) via the lazy GET /.recursive/api/doc
 * route. Raw markdown text; the host validates the root (known workspace) and
 * guards the file path (phase-doc basename only, containment under the run
 * dir). Same 15s AbortController timeout as fetchLiveState.
 */
export async function fetchPhaseDoc(req: PhaseDocRequest): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const q = 'root=' + encodeURIComponent(req.root)
      + '&runId=' + encodeURIComponent(req.runId)
      + '&file=' + encodeURIComponent(req.file)
    const res = await fetch(RECURSIVE_API_PREFIX + '/doc?' + q, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new Error('recursive phase doc: HTTP ' + res.status)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Subscribe to the SSE events feed. Returns a disposer. The host pushes a full
 * {revision, root, projection} frame on every fs change + a 15s heartbeat.
 *
 * @param scope - sessionId primary + cwd fallback (host resolves the root).
 * @param onFrame - called per data frame.
 * @param onError - called when the stream fails/ends (the caller re-subscribes).
 */
export function subscribeLiveEvents(scope: LiveScope, onFrame: (frame: LiveRecursiveFrame) => void, onError?: () => void): () => void {
  const url = RECURSIVE_API_PREFIX + '/events' + scopeQuery(scope)
  const es = new EventSource(url)
  const onMessage = (event: MessageEvent) => {
    try {
      const frame = JSON.parse(event.data as string) as LiveRecursiveFrame
      onFrame(frame)
    } catch { /* malformed frame — ignore */ }
  }
  es.addEventListener('message', onMessage)
  es.onerror = () => { es.close(); onError?.() }
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      // Re-open the stream after the tab slept (the host heartbeat is the only
      // liveness signal; a sleeping tab drops it).
      es.close()
      onError?.()
    }
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    es.close()
  }
}
