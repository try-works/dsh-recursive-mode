import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveEnforcementConfig, DEFAULT_ENFORCEMENT, DEFAULT_BUDGETS,
  evaluateToolGuard, detectTamper, tamperCandidatePath, coerceAskToDecision, type EnforcementConfig,
} from '../src/enforcement.ts'
import { getLockStatus, lockHashFromContent } from '../src/lock.ts'

describe('enforcement.ts — gates + config (R3/R4/R7/R8)', () => {
  it('resolveEnforcementConfig defaults advisory and rejects unknown keys', () => {
    expect(resolveEnforcementConfig(undefined)).toEqual(DEFAULT_ENFORCEMENT)
    // T28 added `budgets` to the shape, so the expected object carries it: the
    // assertion is about resolveEnforcementConfig filling in defaults, and the
    // defaults now include the caps. Pinned explicitly rather than relaxed to a
    // partial match, so a future shape change still fails here loudly.
    expect(resolveEnforcementConfig({ preStep: 'strict' })).toEqual({
      preStep: 'strict',
      toolGuards: 'advisory',
      tamper: 'advisory',
      budgets: DEFAULT_BUDGETS,
    })
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

/**
 * The tamper ADMISSION test — the guard used to be blind to one spelling of one
 * path, measured rather than theorised.
 *
 * ⚠ THE REGRESSION these assertions pin. `detectTamper` admitted a target with a
 * substring test for `/.recursive/run/` ON THE TARGET STRING. A repo-relative
 * target has no separator before `.recursive`, so the spelling a model actually
 * types — and its backslash form — was rejected BEFORE anything was examined, and
 * a tampered locked artifact was invisible through it, while the ABSOLUTE
 * spelling of the same file was reported. One file, two spellings, two answers.
 * The identical defect in the identical spelling was fixed one module over
 * (`policy-globs.ts` `lockedWriteRule`); this is that fix's shape. `src/index.ts`'s
 * `fs/observed` listener carried a hand-copied MIRROR of the same admission test,
 * which is why the test now lives in ONE place (`tamperCandidatePath`) that both
 * callers use: widening only one of the two would have changed nothing on the
 * live path, because the listener would still have rejected the candidate first.
 */
describe('enforcement.ts — every spelling of one path gets one tamper answer', () => {
  const CONTENT = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'

  /** A LOCKED `*.md` whose stored hash MISMATCHES its content: STALE_LOCK, i.e. a real tamper. */
  function writeTampered(path: string): void {
    writeFileSync(path, CONTENT + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + 'f'.repeat(64) + '\n', 'utf8')
  }

  /** A LOCKED `*.md` whose stored hash MATCHES: lock-valid, nothing to report. */
  function writeLockValid(path: string): void {
    const trailer = 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n'
    writeFileSync(path, CONTENT + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + lockHashFromContent(CONTENT + trailer) + '\n', 'utf8')
  }

  it('reports the SAME tampered artifact named relatively or absolutely', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-rel-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const artifact = join(runDir, '00-requirements.md')
    writeTampered(artifact)
    // Precondition, ASSERTED rather than assumed: the file really is STALE_LOCK, so a
    // `null` below cannot be an artifact of a clean or missing fixture.
    expect(getLockStatus(artifact)).toBe('STALE_LOCK')

    const spellings = [
      // The absolute spelling, which always worked — asserted BESIDE the others so a
      // change that only learned relative paths (or that dropped the resolved-path
      // test again) cannot pass.
      artifact,
      // ⚠ These two were `null` before the fix: repo-relative POSIX, and backslashes.
      '.recursive/run/r1/00-requirements.md',
      '.recursive\\run\\r1\\00-requirements.md',
      // `./`-relative only ever matched by ACCIDENT (its leading `./` supplied the
      // separator the marker needs); pinned so it keeps working for the right reason.
      './.recursive/run/r1/00-requirements.md',
      // A non-canonical absolute (`/./`) — the fifth spelling, which resolved cleanly
      // even before the fix and must not regress.
      root.replace(/\\/g, '/') + '/.recursive/run/r1/./00-requirements.md',
    ]
    for (const target of spellings) {
      const tamper = detectTamper(target, root, 'r1')
      expect(tamper, 'no tamper reported for ' + target).not.toBeNull()
      // The RECORD's contents are pinned, not merely its existence: the run the
      // observation was attributed to, and the target AS WRITTEN normalized to
      // forward slashes. That is the pre-fix contract, unchanged by the admission fix.
      const asWritten = target.replace(/\\/g, '/')
      expect(tamper?.runId, target).toBe('r1')
      expect(tamper?.path, target).toBe(asWritten)
      expect(tamper?.reason, target).toContain('tampered')
      expect(tamper?.reason, target).toContain(asWritten)
    }
  })

  it('still admits a target that NAMES the run tree but resolves away from it (the string test is KEPT)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-super-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    // The same file, reachable by a spelling that carries the marker in its TEXT and
    // loses it on RESOLUTION — the case the kept string test exists for.
    const elsewhere = join(root, 'other', '00-requirements.md')
    mkdirSync(join(root, 'other'), { recursive: true })
    writeTampered(elsewhere)
    expect(getLockStatus(elsewhere)).toBe('STALE_LOCK')

    const escaping = runDir.replace(/\\/g, '/') + '/../../../other/00-requirements.md'
    // Both halves of the premise, so this test cannot pass vacuously: the string as
    // written DOES carry the marker, and the path it resolves to does NOT.
    expect(escaping).toContain('/.recursive/run/')
    const resolved = tamperCandidatePath(escaping, root)
    expect(resolved).not.toBeNull()
    expect(resolved!.replace(/\\/g, '/'), 'a resolved-only admission would abstain here').not.toContain('/.recursive/run/')

    // Admitted anyway — a strict SUPERSET of the pre-fix behaviour, so no target that
    // was reported before can become invisible now.
    const tamper = detectTamper(escaping, root, 'r1')
    expect(tamper, 'the string test is KEPT: a target that names the run tree stays admitted').not.toBeNull()
    expect(tamper?.path).toBe(escaping)
  })

  it('never reports a file OUTSIDE a run tree — lock-valid OR stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-outside-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    // (a) lock-valid and outside any run tree: an admission test that reported this
    // would be reporting a file the rule is not about.
    const valid = join(root, 'notes.md')
    writeLockValid(valid)
    // (b) STALE and outside any run tree — a REAL tamper by hash, rejected anyway
    // because the ADMISSION test (not the lock status) is what scopes this rule. This
    // is the control with teeth for the widened admission: (a) would also be `null`
    // from a rule that reported nothing at all, (b) would be reported by a rule whose
    // admission had widened past the run tree.
    const loose = join(root, 'loose', '00-requirements.md')
    mkdirSync(join(root, 'loose'), { recursive: true })
    writeTampered(loose)
    // Preconditions: the two fixtures really carry the lock statuses claimed, so the
    // `null`s below cannot pass because a file was missing or clean by accident.
    expect(getLockStatus(valid)).toBe('LOCKED')
    expect(getLockStatus(loose)).toBe('STALE_LOCK')

    for (const target of ['notes.md', valid, 'loose/00-requirements.md', loose]) {
      expect(detectTamper(target, root, 'r1'), target + ' is not a run-tree artifact').toBeNull()
    }
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
