import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  FEEDBACK_FILE,
  INJECTIONS_FILE,
  LEGACY_FEEDBACK_FILE,
  MEMORY_READ_SOURCE,
  type FeedbackBook,
  feedbackBonus,
  isMemoryReadRecord,
  readFeedback,
  readInjections,
  readMemoryReads,
  recordInjection,
  recordMemoryRead,
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

  /**
   * THE PATH ITSELF, ASSERTED RATHER THAN DESCRIBED.
   *
   * This is the defect the two tests around it exist for: the constant used to read `memory/.feedback.json`
   * — no `.recursive/` prefix — while this module's own doc comment (and README §6's control-plane tree)
   * said `.recursive/memory/.feedback.json`. Joined onto the repo root, the old value wrote the counter
   * into the PRODUCT TREE, where the linter's diff audit (`getPhaseOwnedActualChangedFiles`) hands it to
   * EVERY diff-audited phase; under `.recursive/memory/` it belongs to the memory phase (08) alone, which
   * is always authored after the file exists. Measured before the fix: a completed fixture run ended at
   * FAIL: 4, all four naming `memory/.feedback.json` against phases 03 and 03.5, whose audits had been
   * authored before the first `settleInjections` (phase 04's closeout) wrote it.
   */
  it('writes the counters INTO the memory plane the doc comment names, not the product tree', () => {
    recordInjection(runDir, [entry('memory/domains/locks.md', 'Lock chain ordering')], '04')
    settleInjections(root, runDir, ['04'])
    expect(FEEDBACK_FILE).toBe('.recursive/memory/.feedback.json')
    expect(readFileSync(join(root, FEEDBACK_FILE), 'utf8')).toContain('"applied": 1')
    // Nothing was written at the pre-fix path, which is the whole point of the move.
    expect(existsSync(join(root, LEGACY_FEEDBACK_FILE))).toBe(false)
  })

  /**
   * THE MIGRATION, AND WHY IT IS A READ AND NOT A MOVE.
   *
   * A checkout from before this fix may hold a counter at the old path. It is READ — so the evidence a
   * previous run recorded is not thrown away — and folded forward by the next settle, because the first
   * version of this change simply ignored it, which is a counter lost. It is NOT moved or deleted, for the
   * reason `LEGACY_FEEDBACK_FILE` documents: a delete is the one action that could put a `D` entry into a
   * run's diff mid-flight and re-create the retro-invalidation this change removes.
   */
  it('READS a counter left at the pre-fix path and folds it forward rather than losing it', () => {
    mkdirSync(dirname(join(root, LEGACY_FEEDBACK_FILE)), { recursive: true })
    writeFileSync(join(root, LEGACY_FEEDBACK_FILE),
      JSON.stringify({ 'memory/domains/locks.md': { applied: 3, contradicted: 1 } }), 'utf8')
    // Before this run settles, the old book is what the ranking gets — not an empty one.
    expect(readFeedback(root)['memory/domains/locks.md']).toEqual({ applied: 3, contradicted: 1 })

    recordInjection(runDir, [entry('memory/domains/locks.md', 'Lock chain ordering')], '04')
    settleInjections(root, runDir, ['04'])
    // Carried forward, not summed: the two files are snapshots of ONE counter, so this settle adds its own
    // 1 to the legacy 3 rather than treating the copies as independent evidence.
    expect(readFeedback(root)['memory/domains/locks.md']).toEqual({ applied: 4, contradicted: 1 })
    expect(existsSync(join(root, LEGACY_FEEDBACK_FILE))).toBe(true)
  })

  it('prefers the current file when both exist, so a stale legacy copy cannot double-count', () => {
    mkdirSync(dirname(join(root, FEEDBACK_FILE)), { recursive: true })
    writeFileSync(join(root, FEEDBACK_FILE), JSON.stringify({ a: { applied: 2, contradicted: 0 } }), 'utf8')
    mkdirSync(dirname(join(root, LEGACY_FEEDBACK_FILE)), { recursive: true })
    writeFileSync(join(root, LEGACY_FEEDBACK_FILE), JSON.stringify({ a: { applied: 9, contradicted: 0 } }), 'utf8')
    expect(readFeedback(root)).toEqual({ a: { applied: 2, contradicted: 0 } })
    // And a CURRENT file that does not parse is the empty book this function has always promised — not a
    // licence to fall back to the other one, which would be a silent substitution.
    writeFileSync(join(root, FEEDBACK_FILE), '{ not json', 'utf8')
    expect(readFeedback(root)).toEqual({})
  })
})

/**
 * THE READ RECEIPT — the fact "the plane WAS READ", kept separate from "something was injected".
 *
 * ⚠ WHY THIS BLOCK EXISTS AT ALL, and it is the trap the phase-0 write gate had to be designed around:
 * `recordInjection` can only write a row when a SHARD was selected, so on an EMPTY plane it writes nothing
 * — and a gate keyed on "a row exists" would then refuse forever in a fresh workspace, where an empty
 * memory plane is a legitimate state rather than a failure. What the gate reads instead is the receipt
 * below, which `recordMemoryRead` writes on EVERY phase entry, `injected: false` included.
 *
 * The assertions here are the two halves of that: the receipt is written when nothing was injected, and the
 * shard rows and the receipt do not erase each other, whichever order the two writers run in.
 */
