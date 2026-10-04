/**
 * RED spec for the lazy per-phase doc route (0.2.4):
 *   GET /.recursive/api/doc?root=<root>&runId=<runId>&file=<fileName>
 *
 * - a real run doc returns its raw markdown text (text/markdown), lazily read
 *   on demand (NOT baked into /state or /events projection payloads).
 * - path guards: runId ^[A-Za-z0-9._-]+$ (no separators / no ..), file must be a
 *   single *.md phase-doc basename (no subdirs, no ..), and the resolved doc
 *   path must stay under join(root, .recursive, run, runId).
 * - root validation: the route re-derives the root via host.resolveRoot and
 *   rejects when the client root is not a known workspace root.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeRecursiveRoutes, type RecursiveRouteHost } from '../src/live-route.ts'

/** Minimal ServerResponse spy (same shape the state/events specs use). */
function resSpy() {
  const out: { status: number; headers: Record<string, string>; body: string } = { status: 0, headers: {}, body: '' }
  return {
    out,
    res: {
      writeHead: (n: number, h: Record<string, string>) => { out.status = n; out.headers = h },
      end: (b?: string) => { out.body = b ?? '' },
    } as unknown as import('node:http').ServerResponse,
  }
}

describe('doc route — lazy per-phase doc fetch (0.2.4)', () => {
  let repoRoot: string
  let runDir: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'rm-doc-'))
    runDir = join(repoRoot, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), '# Requirements\n\n- R1: something\n', 'utf8')
    writeFileSync(join(runDir, '02-to-be-plan.md'), '## Implementation Steps\n\n1. do it\n', 'utf8')
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  function hostWith(root: string | null): RecursiveRouteHost {
    return {
      resolveRoot: vi.fn(async () => root),
      snapshot: vi.fn(async () => ({})),
      revision: vi.fn(() => 1),
    }
  }

  it('answers GET with the run doc markdown (text/markdown), lazily', async () => {
    const host = hostWith(repoRoot)
    const routes = makeRecursiveRoutes(host)
    const doc = routes.find((r) => r.path === '/.recursive/api/doc')
    expect(doc).toBeTruthy()
    const { res, out } = resSpy()
    const url = '/.recursive/api/doc?root=' + encodeURIComponent(repoRoot) + '&runId=r1&file=00-requirements.md'
    await doc!.handler({ method: 'GET', url, headers: { 'sec-fetch-site': 'same-origin' } } as never, res)
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toContain('text/markdown')
    expect(out.body).toContain('# Requirements')
    expect(out.body).toContain('- R1: something')
  })

  it('rejects a path-traversal file param with 400', async () => {
    const host = hostWith(repoRoot)
    const doc = makeRecursiveRoutes(host).find((r) => r.path === '/.recursive/api/doc')!
    const { res, out } = resSpy()
    const url = '/.recursive/api/doc?root=' + encodeURIComponent(repoRoot) + '&runId=r1&file=../requirements.md'
    await doc.handler({ method: 'GET', url, headers: { 'sec-fetch-site': 'same-origin' } } as never, res)
    expect(out.status).toBe(400)
  })

  it('rejects a subdir / non-phase file param with 400', async () => {
    const host = hostWith(repoRoot)
    const doc = makeRecursiveRoutes(host).find((r) => r.path === '/.recursive/api/doc')!
    const { res, out } = resSpy()
    const url = '/.recursive/api/doc?root=' + encodeURIComponent(repoRoot) + '&runId=r1&file=evidence/foo.md'
    await doc.handler({ method: 'GET', url, headers: { 'sec-fetch-site': 'same-origin' } } as never, res)
    expect(out.status).toBe(400)
  })

  it('404s for a missing file', async () => {
    const host = hostWith(repoRoot)
    const doc = makeRecursiveRoutes(host).find((r) => r.path === '/.recursive/api/doc')!
    const { res, out } = resSpy()
    const url = '/.recursive/api/doc?root=' + encodeURIComponent(repoRoot) + '&runId=r1&file=08-memory-impact.md'
    await doc.handler({ method: 'GET', url, headers: { 'sec-fetch-site': 'same-origin' } } as never, res)
    expect(out.status).toBe(404)
  })

  it('rejects a client root the host does not know (400)', async () => {
    const host = hostWith('/some/other/root')
    const doc = makeRecursiveRoutes(host).find((r) => r.path === '/.recursive/api/doc')!
    const { res, out } = resSpy()
    const url = '/.recursive/api/doc?root=' + encodeURIComponent(repoRoot) + '&runId=r1&file=00-requirements.md'
    await doc.handler({ method: 'GET', url, headers: { 'sec-fetch-site': 'same-origin' } } as never, res)
    expect(out.status).toBe(400)
  })

  it('rejects a traversal runId (400)', async () => {
    const host = hostWith(repoRoot)
    const doc = makeRecursiveRoutes(host).find((r) => r.path === '/.recursive/api/doc')!
    const { res, out } = resSpy()
    const url = '/.recursive/api/doc?root=' + encodeURIComponent(repoRoot) + '&runId=../r1&file=00-requirements.md'
    await doc.handler({ method: 'GET', url, headers: { 'sec-fetch-site': 'same-origin' } } as never, res)
    expect(out.status).toBe(400)
  })

  it('rejects non-GET (405) and no browser marker (403)', async () => {
    const host = hostWith(repoRoot)
    const doc = makeRecursiveRoutes(host).find((r) => r.path === '/.recursive/api/doc')!
    const { res, out } = resSpy()
    await doc.handler({ method: 'POST', url: '/.recursive/api/doc', headers: { 'sec-fetch-site': 'same-origin' } } as never, res)
    expect(out.status).toBe(405)
    const { res: res2, out: out2 } = resSpy()
    await doc.handler({ method: 'GET', url: '/.recursive/api/doc?x=1', headers: {} } as never, res2)
    expect(out2.status).toBe(403)
  })

  it('does NOT add the doc to the state payload (lazy, out of the projection)', async () => {
    const state = makeRecursiveRoutes(hostWith(repoRoot)).find((r) => r.path === '/.recursive/api/state')!
    const { res, out } = resSpy()
    await state.handler({ method: 'GET', url: '/.recursive/api/state?cwd=' + encodeURIComponent(repoRoot), headers: { 'sec-fetch-site': 'same-origin' } } as never, res)
    expect(out.status).toBe(200)
    const payload = JSON.parse(out.body)
    expect(payload.projection).toEqual({})
  })
})