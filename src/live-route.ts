/**
 * Live recursive board/strip route (SP2 R1): host HTTP + SSE serving the
 * filesystem fold, keyed per-WORKSPACE. The board/strip read this instead of
 * useProjection('recursive'); cold resume and every GET are a fresh fs read.
 *
 * Keying (creator steer): the client passes its session cwd verbatim; the HOST
 * resolves the recursive control-plane root server-side (cwd == workspace root,
 * cwd == subdir, cwd == repo root). Multiple sessions in one workspace collapse
 * to one fold; a workspace switch shows the new root.
 *
 * R9 read-only: GET state + GET events only. No POST/action route; the client
 * never mutates the host.
 *
 * Registration is mountOnce-global because apply() runs PER-SESSION while
 * WebServer.register throws on a duplicate (kind, path). The first mount wins;
 * later mounts no-op (the state is per-workspace, so per-session registration
 * would be both wrong and a crash).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { RecursiveProjection } from './types.ts'
import { RUN_ARTIFACT_SEQUENCE } from './status.ts'

/** API prefix the board/strip fetch. */
export const RECURSIVE_API_PREFIX = '/.recursive/api'

/** The host seam the route builder needs: root resolution + the fs fold + a revision. */
export interface RecursiveRouteHost {
  /**
   * Resolve the recursive control-plane root. sessionId is PRIMARY (the host
   * prefers the attached session header cwd — never trusts a client path); cwd
   * is a fallback hint only while the session is hydrating / for headless callers.
   */
  resolveRoot(sessionId: string | undefined, cwd: string): Promise<string | null>
  /** Fresh filesystem fold for one workspace root (per-workspace state). */
  snapshot(root: string): Promise<RecursiveProjection> | RecursiveProjection
  /** Monotone revision; bump whenever the fs fold changes (SSE frame + state). */
  revision(root: string): number
}

/** The state payload the board/strip read. */
export interface RecursiveStatePayload {
  root: string | null
  projection: RecursiveProjection
  revision: number
}

const HEARTBEAT_MS = 15_000

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Same-origin browser tripwire (NOT an authority check; the loopback socket is the real boundary). */
function browserMarker(req: IncomingMessage): boolean {
  const headers = req.headers ?? {}
  const site = headers['sec-fetch-site']
  return site === 'same-origin' || typeof headers.origin === 'string'
}

/** Read a query param (URLSearchParams tolerates a missing/duplicate value). */
function queryOf(req: IncomingMessage, name: string): string {
  const url = req.url ?? ''
  const q = url.indexOf('?')
  if (q < 0) return ''
  return new URLSearchParams(url.slice(q + 1)).get(name) ?? ''
}

/** Phase-doc basename allowlist (the run artifact sequence: single *.md, no subdirs). */
const PHASE_DOC_FILES = new Set(RUN_ARTIFACT_SEQUENCE)

/** runId/file safety: alphanumerics, dot, underscore, dash only; no '..', no separators. */
const DOC_SAFE_RE = /^[A-Za-z0-9._-]+$/

/** Invalid runId or file name (path traversal / subdir / non-phase doc) — reject. */
function docTargetError(runId: string, file: string): string | null {
  if (!DOC_SAFE_RE.test(runId) || runId.includes('..')) return 'invalid runId'
  if (!DOC_SAFE_RE.test(file) || file.includes('..') || file.includes('/') || file.includes('\\')) return 'invalid file'
  if (!file.endsWith('.md')) return 'invalid file: must be a .md phase doc'
  if (!PHASE_DOC_FILES.has(file)) return 'invalid file: not a phase doc'
  return null
}

/**
 * The lazy per-phase doc route (0.2.4): GET the raw markdown of one run phase
 * doc, read ON DEMAND from the filesystem. NOT part of the /state or /events
 * projection payloads (they stay fold-only). Same browser-marker tripwire as
 * state/events; the client root is re-validated by the host (never trusted:
 * an unknown root -> 400), then the resolved doc path is containment-checked
 * under join(root, '.recursive', 'run', runId).
 */
