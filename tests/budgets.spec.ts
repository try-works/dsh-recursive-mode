/**
 * T28 — budgets: every unbounded loop and every unbounded result gets a named,
 * configurable cap.
 *
 * WHAT WAS UNBOUNDED, measured rather than assumed: `auditToPass` had only
 * `maxRounds ?? 3`, `delegateReview` hardcoded `maxDepth ?? 2` at TWO call sites, and
 * nothing else was bounded at all. Two of the five caps below already had partial
 * neighbours, and the difference matters:
 *   - `maxRepairAttempts` is NOT T20's no-progress bound. T20 stops a loop that
 *     REPEATS a finding; this bounds how many repairs a phase may be asked for even
 *     when every one of them finds something genuinely new, which is the case a
 *     no-progress bound deliberately lets run.
 *   - `maxResultBytes` is NOT T24's cap. T24 bounds the NUMBER of findings
 *     (`MAX_FINDINGS_FULL = 200`); a byte cap bounds a result whose findings are few
 *     but enormous. Both are needed: a count cap cannot see size, and a byte cap
 *     cannot see count.
 *
 * THE RULE THAT MAKES BUDGETS MEANINGFUL: a child may NARROW a budget, never widen
 * it. A delegation starting from a parent already at depth D gets whatever is left
 * (`maxDelegationDepth - D`), not the configured maximum again — otherwise the
 * recursion budget resets at every level and bounds nothing.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_ENFORCEMENT,
  resolveEnforcementConfig,
  type EnforcementConfig,
} from '../src/enforcement.ts'
import { auditToPass, type AuditRoundOutcome, type TeamRuntimeLike, type TeamTaskViewLike } from '../src/teams-loop.ts'
import { remainingDepthFor } from '../src/delegation.ts'
import { capPayloadBytes, payloadBytes, type ElisionMeta } from '../src/result-cap.ts'
import { countOperations, recordOperation } from '../src/identity.ts'

function makeTask(id: string, revision: number, status: TeamTaskViewLike['status'] = 'pending'): TeamTaskViewLike {
  return {
    id, revision, subject: 's', description: 'd', status,
    blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
  }
}

function fakeTeam(script: Array<AuditRoundOutcome | Error>) {
  const task = makeTask('task-a', 1)
  let revision = 1
  let roundIndex = 0
  const runtime: TeamRuntimeLike = {
    createTask: async () => ({ ...task, revision }),
    updateTask: async (_caller, request) => {
      revision += 1
      const next = { ...task, revision }
      if (request.action === 'claim') next.status = 'in_progress'
      if (request.action === 'release') next.status = 'pending'
      if (request.action === 'complete') next.status = 'completed'
      if (request.action === 'edit') next.status = 'in_progress'
      return next
    },
    waitForChange: async () => ({ timedOut: false }),
    interrupt: () => ({ previousStatus: 'running' }),
  }
  return {
    runtime,
    runAuditRound: async (): Promise<AuditRoundOutcome> => {
      const next = script[roundIndex] ?? script[script.length - 1]
      roundIndex += 1
      if (next instanceof Error) throw next
      return next as AuditRoundOutcome
    },
  }
}

/** Always-new findings: progress every round, so only a REPAIR budget can stop it. */
function alwaysNew(count: number): AuditRoundOutcome[] {
  return Array.from({ length: count }, (_, i) => ({
    verdict: 'REVISE' as const, accepted: false, repair: 'Address the findings: n' + i,
  }))
}

