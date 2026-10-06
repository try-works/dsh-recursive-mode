import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type MemoryEntry,
  loadMemoryIndex,
  scoreMemoryEntry,
  selectMemory,
} from '../src/memory.ts'
import { explainMemorySelection } from '../src/memory-select.ts'
import type { FeedbackBook } from '../src/memory-feedback.ts'

/**
 * FU-13 P1/P2 — THE SELECTOR EXPLAINS THE RANKING THAT SHIPS.
 *
 * ⚠ WHY THE FIRST VERSION OF THIS SPEC WAS NOT ENOUGH, and it is the whole reason for the rewrite: it asserted
 * that ONE component (the query score) came from production, and the module ranked on three other signals of
 * its own. The spec passed; the property it was meant to protect was false. So the central assertion here is
 * the one that cannot be faked — ON THE SAME ON-DISK PLANE WITH THE SAME OPTIONS, THE ORDER EQUALS
 * `selectMemory`'s ORDER — and the component checks below are supporting detail rather than the guarantee.
 */
describe('FU-13 P1/P2: the explainer describes production', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-memory-select-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** Write a real memory plane, the shape `loadMemoryIndex` reads: memory/<kind>/<file>.md. */
  function plane(shards: Array<{ kind: string; file: string; text: string }>) {
    for (const shard of shards) {
      mkdirSync(join(root, 'memory', shard.kind), { recursive: true })
      writeFileSync(join(root, 'memory', shard.kind, shard.file), shard.text, 'utf8')
    }
  }

  const shardText = (title: string, body: string) => '## ' + title + '\n\n' + body + '\n'

  const plane_ = () => plane([
    { kind: 'domains', file: 'locks.md', text: shardText('Lock chain ordering', 'Receipts are scaffolded after prerequisites lock. See src/locks/chain.ts for the order.') },
    { kind: 'patterns', file: 'phase35.md', text: shardText('Review round shape', 'Applies to: 03.5\n\nThe review round parks and resumes the same child.') },
    { kind: 'patterns', file: 'retry.md', text: shardText('Retry budget', 'The spawn runner retries twice; the third attempt is dropped. See src/runner.ts.') },
    { kind: 'domains', file: 'billing.md', text: shardText('Unrelated billing note', 'Invoices round per line item.') },
    { kind: 'episodes', file: 'old.md', text: shardText('Retired advice', 'Status: `DEPRECATED`\n\nThe spawn runner retried four times.') },
    { kind: 'domains', file: 'stale.md', text: shardText('Stale ordering note', 'Status: `STALE`\n\nLock chain ordering used to differ.') },
  ])

  const entry = (kind: string, title: string, body: string, source: string): MemoryEntry =>
    ({ kind, title, body, source })

  /**
   * ⚠ THE ASSERTION THAT CANNOT BE FAKED. Same plane, same options: the explainer must produce exactly the
   * shard order `selectMemory` produces. The first version of this module would fail here — that is the point.
   */
  it('matches selectMemory ORDER on the same plane, for several option sets', () => {
    plane_()
    const optionSets: Array<{ query: string; files?: string[]; phase?: string; feedback?: FeedbackBook }> = [
      { query: 'spawn runner retries' },
      { query: 'lock chain ordering', files: ['src/locks/chain.ts'] },
      { query: 'unrelated billing' },
      { query: 'abcdefgh nothing matches', files: ['src/nowhere.ts'] },
      { query: 'ordering note', files: ['src/locks/chain.ts', 'src/runner.ts'] },
      // P2: the phase signal, checked through the SAME order-equality assertion as everything else.
      { query: 'review round shape', phase: '03.5' },
      { query: 'review round shape', phase: '07' },
    ]

    // ⚠ P3b: THE COUNTERS, CHECKED THE SAME WAY — and this case is why the assertion is worth having. The book
    // is keyed from the LOADER's source rather than a path written by hand: a hand-built key silently fails to
    // match, and a bonus that never applies is indistinguishable from a bonus that is not wired. Both
    // directions are exercised, because a reward and a penalty are different code paths in `feedbackBonus`.
    const loaded = loadMemoryIndex(root)
    const sourceOf = (title: string): string => loaded.find((e) => e.title === title)?.source ?? 'missing-' + title
    const feedbackCases: Array<{ query: string; feedback: FeedbackBook }> = [
      { query: 'spawn runner retries', feedback: { [sourceOf('Retry budget')]: { applied: 3, contradicted: 0 } } },
      { query: 'spawn runner retries', feedback: { [sourceOf('Retry budget')]: { applied: 0, contradicted: 2 } } },
      { query: 'ordering note', feedback: { [sourceOf('Lock chain ordering')]: { applied: 1, contradicted: 0 } } },
      { query: 'spawn runner retries', feedback: { 'memory/domains/nowhere.md': { applied: 9, contradicted: 0 } } },
    ]

    for (const options of [...optionSets, ...feedbackCases]) {
      const production = selectMemory(root, options).shards.map((shard) => shard.entry.title)
      const explained = explainMemorySelection(loadMemoryIndex(root), options).entries.map((e) => e.title)
      expect(explained, 'order must equal selectMemory for: ' + JSON.stringify(options)).toEqual(production)
    }
  })

  it('sums its components to the score, and shares the query component with production', () => {
    plane_()
    const query = 'spawn runner retries'
    const result = explainMemorySelection(loadMemoryIndex(root), { query })
    expect(result.entries.length).toBeGreaterThan(0)
    for (const item of result.entries) {
      const sum = item.components.reduce((total, c) => total + c.weight, 0)
      expect(sum, item.title + ' components must add up').toBe(item.score)
    }
    const retry = result.entries.find((e) => e.title === 'Retry budget')
    const explained = retry?.components.find((c) => c.name === 'query-match')?.weight
    const production = scoreMemoryEntry(
      entry('patterns', 'Retry budget', 'The spawn runner retries twice; the third attempt is dropped. See src/runner.ts.', 'x'),
      query,
    )
    expect(explained).toBe(production)
  })

  it('weights a matched path by the SAME exported constant production uses, and names the path', () => {
    const files = ['src/locks/chain.ts']
    // A whole-path match, which is production's rule: the segment alone would NOT match.
    const whole = explainMemorySelection(
      [entry('domains', 'Chain notes', 'The order lives in src/locks/chain.ts.', 'memory/domains/c.md')],
      { query: 'nothing at all matches', files },
    )
    const pathComponent = whole.entries[0].components.find((c) => c.name === 'path-overlap')
    expect(pathComponent?.weight).toBe(3)
    expect(pathComponent?.detail).toBe('src/locks/chain.ts')

    // …and a segment-only mention does NOT match, because production does not match it either.
    const segment = explainMemorySelection(
      [entry('domains', 'Chain notes', 'The order lives in chain.ts somewhere.', 'memory/domains/c.md')],
      { query: 'nothing at all matches', files },
    )
    expect(segment.entries).toEqual([])
    expect(segment.excluded.some((e) => e.reason.includes('no query match'))).toBe(true)
  })

  it('refuses to inject a RETIRED entry, and reports it instead of dropping it silently', () => {
    plane_()
    const result = explainMemorySelection(loadMemoryIndex(root), { query: 'spawn runner retried four times' })
    expect(result.entries.some((e) => e.title === 'Retired advice')).toBe(false)
    expect(result.excluded.find((e) => e.title === 'Retired advice')?.reason).toBe('status DEPRECATED is never injected')
    // STALE is retired too — the same marker, not a second list.
    expect(result.entries.some((e) => e.title === 'Stale ordering note')).toBe(false)
    expect(result.excluded.find((e) => e.title === 'Stale ordering note')?.reason).toBe('status STALE is never injected')
  })

  it('is deterministic: identical inputs produce byte-identical output', () => {
    plane_()
    const options = { query: 'lock chain ordering', files: ['src/locks/chain.ts'] }
    const entries = loadMemoryIndex(root)
    const a = explainMemorySelection(entries, options)
    const b = explainMemorySelection(entries, options)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))

    // ⚠ WHAT THIS DOES AND DOES NOT CLAIM, after the first version of it failed: the INCLUDED set is stable
    // under input reordering, because production tie-breaks on title. The EXCLUDED list is a diagnostic and
    // follows input order, so comparing it would be asserting something the module never promised.
    const reversed = explainMemorySelection([...entries].reverse(), options)
    expect(reversed.entries).toEqual(a.entries)
    expect([...reversed.excluded].sort((x, y) => x.title.localeCompare(y.title)))
      .toEqual([...a.excluded].sort((x, y) => x.title.localeCompare(y.title)))
  })

  it('honours production caps and reports what the budget kept out', () => {
    plane_()
    const options = { query: 'spawn runner retries lock chain ordering billing' }
    const production = selectMemory(root, { ...options, maxDocs: 2 }).shards.length
    const explained = explainMemorySelection(loadMemoryIndex(root), { ...options, maxDocs: 2 })
    expect(explained.entries.length).toBe(production)
    expect(explained.excluded.filter((e) => e.reason.includes('budget')).length).toBeGreaterThan(0)
  })

  it('renders the breakdown, and says why an empty result is empty', () => {
    plane_()
    const result = explainMemorySelection(loadMemoryIndex(root), { query: 'spawn runner retries' })
    expect(result.rendered).toContain('score ')
    expect(result.rendered).toContain('query-match')
    const empty = explainMemorySelection([], { query: 'anything' })
    expect(empty.entries).toEqual([])
    expect(empty.rendered).toContain('Do not assume the absence is conclusive')
  })
})
