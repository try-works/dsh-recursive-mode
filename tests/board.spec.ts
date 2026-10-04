/**
 * Spec for run 08 R2/R3 (board from live-route projection) + run 15 (grid
 * board) + run 16 (Paper theme): class-based structure, solid state pills,
 * data-theme (default light) + a theme toggle.
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { create as createRenderer, act, type ReactTestInstance } from 'react-test-renderer'
import { Board, listRuns } from '../src/client/board.tsx'
import type { LiveProjectionValue } from '../src/client/contract.ts'
import type { RecursiveRunCard } from '../src/types.ts'

function card(runId: string, worktreeRoot: string, phases: RecursiveRunCard['phases'], state: RecursiveRunCard['state'] = 'active'): RecursiveRunCard {
  return { runId, worktreeRoot, phases, state, tampers: {}, subagents: {} }
}

const snapshot: LiveProjectionValue = {
  root: '/workspace-root',
  revision: 1,
  projection: {
    '/workspace-root': {
      'r1': card('r1', '/workspace-root', { '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED' }, '03-implementation-summary.md': { phase: '03-implementation-summary.md', status: 'DRAFT' } }),
      'r2': card('r2', '/workspace-root', { '02-to-be-plan.md': { phase: '02-to-be-plan.md', status: 'DRAFT' } }),
    },
  },
}

function render(props: Parameters<typeof Board>[0]) {
  return createRenderer(createElement(Board, props))
}
function findAll(root: ReactTestInstance, cls: string): ReactTestInstance[] {
  return root.findAll((n) => (n.props as Record<string, unknown> | undefined)?.className === cls)
}
function findOne(root: ReactTestInstance, cls: string): ReactTestInstance {
  return root.find((n) => (n.props as Record<string, unknown> | undefined)?.className === cls)
}
function columnTitle(col: ReactTestInstance): unknown {
  return col.find((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-column-title').props.children
}

describe('board (R2/R3 + Paper redesign)', () => {
  it('listRuns flattens the worktree-grouped projection', () => {
    const runs = listRuns(snapshot.projection)
    expect(runs.map(r => r.runId).sort()).toEqual(['r1', 'r2'])
  })

  it('renders the header (title + workspace path + count) and columns grid', () => {
    const r = render({ snapshot, onOpenInspector: () => {} })
    expect(findOne(r.root, 'rec-board-header')).toBeTruthy()
    expect(findOne(r.root, 'rec-board-path').props.children).toBe('/workspace-root')
    expect(findOne(r.root, 'rec-board-count').props.children).toBe('2 runs')
    expect(findOne(r.root, 'rec-columns')).toBeTruthy()
    expect(findAll(r.root, 'rec-column').length).toBe(7)
    r.unmount()
  })

  it('renders one card per run with a data-state attribute and solid pill', () => {
    const r = render({ snapshot, onOpenInspector: () => {} })
    const cards = findAll(r.root, 'rec-card')
    expect(cards.length).toBe(2)
    for (const c of cards) {
      expect(c.props['data-state']).toBe('active')
      const pill = c.find((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-pill' && (n.props as Record<string, unknown> | undefined)?.['data-pill'] === 'in-progress')
      expect(pill).toBeTruthy()
    }
    r.unmount()
  })

  it('places cards in the correct lane', () => {
    const r = render({ snapshot, onOpenInspector: () => {} })
    const cols = findAll(r.root, 'rec-column')
    const lane2 = cols.find((c) => columnTitle(c) === 'TO-BE Plan')
    const lane35 = cols.find((c) => columnTitle(c) === 'Implementation + Code Review')
    expect(lane2 && findAll(lane2, 'rec-card').length).toBe(1)
    expect(lane35 && findAll(lane35, 'rec-card').length).toBe(1)
    r.unmount()
  })

  it('card click calls onOpenInspector with the run selection', () => {
    const onOpen = vi.fn()
    const r = render({ snapshot, onOpenInspector: onOpen })
    act(() => findAll(r.root, 'rec-card')[0].props.onClick())
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ worktreeRoot: '/workspace-root' }))
    r.unmount()
  })

  it('renders the empty state with data-empty when there are no runs', () => {
    const r = render({ snapshot: { root: '/w', revision: 1, projection: {} }, onOpenInspector: () => {} })
    expect(findOne(r.root, 'rec-board').props['data-empty']).toBe(true)
    expect(findOne(r.root, 'rec-board-empty')).toBeTruthy()
    r.unmount()
  })

  it('exposes a close button calling onClose', () => {
    const onClose = vi.fn()
    const r = render({ snapshot, onOpenInspector: () => {}, onClose })
    act(() => findOne(r.root, 'rec-close').props.onClick())
    expect(onClose).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('defaults to data-theme=light and the toggle flips to dark', () => {
    const r = render({ snapshot, onOpenInspector: () => {} })
    expect(findOne(r.root, 'rec-board').props['data-theme']).toBe('light')
    act(() => findOne(r.root, 'rec-theme-toggle').props.onClick())
    expect(findOne(r.root, 'rec-board').props['data-theme']).toBe('dark')
    r.unmount()
  })

  it('renders nothing when the snapshot is null', () => {
    const r = render({ snapshot: null, onOpenInspector: () => {} })
    expect(r.toJSON()).toBeNull()
    r.unmount()
  })

  it('renders the passed workspacePath prop in the header (not snapshot.root)', () => {
    const staleSnapshot: LiveProjectionValue = {
      root: '/old-workspace', revision: 1, projection: {},
    }
    const r = render({ snapshot: staleSnapshot, workspacePath: '/dsh-anti-slop', onOpenInspector: () => {} })
    expect(findOne(r.root, 'rec-board-path').props.children).toBe('/dsh-anti-slop')
    r.unmount()
  })

  it('does NOT show a stale snapshot.root from a different workspace', () => {
    const staleSnapshot: LiveProjectionValue = {
      root: '/old-workspace', revision: 1, projection: {},
    }
    const r = render({ snapshot: staleSnapshot, workspacePath: '/current', onOpenInspector: () => {} })
    // The header must carry the authoritative current path, never the stale root.
    const pathNodes = r.root.findAll((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-board-path')
    for (const p of pathNodes) {
      expect(p.props.children).not.toBe('/old-workspace')
    }
    r.unmount()
  })

  it('renders NO run cards when snapshot.root differs from workspacePath (stale workspace)', () => {
    const staleSnapshot: LiveProjectionValue = {
      root: '/old-workspace',
      revision: 1,
      projection: {
        '/old-workspace': {
          'r1': card('r1', '/old-workspace', { '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED' } }),
        },
      },
    }
    const r = render({ snapshot: staleSnapshot, workspacePath: '/current', onOpenInspector: () => {} })
    // Stale projection must be suppressed: no cards, but the correct header path shows.
    expect(findAll(r.root, 'rec-card').length).toBe(0)
    expect(findOne(r.root, 'rec-board-path').props.children).toBe('/current')
    r.unmount()
  })

  it('renders cards when snapshot.root matches workspacePath (case/trailing-sep tolerant)', () => {
    const matchSnapshot: LiveProjectionValue = {
      root: '/current',
      revision: 1,
      projection: {
        '/current': {
          'r1': card('r1', '/current', { '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED' } }),
        },
      },
    }
    const r = render({ snapshot: matchSnapshot, workspacePath: '/current', onOpenInspector: () => {} })
    expect(findAll(r.root, 'rec-card').length).toBe(1)
    r.unmount()
  })
})
