/**
 * Spec for the Recursive SETTINGS PANEL (client half).
 *
 * The defect this pins: the panel claimed to report the host's configuration
 * ("This panel reports that; the client is read-only") while rendering a heading,
 * one sentence and a Close button. There is no config on the wire — the live
 * route serves {root, projection, revision} — so the panel must PRINT what the
 * projection actually carries and MARK everything else as not reported.
 *
 * What is asserted here, in order:
 *   1. the pure view model reads real values off a supplied projection;
 *   2. the absence rule: a field the projection did not carry is `not reported`
 *      (never '', never a plausible default — e.g. an absent subagent status is
 *      NOT `done`, which is what derive.cardFacts() defaults it to);
 *   3. the rendered panel prints those values (react-test-renderer);
 *   4. the empty/absent-projection case renders, says the route has not answered,
 *      and still names the route-level fields it cannot report;
 *   5. the LIVE seat is wired: with a mocked host-api frame, the panel shows the
 *      run and root that the route delivered (this is the assertion that fails if
 *      the seat stops subscribing — the panel would render "not reported").
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { create as createRenderer, act, type ReactTestInstance } from 'react-test-renderer'
import { RecursiveSettings, RecursiveSettingsLive, ABSENT_LABEL } from '../src/client/settings.tsx'
import { settingsView, settingsRunView } from '../src/client/settings-view.ts'
import type { LiveProjectionValue, SessionListStateLike, SnapshotSelectorHook, WorkspaceListStateLike } from '../src/client/contract.ts'
import type { RecursiveRunCard } from '../src/types.ts'

function card(partial: Partial<RecursiveRunCard> = {}): RecursiveRunCard {
  return { runId: 'r1', worktreeRoot: '/workspace-root', phases: {}, state: 'active', tampers: {}, subagents: {}, ...partial }
}

/** A frame with one run: a LOCKED 00, a BLOCKED (position) 02, and a subagent with no status. */
function liveSnapshot(): LiveProjectionValue {
  return {
    root: '/workspace-root',
    revision: 7,
    projection: {
      '/workspace-root': {
        r1: card({
          phases: {
            '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED', position: 'locked', lockedAt: '2026-01-01T00:00:00Z', lockHash: 'a'.repeat(64) },
            '02-to-be-plan.md': { phase: '02-to-be-plan.md', status: 'DRAFT', position: 'blocked' },
          },
          subagents: { c1: { childId: 'c1', role: 'reviewer', provider: 'deepseek' } },
          pendingWork: [{ kind: 'unanswered-delegation', delegationId: 'd-1', path: 'handoff.md', detail: 'handoff.md has no reply yet' }],
        }),
      },
    },
  }
}

/* ---------- render-tree helpers ---------- */

interface JsonNode { type?: unknown; props?: Record<string, unknown>; children?: unknown }

/** Concatenate every string in a rendered tree (for "does it say X" checks). */
function textOf(json: unknown): string {
  if (typeof json === 'string') return json
  if (typeof json === 'number') return String(json)
  if (json === null || json === undefined || typeof json === 'boolean') return ''
  if (Array.isArray(json)) return json.map(textOf).join(' ')
  return textOf((json as JsonNode).children)
}

function render(props: { close: () => void; snapshot?: LiveProjectionValue | null }) {
  return createRenderer(createElement(RecursiveSettings, props))
}

function hasClass(cls: string) {
  return (node: ReactTestInstance) => String((node.props as Record<string, unknown> | undefined)?.className ?? '').split(' ').includes(cls)
}

/** The `dd` value that follows a `dt` with this label (a definition-list lookup). */
function valueOfLabel(root: ReactTestInstance, label: string): string {
  const dts = root.findAll((n) => n.type === 'dt' && textOf((n.props as Record<string, unknown>).children) === label)
  expect(dts.length, 'expected exactly one dt labelled ' + label).toBe(1)
  const dl = dts[0].parent
  const kids = (dl?.children ?? []) as ReactTestInstance[]
  const index = kids.indexOf(dts[0])
  return textOf((kids[index + 1].props as Record<string, unknown>).children)
}

/* ---------- 1. the view model reads real values ---------- */

