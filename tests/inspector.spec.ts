/**
 * Spec for run 12 + run 15 + run 16: centered modal detail, solid state pill,
 * back + close buttons, and a data-theme toggle (default light).
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { create as createRenderer, act, type ReactTestInstance } from 'react-test-renderer'
import { Inspector } from '../src/client/inspector.tsx'
import type { LiveProjectionValue } from '../src/client/contract.ts'
import type { RecursiveRunCard } from '../src/types.ts'

function card(runId: string, worktreeRoot: string): RecursiveRunCard {
  return { runId, worktreeRoot, phases: { '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED' } }, state: 'active', tampers: {}, subagents: {} }
}

const snapshot: LiveProjectionValue = {
  root: '/w',
  revision: 1,
  projection: { '/w': { 'r1': card('r1', '/w') } },
}

function render(props: Parameters<typeof Inspector>[0]) {
  return createRenderer(createElement(Inspector, props))
}
function findOne(root: ReactTestInstance, cls: string): ReactTestInstance {
  return root.find((n) => (n.props as Record<string, unknown> | undefined)?.className === cls)
}

describe('inspector (Paper redesign)', () => {
  it('renders backdrop + centered detail + header', () => {
    const r = render({ runId: 'r1', worktreeRoot: '/w', snapshot, onBackToToolDetails: () => {}, onClose: () => {} })
    expect(findOne(r.root, 'rec-inspector')).toBeTruthy()
    expect(findOne(r.root, 'rec-detail')).toBeTruthy()
    expect(findOne(r.root, 'rec-detail-header')).toBeTruthy()
    r.unmount()
  })

  it('back button calls onBackToToolDetails', () => {
    const onBack = vi.fn()
    const r = render({ runId: 'r1', worktreeRoot: '/w', snapshot, onBackToToolDetails: onBack, onClose: () => {} })
    act(() => findOne(r.root, 'rec-back').props.onClick())
    expect(onBack).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('close button calls onClose', () => {
    const onClose = vi.fn()
    const r = render({ runId: 'r1', worktreeRoot: '/w', snapshot, onBackToToolDetails: () => {}, onClose })
    act(() => findOne(r.root, 'rec-close').props.onClick())
    expect(onClose).toHaveBeenCalledTimes(1)
    r.unmount()
  })

  it('renders phase rows with a solid status pill (data-pill)', () => {
    const r = render({ runId: 'r1', worktreeRoot: '/w', snapshot, onBackToToolDetails: () => {}, onClose: () => {} })
    const rows = r.root.findAll((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-phase-row')
    expect(rows.length).toBeGreaterThan(0)
    const lockedPill = rows[0].find((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-pill' && (n.props as Record<string, unknown> | undefined)?.['data-pill'] === 'locked')
    expect(lockedPill).toBeTruthy()
    r.unmount()
  })

  it('defaults to data-theme=light and the toggle flips to dark', () => {
    const r = render({ runId: 'r1', worktreeRoot: '/w', snapshot, onBackToToolDetails: () => {}, onClose: () => {} })
    expect(findOne(r.root, 'rec-inspector').props['data-theme']).toBe('light')
    act(() => findOne(r.root, 'rec-theme-toggle').props.onClick())
    expect(findOne(r.root, 'rec-inspector').props['data-theme']).toBe('dark')
    r.unmount()
  })
  it('renders a View phase button per present phase row (not on absent rows)', () => {
    const r = render({ runId: 'r1', worktreeRoot: '/w', snapshot, onBackToToolDetails: () => {}, onClose: () => {} })
    const buttons = r.root.findAll((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-phase-view')
    expect(buttons.length).toBeGreaterThan(0)
    // the card has one present phase (00-requirements.md): exactly one View button
    expect(buttons.length).toBe(1)
    r.unmount()
  })

  it('clicking View phase swaps the detail body to the doc viewer; Close returns', async () => {
    // Stub fetch so the DocViewer mounts deterministically (node env has no real route).
    const fetchStub = vi.fn(async () => ({ ok: true, text: async () => '# Run doc\n\ncontent here' }))
    const original = globalThis.fetch
    vi.stubGlobal('fetch', fetchStub as never)
    try {
      const r = render({ runId: 'r1', worktreeRoot: '/w', snapshot, onBackToToolDetails: () => {}, onClose: () => {} })
      const button = r.root.findAll((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-phase-view')[0]
      expect(button).toBeTruthy()
      await act(async () => { button.props.onClick() })
      // the doc viewer shell now renders inside the inspector
      expect(r.root.findAll((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-doc').length).toBe(1)
      // Close returns to the phase list (no doc shell)
      const closeButtons = r.root.findAll((n) => String((n.props as Record<string, unknown> | undefined)?.className ?? '').split(' ').includes('rec-doc-close'))
      expect(closeButtons.length).toBe(1)
      await act(async () => { closeButtons[0].props.onClick() })
      expect(r.root.findAll((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-doc').length).toBe(0)
      expect(r.root.findAll((n) => (n.props as Record<string, unknown> | undefined)?.className === 'rec-phase-row').length).toBeGreaterThan(0)
      r.unmount()
    } finally {
      if (original === undefined) vi.unstubAllGlobals()
      else vi.stubGlobal('fetch', original)
    }
  })

  it('renders run-not-found when the card is missing', () => {
    const r = render({ runId: 'nope', worktreeRoot: '/w', snapshot, onBackToToolDetails: () => {}, onClose: () => {} })
    expect(findOne(r.root, 'rec-inspector')).toBeTruthy()
    r.unmount()
  })
})
