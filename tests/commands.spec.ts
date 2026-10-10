import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseRecursiveCommand, executeRecursiveCommand } from '../src/commands.ts'
import { lockHashFromContent } from '../src/lock.ts'

describe('commands.ts — /recursive grammar (R4)', () => {
  let repo: string
  let runDir: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'rec-cmd-'))
    runDir = join(repo, '.recursive', 'run', '07-demo')
    mkdirSync(runDir, { recursive: true })
    const req = [
      'Run: 07-demo',
      'Phase: 0',
      'Status: `LOCKED`',
      'Workflow version: recursive-mode-audit-v2',
      '',
      '## TODO',
      '',
      '- [x] done',
      '',
      'Coverage: PASS',
      'Approval: PASS',
      'LockedAt: `2026-01-15T10:00:00Z`',
      'LockHash: `PLACEHOLDER`',
      '',
    ].join('\n')
    const hash = lockHashFromContent(req.replace('PLACEHOLDER', '0'.repeat(64)))
    writeFileSync(join(runDir, '00-requirements.md'), req.replace('PLACEHOLDER', hash), 'utf8')
  })

  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('parses the verb and raw input', () => {
    expect(parseRecursiveCommand('status 07-demo')).toEqual({ verb: 'status', arg: '07-demo' })
    expect(parseRecursiveCommand('closeout --phase 06')).toEqual({ verb: 'closeout', arg: '--phase 06' })
    expect(parseRecursiveCommand('scratch 07-demo')).toEqual({ verb: 'scratch', arg: '07-demo' })
    expect(parseRecursiveCommand('help')).toEqual({ verb: 'help', arg: '' })
    expect(parseRecursiveCommand('')).toEqual({ verb: 'help', arg: '' })
  })

  it('executes status against a workspace root and returns scoped success', () => {
    const result = executeRecursiveCommand(repo, 'status 07-demo')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('07-demo')
  })

  it('returns error for a runId outside the workspace', () => {
    const result = executeRecursiveCommand(repo, 'status 999-elsewhere')
    expect(result.kind).toBe('error')
  })

  it('closeout verb dispatches to the scoped closeout service', () => {
    const result = executeRecursiveCommand(repo, 'closeout 07-demo --phase 06')
    expect(result.kind).toBe('success')
  })

  it('unknown verb returns error with help', () => {
    const result = executeRecursiveCommand(repo, 'frobnicate')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('status|spec|worktree|init|lock|qa|closeout|addendum|review|scratch')
  })

  it('bootstrap verb performs the idempotent manual repair (R6)', () => {
    // First run: partial scaffold exists (run/ only) — repair fills the gaps.
    const first = executeRecursiveCommand(repo, 'bootstrap')
    expect(first.kind).toBe('success')
    expect(first.text).toContain('created')
    expect(existsSync(join(repo, '.recursive', 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(repo, '.recursive', 'STATE.md'))).toBe(true)
    // ⚠ ABSENCE, NOT PRESENCE, AND THAT IS THE FIX: the repair used to create an EMPTY
    // `.recursive/scripts/` while the shipped `CLAUDE.md` pointers and the canonical `RECURSIVE.md`
    // both sent the agent into it for a script that does not exist. The repair path must not put that
    // trap back, so `/recursive bootstrap` is asserted to leave the directory absent.
    expect(existsSync(join(repo, '.recursive', 'scripts'))).toBe(false)
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(true)
    // run/ artifacts untouched by repair.
    expect(existsSync(join(runDir, '00-requirements.md'))).toBe(true)
    // Second run: idempotent — no changes.
    const second = executeRecursiveCommand(repo, 'bootstrap')
    expect(second.kind).toBe('success')
    expect(second.text).toContain('already complete')
  })
})
