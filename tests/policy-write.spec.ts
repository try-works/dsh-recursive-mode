/**
 * FU-19 step 3 (write half) — THE POLICY WRITER, AND THE THREE RULES THAT ARE EASY TO GET WRONG.
 *
 * Each test below exists because the opposite behaviour is a defect that would be hard to notice: deleting a
 * field we do not understand, storing a blank that stops a deferral, or tearing the file so the loader silently
 * falls back to the built-in policy.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePolicySelection } from '../src/policy-write.ts'
import { loadRouterPolicy } from '../src/router.ts'

describe('FU-19: writing the users provider/model choice', () => {
  let root = ''
  const path = (): string => join(root, '.recursive', 'config', 'recursive-router.json')
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(path(), 'utf8')) as Record<string, unknown>
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-write-'))
    mkdirSync(join(root, '.recursive', 'config'), { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('sets the GENERAL default and it is then resolvable', () => {
    const out = writePolicySelection(root, { scope: 'general', provider: 'fork', model: 'cheap' })
    expect('refused' in out).toBe(false)
    expect(read().defaults).toMatchObject({ subagent: { provider: 'fork', model: 'cheap' } })
    expect(loadRouterPolicy(path()).defaults.subagent).toEqual({ provider: 'fork', model: 'cheap' })
  })

  it('PRESERVES fields it does not understand, rather than rebuilding from our own schema', () => {
    writeFileSync(path(), JSON.stringify({ version: 1, custom_clis: [{ id: 'mine' }], cli_overrides: { x: 1 }, future_field: 'keep me' }), 'utf8')
    writePolicySelection(root, { scope: 'general', model: 'cheap' })
    const policy = read()
    expect(policy.future_field, 'an unknown field must survive a verb').toBe('keep me')
    expect(policy.custom_clis).toEqual([{ id: 'mine' }])
    expect(policy.cli_overrides).toEqual({ x: 1 })
  })

  it('CLEAR DELETES rather than blanking, so the deferral to the next level still works', () => {
    writePolicySelection(root, { scope: 'general', provider: 'fork', model: 'cheap' })
    const out = writePolicySelection(root, { scope: 'general', clear: true })
    expect('refused' in out).toBe(false)
    const defaults = read().defaults as Record<string, unknown>
    expect(defaults.subagent, 'the container is gone, not emptied').toBeUndefined()
    expect(loadRouterPolicy(path()).defaults.subagent).toBeUndefined()
  })

  it('a blank string is treated as CLEARING the field, not as a value that would pin it', () => {
    writePolicySelection(root, { scope: 'role', role: 'code-reviewer', model: 'rigorous' })
    writePolicySelection(root, { scope: 'role', role: 'code-reviewer', model: '   ' })
    const routes = read().role_routes as Record<string, Record<string, unknown>>
    expect('model' in routes['code-reviewer']!).toBe(false)
  })

  it('a PHASE and a ROLE scope write to their own containers and keep the others', () => {
    writePolicySelection(root, { scope: 'phase', phase: '08', model: 'strong' })
    writePolicySelection(root, { scope: 'role', role: 'memory-auditor', provider: 'spawn' })
    const policy = read()
    expect((policy.phase_routes as Record<string, unknown>)['08']).toEqual({ model: 'strong' })
    expect((policy.role_routes as Record<string, unknown>)['memory-auditor']).toEqual({ provider: 'spawn' })
  })

  it('refuses an incomplete scope instead of writing something surprising', () => {
    expect(writePolicySelection(root, { scope: 'phase', model: 'x' })).toHaveProperty('refused')
    expect(writePolicySelection(root, { scope: 'role', model: 'x' })).toHaveProperty('refused')
    expect(existsSync(path()), 'and it writes nothing at all').toBe(false)
  })

  it('refuses to overwrite a file it cannot parse, rather than replacing it with a fresh one', () => {
    writeFileSync(path(), '{ not json', 'utf8')
    const out = writePolicySelection(root, { scope: 'general', model: 'x' })
    expect(out).toHaveProperty('refused')
    expect(readFileSync(path(), 'utf8'), 'the broken file is left exactly as it was').toBe('{ not json')
  })

  it('the message names the level AND the no-history rule', () => {
    const out = writePolicySelection(root, { scope: 'general', model: 'cheap' })
    if ('refused' in out) throw new Error('unexpected refusal')
    expect(out.message).toContain('the general subagent default')
    expect(out.message).toContain('FUTURE delegations only')
    expect(out.message).toContain('never rewrites a run')
  })

  it('says when nothing changed instead of pretending it did', () => {
    writePolicySelection(root, { scope: 'general', model: 'cheap' })
    const again = writePolicySelection(root, { scope: 'general', model: 'cheap' })
    if ('refused' in again) throw new Error('unexpected refusal')
    expect(again.changed).toBe(false)
    expect(again.message).toContain('already as requested')
  })
})
