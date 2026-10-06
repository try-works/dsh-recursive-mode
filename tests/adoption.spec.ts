import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptSettlement } from '../src/settlement.ts'

/**
 * FU-17 step 4 — ADOPTION, NOT DROPPING.
 *
 * `runDirForChild` refuses to attribute a child it cannot place, and its reasoning is sound: filing into the
 * wrong run attaches one run's evidence to another run's chain. But the cost of that refusal is a settlement for
 * work that really happened being lost entirely. The rule tested here keeps the refusal's guarantee — NEVER GUESS
 * BETWEEN RUNS — while making sure the fact is recorded somewhere honest.
 *
 * ⚠ ONE FILE PER ADOPTED CHILD, following the same layout convention a delegation uses (a directory per child).
 * My first version of this spec asserted that two DIFFERENT children append to one file; the code was right and
 * the test was wrong, which is worth keeping in mind when reading the third case below.
 */
describe('FU-17: adopted settlements', () => {
  let root = ''
  const notice = { childId: 'child-foreign', summary: 'done', closingText: 'the deliverable' }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-adopt-'))
    mkdirSync(join(root, '.recursive', 'run'), { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('with exactly ONE run, files into that run under a clearly marked adopted delegation', () => {
    mkdirSync(join(root, '.recursive', 'run', 'only-run'), { recursive: true })
    const path = adoptSettlement(root, notice)
    expect(path).toContain(join('only-run', 'subagents', 'adopted-child-foreign', 'settlement.jsonl'))
    expect(existsSync(path!)).toBe(true)
    const record = JSON.parse(readFileSync(path!, 'utf8').trim()) as Record<string, unknown>
    expect(record.adopted, 'an adopted record must be distinguishable from a delegation own').toBe(true)
    expect(record.childId).toBe('child-foreign')
    expect(String(record.reason)).toContain('no delegation directory')
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
  })

  it('appends for the SAME child, and gives a different child its own record', () => {
    mkdirSync(join(root, '.recursive', 'run', 'only-run'), { recursive: true })
    const first = adoptSettlement(root, notice)
    adoptSettlement(root, notice)
    const lines = readFileSync(first!, 'utf8').trim().split('\n')
    expect(lines, 'two notices for one child share its file').toHaveLength(2)
    const other = adoptSettlement(root, { ...notice, childId: 'child-other' })
    expect(other).not.toBe(first)
    expect(existsSync(other!)).toBe(true)
    expect(readFileSync(other!, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('says nothing, and writes nothing, for a notice with no child', () => {
    mkdirSync(join(root, '.recursive', 'run', 'only-run'), { recursive: true })
    expect(adoptSettlement(root, { ...notice, childId: '' })).toBeNull()
  })
})
