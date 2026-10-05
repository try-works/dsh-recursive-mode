import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeoutPhase, PHASE_CONFIG } from '../src/closeout.ts'
import { getLockStatus, lockHashFromContent } from '../src/lock.ts'
import { PHASES } from '../src/status.ts'

/**
 * FU-8, EXTENDED AGAIN — THE CLOSEOUT COVERS 00–03 (requested).
 *
 * ⚠ WHAT WAS WRONG BEFORE: the port covered 04–08 only (`recursive-closeout.py` scaffolded 4–8), which left
 * the EARLY artifacts — the ones every later receipt leans on — as the only phases with no receipt stub at
 * all, and so the only ones for which the FU-8 lock guard was unreachable through this tool: the phase
 * lookup threw `Unsupported closeout phase` before the guard was ever consulted.
 *
 * ⚠ WHY THE KEYS LOOK LIKE `00R`/`00W`: those are the keys `status.ts` already publishes, because two
 * artifacts share the `00-` prefix. Reusing them means the vocabulary a model reads in `recursive_status`
 * and the vocabulary this tool accepts cannot drift. That table is pinned byte-for-byte by
 * `status.parity.spec.ts` against the Python golden, so it is deliberately NOT edited — the second test
 * checks the two tables AGREE rather than changing the pinned side.
 */
describe('FU-8 extension: the closeout covers the early phases', () => {
  let runDir = ''

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'rm-closeout-early-'))
  })
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
  })

  const EARLY = ['00R', '00W', '01', '01.5', '02', '03']

  it('configures every phase from 00 to 08, with no gap', () => {
    for (const key of EARLY) expect(PHASE_CONFIG[key], key + ' must be scaffoldable').toBeDefined()
    for (const key of ['04', '05', '06', '07', '08']) expect(PHASE_CONFIG[key]).toBeDefined()
    expect(Object.keys(PHASE_CONFIG).sort())
      .toEqual(['00R', '00W', '01', '01.5', '02', '03', '04', '05', '06', '07', '08'].sort())
  })

  it('agrees with the phase table `recursive_status` prints — where both speak', () => {
    for (const phase of PHASES) {
      const config = PHASE_CONFIG[phase.key]
      if (!config) continue // e.g. 03.5, which the review path owns rather than the closeout
      expect(config.file, phase.key).toBe(phase.file)
    }
  })

  it('scaffolds an early receipt with its canonical header and sections', () => {
    const result = closeoutPhase(runDir, '03', { strict: false })
    expect(result.file).toBe('03-implementation-summary.md')
    expect(result.created).toEqual(['03-implementation-summary.md'])
    const receipt = readFileSync(join(runDir, '03-implementation-summary.md'), 'utf8')
    expect(receipt).toContain('Status: `DRAFT`')
    expect(receipt).toContain('Phase: `Phase 3 (Implementation)`')
    expect(receipt).toContain('## TDD Mode')
    expect(result.addenda).toEqual([])
  })

  it('THE POINT OF THE EXTENSION: an early phase now reaches the FU-8 lock guard', () => {
    // ⚠ A hand-written `Status:` line is NOT a lock. getLockStatus wants LockedAt plus a LockHash that
    // matches the content, and answers STALE_LOCK otherwise — so the lock is built through the plugin's own
    // hash, and the premise is ASSERTED before the behaviour under test, so a format drift reports itself
    // here rather than masquerading as a guard failure.
    const body = 'Status: `LOCKED`\nLockedAt: 2026-01-01T00:00:00.000Z\n'
    const file = join(runDir, '03-implementation-summary.md')
    writeFileSync(file, body + 'LockHash: ' + lockHashFromContent(body) + '\n', 'utf8')
    expect(getLockStatus(file), 'the premise: this really is a locked artifact').toBe('LOCKED')

    const before = readFileSync(file, 'utf8')
    expect(() => closeoutPhase(runDir, '03', { strict: false }))
      .toThrow(/Artifact is LOCKED: 03-implementation-summary\.md/)
    // And the artifact it refused to touch is byte-identical afterwards.
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
