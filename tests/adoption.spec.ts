import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptSettlement,
  readSettlement,
  readSettlements,
  recordSettlement,
  settlementLogPath,
  settlementRoundObserver,
} from '../src/settlement.ts'

/**
 * FU-17 step 4 — ADOPTION, NOT DROPPING. **G1 — AND NOW ADOPTION IS READABLE.**
 *
 * `runDirForChild` refuses to attribute a child it cannot place, and its reasoning is sound: filing into the
 * wrong run attaches one run's evidence to another run's chain. But the cost of that refusal is a settlement for
 * work that really happened being lost entirely. The rule tested here keeps the refusal's guarantee — NEVER GUESS
 * BETWEEN RUNS — while making sure the fact is recorded somewhere honest.
 *
 * ⚠ G1 CHANGED WHERE THE SINGLE-RUN RECORD GOES, AND THIS HEADER USED TO SAY THE OPPOSITE: "one file per adopted
 * child, following the same layout convention a delegation uses (a directory per child)". That convention was
 * WRITE-SIDE ONLY — nothing read `subagents/adopted-<child>/settlement.jsonl` — so the record was filed and
 * invisible to `settlementRoundObserver`, which reads exactly one log. A roster-delegated child (which has no
 * delegation directory at the moment it settles) would therefore settle into a drawer no round could open, and
 * the review loop would wait out its timeout for a child that had already answered. Adoption now appends to the
 * run's own `subagents/settlements.jsonl`, marked `adopted: true`, so the observer READS it and a reader can
 * still tell an adopted record from a delegation's own. See `adoptSettlement`'s header for the alternatives
 * rejected.
 */
describe('FU-17: adopted settlements', () => {
  let root = ''
  const notice = { childId: 'child-foreign', summary: 'done', closingText: 'the deliverable' }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-adopt-'))
    mkdirSync(join(root, '.recursive', 'run'), { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('with exactly ONE run, files into that run\'s own settlement LOG, clearly marked as adopted', () => {
    mkdirSync(join(root, '.recursive', 'run', 'only-run'), { recursive: true })
    const path = adoptSettlement(root, notice)
    const runDir = join(root, '.recursive', 'run', 'only-run')
    // ⚠ THE LOG THE OBSERVER READS, not a sibling file nothing opens.
    expect(path).toBe(settlementLogPath(runDir))
    expect(existsSync(path!)).toBe(true)
    const record = JSON.parse(readFileSync(path!, 'utf8').trim()) as Record<string, unknown>
    expect(record.adopted, 'an adopted record must be distinguishable from a delegation own').toBe(true)
    expect(record.childId).toBe('child-foreign')
    expect(String(record.reason)).toContain('no delegation directory')
  })

  it('G1: the adopted settlement IS returned by settlementRoundObserver (it was filed and unreadable before)', async () => {
    mkdirSync(join(root, '.recursive', 'run', 'only-run'), { recursive: true })
    const runDir = join(root, '.recursive', 'run', 'only-run')
    adoptSettlement(root, { ...notice, closingText: '{"verdict":"APPROVE"}' })
    // timeoutMs: 0 — a real settlement must be served immediately; without the fix the observer waits out its
    // timeout and returns null, which the loop reports as "no settlement yet" — forever.
    const observed = await settlementRoundObserver(runDir, { timeoutMs: 0 })('child-foreign', 'm1')
    expect(observed, 'an adopted verdict must reach the round observer or the loop can never accept it').not.toBeNull()
    expect(observed!.stopReason).toBe('completed')
    // AND THE CHILD'S OWN ANSWER travelled with it, so the verdict is readable from the observation.
    expect(observed!.output).toBe('{"verdict":"APPROVE"}')
    expect((observed as { structured?: { verdict?: string } }).structured?.verdict).toBe('APPROVE')
    // Consumed exactly once, like a native settlement: the cursor is not bypassed by adoption.
    expect(await settlementRoundObserver(runDir, { timeoutMs: 0 })('child-foreign', 'm2')).toBeNull()
  })

  it('G1: the adopted marker SURVIVES the read, so adopted and native records stay distinguishable', () => {
    mkdirSync(join(root, '.recursive', 'run', 'only-run'), { recursive: true })
    const runDir = join(root, '.recursive', 'run', 'only-run')
    adoptSettlement(root, notice)
    const [adopted] = readSettlements(runDir)
    expect(adopted!.adopted).toBe(true)
    expect(adopted!.adoptionReason).toContain('no delegation directory')
    // A delegation's own settlement is NOT marked: the two must not read alike.
    recordSettlement(runDir, { childId: 'child-native', summary: 'native', closingText: '' })
    const nativeNotice = readSettlement(runDir, 'child-native')!
    expect(nativeNotice.adopted).toBeUndefined()
    expect(nativeNotice.adoptionReason).toBeUndefined()
  })

  it('with MORE THAN ONE run, records OUTSIDE every run - never guessing which chain owns it', () => {
    mkdirSync(join(root, '.recursive', 'run', 'run-a'), { recursive: true })
    mkdirSync(join(root, '.recursive', 'run', 'run-b'), { recursive: true })
    const path = adoptSettlement(root, notice)
    expect(path).toContain('adopted-settlements.jsonl')
    expect(existsSync(path!)).toBe(true)
    expect(existsSync(join(root, '.recursive', 'run', 'run-a', 'subagents'))).toBe(false)
    expect(existsSync(join(root, '.recursive', 'run', 'run-b', 'subagents'))).toBe(false)
    const record = JSON.parse(readFileSync(path!, 'utf8').trim()) as Record<string, unknown>
    expect(record.run, 'the ambiguous case must attribute NO run').toBeNull()
    expect(String(record.reason)).toContain('2 runs exist')
    // ⚠ AND THE OBSERVER OF EITHER RUN STILL SEES NOTHING: the ambiguous case writes where no run reads.
    expect(readSettlements(join(root, '.recursive', 'run', 'run-a'))).toEqual([])
    expect(readSettlements(join(root, '.recursive', 'run', 'run-b'))).toEqual([])
  })

  it('appends for the SAME child, and gives a different child its own record', () => {
    mkdirSync(join(root, '.recursive', 'run', 'only-run'), { recursive: true })
    const first = adoptSettlement(root, notice)
    adoptSettlement(root, notice)
    const lines = readFileSync(first!, 'utf8').trim().split('\n')
    expect(lines, 'two notices for one child append to the one log').toHaveLength(2)
    adoptSettlement(root, { ...notice, childId: 'child-other' })
    // One log, so a second child appends beside the first rather than getting a second file.
    expect(readFileSync(first!, 'utf8').trim().split('\n')).toHaveLength(3)
    const runDir = join(root, '.recursive', 'run', 'only-run')
    expect(readSettlements(runDir).map((n) => n.childId)).toEqual(['child-foreign', 'child-foreign', 'child-other'])
    // FIFO per child is preserved: the round gets the OLDEST unconsumed notice first.
    expect(readSettlement(runDir, 'child-foreign')!.summary).toBe('done')
  })

  it('says nothing, and writes nothing, for a notice with no child', () => {
    mkdirSync(join(root, '.recursive', 'run', 'only-run'), { recursive: true })
    expect(adoptSettlement(root, { ...notice, childId: '' })).toBeNull()
  })
})
