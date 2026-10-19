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

/**
 * The effective gate/QA settings, as GET /.recursive/api/gates reports them. Plain values (the form
 * binds to this), with `sources` naming the layer that decided each Config field path.
 */
export interface GatesEffective {
  qa: { humanReview: boolean }
  gates: {
    runStart: { ask: boolean }
    tddMode: { ask: boolean; default: string }
    qaSignoff: { ask: boolean; default: string }
    gateBlock: { ask: boolean }
  }
  teammate: { primitiveRoles: string[] }
}

/** The GET /gates payload. `effective` is null when the workspace file is unusable. */
export interface GatesPayload {
  root: string | null
  effective: GatesEffective | null
  sources: Record<string, 'config' | 'file' | 'default'>
  fromConfig: Record<string, unknown>
  fromFile: Record<string, unknown>
  problem?: string
}

/** The PUT /gates result: success, or the host's NAMED refusal to show verbatim. */
export type GatesSaveResult = { ok: true; path?: string } | { ok: false; problem: string }

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

/**
 * Read the effective gate/QA settings plus their sources (GET /.recursive/api/gates). The host resolves
 * the workspace root exactly as it does for /state; the client never sends a path it chose.
 */
export async function fetchGates(scope: LiveScope, signal?: AbortSignal): Promise<GatesPayload> {
  const controller = new AbortController()
  // ⚠ AN ABORT IS OURS TO EXPLAIN. The timeout below is this client's own decision, and the browser
  // reports it as the DOMException "signal is aborted without reason" — a sentence that tells a person
  // nothing and reads like a bug in the settings file they just edited. Tracked separately so the panel
  // can state what happened and why the route may legitimately be absent.
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, FETCH_TIMEOUT_MS)
  const onAbort = (): void => { controller.abort() }
  signal?.addEventListener('abort', onAbort)
  try {
    const res = await fetch(RECURSIVE_API_PREFIX + '/gates' + scopeQuery(scope), { signal: controller.signal, cache: 'no-store' })
    // ⚠ THE BODY IS READ AS TEXT AND PARSED BY US. `res.json()` on an empty body throws
    // "Unexpected end of JSON input", and that is a PARSER's phrase, not an answer: a 404 from a host
    // that does not serve this route has no body at all, so the person editing settings saw a message
    // about JSON syntax when the truth was "this route does not exist here". Reading text first lets a
    // non-JSON answer become a sentence naming the status and the reason.
    const text = await res.text()
    const body = parseGatesPayload(text)
    if (body === undefined) {
      return {
        root: null,
        effective: null,
        sources: {},
        fromConfig: {},
        fromFile: {},
        problem: res.ok
          ? 'the host answered without a gates payload — this route is served only inside a recursive-mode session'
          : 'the host answered HTTP ' + String(res.status) + ' — this route is served only inside a recursive-mode session',
      }
    }
    // A 4xx/5xx WITH a JSON problem is still a payload the panel reports verbatim.
    if (!res.ok && body.problem === undefined) {
      return { ...body, problem: 'recursive gates: HTTP ' + String(res.status) }
    }
    return body
  } catch (error) {
    const aborted = timedOut || controller.signal.aborted
      || (error instanceof Error && error.name === 'AbortError')
    if (!aborted) throw error
    return {
      root: null,
      effective: null,
      sources: {},
      fromConfig: {},
      fromFile: {},
      problem: timedOut
        ? 'the host did not answer within ' + String(Math.round(FETCH_TIMEOUT_MS / 1000)) + 's — this route is served only inside a recursive-mode session'
        : 'the request was cancelled before the host answered',
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Write the workspace gates file (PUT /.recursive/api/gates). A 4xx is NOT thrown: the host's named
 * refusal (`RM#### input: ...`) is returned so the UI can show it verbatim, which is the requirement.
 * A network failure is returned in the same shape rather than thrown, so the panel has one path.
 */
export async function saveGates(scope: LiveScope, value: unknown, signal?: AbortSignal): Promise<GatesSaveResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onAbort = (): void => { controller.abort() }
  signal?.addEventListener('abort', onAbort)
  try {
    const res = await fetch(RECURSIVE_API_PREFIX + '/gates' + scopeQuery(scope), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal: controller.signal,
      cache: 'no-store',
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // A 404 from a host that does not serve this route has NO body, and a JSON parser's complaint
      // ("Unexpected end of JSON input") is not an answer about the save. Name the status instead.
      return {
        ok: false,
        problem: res.ok
          ? 'the host answered without a body, so nothing was written'
          : 'the host answered HTTP ' + String(res.status) + ' — this route is served only inside a recursive-mode session, so nothing was written',
      }
    }
    if (res.ok) return { ok: true, ...(isPlainRecord(body) && typeof body.path === 'string' ? { path: body.path } : {}) }
    if (isPlainRecord(body) && typeof body.problem === 'string') return { ok: false, problem: body.problem }
    return { ok: false, problem: 'recursive gates: HTTP ' + String(res.status) }
  } catch (error) {
    // Same rule as the read path: an abort is this client's own timeout, so the panel must say that
    // rather than echo a DOMException the person cannot act on.
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return { ok: false, problem: 'the host did not answer within ' + String(Math.round(FETCH_TIMEOUT_MS / 1000)) + 's, so nothing was written' }
    }
    return { ok: false, problem: 'recursive gates: ' + (error instanceof Error ? error.message : String(error)) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Decode a `GET /gates` body, or `undefined` when the body is not a JSON object at all.
 *
 * An absent route answers with an EMPTY body, and `JSON.parse('')` throws "Unexpected end of JSON
 * input" — a parser's phrase that says nothing about the route. Callers turn `undefined` into a sentence
 * naming the HTTP status and where the route actually lives.
 */
function parseGatesPayload(text: string): GatesPayload | undefined {
  if (text.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isPlainRecord(parsed) ? (parsed as unknown as GatesPayload) : undefined
  } catch {
    return undefined
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
