/**
 * Spec for run 10 (selector-hook fix) + run 11 (launcher UX gate):
 * - run 10: useSessions is a SELECTOR hook (SnapshotSelectorHook<SessionListState>),
 *   not a zero-arg hook. Calling useSessions() passes sel=undefined into
 *   useSyncExternalStoreWithSelector -> board never mounts -> launcher click dead.
 * - run 11: the ⧉ launcher is root-scoped (visible in EVERY session) but the board
 *   gate is recursive-only — in a code/other session clicking does nothing BY
 *   DESIGN (a UX trap). The launcher itself is now preset-gated: it renders only
 *   in recursive sessions, where clicking it opens the board.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SessionListStateLike, SnapshotSelectorHook, WorkspaceListStateLike } from '../src/client/contract.ts'
import { overlayContent, useRecursiveSessions, registerSlots, RecursiveLauncherGate, RecursiveView } from '../src/client/slots.ts'
import { RecursiveSettings, RecursiveSettingsLive } from '../src/client/settings.tsx'
import { createBoardState } from '../src/client/open-state.ts'

/** Real SessionListState-shaped fixture (ids/byId/current — the subset we consume). */
function sessionState(preset: string | undefined): SessionListStateLike {
  return {
    ids: ['s1'],
    byId: { s1: { id: 's1', agentPreset: preset, cwd: '/w' } },
    current: 's1',
  }
}

/** A useSessions double shaped as the REAL selector hook: (sel) => sel(state). */
function selectorHook(state: SessionListStateLike): SnapshotSelectorHook<SessionListStateLike> {
  return ((sel: (s: SessionListStateLike) => unknown) => sel(state)) as SnapshotSelectorHook<SessionListStateLike>
}

/** A useWorkspaces double shaped as the REAL selector hook. */
function workspaceHook(state: WorkspaceListStateLike): SnapshotSelectorHook<WorkspaceListStateLike> {
  return ((sel: (s: WorkspaceListStateLike) => unknown) => sel(state)) as SnapshotSelectorHook<WorkspaceListStateLike>
}

type SlotComponent = (props: Record<string, unknown>) => unknown

function collect(slot: string): SlotComponent[] {
  const regs: Record<string, SlotComponent[]> = {}
  const ctx = {
    slots: {
      inject: (_seat: string, factory: (c: unknown) => () => void) => {
        factory({})
        return () => {}
      },
      register: (opts: { name: string }, component: unknown) => {
        ;(regs[opts.name] ??= []).push(component as SlotComponent)
        return () => {}
      },
    },
    get: () => undefined,
    effect: () => () => {},
  }
  registerSlots(ctx as never)
  return regs[slot] ?? []
}

/** Capture register options (id/order/label) for a slot. */
function collectOptions(slot: string): Record<string, unknown>[] {
  const opts: Record<string, unknown>[] = []
  const ctx = {
    slots: {
      inject: (_seat: string, factory: (c: unknown) => () => void) => {
        factory({})
        return () => {}
      },
      register: (options: { name: string }, component: unknown) => {
        if (options.name === slot) opts.push(options as Record<string, unknown>)
        return () => {}
      },
    },
    get: () => undefined,
    effect: () => () => {},
  }
  registerSlots(ctx as never)
  return opts
}

