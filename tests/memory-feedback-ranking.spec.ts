import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMemoryIndex, selectMemory } from '../src/memory.ts'
import { explainMemorySelection } from '../src/memory-select.ts'
import type { FeedbackBook } from '../src/memory-feedback.ts'

/**
 * FU-13 P3b — THE COUNTERS CHANGE THE RANKING, AND BOTH SIDES AGREE ABOUT HOW.
 *
 * The counters are only worth having if they move the order, and only trustworthy if production and the
 * explainer move it the SAME way. This spec supplies a book directly, which is the design: the ranking takes
 * evidence as an OPTION, so the test can hand it a known book rather than arranging a filesystem to produce
 * one. Remove the wiring and the first assertion fails, because the two shards score identically.
 */
describe('FU-13 P3b: the counters change the ranking', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-feedback-rank-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** Two shards with identical wording, so ONLY the counters can separate them. */
  function plane() {
    mkdirSync(join(root, 'memory', 'domains'), { recursive: true })
    writeFileSync(join(root, 'memory', 'domains', 'a.md'), '## Alpha lesson\n\nThe lock chain orders receipts by phase.\n', 'utf8')
    writeFileSync(join(root, 'memory', 'domains', 'b.md'), '## Beta lesson\n\nThe lock chain orders receipts by phase.\n', 'utf8')
  }

  const QUERY = 'lock chain orders receipts phase'
  const orderOf = (options: { query: string; feedback?: FeedbackBook }): string[] =>
    selectMemory(root, options).shards.map((s) => s.entry.title)
  const explainedOrderOf = (options: { query: string; feedback?: FeedbackBook }): string[] =>
    explainMemorySelection(loadMemoryIndex(root), options).entries.map((e) => e.title)

  it('a reinforced entry overtakes an identical one, and loses the lead when it is contradicted', () => {
    plane()
    const sourceA = loadMemoryIndex(root).find((e) => e.title === 'Alpha lesson')?.source ?? ''
    expect(sourceA, 'the plane must expose a source to key the book by').toContain('a.md')

    // Without a book the two are tied, so the title tie-break decides.
    const noBook = orderOf({ query: QUERY })
    expect(noBook[0]).toBe('Alpha lesson')

    // Reinforcing B alone must put B first — this assertion fails if the wiring is missing.
    const favourB: FeedbackBook = { [loadMemoryIndex(root).find((e) => e.title === 'Beta lesson')?.source ?? 'x']: { applied: 2, contradicted: 0 } }
    expect(orderOf({ query: QUERY, feedback: favourB })[0]).toBe('Beta lesson')

    // …and contradicting it hands the lead back.
    const againstB: FeedbackBook = { [loadMemoryIndex(root).find((e) => e.title === 'Beta lesson')?.source ?? 'x']: { applied: 0, contradicted: 3 } }
    expect(orderOf({ query: QUERY, feedback: againstB })[0]).toBe('Alpha lesson')
  })

  it('and the explainer moves with it, naming the feedback component', () => {
    plane()
    const sourceB = loadMemoryIndex(root).find((e) => e.title === 'Beta lesson')?.source ?? 'x'
    const book: FeedbackBook = { [sourceB]: { applied: 2, contradicted: 0 } }
    const options = { query: QUERY, feedback: book }

    expect(explainedOrderOf(options), 'the explainer must agree with production').toEqual(orderOf(options))
    const winner = explainMemorySelection(loadMemoryIndex(root), options).entries[0]
    const component = winner.components.find((c) => c.name === 'feedback')
    expect(component?.weight, 'the component must carry the clamped bonus').toBe(1)
    expect(component?.detail).toContain('applied')
  })

  it('is neutral for an entry the book has never seen, and for an empty book', () => {
    plane()
    expect(orderOf({ query: QUERY, feedback: {} })).toEqual(orderOf({ query: QUERY }))
    const unknown: FeedbackBook = { 'memory/domains/nowhere.md': { applied: 5, contradicted: 0 } }
    expect(orderOf({ query: QUERY, feedback: unknown })).toEqual(orderOf({ query: QUERY }))
  })
})
