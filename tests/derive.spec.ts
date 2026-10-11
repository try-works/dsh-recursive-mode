import { describe, it, expect } from 'vitest'
import {
  phaseGroupOf,
  laneOf,
  columnForRun,
  cardFacts,
  nodeKeyOf,
  expandPhaseRows,
  KANBAN_LANES,
} from '../src/client/derive.ts'
import type { RecursiveRunCard } from '../src/types.ts'

function card(partial: Partial<RecursiveRunCard> = {}): RecursiveRunCard {
  return {
    runId: 'r1',
    worktreeRoot: '/w',
    phases: {},
    state: 'active',
    tampers: {},
    subagents: {},
    ...partial,
  }
}

describe('derive: phase group + lane mapping (R5)', () => {
  it('maps phase keys to their numeric group', () => {
    expect(phaseGroupOf('00-requirements.md')).toBe('00')
    expect(phaseGroupOf('03.5-code-review.md')).toBe('03.5')
    expect(phaseGroupOf('06-decisions-update.md')).toBe('06')
    expect(phaseGroupOf('not-a-phase')).toBeNull()
  })

  it('maps groups to kanban lanes', () => {
    expect(laneOf('00-requirements.md')).toBe('0')
    expect(laneOf('01-as-is.md')).toBe('1/1.5')
    expect(laneOf('01.5-supplement.md')).toBe('1/1.5')
    expect(laneOf('02-to-be-plan.md')).toBe('2')
    expect(laneOf('03-implementation-summary.md')).toBe('3/3.5')
    expect(laneOf('03.5-code-review.md')).toBe('3/3.5')
    expect(laneOf('04-test-summary.md')).toBe('4')
    expect(laneOf('05-manual-qa.md')).toBe('5')
    expect(laneOf('07-state-update.md')).toBe('6-8')
  })

  it('exposes the ordered lane list', () => {
    expect(KANBAN_LANES.map(l => l.id)).toEqual(['0', '1/1.5', '2', '3/3.5', '4', '5', '6-8'])
  })

  it('maps a run to its current-phase lane (highest-order phase wins)', () => {
    const c = card({ phases: {
      '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED' },
      '03-implementation-summary.md': { phase: '03-implementation-summary.md', status: 'DRAFT' },
    } })
    expect(columnForRun(c)).toBe('3/3.5')
  })

  it('defaults to lane 0 for a run with no phases', () => {
    expect(columnForRun(card())).toBe('0')
  })
})

describe('derive: card facts (R5)', () => {
  it('computes progress, tamper flag, gate block, subagents, merge, state', () => {
    const c = card({
      phases: {
        '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED', lockHash: 'h0' },
        '01-as-is.md': { phase: '01-as-is.md', status: 'LOCKED', lockHash: 'h1' },
        '02-to-be-plan.md': { phase: '02-to-be-plan.md', status: 'DRAFT' },
      },
      state: 'blocked',
      stateReason: 'why',
      gateBlocked: { failures: ['f'], kind: 'pre-step' },
      tampers: { '03-implementation-summary.md': { path: '03-implementation-summary.md', reason: 'hash' } },
      subagents: {
        c1: { childId: 'c1', role: 'auditor', provider: 'p', status: 'done' },
      },
      mergedToRepoRoot: '/repo',
    })
    const f = cardFacts(c)
    expect(f.lockedCount).toBe(2)
    expect(f.totalPhases).toBeGreaterThanOrEqual(f.lockedCount)
    expect(f.progress).toBe(2 / f.totalPhases)
    expect(f.tampered).toBe(true)
    expect(f.gateBlocked).toBe(true)
    expect(f.merged).toBe(true)
    expect(f.state).toBe('blocked')
    expect(f.subagents).toHaveLength(1)
    expect(f.subagents[0].childId).toBe('c1')
  })

  it('reports lock validity: tampered wins over locked', () => {
    const tampered = card({ tampers: { p: { path: 'p', reason: 'x' } }, phases: {
      '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED', lockHash: 'h' },
    } })
    expect(cardFacts(tampered).lockValidity).toBe('tampered')

    const locked = card({ phases: {
      '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED', lockHash: 'h' },
    } })
    expect(cardFacts(locked).lockValidity).toBe('in-progress') // not all groups locked yet
  })
})

