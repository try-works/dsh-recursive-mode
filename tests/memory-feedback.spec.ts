import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FEEDBACK_FILE,
  type FeedbackBook,
  feedbackBonus,
  readFeedback,
  readInjections,
  recordInjection,
  settleInjections,
} from '../src/memory-feedback.ts'

/**
 * FU-13 P3 — THE FEEDBACK LOOP, AND WHAT IT IS NOT.
 *
 * ⚠ The counters are EVIDENCE ABOUT RETRIEVAL, not learning: no model is trained, and an entry is never
 * deleted for losing. What these tests pin is that the loop is honest — merged rather than appended, settled
 * only against an outcome the run can actually show, stored in a machine-owned SIDECAR so a human-authored
 * shard is never rewritten to bump a number, and byte-identical for identical inputs.
 */
describe('FU-13 P3: memory feedback counters', () => {
  let root = ''
  let runDir = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-feedback-'))
    runDir = join(root, '..', 'rm-feedback-run-' + Math.random().toString(36).slice(2, 8))
    rmSync(runDir, { recursive: true, force: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })

  const entry = (source: string, title: string, score = 5) => ({ source, title, score })

  it('records what the run was shown, and READS IT BACK from the run dir', () => {
    recordInjection(runDir, [entry('memory/domains/locks.md', 'Lock chain ordering')], '04')
    const back = readInjections(runDir)
    expect(back).toEqual([{ source: 'memory/domains/locks.md', title: 'Lock chain ordering', phase: '04', score: 5 }])
  })

  it('MERGES rather than appends, because a DRAFT phase is re-entered and would count one decision four times', () => {
    for (let round = 0; round < 4; round += 1) {
      recordInjection(runDir, [entry('memory/domains/locks.md', 'Lock chain ordering', 4 + round)], '04')
    }
    const back = readInjections(runDir)
    expect(back.length).toBe(1)
    // The highest score seen wins: that is what the agent was most recently shown.
    expect(back[0].score).toBe(7)
  })

  it('settles against the run own outcome: one round that locked is APPLIED', () => {
    recordInjection(runDir, [entry('memory/domains/locks.md', 'Lock chain ordering')], '04')
    const book = settleInjections(root, runDir, ['04'])
    expect(book['memory/domains/locks.md']).toEqual({ applied: 1, contradicted: 0 })
    // The counters land in the SIDECAR, and no shard was touched — the plane holds no shard here at all.
    expect(readFeedback(root)['memory/domains/locks.md']).toEqual({ applied: 1, contradicted: 0 })
    expect(readFileSync(join(root, FEEDBACK_FILE), 'utf8')).toContain('"applied": 1')
  })

  it('does NOT invent a contradiction it cannot show — the merge discards the re-entry history', () => {
    recordInjection(runDir, [entry('memory/domains/locks.md', 'Lock chain ordering')], '04')
    recordInjection(runDir, [entry('memory/domains/locks.md', 'Lock chain ordering')], '05')
    // Phase 05 has two injections across the run, so the entry did not carry it alone.
    const book = settleInjections(root, runDir, ['04', '05'])
    expect(book['memory/domains/locks.md']).toEqual({ applied: 2, contradicted: 0 })
    expect(feedbackBonus(book, 'memory/domains/locks.md')).toBe(1)
  })

  it('ignores injections for phases that never locked — an unfinished phase is not evidence', () => {
    recordInjection(runDir, [entry('memory/domains/locks.md', 'Lock chain ordering')], '07')
    const book = settleInjections(root, runDir, ['04'])
    expect(book['memory/domains/locks.md']).toBeUndefined()
  })

  it('clamps the bonus to one step, so one long-lived entry cannot dominate the ranking', () => {
    const book: FeedbackBook = { a: { applied: 9, contradicted: 0 }, b: { applied: 0, contradicted: 4 }, c: { applied: 2, contradicted: 2 } }
    expect(feedbackBonus(book, 'a')).toBe(1)
    expect(feedbackBonus(book, 'b')).toBe(-1)
    expect(feedbackBonus(book, 'c')).toBe(0)
    expect(feedbackBonus(book, 'never-seen')).toBe(0)
  })

  it('accumulates across runs, and is byte-identical for identical inputs', () => {
    recordInjection(runDir, [entry('memory/domains/a.md', 'A'), entry('memory/patterns/b.md', 'B')], '04')
    settleInjections(root, runDir, ['04'])
    const first = readFileSync(join(root, FEEDBACK_FILE), 'utf8')
    settleInjections(root, runDir, ['04'])
    const second = readFileSync(join(root, FEEDBACK_FILE), 'utf8')
    // Same run settled twice adds the same evidence twice — accumulation is per settle, and that is stated
    // rather than hidden: the caller settles a run once, at closeout.
    expect(second).not.toBe(first)
    expect(readFeedback(root)['memory/domains/a.md']?.applied).toBe(2)
    // …and a corrupt sidecar is an empty book, never a crash.
    writeFileSync(join(root, FEEDBACK_FILE), '{ not json', 'utf8')
    expect(readFeedback(root)).toEqual({})
  })
})
