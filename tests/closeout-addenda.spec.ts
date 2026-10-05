import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeoutPhase } from '../src/closeout.ts'
import { getRunTreeAddenda } from '../src/ts-lint.ts'

/**
 * FU-8, EXTENDED — ADDENDA ARE PART OF THE CLOSEOUT WORK.
 *
 * ⚠ THE DEFECT THIS PINS: the plugin's two addendum enumerators both scan `run_dir/addenda/` and nothing
 * else, and flatly. But real addenda are written BESIDE THE ARTIFACT THEY CLOSE — the run ROOT, e.g.
 * `02-to-be-plan.addendum-r4-r2-mount-resolution.md`, a name the source itself cites — and a stage may file
 * one in a subfolder. A closeout that consulted only `addenda/` would therefore miss exactly the addenda
 * that closed an upstream gap, which are the ones a receipt most needs to account for.
 *
 * These assertions fail against the old behaviour in both halves: the walk finds nothing outside `addenda/`,
 * and the receipt says nothing about addenda at all.
 */
describe('FU-8 extension: addenda in the closeout work', () => {
  let runDir = ''

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'rm-closeout-addenda-'))
  })
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
  })

  /** The three places an addendum really turns up, plus one file that must NOT count. */
  function seed() {
    writeFileSync(join(runDir, '04-test-summary.addendum-r1-flaky-suite.md'), '# root addendum\n', 'utf8')
    mkdirSync(join(runDir, 'addenda'), { recursive: true })
    writeFileSync(join(runDir, 'addenda', '03-implementation-summary.addendum-r2-scope.md'), '# filed addendum\n', 'utf8')
    mkdirSync(join(runDir, 'notes', 'deep'), { recursive: true })
    writeFileSync(join(runDir, 'notes', 'deep', '05-manual-qa.upstream-gap.r3.addendum-q1.md'), '# nested\n', 'utf8')
    writeFileSync(join(runDir, 'notes', 'decoy.md'), '# not an addendum\n', 'utf8')
    writeFileSync(join(runDir, '04-test-summary.md'), '# the artifact\n', 'utf8')
  }

  it('finds addenda at the run root, in addenda/, and nested — and nothing else', () => {
    seed()
    const found = getRunTreeAddenda(runDir)
    expect(found).toEqual([
      '04-test-summary.addendum-r1-flaky-suite.md',
      'addenda/03-implementation-summary.addendum-r2-scope.md',
      'notes/deep/05-manual-qa.upstream-gap.r3.addendum-q1.md',
    ])
    // The decoy and the ordinary artifact are not addenda, at any depth.
    expect(found.some((f) => f.includes('decoy'))).toBe(false)
    expect(found).not.toContain('04-test-summary.md')
  })

  it('CITES them in the scaffolded receipt and returns them, so the work is observable', () => {
    seed()
    const result = closeoutPhase(runDir, '04', { strict: false })
    expect(result.addenda?.length).toBe(3)
    const receipt = readFileSync(join(runDir, '04-test-summary.md'), 'utf8')
    const runId = runDir.split(/[\\/]/).filter(Boolean).pop()
    expect(receipt).toContain('Addenda:')
    // The citation is the run-relative path under the canonical run root, not a bare file name.
    expect(receipt).toContain('`/.recursive/run/' + runId + '/notes/deep/05-manual-qa.upstream-gap.r3.addendum-q1.md`')
    expect(receipt).toContain('`/.recursive/run/' + runId + '/addenda/03-implementation-summary.addendum-r2-scope.md`')
  })

  it('SAYS SO when there are none — "we looked" must not read like "we never looked"', () => {
    const result = closeoutPhase(runDir, '04', { strict: false })
    expect(result.addenda).toEqual([])
    const receipt = readFileSync(join(runDir, '04-test-summary.md'), 'utf8')
    expect(receipt).toContain('Addenda:')
    expect(receipt).toContain('- none found in the run tree')
  })
})