describe('T28 — the budget block is part of the config and is validated', () => {
  it('ships defaults for every cap, so no cap is left implicit', () => {
    const budgets = DEFAULT_ENFORCEMENT.budgets
    expect(budgets.maxAuditRounds).toBeGreaterThan(0)
    expect(budgets.maxRepairAttempts).toBeGreaterThan(0)
    expect(budgets.maxDelegationDepth).toBeGreaterThan(0)
    expect(budgets.maxChildrenPerPhase).toBeGreaterThan(0)
    expect(budgets.maxResultBytes).toBeGreaterThan(0)
  })

  it('accepts a partial override and keeps the rest of the defaults', () => {
    const config = resolveEnforcementConfig({ budgets: { maxAuditRounds: 7 } })
    expect(config.budgets.maxAuditRounds).toBe(7)
    expect(config.budgets.maxDelegationDepth).toBe(DEFAULT_ENFORCEMENT.budgets.maxDelegationDepth)
  })

  it('REJECTS a non-positive or non-integer cap rather than silently accepting it', () => {
    // A budget of 0 or -1 would mean "never" or "already exceeded" — neither is a
    // budget, and both would brick a phase. Fail loud at config time.
    expect(() => resolveEnforcementConfig({ budgets: { maxAuditRounds: 0 } })).toThrow(/maxAuditRounds/)
    expect(() => resolveEnforcementConfig({ budgets: { maxDelegationDepth: -1 } })).toThrow(/maxDelegationDepth/)
    expect(() => resolveEnforcementConfig({ budgets: { maxResultBytes: 1.5 } })).toThrow(/maxResultBytes/)
  })

  it('still rejects an unknown key, including inside budgets', () => {
    expect(() => resolveEnforcementConfig({ nope: 1 })).toThrow(/unknown key/)
    expect(() => resolveEnforcementConfig({ budgets: { nope: 1 } })).toThrow(/budgets/)
  })
})