describe('settings view model (values from the projection)', () => {
  it('reports the frame facts verbatim', () => {
    const view = settingsView(liveSnapshot())
    expect(view.status).toBe('connected')
    expect(view.root).toBe('/workspace-root')
    expect(view.revision).toBe(7)
    expect(view.runs.length).toBe(1)
  })

  it('reports run facts, lock position and phase positions from the card', () => {
    const view = settingsView(liveSnapshot())
    const run = view.runs[0]
    const row = (id: string) => run.rows.find((r) => r.id === id)?.value
    expect(row('state')).toBe('active')
    expect(row('state-reason')).toBeNull()
    expect(row('lock')).toBe('in-progress')
    expect(row('locked')).toBe('1 of 2 present')
    expect(row('current-phase')).toBe('02-to-be-plan.md')
    expect(row('tampers')).toBe('none')
    // Optional card fields the fold does not carry -> null (rendered as absent).
    expect(row('gate')).toBeNull()
    expect(row('repo')).toBeNull()
    expect(row('template')).toBeNull()
    expect(row('merged')).toBeNull()

    const locked = run.phases.find((p) => p.phase === '00')
    expect(locked?.status).toBe('LOCKED')
    expect(locked?.position).toBe('locked')
    expect(locked?.lockedAt).toBe('2026-01-01T00:00:00Z')
    expect(locked?.lockHash).toBe('a'.repeat(64))
    const blocked = run.phases.find((p) => p.phase === '02')
    expect(blocked?.position).toBe('blocked')
    // The mandatory 03.5 slot is expanded but absent: position is NOT invented.
    const slot = run.phases.find((p) => p.phase === '03.5')
    expect(slot?.present).toBe(false)
    expect(slot?.fileName).toBeNull()
    expect(slot?.position).toBeNull()
  })

  it('reports subagent role/provider, and an ABSENT status as absent (never "done")', () => {
    const run = settingsView(liveSnapshot()).runs[0]
    expect(run.subagents).toEqual([{ childId: 'c1', role: 'reviewer', provider: 'deepseek', status: null }])
    expect(run.pendingWork).toEqual([{ kind: 'unanswered-delegation', delegationId: 'd-1', detail: 'handoff.md has no reply yet' }])
  })

  it('distinguishes an empty collection (none) from an omitted one (not reported)', () => {
    const run = settingsRunView(card({ phases: {} }))
    expect(run.subagents).toEqual([])
    expect(run.pendingWork).toBeNull()
  })

  it('reports the tamper facts it is given', () => {
    const run = settingsRunView(card({
      phases: { '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED', position: 'tampered' } },
      tampers: { '00-requirements.md': { path: '00-requirements.md', reason: 'LockHash mismatch' } },
    }))
    expect(run.rows.find((r) => r.id === 'tampers')?.value).toBe('00-requirements.md: LockHash mismatch')
    expect(run.pill).toBe('tampered')
  })

  it('names the route-level config the payload does not carry', () => {
    const view = settingsView(liveSnapshot())
    expect(view.notCarried.map((r) => r.label)).toEqual([
      'Enforcement modes (preStep / toolGuards / tamper)',
      'Router defaults (defaults.subagent) and per-role routes',
      'Scratch format',
    ])
    for (const row of view.notCarried) expect(row.value).toBeNull()
  })
})

/* ---------- 2. the rendered panel ---------- */

describe('RecursiveSettings (renders the projection it is given)', () => {
  it('prints the frame, the run and its phases', () => {
    const r = render({ close: () => {}, snapshot: liveSnapshot() })
    const text = textOf(r.toJSON())
    expect(text).toContain('Recursive')
    expect(valueOfLabel(r.root, 'workspace root')).toBe('/workspace-root')
    expect(valueOfLabel(r.root, 'revision')).toBe('7')
    expect(valueOfLabel(r.root, 'runs in the projection')).toBe('1')
    expect(text).toContain('r1')
    expect(valueOfLabel(r.root, 'run state')).toBe('active')
    expect(valueOfLabel(r.root, 'lock position')).toBe('in-progress')
    expect(text).toContain('00-requirements.md')
    expect(text).toContain('LOCKED')
    expect(text).toContain('blocked')
    expect(text).toContain('role reviewer · provider deepseek · status ' + ABSENT_LABEL)
    expect(text).toContain('unanswered-delegation')
    r.unmount()
  })

  it('renders an absent field as the marked "not reported", never as an empty row', () => {
    const r = render({ close: () => {}, snapshot: liveSnapshot() })
    // The gate block and repo are absent on this card.
    expect(valueOfLabel(r.root, 'gate block')).toBe(ABSENT_LABEL)
    expect(valueOfLabel(r.root, 'repo')).toBe(ABSENT_LABEL)
    const absent = r.root.findAll(hasClass('rec-settings-absent'))
    expect(absent.length).toBeGreaterThan(0)
    for (const node of absent) expect(textOf((node.props as Record<string, unknown>).children)).toBe(ABSENT_LABEL)
    // No value cell anywhere is blank. The count guard is load-bearing: without it
    // this loop would pass vacuously if the class selector stopped matching.
    const values = r.root.findAll(hasClass('rec-settings-value'))
    expect(values.length).toBeGreaterThan(0)
    for (const dd of values) {
      expect(textOf((dd.props as Record<string, unknown>).children).trim()).not.toBe('')
    }
    r.unmount()
  })

  it('keeps the not-carried fields visible instead of promising them', () => {
    const r = render({ close: () => {}, snapshot: liveSnapshot() })
    expect(textOf(r.toJSON())).toContain('Not carried by this route')
    for (const label of ['Enforcement modes (preStep / toolGuards / tamper)', 'Router defaults (defaults.subagent) and per-role routes', 'Scratch format']) {
      expect(valueOfLabel(r.root, label)).toBe(ABSENT_LABEL)
    }
    // The old claim — that this panel reports the host config — is gone.
    expect(textOf(r.toJSON())).not.toContain('This panel reports that')
    r.unmount()
  })

  it('calls close from the Close button', () => {
    const close = vi.fn()
    const r = render({ close, snapshot: liveSnapshot() })
    r.root.find(hasClass('rec-settings-close')).props.onClick()
    expect(close).toHaveBeenCalledTimes(1)
    r.unmount()
  })
})

