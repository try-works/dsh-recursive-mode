/**
 * RED contract tests for SP2 R1 — zero-emission + live HTTP/SSE route (per-workspace).
 *
 * Written FIRST (strict TDD). GREEN = these pass with:
 *   - src/live-route.ts (route builder + root-keyed fold + mountOnce)
 *   - src/snapshot.ts  (snapshotWorkspace: discoverRuns + foldRun -> RecursiveProjection)
 *   - zero recursive/* emission sites
 *
 * Contract: .recursive/run/07-parity-with-skill-based/evidence/reference/red-spec-r1-live-route.md
 * SessionId-PRIMARY: the host resolves the root from the attached session
 * header cwd; the client-passed cwd is only a fallback hint.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECURSIVE_API_PREFIX, makeRecursiveRoutes, mountRecursiveRoutesOnce, type RecursiveRouteHost } from '../src/live-route.ts'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(pkgRoot, 'src')

/** Emission call sites that would write a recursive/* event (zero-emission contract). */
const EMISSION_RE = new RegExp(
  "(\\.append\\s*\\(|emitToSession\\s*\\(|emitRecursiveEvent\\s*\\()"
    + "[^\\n]{0,120}['\"]recursive/",
  'g',
)

/** Count real emission sites of recursive/* (doc comments excluded by the call-site anchor). */
function emissionSites(text: string): number {
  return (text.match(EMISSION_RE) ?? []).length
}

describe('G1 zero-emission (static)', () => {
  it('src has no recursive/* emission call site and no events.ts', () => {
    for (const file of ['index.ts', 'runtime.ts', 'policy.ts', 'status.ts', 'lock.ts', 'lifecycle.ts', 'bootstrap.ts', 'enforcement.ts']) {
      const text = readFileSync(join(SRC, file), 'utf8')
      expect(emissionSites(text), file + ' must not emit recursive/*').toBe(0)
    }
    expect(() => readFileSync(join(SRC, 'events.ts'))).toThrow()
  })
})

describe('G2 snapshotWorkspace + G3 route keying', () => {
  it('exports the API prefix constant', () => {
    expect(RECURSIVE_API_PREFIX).toBe('/.recursive/api')
  })

  it('state route answers GET with a per-workspace projection, resolved server-side (sessionId-primary)', async () => {
    const host: RecursiveRouteHost = {
      resolveRoot: vi.fn(async (_sessionId: string | undefined, _cwd: string) => '/w'),
      snapshot: vi.fn(async (_root: string) => ({ '/w': { r1: { runId: 'r1', worktreeRoot: '/w', phases: {}, state: 'active' as const, tampers: {}, subagents: {} } } })),
      revision: vi.fn(() => 1),
    }
    const [state] = makeRecursiveRoutes(host)
    expect(state.kind).toBe('exact')
    expect(state.path).toBe('/.recursive/api/state')
    const res = { status: 0, headers: {}, body: '' } as unknown as import('node:http').ServerResponse
    const ended = new Promise<void>((done) => {
      ;(res as unknown as { end: (b?: string) => void }).end = (b?: string) => { (res as unknown as { body: string }).body = b ?? ''; done() }
      ;(res as unknown as { writeHead: (n: number, h: Record<string, string>) => void }).writeHead = (n: number, h: Record<string, string>) => { (res as unknown as { status: number }).status = n; (res as unknown as { headers: Record<string, string> }).headers = h }
    })
    await state.handler({ method: 'GET', url: '/.recursive/api/state?sessionId=s1&cwd=/w/sub', headers: { 'sec-fetch-site': 'same-origin' } } as never, res as never)
    await ended
    expect((res as unknown as { status: number }).status).toBe(200)
    expect(host.resolveRoot).toHaveBeenCalledWith('s1', '/w/sub')
    expect(host.snapshot).toHaveBeenCalledWith('/w')
  })
})

describe('G5 SSE events awaits the async snapshot', () => {
  it('SSE events route awaits the async snapshot (no empty projection frame)', async () => {
    const snapshotValue = {
      '/w': {
        r1: {
          runId: 'r1', worktreeRoot: '/w', phases: {}, state: 'active' as const, tampers: {}, subagents: {},
        },
      },
    }
    const host: RecursiveRouteHost = {
      resolveRoot: vi.fn(async () => '/w'),
      snapshot: vi.fn(async () => snapshotValue),
      revision: vi.fn(() => 1),
    }
    const [, events] = makeRecursiveRoutes(host)
    expect(events.path).toBe('/.recursive/api/events')

    const writes: string[] = []
    const closeCbs: Array<() => void> = []
    const res = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => { writes.push(chunk) }),
      end: vi.fn(),
      once: vi.fn((_ev: string, cb: () => void) => { closeCbs.push(cb) }),
    } as unknown as import('node:http').ServerResponse
    const req = {
      method: 'GET',
      url: '/.recursive/api/events?sessionId=s1&cwd=/w/sub',
      headers: { 'sec-fetch-site': 'same-origin' },
      once: vi.fn((_ev: string, cb: () => void) => { closeCbs.push(cb) }),
    } as unknown as import('node:http').IncomingMessage

    await events.handler(req, res)

    const frame = writes.find((s) => s.startsWith('data: '))
    expect(frame).toBeTruthy()
    expect(JSON.parse(frame!.slice('data: '.length)).projection).toEqual(snapshotValue)

    // Clear the 15s heartbeat interval so the test doesn't leak an open handle.
    for (const cb of closeCbs) cb()
  })
})

describe('G4 mountOnce-global', () => {
  it('second mount of the same package name is a no-op', () => {
    const register = vi.fn(() => () => {})
    const webServer = { register }
    const mk = () => mountRecursiveRoutesOnce('@try-works/dsh-recursive-mode', () => makeRecursiveRoutes({
      resolveRoot: async (_sid: string | undefined, _cwd: string) => '/w', snapshot: async () => ({}), revision: () => 1,
    }), webServer as never)
    const d1 = mk()
    const d2 = mk()
    expect(register).toHaveBeenCalledTimes(3) // three routes per mount: state + events + doc
    expect(typeof d1).toBe('function')
    expect(typeof d2).toBe('function')
  })
})
