import { describe, it, expect } from 'vitest'
import { createBoardState } from '../src/client/open-state.ts'

describe('open-state (R1)', () => {
  it('starts closed with no selection', () => {
    const s = createBoardState()
    expect(s.get()).toEqual({ open: false, selection: null })
  })

  it('openBoard opens the overlay', () => {
    const s = createBoardState()
    s.openBoard()
    expect(s.get().open).toBe(true)
  })

  it('close clears open + selection', () => {
    const s = createBoardState({ open: true, selection: { worktreeRoot: '/w', runId: 'r1' } })
    s.close()
    expect(s.get()).toEqual({ open: false, selection: null })
  })

  it('openInspector selects a run; backToBoard clears the selection but stays open', () => {
    const s = createBoardState()
    s.openInspector({ worktreeRoot: '/w', runId: 'r1' })
    expect(s.get()).toEqual({ open: true, selection: { worktreeRoot: '/w', runId: 'r1' } })
    s.backToBoard()
    expect(s.get()).toEqual({ open: true, selection: null })
  })

  it('subscribe notifies on change and unsubscribes', () => {
    const s = createBoardState()
    let calls = 0
    const unsub = s.subscribe(() => { calls += 1 })
    s.openBoard()
    expect(calls).toBe(1)
    unsub()
    s.close()
    expect(calls).toBe(1)
  })
})