describe('the memory READ RECEIPT — recorded even when the read returned nothing', () => {
  let runDir = ''
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'rm-readreceipt-'))
    runDir = root
  })
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
  })

  it('records an EMPTY-plane read, which `recordInjection` alone could not: nothing was injected', () => {
    const receipts = recordMemoryRead(runDir, '00-requirements.md', {
      injected: false,
      shards: 0,
      reason: 'the memory plane is empty, so nothing is injected',
    })
    expect(receipts).toHaveLength(1)
    expect(receipts[0].injected).toBe(false)
    expect(receipts[0].phase).toBe('00-requirements.md')
    // The reason is carried VERBATIM, so the file says why the read answered nothing — an `injected: false`
    // with no reason would be indistinguishable from a read that was never recorded.
    expect(receipts[0].reason).toBe('the memory plane is empty, so nothing is injected')
    // And a receipt is not a ranking: a score would let it move a counter, which is not its job.
    expect(receipts[0].score).toBe(0)

    const onDisk = JSON.parse(readFileSync(join(runDir, INJECTIONS_FILE), 'utf8')) as unknown[]
    expect(onDisk).toHaveLength(1)
    expect(readMemoryReads(runDir)).toEqual(receipts)
  })

  it('REPLACES one receipt per phase rather than appending, because a phase is re-entered while DRAFT', () => {
    for (let round = 0; round < 4; round += 1) {
      recordMemoryRead(runDir, '00-requirements.md', { injected: false, shards: 0, reason: 'empty plane, entry ' + round })
    }
    const reads = readMemoryReads(runDir)
    expect(reads).toHaveLength(1)
    // The newest read wins: the receipt reports the state the run is in, not a history of every entry.
    expect(reads[0].reason).toBe('empty plane, entry 3')
    // …and a SECOND phase gets its own receipt, so the file is one row per phase and not one row per run.
    recordMemoryRead(runDir, '01-as-is.md', { injected: true, shards: 2, reason: 'injected 2 of 3 matching shard(s), capped at maxDocs 3' })
    expect(readMemoryReads(runDir).map((read) => read.phase)).toEqual(['00-requirements.md', '01-as-is.md'])
  })

  it('is BYTE-IDENTICAL when the same read is recorded twice — the determinism the other receipts follow', () => {
    const read = { injected: true, shards: 1, reason: 'injected 1 of 1 matching shard(s), capped at maxDocs 3' }
    recordMemoryRead(runDir, '04-test-summary.md', read)
    const first = readFileSync(join(runDir, INJECTIONS_FILE), 'utf8')
    recordMemoryRead(runDir, '04-test-summary.md', read)
    expect(readFileSync(join(runDir, INJECTIONS_FILE), 'utf8')).toBe(first)
  })

  it('the two writers PRESERVE each other, in either order', () => {
    // Order 1: the shards are recorded first, then the receipt. The shard row must survive the receipt's
    // rewrite — a receipt that overwrote the file would delete the evidence the counters settle against.
    recordInjection(runDir, [{ source: 'memory/domains/locks.md', title: 'Lock chain ordering', score: 5 }], '04')
    recordMemoryRead(runDir, '04', { injected: true, shards: 1, reason: 'injected 1 of 1' })
    expect(readInjections(runDir).filter((row) => !isMemoryReadRecord(row))).toEqual([
      { source: 'memory/domains/locks.md', title: 'Lock chain ordering', phase: '04', score: 5 },
    ])
    // Order 2 — the one production uses (`runtime.phaseRules` records the shards, then the receipt): the
    // receipt must survive a LATER `recordInjection`, or the gate would refuse a write in the very phase
    // entry that satisfied it.
    recordInjection(runDir, [{ source: 'memory/patterns/other.md', title: 'Other', score: 3 }], '05')
    expect(readMemoryReads(runDir)).toHaveLength(1)
    expect(readInjections(runDir).filter((row) => !isMemoryReadRecord(row))).toHaveLength(2)
  })

  it('settles NO counter for a receipt, so an empty plane never becomes fake evidence', () => {
    recordMemoryRead(runDir, '00-requirements.md', { injected: false, shards: 0, reason: 'the memory plane is empty, so nothing is injected' })
    recordInjection(runDir, [{ source: 'memory/domains/locks.md', title: 'Lock chain ordering', score: 5 }], '04')
    const book = settleInjections(runDir, runDir, ['00-requirements.md', '04'])
    // The one entry that WAS injected is settled; the receipt is not an entry, so it appears nowhere.
    expect(Object.keys(book)).toEqual(['memory/domains/locks.md'])
    expect(book[MEMORY_READ_SOURCE]).toBeUndefined()
  })

  it('is a RESERVED subject: no shard the plane can hold carries it', () => {
    // The gate decides "the read happened" from this row's subject, so a real entry able to hold the same
    // subject would let a shard satisfy the gate without a read ever running. Memory sources are the
    // shard's own `.md` path, which is why the reserved name is not a path.
    expect(MEMORY_READ_SOURCE.startsWith('memory-read:')).toBe(true)
    expect(MEMORY_READ_SOURCE.endsWith('.md')).toBe(false)
    // And the discriminator is the SHAPE, not the subject alone: a shard that happens to be titled like a
    // receipt is still a shard.
    expect(isMemoryReadRecord({ source: MEMORY_READ_SOURCE, title: 'x', phase: '04', score: 0 })).toBe(false)
    expect(isMemoryReadRecord({ source: MEMORY_READ_SOURCE, title: 'x', phase: '04', score: 0, injected: false, shards: 0, reason: 'r' })).toBe(true)
    // …and the shard SHAPE is not a receipt, however complete it looks.
    expect(isMemoryReadRecord({ source: 'memory/domains/locks.md', title: 'Lock chain ordering', phase: '04', score: 5 })).toBe(false)
    expect(isMemoryReadRecord(null)).toBe(false)
    expect(isMemoryReadRecord('memory-read:attempt')).toBe(false)
  })
})
