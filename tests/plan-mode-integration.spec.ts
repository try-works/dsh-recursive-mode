/**
 * T13 — planMode for phases 0-2 and the gate out of them.
 *
 * The central risk this module exists to remove is a SILENT one: the codebase names a phase
 * three ways, and a mapping that understood only one form would answer `false` for the others
 * — turning the non-mutating guarantee OFF for exactly the phases that need it, with no error
 * anywhere. So every form is pinned to the same answer, in both directions.
 *
 * The second property is a deliberate refusal: an unrecognised phase is NOT asserted to be
 * plan-gated, because guessing about the one guarantee this module provides is worse than
 * answering "no".
 */
import { describe, it, expect } from 'vitest'
import {
  phaseIndexOf, phaseUsesPlanMode, planGateRequired, describePlanMode, IMPLEMENTATION_PHASE_INDEX,
} from '../src/plan-gate.ts'

describe('T13 — the phase index is read from every form this codebase uses', () => {
  it('reads the bare number, the zero-padded number, and the artifact filename alike', () => {
    // The trap: understanding only one form silently disables plan mode for the rest.
    expect(phaseIndexOf('2')).toBe(2)
    expect(phaseIndexOf('02')).toBe(2)
    expect(phaseIndexOf('02-to-be-plan.md')).toBe(2)
    expect(phaseIndexOf('00-requirements.md')).toBe(0)
    expect(phaseIndexOf('01-as-is.md')).toBe(1)
  })

  it('keeps a fractional sub-phase at its position between the whole phases', () => {
    // 01.5-root-cause sits inside discovery, and the range comparison must see that.
    expect(phaseIndexOf('01.5-root-cause.md')).toBe(1.5)
  })

  it('tolerates surrounding whitespace, because tool arguments arrive as typed', () => {
    expect(phaseIndexOf('  3 ')).toBe(3)
  })

  it('answers null for something that names no phase', () => {
    expect(phaseIndexOf('')).toBeNull()
    expect(phaseIndexOf('implementation')).toBeNull()
    expect(phaseIndexOf('-1')).toBeNull()
  })
})

describe('T13 — the discovery phases are non-mutating', () => {
  it('includes requirements, AS-IS, root cause and TO-BE plan', () => {
    for (const phase of ['0', '00', '00-requirements.md', '1', '01-as-is.md', '01.5-root-cause.md', '2', '02-to-be-plan.md']) {
      expect(phaseUsesPlanMode(phase)).toBe(true)
    }
  })

  it('excludes implementation and everything after it', () => {
    for (const phase of ['3', '03', '03-implementation-summary.md', '03.5-code-review.md', '4', '08-memory.md']) {
      expect(phaseUsesPlanMode(phase)).toBe(false)
    }
  })

  it('does NOT assert plan mode for a phase it cannot identify', () => {
    // The safe reading of "I do not know what this is" is "do not claim a mode about it".
    expect(phaseUsesPlanMode('nonsense')).toBe(false)
    expect(phaseUsesPlanMode('')).toBe(false)
  })
})

describe('T13 — the plan gate is on the DESTINATION, not the distance', () => {
  it('gates every way out of discovery', () => {
    expect(planGateRequired('02-to-be-plan.md', '03-implementation-summary.md')).toBe(true)
    expect(planGateRequired('2', '3')).toBe(true)
    // Skipping ahead does not make the plan less necessary.
    expect(planGateRequired('02', '04')).toBe(true)
    expect(planGateRequired('00-requirements.md', '03-implementation-summary.md')).toBe(true)
  })

  it('does not gate movement INSIDE discovery', () => {
    expect(planGateRequired('00-requirements.md', '01-as-is.md')).toBe(false)
    expect(planGateRequired('01-as-is.md', '02-to-be-plan.md')).toBe(false)
    expect(planGateRequired('0', '2')).toBe(false)
  })

  it('does not gate a transition that starts after the boundary — the plan was already required', () => {
    expect(planGateRequired('03-implementation-summary.md', '04-test-summary.md')).toBe(false)
  })

  it('does not gate a destination it cannot identify', () => {
    expect(planGateRequired('02', 'nonsense')).toBe(false)
  })
})

describe('T13 — the boundary is stated once, so it cannot drift between callers', () => {
  it('names implementation as the exclusive bound', () => {
    expect(IMPLEMENTATION_PHASE_INDEX).toBe(3)
    expect(phaseUsesPlanMode('2.9')).toBe(true)
    expect(phaseUsesPlanMode('3')).toBe(false)
  })

  it('describes the phase for a rules section, in each of the three situations', () => {
    expect(describePlanMode('02-to-be-plan.md')).toContain('NON-MUTATING')
    expect(describePlanMode('03-implementation-summary.md')).toContain('past discovery')
    expect(describePlanMode('nonsense')).toContain('not a recognised phase')
  })
})
