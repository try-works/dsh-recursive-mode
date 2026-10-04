import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveEnforcementConfig, DEFAULT_ENFORCEMENT,
  evaluateToolGuard, detectTamper, coerceAskToDecision, type EnforcementConfig,
} from '../src/enforcement.ts'
import { lockHashFromContent } from '../src/lock.ts'

describe('enforcement.ts — gates + config (R3/R4/R7/R8)', () => {
  it('resolveEnforcementConfig defaults advisory and rejects unknown keys', () => {
    expect(resolveEnforcementConfig(undefined)).toEqual(DEFAULT_ENFORCEMENT)
    expect(resolveEnforcementConfig({ preStep: 'strict' })).toEqual({ preStep: 'strict', toolGuards: 'advisory', tamper: 'advisory' })
    expect(() => resolveEnforcementConfig({ bogus: 'x' })).toThrow(/unknown key/)
  })

  it('evaluateToolGuard denies an out-of-order recursive_lock (strict)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: r1\nPhase: 0\nStatus: DRAFT\n', 'utf8')
    const d = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '01-as-is.md' } }, root, 'r1', 'strict')
    expect(d.kind).toBe('deny')
    expect((d as { reason: string }).reason).toContain('monotonic lock-order')
  })

  it('evaluateToolGuard asks (advisory) instead of deny on out-of-order lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: r1\nPhase: 0\nStatus: DRAFT\n', 'utf8')
    const d = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '01-as-is.md' } }, root, 'r1', 'advisory')
    expect(d.kind).toBe('ask')
  })

  it('evaluateToolGuard denies a write to a LOCKED run doc (strict)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const content = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    writeFileSync(join(runDir, '00-requirements.md'), content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n', 'utf8')
    const d = evaluateToolGuard({ name: 'write', arguments: { file_path: join(runDir, '00-requirements.md') } }, root, 'r1', 'strict')
    expect(d.kind).toBe('deny')
    expect((d as { reason: string }).reason).toContain('locked-artifact write denial')
  })

  it('detectTamper flags a locked artifact with a hash mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const content = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    // write a DIFFERENT hash to force STALE_LOCK
    writeFileSync(join(runDir, '00-requirements.md'), content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + 'f'.repeat(64) + '\n', 'utf8')
    const tamper = detectTamper(join(runDir, '00-requirements.md'), root, 'r1')
    expect(tamper).not.toBeNull()
    expect(tamper?.reason).toContain('tampered')
  })

  it('detectTamper is null for a clean locked artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const content = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    writeFileSync(join(runDir, '00-requirements.md'), content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n', 'utf8')
    expect(detectTamper(join(runDir, '00-requirements.md'), root, 'r1')).toBeNull()
  })
})

describe('enforcement.ts — coerceAskToDecision (T6 ask→policy bridge)', () => {
  it('passes allow and deny through unchanged', () => {
    expect(coerceAskToDecision({ kind: 'allow' }, 'strict')).toEqual({ kind: 'allow' })
    expect(coerceAskToDecision({ kind: 'deny', reason: 'r' }, 'strict')).toEqual({ kind: 'deny', reason: 'r' })
  })

  it('coerces ask -> deny under strict (never a silent allow)', () => {
    const d = coerceAskToDecision({ kind: 'ask', reason: 'monotonic lock-order' }, 'strict')
    expect(d.kind).toBe('deny')
    expect((d as { reason: string }).reason).toContain('monotonic lock-order')
  })

  it('coerces ask -> allow+warn under advisory (logged, never silent)', () => {
    const d = coerceAskToDecision({ kind: 'ask', reason: 'monotonic lock-order' }, 'advisory')
    expect(d.kind).toBe('allow')
    expect((d as { warn?: string }).warn).toContain('monotonic lock-order')
  })

  it('defaults a bare ask to an advisory allow with a warn message', () => {
    const d = coerceAskToDecision({ kind: 'ask' })
    expect(d.kind).toBe('allow')
    expect((d as { warn?: string }).warn).toBeTruthy()
  })
})
