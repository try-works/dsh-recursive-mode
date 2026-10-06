/**
 * FU-19 step 1 — THE POLICY SCHEMA, and the tolerance that makes it usable.
 *
 * The whole point of the three levels is that a user can set one without setting the others, so the parser must
 * distinguish "defer to the next level" from "explicitly cleared". These tests pin that distinction at the parse
 * boundary, because a default that fills every field is exactly how a configured value gets silently shadowed.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRouterPolicy, resolveRole } from '../src/router.ts'

describe('FU-19: the provider/model selection schema', () => {
  let root = ''
  const write = (policy: unknown): void => {
    mkdirSync(join(root, '.recursive', 'config'), { recursive: true })
    writeFileSync(join(root, '.recursive', 'config', 'recursive-router.json'), JSON.stringify(policy), 'utf8')
  }
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rm-fu19-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('a policy that names nothing keeps every new field ABSENT rather than filling it in', () => {
    write({ version: 1, role_routes: { analyst: { enabled: true, mode: 'native', cli: null, model: null, fallback: 'self-audit' } } })
    const policy = loadRouterPolicy(join(root, '.recursive', 'config', 'recursive-router.json'))
    expect(policy.defaults.subagent, 'no general default was configured').toBeUndefined()
    expect(policy.phase_routes, 'and no phase overrides either').toBeUndefined()
    expect(policy.role_routes.analyst?.provider, 'nor a per-role provider').toBeUndefined()
  })

  it('carries all three levels through when the file declares them', () => {
    write({
      version: 1,
      defaults: { subagent: { provider: 'spawn', model: 'cheap-model' } },
      phase_routes: { '08': { role: 'memory-auditor', model: 'strong-model' } },
      role_routes: { analyst: { enabled: true, mode: 'native', cli: null, model: 'role-model', provider: 'fork', fallback: 'self-audit' } },
    })
    const policy = loadRouterPolicy(join(root, '.recursive', 'config', 'recursive-router.json'))
    expect(policy.defaults.subagent).toEqual({ provider: 'spawn', model: 'cheap-model' })
    expect(policy.phase_routes?.['08']).toEqual({ role: 'memory-auditor', model: 'strong-model' })
    expect(policy.role_routes.analyst?.provider).toBe('fork')
    expect(policy.role_routes.analyst?.model).toBe('role-model')
  })

  it('an invalid file still yields the built-in default policy and never throws', () => {
    mkdirSync(join(root, '.recursive', 'config'), { recursive: true })
    writeFileSync(join(root, '.recursive', 'config', 'recursive-router.json'), '{ not json', 'utf8')
    const policy = loadRouterPolicy(join(root, '.recursive', 'config', 'recursive-router.json'))
    expect(policy.role_routes).toEqual({})
    expect(policy.defaults.subagent).toBeUndefined()
  })

  it('an UNCONFIGURED role still degrades to self-audit, and says which — the ladder floor, unchanged', () => {
    // My first version of this asserted `native` here and failed, and the code was right: the built-in policy has
    // NO role routes, so resolveRole returns self-audit with "role analyst is unconfigured or disabled". That is
    // the behaviour FU-19 must preserve — a new level of selection must not quietly turn an unconfigured role
    // into a live provider.
    const decision = resolveRole('analyst', loadRouterPolicy(), { spawn: { name: 'spawn' } })
    expect(decision.tier).toBe('self-audit')
    expect(decision.reason).toContain('unconfigured')
  })

  it('an ENABLED role with a registered provider still resolves to native, so nothing regressed at the seam', () => {
    write({ version: 1, role_routes: { analyst: { enabled: true, mode: 'native', cli: null, model: 'role-model', fallback: 'self-audit' } } })
    const policy = loadRouterPolicy(join(root, '.recursive', 'config', 'recursive-router.json'))
    const decision = resolveRole('analyst', policy, { spawn: { name: 'spawn' } })
    expect(decision.tier).toBe('native')
    expect(decision.provider).toBe('spawn')
    expect(decision.model).toBe('role-model')
  })
})
