import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeoutPhase, PHASE_CONFIG } from '../src/closeout.ts'
import { lockHashFromContent } from '../src/lock.ts'

describe('closeout.ts — closeoutPhase (R2)', () => {
  let repo: string
  let runDir: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'closeout-'))
    runDir = join(repo, '.recursive', 'run', '99-test-run')
    mkdirSync(runDir, { recursive: true })
    const req = [
      'Run: 99-test-run',
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

  it('scaffolds 06/07/08 stubs with header + required sections', () => {
    for (const phase of ['06', '07', '08']) {
      const result = closeoutPhase(runDir, phase, { strict: false })
      expect(result.created).toContain(PHASE_CONFIG[phase].file)
      const content = readFileSync(join(runDir, PHASE_CONFIG[phase].file), 'utf8')
      expect(content).toContain('Status: `DRAFT`')
      expect(content).toContain('## TODO')
      expect(content).toContain('## Coverage Gate')
      expect(content).toContain('## Approval Gate')
    }
  })

  it('is idempotent: existing stub is updated, not duplicated', () => {
    closeoutPhase(runDir, '06', { strict: false })
    closeoutPhase(runDir, '06', { strict: false })
    const content = readFileSync(join(runDir, '06-decisions-update.md'), 'utf8')
    expect(content.split('## TODO').length - 1).toBe(1)
  })

  it('refuses phases whose earlier phases are not LOCKED', () => {
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: 99-test-run\nPhase: 0\nStatus: `LOCKED`\n', 'utf8')
    expect(() => closeoutPhase(runDir, '06', { strict: true })).toThrow(/prerequisite/i)
  })

  it('supports 04/05 test-summary and manual-qa stubs', () => {
    const r4 = closeoutPhase(runDir, '04', { strict: false })
    expect(r4.created).toContain('04-test-summary.md')
    const r5 = closeoutPhase(runDir, '05', { strict: false })
    expect(r5.created).toContain('05-manual-qa.md')
  })
})
