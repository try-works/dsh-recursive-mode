import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_PHASE_MATCH_WEIGHT, loadMemoryIndex, selectMemory } from '../src/memory.ts'
import { explainMemorySelection } from '../src/memory-select.ts'

/**
 * FU-14 — THE PHASE SIGNAL IN PRODUCTION, TESTED BY A CASE THAT CAN FAIL.
 *
 * ⚠ P2 was committed with the constant, the parser and the `phase` option present - but the BONUS WAS NEVER
 * ADDED to production's score line. Production ignored the phase while the explainer honoured it, and the
 * order-equality test did not notice because its phase case held ONE relevant entry, whose position cannot
 * change however it scores. A test that cannot fail is decoration.
 *
 * ⚠ SO THE ASSERTION HERE IS ARITHMETIC, NOT ORDINAL: the SAME entry, ranked twice, must score exactly
 * MEMORY_PHASE_MATCH_WEIGHT more when the phase in play is the one it declares. Nothing about that can pass
 * by accident, and it names the weight it expects rather than trusting whatever the constant happens to be.
 */
describe('FU-14: production honours the phase signal', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-phase-signal-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function plane() {
    mkdirSync(join(root, 'memory', 'patterns'), { recursive: true })
    writeFileSync(
      join(root, 'memory', 'patterns', 'applies.md'),
      '## Review round shape\n\nApplies to: 03.5\n\nThe review round parks and resumes the same child.\n',
      'utf8',
    )
    writeFileSync(
      join(root, 'memory', 'patterns', 'general.md'),
      '## Review round guidance\n\nThe review round parks and resumes the same child.\n',
      'utf8',
    )
  }

  const QUERY = 'review round parks resumes child'
  const scoreOf = (phase: string | undefined, title: string): number => {
    const options = phase === undefined ? { query: QUERY } : { query: QUERY, phase }
    const shard = selectMemory(root, options).shards.find((s) => s.entry.title === title)
    return shard?.score ?? 0
  }

  it('scores a declaring entry EXACTLY the phase weight higher for its own phase', () => {
    plane()
    const forItsPhase = scoreOf('03.5', 'Review round shape')
    const forAnother = scoreOf('07', 'Review round shape')
    const noPhase = scoreOf(undefined, 'Review round shape')
    expect(forItsPhase - forAnother, 'the declared phase must be worth the weight').toBe(MEMORY_PHASE_MATCH_WEIGHT)
    expect(forItsPhase - noPhase).toBe(MEMORY_PHASE_MATCH_WEIGHT)
    expect(forAnother).toBe(noPhase)
  })

  it('leaves an entry that declares NOTHING untouched - general guidance is neutral, never penalised', () => {
    plane()
    expect(scoreOf('03.5', 'Review round guidance')).toBe(scoreOf('07', 'Review round guidance'))
    expect(scoreOf(undefined, 'Review round guidance')).toBe(scoreOf('03.5', 'Review round guidance'))
  })

  it('and the explainer mirrors it, so the two cannot disagree about the phase', () => {
    plane()
    for (const phase of ['03.5', '07', undefined]) {
      const options = phase === undefined ? { query: QUERY } : { query: QUERY, phase }
      const production = selectMemory(root, options).shards.map((s) => s.entry.title)
      const explained = explainMemorySelection(loadMemoryIndex(root), options).entries.map((e) => e.title)
      expect(explained, 'order for phase ' + String(phase)).toEqual(production)
      const winner = explainMemorySelection(loadMemoryIndex(root), options).entries[0]
      const named = winner.components.some((c) => c.name === 'phase-applicable' && c.weight === MEMORY_PHASE_MATCH_WEIGHT)
      expect(named, 'component for phase ' + String(phase)).toBe(phase === '03.5')
    }
  })
})
