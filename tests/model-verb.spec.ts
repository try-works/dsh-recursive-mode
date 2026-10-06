/**
 * FU-19 step 3 (read half) — `/recursive model` PRINTS THE EFFECTIVE SELECTION AND WHERE IT CAME FROM.
 *
 * Same principle as `/recursive memory`: no agent loop, and every value names the level that produced it. The verb
 * reports what is CONFIGURED, so it passes no ladder provider — the resolved ladder needs a live host and appears
 * in a delegation routing notes instead.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_VERBS, executeRecursiveCommand, parseRecursiveCommand } from '../src/commands.ts'

describe('FU-19: the /recursive model verb', () => {
  let root = ''
  const write = (policy: unknown): void => {
    mkdirSync(join(root, '.recursive', 'config'), { recursive: true })
    writeFileSync(join(root, '.recursive', 'config', 'recursive-router.json'), JSON.stringify(policy), 'utf8')
  }
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rm-verb-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('is on the verb surface and parses', () => {
    expect(ALL_VERBS).toContain('model')
    expect(parseRecursiveCommand('model --phase 03 --role code-reviewer').verb).toBe('model')
  })

  it('names the level that produced each value', () => {
    write({
      version: 1,
      role_routes: { 'code-reviewer': { enabled: true, mode: 'native', cli: null, model: 'rigorous', provider: 'fork', fallback: 'self-audit' } },
      phase_routes: { '08': { model: 'strong' } },
    })
    const out = executeRecursiveCommand(root, 'model --phase 08 --role code-reviewer')
    expect(out.kind).toBe('success')
    expect(out.text, 'the phase route wins').toContain('strong')
    expect(out.text).toContain('[from phase]')
    expect(out.text, 'and the role route still supplies the provider').toContain('fork')
    expect(out.text).toContain('[from role]')
  })

  it('says INHERITED rather than pretending there is a model, when nothing configures one', () => {
    write({ version: 1, role_routes: {} })
    const out = executeRecursiveCommand(root, 'model --phase 03')
    expect(out.kind).toBe('success')
    expect(out.text).toContain('inherited — no model is sent')
    expect(out.text).toContain('[from inherit]')
    expect(out.text, 'nothing configured is stated, not implied').toContain('general unset')
  })

  it('states the three verdicts AND that a default never rewrites history', () => {
    write({ version: 1, role_routes: {} })
    const out = executeRecursiveCommand(root, 'model')
    expect(out.text).toContain('missing')
    expect(out.text).toContain('NOT substituted')
    expect(out.text).toContain('unverified')
    expect(out.text, 'the goal clause, made visible to the user').toContain('never rewrites a run')
  })
})
