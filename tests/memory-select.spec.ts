import { describe, expect, it } from 'vitest'
import { type MemoryEntry, scoreMemoryEntry } from '../src/memory.ts'
import { explainMemorySelection } from '../src/memory-select.ts'

/**
 * FU-13 P1 — THE SELECTOR EXPLAINS ITSELF.
 *
 * ⚠ WHAT THESE TESTS ARE FOR: the reference loader's ranking is opaque, so "why did the agent get this?" has
 * no answer and a bad ranking cannot be tuned. The assertions below pin the three properties that make the
 * explanation trustworthy rather than decorative:
 *   1. the components SUM to the score — a breakdown that does not add up is worse than none;
 *   2. the query component IS the production scorer's own number, so the explanation cannot drift from the
 *      ranking that actually ships;
 *   3. the output is DETERMINISTIC (same inputs, same order, twice) and the excluded list is complete.
 */
describe('FU-13 P1: explainable memory selection', () => {
  const entry = (kind: string, title: string, body: string, source: string): MemoryEntry =>
    ({ kind, title, body, source })

  const shards: MemoryEntry[] = [
    entry('domains', 'Lock chain ordering', 'Phase 4 receipts must be scaffolded after prerequisites lock.', 'memory/domains/locks.md'),
    entry('patterns', 'Retry budget', 'The spawn runner retries twice; the third attempt is dropped.', 'memory/patterns/retry.md'),
    entry('domains', 'Unrelated billing note', 'Invoices are rounded per line item.', 'memory/domains/billing.md'),
    entry('episodes', 'Dead advice', 'Status: `DEPRECATED`\n\nOld approach that no longer applies.', 'memory/episodes/old.md'),
    entry('domains', 'Suspect claim', 'Status: `SUSPECT`\nThe spawn runner retries four times.', 'memory/domains/suspect.md'),
  ]

  it('sums its components to the score, for every included entry', () => {
    const result = explainMemorySelection(shards, { query: 'spawn runner retries', files: ['src/runner.ts'] })
    expect(result.entries.length).toBeGreaterThan(0)
    for (const item of result.entries) {
      const sum = item.components.reduce((total, c) => total + c.weight, 0)
      expect(sum, item.title + ' components must add up').toBe(item.score)
    }
  })

  it('uses the PRODUCTION scorer for the query component, so explanation cannot drift from behaviour', () => {
    const query = 'lock chain ordering'
    const result = explainMemorySelection(shards, { query })
    const first = result.entries[0]
    const production = scoreMemoryEntry(shards[0], query)
    const explained = first.components.find((c) => c.name === 'query-match')?.weight
    expect(explained).toBe(production)
  })

  it('boosts an entry that names a path the run actually changed, and says which', () => {
    const result = explainMemorySelection(shards, { query: 'irrelevant query', files: ['src/locks/chain.ts'] })
    // The lock shard mentions 'lock' but not the file name; the retry shard names the runner, so seed a match.
    const withPath = explainMemorySelection(
      [entry('domains', 'Runner notes', 'See runner.ts for the retry loop.', 'memory/domains/runner.md')],
      { query: 'nothing matches this', files: ['src/deep/runner.ts'] },
    )
    expect(withPath.entries.length).toBe(1)
    const pathComponent = withPath.entries[0].components.find((c) => c.name === 'path-overlap')
    expect(pathComponent?.weight).toBe(1)
    expect(pathComponent?.detail).toBe('src/deep/runner.ts')
    // …and the run above, with no file overlap and no query match, injects nothing at all.
    expect(result.entries.length).toBe(0)
    expect(result.excluded.some((e) => e.reason.includes('no query match'))).toBe(true)
  })

  it('never injects a DEPRECATED entry, and reports it instead of dropping it silently', () => {
    const result = explainMemorySelection(shards, { query: 'old approach', files: ['memory/episodes/old.md'] })
    expect(result.entries.some((e) => e.title === 'Dead advice')).toBe(false)
    const dead = result.excluded.find((e) => e.title === 'Dead advice')
    expect(dead?.reason).toBe('status DEPRECATED is never injected')
  })

  it('injects a SUSPECT entry with a visible warning rather than hiding it', () => {
    const result = explainMemorySelection(shards, { query: 'spawn runner retries' })
    const suspect = result.entries.find((e) => e.title === 'Suspect claim')
    expect(suspect).toBeDefined()
    expect(suspect?.warnings[0]).toContain('SUSPECT')
  })

  it('is deterministic: identical inputs produce byte-identical output', () => {
    const options = { query: 'lock chain', files: ['src/locks/chain.ts'] }
    const a = explainMemorySelection(shards, options)
    const b = explainMemorySelection(shards, options)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // …and stable under input reordering, because the sort breaks ties on source and title, not input order.
    const reordered = explainMemorySelection([...shards].reverse(), options)
    expect(reordered.entries.map((e) => e.title)).toEqual(a.entries.map((e) => e.title))
  })

  it('renders what was injected, including the score breakdown', () => {
    const result = explainMemorySelection(shards, { query: 'spawn runner retries', files: ['src/runner.ts'] })
    expect(result.rendered).toContain('cite by title')
    expect(result.rendered).toContain('score ')
    expect(result.rendered).toContain('query-match')
    // An empty result says so in words, and does not read like a failure.
    const empty = explainMemorySelection([], { query: 'anything' })
    expect(empty.entries).toEqual([])
    expect(empty.rendered).toContain('Do not assume the absence is conclusive')
  })

  it('honours the injection budget and reports what the budget kept out', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      entry('domains', 'Budget shard ' + i, 'lock chain ordering note ' + i, 'memory/domains/b' + i + '.md'))
    const result = explainMemorySelection(many, { query: 'lock chain ordering', maxItems: 2 })
    expect(result.entries.length).toBe(2)
    expect(result.excluded.filter((e) => e.reason.includes('budget')).length).toBe(3)
  })
})
