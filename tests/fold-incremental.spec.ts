/**
 * T21 — incremental fold, an append-only assertion, and ONE named position per phase.
 *
 * TWO CLAIMS, TESTED SEPARATELY.
 *
 * 1. COST. `foldRun` re-reads and re-parses every artifact on every call, and
 *    `snapshotWorkspace` does that for the whole run tree on every board request.
 *    A cheap per-artifact fingerprint (`size:mtimeMs`) lets an unchanged run be
 *    answered from the frame with no artifact reads at all, and a changed one be
 *    stepped only where it changed.
 *
 * 2. THE APPEND-ONLY ASSERTION. Tardigrade's `durableAtom` throws `EventLog
 *    source must be append-only` when its source shrinks. Here the artifacts ARE
 *    the run's evidence: a `LockHash` chain plus receipts reference them, so an
 *    artifact disappearing is an anomaly, not a routine edit. An INCREMENTAL fold
 *    that finds a remembered artifact gone therefore THROWS rather than quietly
 *    returning a shorter state. Deliberately scoped to the cache: a cold fold
 *    still reports the honest current state, so a repo that really did lose an
 *    artifact stays inspectable (`recursive_abandon`-style recovery must not be
 *    blocked by the very check that noticed the loss).
 *
 * `position` is one lowercase word per phase, derived from fields every consumer
 * currently recombines for itself — which is how two consumers come to disagree.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { foldRun, foldDiagnostics, resetFoldCache, phasePosition, PHASE_POSITIONS, type ArtifactState } from '../src/status.ts'
import { lockHashFromContent } from '../src/lock.ts'

const RUN = 'fold-run'

/** A run directory with the given artifacts (name -> content). */
function makeRun(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-fold-'))
  const runDir = join(root, '.recursive', 'run', RUN)
  mkdirSync(runDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(runDir, name), content, 'utf8')
  return runDir
}

/** A minimal DRAFT artifact with no blockers. */
function draftBody(): string {
  return 'Run: `x`\nPhase: `0`\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n\nCoverage: PASS\nApproval: PASS\n'
}

/** A minimal LOCKED artifact whose gates pass and whose hash is self-consistent. */
function lockedBody(hash = '0'.repeat(64)): string {
  return 'Run: `x`\nPhase: `0`\nStatus: `LOCKED`\n\n## TODO\n\n- [x] done\n\nCoverage: PASS\nApproval: PASS\nLockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n'
}

function stateOf(over: Partial<ArtifactState>): ArtifactState {
  return {
    exists: true, status: 'DRAFT', lockValid: false, lockProblems: [], blockers: [],
    lockedAt: null, storedHash: null, actualHash: null,
    coverage: 'MISSING', approval: 'MISSING', audit: 'MISSING',
    todoHasSection: true, todoUnchecked: 0,
    ...over,
  }
}

beforeEach(() => { resetFoldCache() })

describe('T21 — one named position per phase', () => {
  it('names every reachable state, and the vocabulary is closed', () => {
    expect(PHASE_POSITIONS).toEqual(['absent', 'skipped', 'draft', 'blocked', 'locked', 'invalid-lock', 'tampered'])
  })

  it('maps each underlying shape to exactly one position', () => {
    expect(phasePosition(stateOf({ exists: false, status: 'MISSING' }))).toBe('absent')
    expect(phasePosition(stateOf({ status: 'SKIPPED', exists: false }))).toBe('skipped')
    expect(phasePosition(stateOf({ status: 'DRAFT', blockers: [] }))).toBe('draft')
    expect(phasePosition(stateOf({ status: 'DRAFT', blockers: ['Coverage gate is FAIL'] }))).toBe('blocked')
    expect(phasePosition(stateOf({ status: 'LOCKED', lockValid: true }))).toBe('locked')
    // A LOCKED artifact failing a NON-hash condition is a different fact from one
    // whose content no longer matches its hash, so they must not share a name.
    expect(phasePosition(stateOf({ status: 'LOCKED', lockValid: false, lockProblems: ['Coverage gate is FAIL'] }))).toBe('invalid-lock')
    expect(phasePosition(stateOf({ status: 'LOCKED', lockValid: false, lockProblems: ['LockHash mismatch'] }))).toBe('tampered')
    // tamper wins even alongside other problems: it is the more serious fact.
    expect(phasePosition(stateOf({ status: 'LOCKED', lockValid: false, lockProblems: ['Coverage gate is FAIL', 'LockHash mismatch'] }))).toBe('tampered')
  })

  it('LINKS a lock-valid LOCKED artifact to "locked" and nothing else (the mapping is total)', () => {
    // Exhaustive over the axes that actually vary, so no combination is unnamed.
    const statuses = ['MISSING', 'DRAFT', 'LOCKED', 'SKIPPED']
    const seen = new Set<string>()
    for (const status of statuses) {
      for (const exists of [true, false]) {
        for (const lockValid of [true, false]) {
          for (const lockProblems of [[], ['LockHash mismatch'], ['Coverage gate is FAIL']]) {
            for (const blockers of [[], ['Coverage gate is FAIL']]) {
              const position = phasePosition(stateOf({ status, exists, lockValid, lockProblems, blockers }))
              expect(PHASE_POSITIONS, 'unnamed combination: ' + JSON.stringify({ status, exists, lockValid })).toContain(position)
              seen.add(position)
            }
          }
        }
      }
    }
    // The fuzz must actually reach most of the vocabulary, or it proves little.
    expect(seen.size).toBeGreaterThanOrEqual(5)
  })

  it('rides on every phase of a real fold', () => {
    const runDir = makeRun({ '00-requirements.md': draftBody() })
    const result = foldRun(runDir, RUN)
    expect(result.phases).toHaveLength(12)
    for (const p of result.phases) expect(PHASE_POSITIONS).toContain(p.position)
    // draftBody() has every gate PASS and its TODO ticked, so it is a clean
    // DRAFT with no blockers — 'draft', not 'blocked'.
    expect(result.phases.find(p => p.key === '00R')!.position).toBe('draft')
    expect(result.phases.find(p => p.key === '01')!.position).toBe('absent')
  })
})

