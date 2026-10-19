/**
 * THE GATE SETTINGS IN THE CONVERSATION VIEW, AND WHAT AN ABORTED FETCH SAYS.
 *
 * Two defects reported from the live GUI, each pinned here so it cannot come back:
 *
 *   1. THE PANEL SHOWED "signal is aborted without reason". That is the browser's own sentence for an
 *      AbortError, surfaced verbatim because the transport let the exception escape. The abort is OUR
 *      timeout (`FETCH_TIMEOUT_MS`), so the panel must state what happened and why the route may be
 *      absent — a person editing a settings file must never be shown a browser-internal phrase and left
 *      to guess that their config is broken.
 *
 *   2. THE ENTRY POINT WAS ONLY IN THE RIGHT SIDEBAR. The owner asked for it "in the conversation view,
 *      next to Trajectory", and this plugin already owns that seat (`conversation.view`). The gates form
 *      is therefore rendered inside that view, above the board, opening from a "Gate settings" summary.
 *
 * The transport tests stub the GLOBAL fetch and exercise the real transport, so they cover the code path
 * the GUI actually runs — including the timer that is the true source of the abort.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { create as createRenderer } from 'react-test-renderer'
import { fetchGates, saveGates } from '../src/client/host-api.ts'
import { RecursiveView } from '../src/client/slots.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A fetch that rejects immediately the way an aborted request does. */
function abortingFetch(): void {
  vi.stubGlobal('fetch', (): Promise<never> => {
    const error = new Error('signal is aborted without reason')
    error.name = 'AbortError'
    return Promise.reject(error)
  })
}

/** A fetch that never answers, but rejects when the caller's signal aborts — the timeout path. */
function hangingFetch(): void {
  vi.stubGlobal('fetch', (_url: string, init: { signal: AbortSignal }): Promise<never> => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('signal is aborted without reason')
      error.name = 'AbortError'
      reject(error)
    })
  }))
}

/** A fetch stub that answers both routes the view touches, so rendering does not depend on a host. */
function healthyFetch(): void {
  vi.stubGlobal('fetch', (url: string): Promise<unknown> => {
    const body = String(url).includes('/gates')
      ? {
          root: '/workspace',
          effective: {
            qa: { humanReview: false },
            gates: {
              runStart: { ask: true },
              tddMode: { ask: false, default: 'strict' },
              qaSignoff: { ask: true, default: 'agent-operated' },
              gateBlock: { ask: true },
            },
            teammate: { primitiveRoles: [] },
          },
          sources: {},
          fromConfig: {},
          fromFile: {},
        }
      : { root: null, projection: { runs: [], activeRunId: null }, revision: 0 }
    // The transport reads the body as TEXT and parses it itself (so a non-JSON answer can become a
    // sentence), so the double must serve text — a `json()`-only double would test a path that no longer runs.
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    })
  })
}

describe('an aborted gates fetch explains itself', () => {
  it('OUR TIMEOUT says it timed out, where the route lives, and never the DOMException', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const pending = fetchGates({})
    // Past the transport's 15s timeout: the abort is ours, so it must be described as one.
    await vi.advanceTimersByTimeAsync(16_000)
    const payload = await pending
    expect(JSON.stringify(payload)).not.toContain('aborted without reason')
    expect(payload.problem).toContain('did not answer within')
    // Outside a recursive-mode session the route is absent BY DESIGN; the sentence must say so.
    expect(payload.problem).toContain('recursive-mode session')
    expect(payload.effective).toBeNull()
  })

  it('an external cancellation says so, and still never echoes the DOMException', async () => {
    abortingFetch()
    const payload = await fetchGates({})
    expect(JSON.stringify(payload)).not.toContain('aborted without reason')
    expect(payload.problem).toContain('cancelled')
  })

  it('a cancelled save says nothing was written', async () => {
    abortingFetch()
    const result = await saveGates({}, { gates: {} })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('aborted without reason')
    expect(result.ok === false ? result.problem : '').toContain('nothing was written')
  })
})

/**
 * ⚠ THE LIVE GUI SHOWED "Unexpected end of JSON input" IN THIS PANEL.
 *
 * That is `JSON.parse('')`'s complaint. The route is served only inside a recursive-mode session, so
 * opening the tab anywhere else got an EMPTY 404 body, and the panel reported a JSON SYNTAX error — sending
 * a person to look for a malformed settings file that does not exist. A parser's phrase is not an answer:
 * these tests require the status and the reason, and forbid the parser text outright.
 */
describe('a body that is not a gates payload becomes a sentence, never a parser error', () => {
  function emptyStatusFetch(status: number): void {
    vi.stubGlobal('fetch', (): Promise<unknown> => Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(''),
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    }))
  }
  function htmlFetch(): void {
    vi.stubGlobal('fetch', (): Promise<unknown> => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<!doctype html><html><body>app shell</body></html>'),
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    }))
  }

  it('an empty 404 names the status and where the route lives', async () => {
    emptyStatusFetch(404)
    const payload = await fetchGates({})
    expect(JSON.stringify(payload)).not.toContain('Unexpected end of JSON input')
    expect(payload.problem).toContain('HTTP 404')
    expect(payload.problem).toContain('recursive-mode session')
    expect(payload.effective).toBeNull()
  })

  it('a non-JSON 200 does not claim a JSON syntax problem', async () => {
    htmlFetch()
    const payload = await fetchGates({})
    expect(JSON.stringify(payload)).not.toContain('Unexpected token')
    expect(payload.problem).toContain('without a gates payload')
  })

  it('an empty 404 on save says nothing was written, and does not echo the parser', async () => {
    emptyStatusFetch(404)
    const result = await saveGates({}, { gates: {} })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('Unexpected end of JSON input')
    expect(result.ok === false ? result.problem : '').toContain('HTTP 404')
    expect(result.ok === false ? result.problem : '').toContain('nothing was written')
  })
})

describe('the gate settings are reachable from the conversation view', () => {
  it('the conversation tab renders a Gate settings section containing the live form', async () => {
    healthyFetch()
    const hooks = {
      useSessions: (select: (state: unknown) => unknown) => select({ items: [] }),
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: undefined }),
    }
    const renderer = createRenderer(createElement(RecursiveView, hooks as never))
    // The entry point the owner asked for: a section inside the conversation view, not a sidebar-only seat.
    const summaries = renderer.root.findAll((node) => node.type === 'summary')
    expect(summaries.map((node) => JSON.stringify(node.children)).join(' ')).toContain('Gate settings')
    // ...and it renders the REAL form once its load settles: one ask switch per gate plus the QA switch.
    await vi.waitFor(() => {
      const switches = renderer.root.findAll((node) => (node.props as Record<string, unknown>).role === 'switch')
      expect(switches.length).toBeGreaterThanOrEqual(5)
      return switches
    })
    renderer.unmount()
  })
})
