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
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as plugin from '../src/index.ts'
import {
  phaseIndexOf, phaseUsesPlanMode, planGateRequired, describePlanMode, planGateForExit,
  IMPLEMENTATION_PHASE_INDEX,
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

/**
 * T13 part 2 — the gate is LIVE, keyed on the phase the run is ALREADY waiting on.
 *
 * That input is what makes the gate unable to drift: it keeps no state of its own, so it cannot
 * disagree with the workflow about where the run is.
 */
describe('T13 — whether exit_plan_mode may open, given the pending phase', () => {
  it('REFUSES while the run is still waiting on a discovery phase, and says why', () => {
    for (const pending of ['00-requirements.md', '01-as-is.md', '01.5-root-cause.md', '02-to-be-plan.md']) {
      const gate = planGateForExit(pending)
      expect(gate.allow).toBe(false)
      expect(gate.reason).toContain('plan gate')
      expect(gate.reason).toContain(pending)
    }
  })

  it('OPENS once discovery is done — the gate is 02 -> 03', () => {
    const gate = planGateForExit('03-implementation-summary.md')
    expect(gate.allow).toBe(true)
    expect(gate.reason).toContain('discovery is complete')
  })

  it('allows an exit when NOTHING is pending, with a reason that says which case it is', () => {
    // "Nothing pending" is not "discovery is done"; refusing forever on a completed run would
    // make plan mode a trap rather than a gate, so the reason distinguishes the two.
    const gate = planGateForExit(null)
    expect(gate.allow).toBe(true)
    expect(gate.reason).toContain('no phase is pending')
  })

  it('claims nothing about a pending phase it cannot identify', () => {
    const gate = planGateForExit('not-a-phase')
    expect(gate.allow).toBe(true)
    expect(gate.reason).toContain('not a recognised phase')
  })
})

describe('T13 — the gate runs on the live chain, and only for exit_plan_mode', () => {
  async function mountWithRun() {
    const repo = mkdtempSync(join(tmpdir(), 'rm-t13-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin as never, { repoRoot: repo } as never)
    await ctx.recursive.initRun('r1')
    return {
      ctx,
      repo,
      dispose: async () => {
        await ctx.fiber.dispose()
        rmSync(repo, { recursive: true, force: true })
      },
    }
  }

  it('is registered on pre_trigger as a built-in', async () => {
    const m = await mountWithRun()
    try {
      const names = m.ctx.recursive.hooks.list('pre_trigger').map((entry) => entry.name)
      expect(names).toContain('exit-plan-mode-gate')
    } finally {
      await m.dispose()
    }
  })

  it('DENIES exit_plan_mode on a run that is still in discovery', async () => {
    const m = await mountWithRun()
    try {
      // A fresh run is waiting on 00-requirements.md, so the plan is not finished.
      const result = await m.ctx.recursive.hooks.run('pre_trigger', {
        tool: 'exit_plan_mode', args: {}, exec: { name: 'exit_plan_mode', arguments: {} },
        root: m.repo, runId: 'r1',
      })
      expect(result.decision).toBe('deny')
      expect(result.reason).toContain('plan gate')
    } finally {
      await m.dispose()
    }
  })

  it('does not interfere with any OTHER tool', async () => {
    const m = await mountWithRun()
    try {
      const result = await m.ctx.recursive.hooks.run('pre_trigger', {
        tool: 'recursive_status', args: {}, exec: { name: 'recursive_status', arguments: {} },
        root: m.repo, runId: 'r1',
      })
      // The gate annotates nothing and denies nothing for a tool that is not the exit event.
      const gateRecord = result.ran.find((entry) => entry.name === 'exit-plan-mode-gate')
      expect(gateRecord?.decision).toBe('continue')
    } finally {
      await m.dispose()
    }
  })
})