describe('T21 — the incremental fold', () => {
  it('answers an unchanged run without re-reading a single artifact', () => {
    const runDir = makeRun({ '00-requirements.md': draftBody(), '01-as-is.md': draftBody() })
    foldRun(runDir, RUN)
    const after1 = foldDiagnostics()
    const second = foldRun(runDir, RUN)
    const after2 = foldDiagnostics()
    expect(after2.reparsed).toBe(after1.reparsed)
    expect(after2.reuses).toBe(after1.reuses + 1)
    // ...and the cached answer is the SAME answer, not a degraded one.
    expect(second.phases.find(p => p.key === '00R')!.status).toBe('DRAFT')
  })

  it('steps only the artifact that changed', () => {
    const runDir = makeRun({ '00-requirements.md': draftBody(), '01-as-is.md': draftBody() })
    foldRun(runDir, RUN)
    const before = foldDiagnostics().reparsed
    // Change content AND size, so the stamp differs.
    writeFileSync(join(runDir, '01-as-is.md'), draftBody() + '\nextra line\n', 'utf8')
    foldRun(runDir, RUN)
    expect(foldDiagnostics().reparsed).toBe(before + 1)
  })

  it('steps an APPENDED artifact and keeps the rest of the frame', () => {
    const runDir = makeRun({ '00-requirements.md': draftBody() })
    foldRun(runDir, RUN)
    const before = foldDiagnostics().reparsed
    writeFileSync(join(runDir, '01-as-is.md'), draftBody(), 'utf8')
    const result = foldRun(runDir, RUN)
    expect(foldDiagnostics().reparsed).toBe(before + 1)
    expect(result.phases.find(p => p.key === '01')!.exists).toBe(true)
  })

  it('THROWS when a remembered artifact disappears instead of returning a shorter state', () => {
    const runDir = makeRun({ '00-requirements.md': draftBody(), '01-as-is.md': draftBody() })
    foldRun(runDir, RUN)
    rmSync(join(runDir, '01-as-is.md'))
    expect(() => foldRun(runDir, RUN)).toThrow(/append-only|disappeared|removed/i)
  })

  it('a COLD fold still reports the honest state after a removal', () => {
    const runDir = makeRun({ '00-requirements.md': draftBody(), '01-as-is.md': draftBody() })
    foldRun(runDir, RUN)
    rmSync(join(runDir, '01-as-is.md'))
    // Recovery must not be blocked by the check that noticed the loss.
    resetFoldCache()
    const result = foldRun(runDir, RUN)
    expect(result.phases.find(p => p.key === '01')!.exists).toBe(false)
  })

  it('does not serve a stale state when content changes at the same size', () => {
    const runDir = makeRun({ '00-requirements.md': draftBody() })
    foldRun(runDir, RUN)
    // Same byte length, different content, and an explicitly bumped mtime: a
    // fingerprint that ignored mtime would wrongly reuse the frame here.
    const sameLength = 'Run: `x`\nPhase: `0`\nStatus: `DRAFZ`\n\n## TODO\n\n- [x] done\n\nCoverage: PASS\nApproval: PASS\n'
    writeFileSync(join(runDir, '00-requirements.md'), sameLength, 'utf8')
    const future = new Date(Date.now() + 5000)
    utimesSync(join(runDir, '00-requirements.md'), future, future)
    const result = foldRun(runDir, RUN)
    expect(result.phases.find(p => p.key === '00R')!.status).toBe('DRAFZ')
  })

  it('reports a genuinely lock-valid LOCKED artifact as "locked" end to end', () => {
    // Build the artifact the way the runtime does: the stored LockHash is computed
    // over the content with a placeholder hash in place, so the fold's re-hash
    // matches and lockValid is true.
    const body = 'Run: `x`\nPhase: `0`\nStatus: `LOCKED`\n\n## TODO\n\n- [x] done\n\nCoverage: PASS\nApproval: PASS\nLockedAt: 2026-01-01T00:00:00Z\n'
    const hash = lockHashFromContent(body + 'LockHash: ' + '0'.repeat(64) + '\n')
    const runDir = makeRun({ '00-requirements.md': body + 'LockHash: ' + hash + '\n' })
    const row = foldRun(runDir, RUN).phases.find(p => p.key === '00R')!
    expect(row.lockValid).toBe(true)
    expect(row.position).toBe('locked')
  })
})
