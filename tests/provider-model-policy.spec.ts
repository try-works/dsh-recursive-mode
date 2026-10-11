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
import { loadRouterPolicy, resolveRole, type RouterPolicyOverrides } from '../src/router.ts'
import { Config } from '../src/config.ts'

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

/**
 * ⚠ FU-20 — THE SETTINGS HALF OF "the user should be able to configure subagent per phase or role".
 *
 * The policy FILE could already carry these levels; what a user cannot do is edit a JSON file inside a run, which
 * is why the directive asks for a SETTING. The seam is the plugin's Config schema, and the property this spec
 * pins is the one that makes the seam work WITHOUT a line changing in `src/index.ts`: that file forwards the
 * plugin's whole `router` config section to `setRouterOverrides` (`index.ts:362`), so a field DECLARED on the
 * schema arrives at `loadRouterPolicy` by construction.
 *
 * ⚠ AND THE NEGATIVE PROPERTY IS THE IMPORTANT ONE, as it was for T7: an untouched settings namespace must not
 * shadow the workspace file. A settings form projects an untouched object as `{}`, which is a VALUE — merging it
 * literally would overwrite a configured route with nothing. The first version of this change did exactly that
 * and `settings-config.spec.ts` caught it, so it is pinned here at the new fields.
 */
describe('FU-20: the settings namespace reaches the router policy, and an untouched one does not', () => {
  let root = ''
  const write = (policy: unknown): void => {
    mkdirSync(join(root, '.recursive', 'config'), { recursive: true })
    writeFileSync(join(root, '.recursive', 'config', 'recursive-router.json'), JSON.stringify(policy), 'utf8')
  }
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rm-fu20s-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('the schema DECLARES the per-role, per-phase and general levels', () => {
    const filled = Config({}) as { router?: { roles?: unknown; phases?: unknown; subagent?: unknown; defaults?: Record<string, unknown> } }
    expect(filled.router?.roles, 'a dict, so a role can be named without restating the file').toBeDefined()
    expect(filled.router?.phases).toBeDefined()
    expect(filled.router?.subagent).toBeDefined()
  })

  it('⚠ an untouched namespace leaves `router.defaults` with NO present field — it must not shadow the file', () => {
    // `subagent` is deliberately a SIBLING of `defaults` rather than a key inside it: a nested object always
    // materializes as `{}`, and a present field is an override. This assertion is the reason for that shape.
    const filled = Config({}) as { router?: { defaults?: Record<string, unknown> } }
    const present = Object.entries(filled.router?.defaults ?? {}).filter(([, value]) => value !== undefined)
    expect(present).toEqual([])
  })

  it('the schema’s own projection of an empty namespace cannot erase a configured route', () => {
    write({
      version: 1,
      defaults: { subagent: { provider: 'fork', model: 'cheap' } },
      role_routes: { analyst: { enabled: true, mode: 'native', cli: null, model: 'keep-me', fallback: 'self-audit' } },
      phase_routes: { '08': { model: 'keep-this-too' } },
    })
    const filled = Config({}) as unknown as { router: RouterPolicyOverrides }
    const policy = loadRouterPolicy(join(root, '.recursive', 'config', 'recursive-router.json'), filled.router)
    expect(policy.role_routes.analyst?.model).toBe('keep-me')
    expect(policy.phase_routes?.['08']?.model).toBe('keep-this-too')
    expect(policy.defaults.subagent).toEqual({ provider: 'fork', model: 'cheap' })
  })

  it('a settings edit SETS a role’s model, and the decision reports that level as the one that chose it', () => {
    write({ version: 1, role_routes: { analyst: { enabled: true, mode: 'native', cli: null, model: null, fallback: 'self-audit' } } })
    const filled = Config({ router: { roles: { analyst: { model: 'from-settings', modelProvider: 'deepseek-official' } } } }) as {
      router: { roles: Record<string, { model?: string }> }
    }
    const policy = loadRouterPolicy(join(root, '.recursive', 'config', 'recursive-router.json'), filled.router as never)
    expect(policy.role_routes.analyst?.model).toBe('from-settings')
    expect(policy.role_routes.analyst?.modelProvider).toBe('deepseek-official')
    const decision = resolveRole('analyst', policy, { spawn: { name: 'spawn' } })
    expect(decision.model).toBe('from-settings')
    expect(decision.chosen?.model).toBe('role')
  })

  it('a PHASE setting wins over the role setting — the stated precedence, through the settings path', () => {
    write({
      version: 1,
      role_routes: { analyst: { enabled: true, mode: 'native', cli: null, model: 'role-level', fallback: 'self-audit' } },
    })
    const filled = Config({ router: { phases: { '3.5': { model: 'phase-level' } } } }) as {
      router: { phases: Record<string, { model?: string }> }
    }
    const policy = loadRouterPolicy(join(root, '.recursive', 'config', 'recursive-router.json'), filled.router as never)
    const decision = resolveRole('analyst', policy, { spawn: { name: 'spawn' } }, { phase: '3.5' })
    expect(decision.model).toBe('phase-level')
    expect(decision.chosen?.model).toBe('phase')
  })
})