describe('slots (run 10 selector-hook fix + run 11 launcher gate)', () => {
  it('launcher renders the ⧉ button ONLY on the recursive preset (null on code)', () => {
    const gate = RecursiveLauncherGate({ useSessions: selectorHook(sessionState('code')) })
    expect(gate).toBeNull()
    const button = RecursiveLauncherGate({ useSessions: selectorHook(sessionState('recursive')) })
    expect(button).not.toBeNull()
    const el = button as { props: Record<string, unknown> }
    expect(el.props.className).toBe('rec-launcher')
    expect(el.props.title).toBe('Recursive runs')
    expect(el.props.children).toBe('⧉')
  })

  it('launcher seat wraps the gate; the gate gates on the preset', () => {
    const [launcher] = collect('sidebar.footer.action')
    expect(launcher).toBeDefined()
    // The seat wraps RecursiveLauncherGate in createElement — unwrap and invoke the gate.
    const codeEl = launcher({ useSessions: selectorHook(sessionState('code')) }) as { type: (p: Record<string, unknown>) => unknown; props: Record<string, unknown> }
    expect(codeEl.type).toBe(RecursiveLauncherGate)
    expect(codeEl.type(codeEl.props)).toBeNull()
    const recEl = launcher({ useSessions: selectorHook(sessionState('recursive')) }) as { type: (p: Record<string, unknown>) => unknown; props: Record<string, unknown> }
    const btn = recEl.type(recEl.props) as { props: Record<string, unknown> }
    expect(typeof btn.props.onClick).toBe('function')
  })

  it('THE FIX: useSessions is called WITH a function selector (never bare)', () => {
    const fake = vi.fn(selectorHook(sessionState('recursive')))
    const out = useRecursiveSessions(fake as SnapshotSelectorHook<SessionListStateLike>)
    expect(fake).toHaveBeenCalledTimes(1)
    expect(fake.mock.calls[0][0]).toEqual(expect.any(Function))
    // The identity selector yields the full SessionListStateLike.
    expect(out.current).toBe('s1')
    expect(out.byId.s1.agentPreset).toBe('recursive')
  })

  it('overlayContent gates on the real SessionListState: board when open + recursive', () => {
    const openState = createBoardState({ open: true, selection: null }).get()
    expect(overlayContent(openState, sessionState('recursive'))).toBe('board')
  })

  it('overlayContent gates on the real SessionListState: hidden when non-recursive', () => {
    const openState = createBoardState({ open: true, selection: null }).get()
    expect(overlayContent(openState, sessionState(undefined))).toBe('hidden')
    expect(overlayContent(openState, sessionState('default'))).toBe('hidden')
  })

  it('overlayContent shows inspector when a run is selected on the recursive preset', () => {
    const selState = createBoardState({ open: true, selection: { worktreeRoot: '/w', runId: 'r1' } }).get()
    expect(overlayContent(selState, sessionState('recursive'))).toBe('inspector')
  })

  it('conversation.input.dock registers NOTHING (run names/status stay in the board only)', () => {
    expect(collect('conversation.input.dock').length).toBe(0)
    expect(collect('settings.section').length).toBe(1)
  })

  it('settings seat hands the panel a LIVE snapshot (root kit) and still renders without it', () => {
    const [seat] = collect('settings.section')
    expect(seat).toBeDefined()
    // With the shell's standard kit the seat renders the subscribing wrapper — this
    // is the assertion that fails if the panel stops reading the live route.
    const withKit = seat({
      close: () => {},
      useSessions: selectorHook(sessionState('recursive')),
      useWorkspaces: workspaceHook({ items: [], recentWorkspaceId: undefined }),
    }) as { type?: unknown }
    expect(withKit.type).toBe(RecursiveSettingsLive)
    // Without the kit the panel still renders (values report as absent, never guessed).
    const withoutKit = seat({ close: () => {} }) as { type?: unknown }
    expect(withoutKit.type).toBe(RecursiveSettings)
  })

  it('registers a Recursive conversation.view tab at the right of Trajectory (order 20)', () => {
    const view = collect('conversation.view').length
    const [viewOpt] = collectOptions('conversation.view').filter(o => o.id === 'recursive')
    expect(viewOpt).toBeDefined()
    expect(viewOpt.order).toBe(20)
    expect(viewOpt.label).toBe('Recursive')
    // Ensure it sits AFTER Trajectory (order 10) so it renders to its right.
    expect(viewOpt.order as number).toBeGreaterThan(10)
  })

  it('view seat wraps RecursiveView (the inline board tab body)', () => {
    const viewSeat = collect('conversation.view').find(c => {
      const el = c({ useSessions: selectorHook(sessionState('default')), useWorkspaces: workspaceHook({ items: [], recentWorkspaceId: undefined }) }) as { type?: unknown } | null
      return el?.type === RecursiveView
    })
    expect(viewSeat).toBeDefined()
  })
})