function docRoute(host: RecursiveRouteHost) {
  return {
    kind: 'exact' as const,
    path: RECURSIVE_API_PREFIX + '/doc',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      if (!browserMarker(req)) { res.writeHead(403); res.end(); return }
      const root = queryOf(req, 'root')
      const runId = queryOf(req, 'runId')
      const file = queryOf(req, 'file')
      const targetError = docTargetError(runId, file)
      if (root === '' || targetError !== null) {
        json(res, 400, { ok: false, error: targetError ?? 'missing root' })
        return
      }
      // Root validation: the client passes back what the host already resolved.
      // Re-resolve via the host and require a canonical match — never accept an
      // arbitrary path (registry know-it or headless cwd pass-through).
      const resolvedRoot = await host.resolveRoot(undefined, root)
      if (resolvedRoot === null || resolve(resolvedRoot) !== resolve(root)) {
        json(res, 400, { ok: false, error: 'root is not a known workspace' })
        return
      }
      // Containment: the doc must stay under join(root, .recursive, run, runId).
      const runBase = resolve(root, '.recursive', 'run', runId)
      const docPath = resolve(runBase, file)
      if (docPath === runBase || !docPath.startsWith(runBase + sep)) {
        json(res, 400, { ok: false, error: 'doc path escapes the run dir' })
        return
      }
      if (!existsSync(docPath)) {
        json(res, 404, { ok: false, error: 'phase doc not found' })
        return
      }
      const text = readFileSync(docPath, 'utf8')
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    },
  }
}

/**
 * Build the read-only routes. Returns [state, events, doc] in registration order.
 * @param host - the resolved-root + fs-fold seam (the RecursiveRuntime adapter).
 */
export function makeRecursiveRoutes(host: RecursiveRouteHost): readonly { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] {
  const state: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> } = {
    kind: 'exact',
    path: RECURSIVE_API_PREFIX + '/state',
    handler: async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      if (!browserMarker(req)) { res.writeHead(403); res.end(); return }
      const sessionId = queryOf(req, 'sessionId') || undefined
      const cwd = queryOf(req, 'cwd')
      const root = sessionId === undefined && cwd === '' ? null : await host.resolveRoot(sessionId, cwd)
      if (root === null) {
        json(res, 200, { root: null, projection: {}, revision: 0 } as RecursiveStatePayload)
        return
      }
      json(res, 200, { root, projection: await host.snapshot(root), revision: host.revision(root) } as RecursiveStatePayload)
    },
  }
  const events: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> } = {
    kind: 'exact',
    path: RECURSIVE_API_PREFIX + '/events',
    handler: async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      if (!browserMarker(req)) { res.writeHead(403); res.end(); return }
      const sessionId = queryOf(req, 'sessionId') || undefined
      const cwd = queryOf(req, 'cwd')
      const root = sessionId === undefined && cwd === '' ? null : await host.resolveRoot(sessionId, cwd)
      if (root === null) { res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write('data: {"root":null,"projection":{},"revision":0}\n\n'); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const push = async (): Promise<void> => {
        const projection = await host.snapshot(root)
        const payload = { root, projection, revision: host.revision(root) }
        res.write('data: ' + JSON.stringify(payload) + '\n\n')
      }
      const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
      const close = (): void => { clearInterval(heartbeat) }
      req.once('close', close)
      res.once('close', close)
      await push()
    },
  }
  return [state, events, docRoute(host)]
}

/**
 * Register the routes at most ONCE per process. WebServer.register throws on a
 * duplicate (kind, path), and apply() runs per-session, so later mounts MUST
 * no-op. The registry rides a global symbol so two module instances of the same
 * package share one verdict; the unmarker rides ctx.effect (cordis runs the
 * effect callback immediately and treats its return as the disposer).
 */
const MOUNTED = Symbol.for('dsh-recursive-mode.mounted')

interface MountRegistry {
  [MOUNTED]?: Set<string>
}

function mountedSet(): Set<string> {
  const registry = globalThis as MountRegistry
  return (registry[MOUNTED] ??= new Set())
}

export interface WebServerLike {
  register(route: { kind: string; path: string; handler: unknown }): () => void
}

/**
 * mountOnce wrapper for the route registration. Returns the disposer of the
 * registration (or a no-op for a later mount).
 * @param packageName - npm package identity (every install source shares it).
 * @param makeRoutes - builds the routes (called once, on the first mount).
 * @param webServer - the host webserver service (or a structural fake).
 */
export function mountRecursiveRoutesOnce(
  packageName: string,
  makeRoutes: () => readonly { kind: string; path: string; handler: unknown }[],
  webServer: WebServerLike,
): () => void {
  const mounted = mountedSet()
  if (mounted.has(packageName)) return () => {}
  mounted.add(packageName)
  const disposers: Array<() => void> = []
  try {
    for (const route of makeRoutes()) disposers.push(webServer.register(route))
  } catch (error) {
    mounted.delete(packageName)
    for (const dispose of disposers) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers) dispose()
    mounted.delete(packageName)
  }
}