describe('T28 — the audit loop honours its two bounds', () => {
  it('maxAuditRounds caps an always-progressing loop', async () => {
    const fake = fakeTeam(alwaysNew(12))
    const result = await auditToPass({
      teams: fake.runtime, caller: { id: 'lead' }, runId: 'r', phase: '03',
      runAuditRound: fake.runAuditRound, lockPhase: async () => {},
      budgets: { maxAuditRounds: 4, maxRepairAttempts: 99 },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('max rounds')
    expect(result.rounds.length).toBeLessThanOrEqual(5)
  })

  it('maxRepairAttempts stops a loop that keeps making progress', async () => {
    // Every round finds something NEW, so T20's no-progress bound never fires — this
    // is exactly the case a repair budget exists for.
    const fake = fakeTeam(alwaysNew(12))
    const result = await auditToPass({
      teams: fake.runtime, caller: { id: 'lead' }, runId: 'r', phase: '03',
      runAuditRound: fake.runAuditRound, lockPhase: async () => {},
      budgets: { maxAuditRounds: 99, maxRepairAttempts: 2 },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('repair')
    expect(result.repairAttempts).toBe(2)
    // It stopped on the REPAIR budget, not on the round cap.
    expect(result.rounds.length).toBeLessThan(99)
  })

  it('an APPROVE before either bound is reached still wins', async () => {
    const fake = fakeTeam([{ verdict: 'REVISE', accepted: false, repair: 'x' }, { verdict: 'APPROVE', accepted: true }])
    const result = await auditToPass({
      teams: fake.runtime, caller: { id: 'lead' }, runId: 'r', phase: '03',
      runAuditRound: fake.runAuditRound, lockPhase: async () => {},
      budgets: { maxAuditRounds: 99, maxRepairAttempts: 99 },
    })
    expect(result.ok).toBe(true)
    expect(result.locked).toBe(true)
  })
})

describe('T28 — a child may NARROW a budget, never widen it', () => {
  it('reports the remaining depth from a parent already partway down', () => {
    // The configured maximum is a ceiling for the WHOLE recursion, not a fresh
    // allowance at every level: otherwise a bound of 3 permits 3^depth children.
    expect(remainingDepthFor({ maxDelegationDepth: 3 }, 0)).toBe(3)
    expect(remainingDepthFor({ maxDelegationDepth: 3 }, 2)).toBe(1)
    expect(remainingDepthFor({ maxDelegationDepth: 3 }, 3)).toBe(0)
  })

  it('NEVER returns a negative remaining depth for a parent already past the cap', () => {
    // A parent deeper than the configured cap (a config tightened after the fact)
    // must yield 0 — "delegate no further" — not a negative number that would be
    // read as permission somewhere downstream.
    expect(remainingDepthFor({ maxDelegationDepth: 2 }, 5)).toBe(0)
  })

  it('a NARROWER request from the caller is respected over the remaining budget', () => {
    // min(remaining, requested): the caller may ask for less, never for more.
    expect(remainingDepthFor({ maxDelegationDepth: 5 }, 0, 2)).toBe(2)
    expect(remainingDepthFor({ maxDelegationDepth: 5 }, 4, 9)).toBe(1)
  })
})

describe('T28 — the budgets reach the enforcement config the plugin ships', () => {
  it('a config parsed from disk carries the budgets, so the caps are configurable', () => {
    const parsed: EnforcementConfig = resolveEnforcementConfig({ budgets: { maxChildrenPerPhase: 1, maxResultBytes: 4096 } })
    expect(parsed.budgets.maxChildrenPerPhase).toBe(1)
    expect(parsed.budgets.maxResultBytes).toBe(4096)
    // The pre-existing config keys are untouched by the addition.
    expect(parsed.toolGuards).toBe(DEFAULT_ENFORCEMENT.toolGuards)
    expect(parsed.preStep).toBe(DEFAULT_ENFORCEMENT.preStep)
  })
})

describe('T28 — the BYTE budget, which a count cap cannot do', () => {
  function payload(errors: string[], warnings: string[] = []) {
    return { errors, warnings, elided: [] as ElisionMeta[] }
  }

  it('leaves a payload within budget completely alone', () => {
    const small = payload(['one issue'])
    const capped = capPayloadBytes(small, 65_536)
    expect(capped).toBe(small)
    expect(capped.elided).toEqual([])
  })

  it('trims an oversized payload and REPORTS the trim', () => {
    // FEW findings, each enormous: T24's count cap would pass this untouched.
    const big = payload(Array.from({ length: 4 }, (_, i) => 'e' + i + ':' + 'x'.repeat(20_000)))
    const capped = capPayloadBytes(big, 8_192)
    expect(payloadBytes(capped)).toBeLessThanOrEqual(8_192)
    expect(capped.elided.length).toBeGreaterThan(0)
    expect(capped.elided[0].kind).toBe('errors')
    expect(capped.elided[0].hint).toContain('maxResultBytes')
    // The trim is honest about how much it dropped.
    expect(capped.elided[0].omitted).toBeGreaterThan(0)
    expect(capped.elided[0].total).toBe(4)
  })

  it('trims the LONGER list, so one huge list cannot hide behind a short one', () => {
    const mixed = payload(['short'], Array.from({ length: 8 }, () => 'w'.repeat(5_000)))
    const capped = capPayloadBytes(mixed, 8_192)
    expect(payloadBytes(capped)).toBeLessThanOrEqual(8_192)
    expect(capped.elided[0].kind).toBe('warnings')
    // The short list is untouched — only what had to go, went.
    expect(capped.errors).toEqual(['short'])
  })

  it('reports honestly even when it cannot fit, rather than deleting fields', () => {
    // An empty pair of lists still over budget (huge other fields) is returned as-is:
    // dropping fields the caller needs would be worse than an oversize result.
    const odd = { errors: [] as string[], warnings: [] as string[], elided: [] as never[], note: 'x'.repeat(20_000) }
    const capped = capPayloadBytes(odd, 1_000)
    expect(capped.note).toHaveLength(20_000)
    expect(capped.elided).toEqual([])
  })
})

describe('T28 — the children budget is counted from the operation index', () => {
  it('counts DISTINCT operations per phase, so a resumed turn is not a new child', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-budget-count-'))
    try {
      // The same operation recorded three times: one child, three records.
      recordOperation(dir, { id: 'a'.repeat(32), act: 'delegate-review', at: 't1', phase: '03' })
      recordOperation(dir, { id: 'a'.repeat(32), act: 'delegate-review', at: 't2', phase: '03' })
      recordOperation(dir, { id: 'a'.repeat(32), act: 'delegate-review', at: 't3', phase: '03' })
      expect(countOperations(dir, 'delegate-review', '03')).toBe(1)

      // A repaired artifact changes the body, hence the id: a genuinely new child.
      recordOperation(dir, { id: 'b'.repeat(32), act: 'delegate-review', at: 't4', phase: '03' })
      expect(countOperations(dir, 'delegate-review', '03')).toBe(2)

      // Another phase is counted separately, and another act is not counted at all.
      recordOperation(dir, { id: 'c'.repeat(32), act: 'delegate-review', at: 't5', phase: '04' })
      recordOperation(dir, { id: 'd'.repeat(32), act: 'reopen', at: 't6', phase: '03' })
      expect(countOperations(dir, 'delegate-review', '03')).toBe(2)
      expect(countOperations(dir, 'delegate-review', '04')).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