describe('derive: conversation node key + inspector rows (R6/R7)', () => {
  it('keys a node by runId + worktreeRoot (never "latest unfinished")', () => {
    expect(nodeKeyOf('r1', '/w')).toBe('/w\u0000r1')
    expect(nodeKeyOf('r1', '/w')).not.toBe(nodeKeyOf('r1', '/other'))
    expect(nodeKeyOf('r1', '/w')).not.toBe(nodeKeyOf('r2', '/w'))
  })

  it('expands the inspector phase chain: always shows 3.5, expands 6/7/8', () => {
    const c = card({ phases: {
      '03.5-code-review.md': { phase: '03.5-code-review.md', status: 'LOCKED', lockHash: 'h35' },
      '06-decisions-update.md': { phase: '06-decisions-update.md', status: 'LOCKED' },
      '07-state-update.md': { phase: '07-state-update.md', status: 'DRAFT' },
      '08-memory-impact.md': { phase: '08-memory-impact.md', status: 'DRAFT' },
    } })
    const rows = expandPhaseRows(c)
    const keys = rows.map(r => r.phase)
    expect(keys).toContain('03.5')
    expect(keys).toContain('06')
    expect(keys).toContain('07')
    expect(keys).toContain('08')
    // 3.5 is present even though the card does not name 01.5
    const row35 = rows.find(r => r.phase === '03.5')
    expect(row35?.status).toBe('LOCKED')
    expect(row35?.lockHash).toBe('h35')
    // 01.5 row is omitted when absent
    expect(keys).not.toContain('01.5')
    // 6/7/8 are three distinct rows, not one merged lane
    expect(keys.filter(k => ['06', '07', '08'].includes(k))).toEqual(['06', '07', '08'])
  })

  it('includes 01.5 when the run has it', () => {
    const c = card({ phases: {
      '01.5-supplement.md': { phase: '01.5-supplement.md', status: 'LOCKED' },
    } })
    expect(expandPhaseRows(c).map(r => r.phase)).toContain('01.5')
  })
})

/**
 * T21 — the client reads the ONE derived position instead of recombining fields.
 *
 * The bug this pins was real: `allMandatoryLocked` tested only `status`, so a
 * phase that the server's fold called `invalid-lock` (LOCKED, but failing a gate
 * or a hash-independent lock condition) made this consumer report
 * `lockValidity: 'locked'`. Two consumers, two answers, one phase — which is
 * exactly what a single derived value exists to prevent.
 */
describe('derive: phase POSITION is the single source of a phase state (T21)', () => {
  const MANDATORY_FILES = [
    '00-requirements.md', '01-as-is.md', '02-to-be-plan.md', '03-implementation-summary.md',
    '03.5-code-review.md', '04-test-summary.md', '05-manual-qa.md', '06-decisions-update.md',
    '07-state-update.md', '08-memory-impact.md',
  ]

  /** Every mandatory phase LOCKED, carrying the server's derived position. */
  function allLocked(overrides: Record<string, string> = {}): RecursiveRunCard {
    const phases: Record<string, { phase: string; status: string; position?: string }> = {}
    for (const file of MANDATORY_FILES) phases[file] = { phase: file, status: 'LOCKED', position: overrides[file] ?? 'locked' }
    return card({ phases: phases as never })
  }

  it('every phase lock-valid -> locked', () => {
    expect(cardFacts(allLocked()).lockValidity).toBe('locked')
  })

  it('a LOCKED phase whose position is invalid-lock makes the card in-progress, not locked', () => {
    expect(cardFacts(allLocked({ '05-manual-qa.md': 'invalid-lock' })).lockValidity).toBe('in-progress')
  })

  it('a tampered position beats everything, even with an empty tampers map', () => {
    const c = allLocked({ '03-implementation-summary.md': 'tampered' })
    // The server has not (yet) published a tamper fact, so the map is empty: the
    // position alone must be enough, or the two consumers disagree again.
    expect(c.tampers).toEqual({})
    expect(cardFacts(c).lockValidity).toBe('tampered')
  })

  it('falls back to `status` for a row produced before position existed', () => {
    const phases: Record<string, { phase: string; status: string }> = {}
    for (const file of MANDATORY_FILES) phases[file] = { phase: file, status: 'LOCKED' }
    expect(cardFacts(card({ phases: phases as never })).lockValidity).toBe('locked')
  })

  /**
   * ⚠ A SKIP IS SETTLED, NOT LOCKED, AND THE BOARD MUST NOT SHOW IT AS FINISHED. The server's fold
   * reports a deliberately skipped phase as position `skipped` with `lockValid: false` (see
   * `src/skip.ts`), and this consumer derives run-level validity from that single position — so a run
   * that skipped a required phase must still read `in-progress`. This is the cheap safeguard against
   * the obvious abuse of the skip mechanism: a run cannot look complete by marking its way there.
   */
  it('a SKIPPED required phase keeps the card in-progress — a skip is settled, never approved', () => {
    expect(cardFacts(allLocked({ '05-manual-qa.md': 'skipped' })).lockValidity).toBe('in-progress')
  })
})
