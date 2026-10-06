import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeoutReport, runCloseoutReport, writeCloseoutReceipt } from '../src/closeout-report.ts'
import { getLockStatus, lockHashFromContent } from '../src/lock.ts'

/**
 * FU-12 — THE CLOSEOUT IS A LINTER, AND THESE TESTS ARE THE PROOF THAT IT WRITES NOTHING.
 *
 * ⚠ WHAT THEY PIN, from a probe in a temp run folder: the previous implementation called `mkdirSync` and
 * `writeFileSync`, and against a DRAFT `05-manual-qa.md` it RETURNED SUCCESS while the agent's real QA
 * content was GONE. A closeout runs BEFORE a phase locks, so that was the ordinary case. The first test below
 * is the regression test for exactly that, and it asserts the strongest form available: byte-identical
 * content AND no new file anywhere in the run directory.
 */
describe('FU-12: the closeout report', () => {
  let runDir = ''

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'rm-closeout-report-'))
  })
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
  })

  /** Every path under the run dir, so "wrote nothing" can be asserted rather than assumed. */
  function tree(): string[] {
    return readdirSync(runDir, { recursive: true }).map(String).sort()
  }

  it('DOES NOT TOUCH A DRAFT ARTIFACT — the defect this replaces, as a regression test', () => {
    const content = 'Status: `DRAFT`\n\n## TODO\n\n- the agent actual QA work\n'
    const file = join(runDir, '05-manual-qa.md')
    writeFileSync(file, content, 'utf8')
    const before = tree()

    const report = closeoutReport(runDir, '05')

    // The content survives, byte for byte…
    expect(readFileSync(file, 'utf8')).toBe(content)
    // …and the closeout created nothing beside it.
    expect(tree()).toEqual(before)
    // It still had something useful to say, which is the whole point of the change.
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.exists).toBe(true)
  })

  it('reports missing sections and gates, generated from the rules rather than a private list', () => {
    writeFileSync(join(runDir, '05-manual-qa.md'), 'Status: `DRAFT`\n\n## TODO\n', 'utf8')
    const report = closeoutReport(runDir, '05')
    const details = report.findings.map((f) => f.detail)
    expect(details).toContain('Coverage gate reads MISSING; it must read PASS')
    expect(report.findings.some((f) => f.kind === 'missing-section' && f.detail.includes('## QA Execution Record'))).toBe(true)
    // The guidance the agent is handed comes from the rules module, not from this one.
    expect(report.guidance.length).toBeGreaterThan(0)
  })

  it('handles a LOCKED artifact by reporting, not by throwing — the FU-8 guard is gone by design', () => {
    const body = 'Status: `LOCKED`\nLockedAt: 2026-01-01T00:00:00.000Z\n\n## TODO\n'
    const file = join(runDir, '08-memory-impact.md')
    writeFileSync(file, body + 'LockHash: ' + lockHashFromContent(body) + '\n', 'utf8')
    const locked = readFileSync(file, 'utf8')

    const report = closeoutReport(runDir, '08')

    expect(report.status).toBe('LOCKED')
    expect(readFileSync(file, 'utf8')).toBe(locked)
    // A locked artifact that is nonetheless incomplete still gets told so.
    expect(report.findings.length).toBeGreaterThan(0)
  })

  it('treats a missing artifact as a finding, not an error', () => {
    const report = closeoutReport(runDir, '06')
    expect(report.exists).toBe(false)
    expect(report.status).toBe('MISSING')
    expect(report.findings[0].kind).toBe('missing-artifact')
    expect(tree()).toEqual([])
  })

  it('treats unlocked prerequisites as ADVISORY — the reference warns, it does not refuse', () => {
    // ⚠ THE PREMISE, corrected after this test failed: `getPrerequisiteBlockers` does NOT count a MISSING
    // artifact as a blocker — absent is not blocking, it is simply not there. So the advisory list is
    // exercised with an artifact that EXISTS and is not yet LOCKED, which is the case the reference's
    // "[WARN] Scaffolding … before prerequisite phases are LOCKED" actually describes.
    writeFileSync(join(runDir, '04-test-summary.md'), 'Status: `DRAFT`\n\n## TODO\n', 'utf8')
    const report = closeoutReport(runDir, '05')
    expect(report.prerequisites.some((p) => p.artifact === '04-test-summary.md')).toBe(true)
    // …and it did not throw, which is what makes a closeout usable at phase entry.
    expect(report.artifact).toBe('05-manual-qa.md')
  })

  it('cites addenda instead of writing to them, and rejects an unknown phase', () => {
    writeFileSync(join(runDir, '02-to-be-plan.addendum-r4-mount.md'), '# seed\n', 'utf8')
    mkdirSync(join(runDir, 'addenda'), { recursive: true })
    writeFileSync(join(runDir, 'addenda', '01-as-is.addendum-r1.md'), '# seed\n', 'utf8')
    const before = tree()

    const report = closeoutReport(runDir, '07')

    expect(report.addenda).toEqual(['02-to-be-plan.addendum-r4-mount.md', 'addenda/01-as-is.addendum-r1.md'])
    expect(tree()).toEqual(before)
    expect(() => closeoutReport(runDir, '03')).toThrow(/Unsupported closeout phase/)
  })

  /**
   * ⚠ THE RUN-LEVEL RECEIPT COVERS 00–03. User's point, and it is the right one: a receipt represents what
   * was done IN THE RUN, so it must include the early artifacts. This does NOT undo the earlier correction -
   * the closeout still never WRITES those documents; it reads them and records their state. Reading broadly
   * and writing narrowly is the distinction that was missing.
   */
  it('the RUN receipt covers every artifact, 00 through 08, not just the closeout phases', () => {
    // A run with only the early artifacts present: they must still appear, with their state recorded.
    writeFileSync(join(runDir, '00-requirements.md'), 'Status: `DRAFT`\n\n## TODO\n', 'utf8')
    writeFileSync(join(runDir, '01-as-is.md'), 'Status: `DRAFT`\n\n## TODO\n', 'utf8')

    const run = runCloseoutReport(runDir)
    const names = run.artifacts.map((a) => a.artifact)
    expect(names).toContain('00-requirements.md')
    expect(names).toContain('00-worktree.md')
    expect(names).toContain('01-as-is.md')
    expect(names).toContain('02-to-be-plan.md')
    expect(names).toContain('03-implementation-summary.md')
    // …and it reaches the late phases too, so one receipt describes the whole run.
    expect(names).toContain('08-memory-impact.md')
    // The two seeded artifacts are recorded with their status and their gaps.
    const early = run.artifacts.find((a) => a.artifact === '00-requirements.md')
    expect(early?.exists).toBe(true)
    expect(early?.status).toBe('DRAFT')
    expect(early?.findings.length).toBeGreaterThan(0)
    // The untouched ones are ABSENT rather than violations.
    const absent = run.artifacts.find((a) => a.artifact === '00-worktree.md')
    expect(absent?.exists).toBe(false)
    expect(absent?.status).toBe('ABSENT')
    expect(absent?.findings).toEqual([])
  })

  it('writes the run receipt at the run root when the FINAL phase is closed out, and only then', () => {
    writeFileSync(join(runDir, '00-requirements.md'), 'Status: `DRAFT`\n\n## TODO\n', 'utf8')

    // A mid-run phase writes only its own per-phase receipt.
    const mid = writeCloseoutReceipt(runDir, '05')
    expect(mid.runReceipt).toBeNull()
    expect(existsSync(join(runDir, 'closeout.receipt.json'))).toBe(false)

    // Phase 08 is the run's last phase, so that is where the run's own receipt belongs.
    const final = writeCloseoutReceipt(runDir, '08')
    expect(final.runReceipt?.path).toBe(join(runDir, 'closeout.receipt.json'))
    const recorded = JSON.parse(readFileSync(join(runDir, 'closeout.receipt.json'), 'utf8'))
    expect(recorded.artifacts.some((a: { artifact: string }) => a.artifact === '00-requirements.md')).toBe(true)
    // And neither receipt is a phase document.
    expect(readFileSync(join(runDir, '00-requirements.md'), 'utf8')).toBe('Status: `DRAFT`\n\n## TODO\n')
  })
})
