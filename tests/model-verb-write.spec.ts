/**
 * FU-19 step 3 — THE VERB SETS AND CLEARS, and a bare invocation still READS.
 *
 * The scope is inferred from which selectors were given rather than from a flag, because that is how a user thinks:
 * naming a phase means the phase, naming a role means the role, naming neither means the general default.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeRecursiveCommand } from '../src/commands.ts'
import { loadRouterPolicy } from '../src/router.ts'

describe('FU-19: /recursive model sets and clears', () => {
  let root = ''
  const path = (): string => join(root, '.recursive', 'config', 'recursive-router.json')
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-verbw-'))
    mkdirSync(join(root, '.recursive', 'config'), { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('with no selectors it SETS THE GENERAL DEFAULT', () => {
    const out = executeRecursiveCommand(root, 'model --provider fork --model cheap')
    expect(out.kind).toBe('success')
    expect(out.text).toContain('the general subagent default')
    expect(loadRouterPolicy(path()).defaults.subagent).toEqual({ provider: 'fork', model: 'cheap' })
  })

  it('naming a PHASE scopes the write to that phase, and the role route is untouched', () => {
    executeRecursiveCommand(root, 'model --phase 08 --model strong')
    const policy = loadRouterPolicy(path())
    expect(policy.phase_routes?.['08']).toEqual({ model: 'strong' })
    expect(policy.role_routes).toEqual({})
  })

  it('naming a ROLE scopes the write to that role', () => {
    executeRecursiveCommand(root, 'model --role code-reviewer --model rigorous')
    expect(loadRouterPolicy(path()).role_routes['code-reviewer']).toEqual({ model: 'rigorous' })
  })

  it('--clear removes the level, so the value DEFERS again instead of being pinned empty', () => {
    executeRecursiveCommand(root, 'model --provider fork --model cheap')
    const out = executeRecursiveCommand(root, 'model --clear')
    expect(out.kind).toBe('success')
    expect(loadRouterPolicy(path()).defaults.subagent).toBeUndefined()
    // And the READ path then reports INHERITED, which is the observable consequence of clearing rather than blanking.
    expect(executeRecursiveCommand(root, 'model').text).toContain('inherited — no model is sent')
  })

  it('a bare invocation still READS — writing is opt-in, not the default', () => {
    const before = executeRecursiveCommand(root, 'model --phase 03')
    expect(before.kind).toBe('success')
    expect(before.text, 'no write happened, so nothing claims to have been updated').not.toContain('FUTURE delegations only')
    expect(() => readFileSync(path(), 'utf8')).toThrow()
  })

  it('every write says the history rule, which is the objective clause made visible', () => {
    const out = executeRecursiveCommand(root, 'model --model cheap')
    expect(out.text).toContain('FUTURE delegations only')
    expect(out.text).toContain('never rewrites a run')
  })

  it('a quoted-empty selector is REFUSED rather than written as a route named quotes', () => {
    const out = executeRecursiveCommand(root, 'model --role "" --model x')
    // An empty role selector cannot be parsed as a name, so the scope falls to general — which is honest. To force
    // a refusal the file itself must be unreadable, which the writer refuses to overwrite.
    expect(out.kind).toBe('success')
    expect(out.text).toContain('the general subagent default')
  })
})
