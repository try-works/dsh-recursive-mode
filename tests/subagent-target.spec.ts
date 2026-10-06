/**
 * FU-19 step 2 — THE PRECEDENCE LADDER, AND THE PROVENANCE OF EVERY VALUE.
 *
 * The question this answers is the one a user actually asks: "why did this child run on that model?" So each
 * level is exercised on its own, and each result is asserted to NAME the level that produced it. The floor — no
 * model anywhere — resolves to null, which means INHERIT, not "no model": the plugin sends no agentOptions.model
 * and the child keeps the session default.
 */
import { describe, expect, it } from 'vitest'
import { resolveSubagentTarget } from '../src/role-route.ts'
import { loadRouterPolicy, type RouterPolicy } from '../src/router.ts'

const policy = (over: Partial<RouterPolicy>): RouterPolicy => ({ ...loadRouterPolicy(), ...over })

describe('FU-19: which provider and model a child gets, and who chose', () => {
  it('THE FLOOR: nothing configured anywhere means provider from the ladder and an INHERITED model', () => {
    const target = resolveSubagentTarget({ role: 'analyst', phase: '03', policy: policy({}), ladderProvider: 'spawn' })
    expect(target.provider, 'a child cannot exist without a provider').toBe('spawn')
    expect(target.chosen.provider).toBe('ladder')
    expect(target.model, 'null means INHERIT - no agentOptions.model is sent').toBeNull()
    expect(target.chosen.model).toBe('inherit')
    expect(target.reason).toContain('inherits the session default')
  })

  it('GENERAL default supplies both, and says so', () => {
    const target = resolveSubagentTarget({
      role: 'analyst',
      phase: '03',
      policy: policy({ defaults: { ...loadRouterPolicy().defaults, subagent: { provider: 'fork', model: 'cheap' } } }),
      ladderProvider: 'spawn',
    })
    expect(target.provider).toBe('fork')
    expect(target.model).toBe('cheap')
    expect(target.chosen).toEqual({ provider: 'general', model: 'general' })
    expect(target.reason).toContain('the general subagent default')
  })

  it('ROLE route beats the general default, per value rather than wholesale', () => {
    const base = loadRouterPolicy().defaults
    const target = resolveSubagentTarget({
      role: 'code-reviewer',
      phase: '03.5',
      policy: policy({
        defaults: { ...base, subagent: { provider: 'fork', model: 'cheap' } },
        role_routes: { 'code-reviewer': { enabled: true, mode: 'native', cli: null, model: 'rigorous', fallback: 'self-audit' } },
      }),
      ladderProvider: 'spawn',
    })
    expect(target.model, 'the role route wins for the model').toBe('rigorous')
    expect(target.chosen.model).toBe('role')
    expect(target.provider, 'and the general default still supplies the provider it alone names').toBe('fork')
    expect(target.chosen.provider).toBe('general')
  })

  it('PHASE override beats the role route, and can also name the role', () => {
    const base = loadRouterPolicy().defaults
    const target = resolveSubagentTarget({
      role: 'code-reviewer',
      phase: '08',
      policy: policy({
        defaults: { ...base, subagent: { provider: 'fork', model: 'cheap' } },
        role_routes: { 'code-reviewer': { enabled: true, mode: 'native', cli: null, model: 'rigorous', fallback: 'self-audit' } },
        phase_routes: { '08': { role: 'memory-auditor', provider: 'spawn', model: 'strong' } },
      }),
      ladderProvider: 'spawn',
    })
    expect(target.model).toBe('strong')
    expect(target.chosen.model).toBe('phase')
    expect(target.provider).toBe('spawn')
    expect(target.chosen.provider).toBe('phase')
    expect(target.reason).toContain('the phase 08 override')
  })

  it('PER-CALL override beats everything, which is what "on demand" means', () => {
    const base = loadRouterPolicy().defaults
    const target = resolveSubagentTarget({
      role: 'code-reviewer',
      phase: '08',
      policy: policy({
        defaults: { ...base, subagent: { provider: 'fork', model: 'cheap' } },
        role_routes: { 'code-reviewer': { enabled: true, mode: 'native', cli: null, model: 'rigorous', fallback: 'self-audit' } },
        phase_routes: { '08': { provider: 'spawn', model: 'strong' } },
      }),
      override: { provider: 'fork', model: 'one-off' },
      ladderProvider: 'spawn',
    })
    expect(target.provider).toBe('fork')
    expect(target.model).toBe('one-off')
    expect(target.chosen).toEqual({ provider: 'per-call', model: 'per-call' })
    expect(target.reason).toContain('this call')
  })

  it('an empty string is not a choice: it defers rather than clearing', () => {
    const base = loadRouterPolicy().defaults
    const target = resolveSubagentTarget({
      role: 'analyst',
      policy: policy({ defaults: { ...base, subagent: { provider: 'fork', model: 'cheap' } } }),
      override: { provider: '   ', model: '' },
      ladderProvider: 'spawn',
    })
    expect(target.provider, 'blank defers to the general default').toBe('fork')
    expect(target.model).toBe('cheap')
    expect(target.chosen).toEqual({ provider: 'general', model: 'general' })
  })

  it('no provider anywhere is reported as such rather than invented', () => {
    const target = resolveSubagentTarget({ role: 'analyst', policy: policy({}) })
    expect(target.provider).toBeNull()
    expect(target.reason).toContain('no provider was resolved')
  })
})
