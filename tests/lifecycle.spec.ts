import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  RUN_STATES, validateTransition, coupleGateBlockToGoal,
  type PhaseTransitionIntent,
} from '../src/lifecycle.ts'
import { lockHashFromContent } from '../src/lock.ts'

function makeLocked(root: string, runId: string, artifact: string, extra = '') {
  const runDir = join(root, '.recursive', 'run', runId)
  mkdirSync(runDir, { recursive: true })
  const content = [
    'Run: ' + runId, 'Phase: ' + artifact.replace('.md', ''), 'Status: LOCKED',
    'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none',
    '', '## TODO', '', '- [x] done', '', 'Coverage: PASS', 'Approval: PASS',
    ...(artifact !== '00-requirements.md' ? ['Audit: PASS'] : []),
    ...(artifact === '03-implementation-summary.md' ? ['TDD Mode: strict', 'TDD Compliance: PASS'] : []),
    'Effective Inputs Re-read:', '- none',
    ...(extra ? [extra] : []),
    '',
  ].join('\n')
  const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
  const final = content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n'
  writeFileSync(join(runDir, artifact), final, 'utf8')
  return join(runDir, artifact)
}

describe('lifecycle.ts — transition gate (R1/R2/R6)', () => {
  it('RUN_STATES is the five durable states', () => {
    expect(RUN_STATES).toEqual(['new', 'active', 'paused', 'blocked', 'complete'])
  })

  it('validateTransition blocks a lock whose prerequisites are DRAFT', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-lifecycle-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: r1\nPhase: 0\nStatus: DRAFT\n', 'utf8')
    writeFileSync(join(runDir, '01-as-is.md'), 'Run: r1\nPhase: 1\nStatus: DRAFT\n', 'utf8')
    const intent: PhaseTransitionIntent = { runId: 'r1', worktreeRoot: root, targetArtifact: '01-as-is.md', kind: 'lock' }
    const check = validateTransition(intent)
    expect(check.passed).toBe(false)
    expect(check.failures.join(' ')).toContain('unlocked prerequisite')
  })

  it('validateTransition blocks Phase 3 without TDD Mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-lifecycle-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    // prerequisites locked
    for (const art of ['00-requirements.md', '00-worktree.md', '01-as-is.md', '02-to-be-plan.md']) {
      makeLocked(root, 'r1', art)
    }
    writeFileSync(join(runDir, '03-implementation-summary.md'), 'Run: r1\nPhase: 3\nStatus: DRAFT\n', 'utf8')
    const intent: PhaseTransitionIntent = { runId: 'r1', worktreeRoot: root, targetArtifact: '03-implementation-summary.md', kind: 'lock' }
    const check = validateTransition(intent)
    expect(check.passed).toBe(false)
    expect(check.failures.join(' ')).toContain('TDD Mode')
  })

  it('validateTransition passes a fully-gated audited artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-lifecycle-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    for (const art of ['00-requirements.md', '00-worktree.md', '01-as-is.md', '02-to-be-plan.md']) {
      makeLocked(root, 'r1', art)
    }
    const extra = '## Requirement Completion Status\n- R1 | Status: implemented\n\nDelegation Decision Basis: self-audit\nSubagent Capability Probe: n/a\nAudit: PASS\n'
    makeLocked(root, 'r1', '03-implementation-summary.md', extra)
    // reopen to DRAFT so lock can be validated
    const path = join(runDir, '03-implementation-summary.md')
    let c = readFileSync(path, 'utf8').replace('Status: LOCKED', 'Status: DRAFT')
    writeFileSync(path, c, 'utf8')
    const intent: PhaseTransitionIntent = { runId: 'r1', worktreeRoot: root, targetArtifact: '03-implementation-summary.md', kind: 'lock', evidence: { tddMode: 'strict', redEvidencePath: 'evidence/logs/red/tdd-red.md', greenEvidencePath: 'evidence/logs/green/tdd-green.md' } }
    // create evidence files
    mkdirSync(join(runDir, 'evidence/logs/red'), { recursive: true })
    mkdirSync(join(runDir, 'evidence/logs/green'), { recursive: true })
    writeFileSync(join(runDir, 'evidence/logs/red/tdd-red.md'), '# red', 'utf8')
    writeFileSync(join(runDir, 'evidence/logs/green/tdd-green.md'), '# green', 'utf8')
    const check = validateTransition(intent)
    expect(check.failures).toEqual([])
    expect(check.passed).toBe(true)
  })

  it('coupleGateBlockToGoal is a no-op without a goal service', () => {
    expect(coupleGateBlockToGoal(null, {}, { id: 'g' }, { code: 'GATE', message: 'x' })).toBe(false)
  })

  it('coupleGateBlockToGoal blocks with a goal service', () => {
    let called = false
    const goalService = { block: (_a: unknown, _r: unknown, _reason: unknown) => { called = true } }
    expect(coupleGateBlockToGoal(goalService, {}, { id: 'g' }, { code: 'GATE', message: 'x' })).toBe(true)
    expect(called).toBe(true)
  })
})