/* ---------- 3. the empty / absent projection ---------- */

describe('RecursiveSettings (absent projection)', () => {
  it('renders without a snapshot: says the route has not answered, values absent', () => {
    const r = render({ close: () => {} })
    const text = textOf(r.toJSON())
    expect(valueOfLabel(r.root, 'route status')).toBe('no frame yet')
    expect(valueOfLabel(r.root, 'workspace root')).toBe(ABSENT_LABEL)
    expect(valueOfLabel(r.root, 'revision')).toBe(ABSENT_LABEL)
    expect(valueOfLabel(r.root, 'runs in the projection')).toBe(ABSENT_LABEL)
    expect(text).toContain('has not answered')
    expect(text).toContain('Not carried by this route')
    // Same load-bearing count guard as above: no blank value cell anywhere.
    const values = r.root.findAll(hasClass('rec-settings-value'))
    expect(values.length).toBeGreaterThan(0)
    for (const dd of values) {
      expect(textOf((dd.props as Record<string, unknown>).children).trim()).not.toBe('')
    }
    r.unmount()
  })

  it('renders an answered-but-rootless frame without inventing a root', () => {
    const r = render({ close: () => {}, snapshot: { root: null, projection: {}, revision: 0 } })
    expect(valueOfLabel(r.root, 'route status')).toBe('answered · no recursive root')
    expect(valueOfLabel(r.root, 'workspace root')).toBe(ABSENT_LABEL)
    // revision 0 IS a carried value — it must print as 0, not as absent.
    expect(valueOfLabel(r.root, 'revision')).toBe('0')
    expect(textOf(r.toJSON())).toContain('resolved no recursive root')
    r.unmount()
  })

  it('renders a connected-but-empty workspace as "none", not as not reported', () => {
    const r = render({ close: () => {}, snapshot: { root: '/empty', projection: {}, revision: 3 } })
    expect(valueOfLabel(r.root, 'runs in the projection')).toBe('0')
    expect(textOf(r.toJSON())).toContain('carries no runs in this workspace')
    r.unmount()
  })
})

/* ---------- 4. the live seat is wired (fails without the subscription) ---------- */

vi.mock('../src/client/host-api.ts', () => ({
  fetchLiveState: vi.fn(async () => ({
    root: '/ws',
    revision: 3,
    projection: {
      '/ws': {
        r9: {
          runId: 'r9',
          worktreeRoot: '/ws',
          phases: { '04-test-summary.md': { phase: '04-test-summary.md', status: 'LOCKED', position: 'locked' } },
          state: 'active',
          tampers: {},
          subagents: {},
        },
      },
    },
  })),
  subscribeLiveEvents: vi.fn(() => () => {}),
}))

const SESSIONS: SessionListStateLike = { ids: ['s1'], byId: { s1: { id: 's1', cwd: '/ws' } }, current: 's1' }
const WORKSPACES: WorkspaceListStateLike = { items: [{ workspaceId: 'w1', path: '/ws', title: 'WS', sessionIds: ['s1'] }], recentWorkspaceId: 'w1' }

const sessionsHook = ((sel: (s: SessionListStateLike) => unknown) => sel(SESSIONS)) as SnapshotSelectorHook<SessionListStateLike>
const workspacesHook = ((sel: (s: WorkspaceListStateLike) => unknown) => sel(WORKSPACES)) as SnapshotSelectorHook<WorkspaceListStateLike>

describe('RecursiveSettingsLive (the seat subscribes to the live route)', () => {
  it('renders the run and root the host route delivered', async () => {
    let r: ReturnType<typeof createRenderer> | undefined
    await act(async () => {
      r = createRenderer(createElement(RecursiveSettingsLive, { close: () => {}, useSessions: sessionsHook, useWorkspaces: workspacesHook }))
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const text = textOf(r!.toJSON())
    // These two lines are the wiring assertion: with no subscription the panel
    // renders ABSENT_LABEL everywhere and never sees r9 or the delivered root.
    expect(text).toContain('r9')
    expect(valueOfLabel(r!.root, 'workspace root')).toBe('/ws')
    expect(valueOfLabel(r!.root, 'runs in the projection')).toBe('1')
    r!.unmount()
  })
})
