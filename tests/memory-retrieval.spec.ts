/**
 * T14 — memory retrieval into the review bundle.
 *
 * The properties pinned here are the ones that keep retrieval TRUSTWORTHY: the same inputs always
 * give the same selection (a reviewer whose context shuffles cannot be compared with itself), an
 * unrelated note is EXCLUDED rather than ranked last (padding costs attention for nothing), and an
 * empty result SAYS it is not conclusive rather than reading as "nothing was ever learned".
 */
import { describe, it, expect } from 'vitest'
import {
  parseMemoryEntries, scoreMemoryEntry, retrieveMemory, readMemoryEntries, renderMemorySection,
  DEFAULT_MEMORY_LIMIT, MEMORY_KINDS, type MemoryEntry,
} from '../src/memory.ts'

function entry(kind: string, title: string, body: string, source = kind + '.md'): MemoryEntry {
  return { kind, title, body, source }
}

describe('T14 — a memory document becomes titled entries', () => {
  it('splits at headings and keeps the body with its title', () => {
    const entries = parseMemoryEntries('patterns', '# Lock ordering\nAlways lock upstream first.\n\n## Retries\nBound them.', 'patterns.md')
    expect(entries.map((e) => e.title)).toEqual(['Lock ordering', 'Retries'])
    expect(entries[0].body).toContain('upstream first')
    expect(entries[1].body).toContain('Bound them')
    expect(entries[0].kind).toBe('patterns')
    expect(entries[0].source).toBe('patterns.md')
  })

  it('keeps a document with NO headings as one entry', () => {
    // A memory file written as a single paragraph is still memory; dropping it for lacking
    // structure would lose exactly the notes a hurried run leaves behind.
    const entries = parseMemoryEntries('episodes', 'We tried X and it failed because Y.', 'episodes.md')
    expect(entries.length).toBe(1)
    expect(entries[0].body).toContain('failed because Y')
  })

  it('ignores an empty document rather than inventing an entry', () => {
    expect(parseMemoryEntries('domains', '   \n\n', 'domains.md')).toEqual([])
  })
})

describe('T14 — retrieval is deterministic and explainable', () => {
  const entries = [
    entry('patterns', 'Lock ordering', 'Always lock the upstream phase first.'),
    entry('episodes', 'Vacuous test', 'A test that asserts nothing passed CI for a week.'),
    entry('domains', 'Billing', 'Invoices and proration.'),
    entry('skills', 'Lock ordering checklist', 'Check upstream locks before locking.'),
  ]

  it('ranks title matches above body-only matches', () => {
    // A term in the title is what the note is ABOUT; a body-only term may be incidental.
    const ranked = retrieveMemory(entries, 'lock ordering upstream')
    expect(ranked[0].title).toBe('Lock ordering')
    expect(ranked.map((e) => e.title)).toContain('Lock ordering checklist')
    // The unrelated domain note is not in the result at all.
    expect(ranked.map((e) => e.title)).not.toContain('Billing')
  })

  it('is STABLE: the same inputs always select the same entries, in the same order', () => {
    const first = retrieveMemory(entries, 'lock').map((e) => e.title)
    const second = retrieveMemory(entries, 'lock').map((e) => e.title)
    expect(first).toEqual(second)
    // Ties break by document order, not by chance.
    const tied = retrieveMemory([entry('a', 'same', 'x'), entry('b', 'same', 'x')], 'same')
    expect(tied.map((e) => e.kind)).toEqual(['a', 'b'])
  })

  it('EXCLUDES an unrelated note rather than ranking it last', () => {
    // Padding a reviewer's context with an unrelated note costs attention and buys nothing.
    expect(retrieveMemory(entries, 'billing').map((e) => e.title)).toEqual(['Billing'])
    expect(retrieveMemory(entries, 'zzzz')).toEqual([])
  })

  it('honours the limit, and a limit of zero means zero', () => {
    expect(retrieveMemory(entries, 'lock', 1).length).toBe(1)
    expect(retrieveMemory(entries, 'lock', 0)).toEqual([])
    expect(retrieveMemory(entries, 'lock').length).toBeLessThanOrEqual(DEFAULT_MEMORY_LIMIT)
  })

  it('scores nothing for an empty or trivial query', () => {
    expect(scoreMemoryEntry(entries[0], '')).toBe(0)
    // Terms shorter than three characters are ignored, so a stray "a" matches nothing.
    expect(scoreMemoryEntry(entries[0], 'a')).toBe(0)
  })
})

describe('T14 — reading the plugin’s own memory layer', () => {
  it('reads every kind through the injected readers, in kind order', () => {
    const files: Record<string, string> = {
      '/m/patterns/p1.md': '# P1\nbody one',
      '/m/domains/d1.md': '# D1\nbody two',
    }
    const entries = readMemoryEntries(
      (path) => files[path] ?? null,
      (kind) => Object.keys(files).filter((path) => path.includes('/' + kind + '/')),
    )
    expect(entries.map((e) => e.title)).toEqual(['D1', 'P1'])
    expect(entries.map((e) => e.kind)).toEqual(['domains', 'patterns'])
  })

  it('treats an unreadable or empty file as absent, never as an error', () => {
    // A missing memory directory is a missing advantage, not a failed review.
    const entries = readMemoryEntries(() => null, () => ['/m/patterns/missing.md'])
    expect(entries).toEqual([])
    const blank = readMemoryEntries(() => '   ', () => ['/m/patterns/blank.md'])
    expect(blank).toEqual([])
  })

  it('names the kinds it knows, so the layout is not discovered by shell', () => {
    expect([...MEMORY_KINDS]).toEqual(['domains', 'patterns', 'episodes', 'skills'])
  })
})

describe('T14 — the bundle section is honest about an empty result', () => {
  it('renders titles a reviewer can CITE, with their source', () => {
    const rendered = renderMemorySection([entry('patterns', 'Lock ordering', 'Lock upstream first.', '/m/patterns/p1.md')])
    expect(rendered).toContain('[patterns] Lock ordering')
    expect(rendered).toContain('Lock upstream first.')
    expect(rendered).toContain('/m/patterns/p1.md')
    expect(rendered).toContain('cite by title')
  })

  it('says an empty result is NOT conclusive, rather than reading as "nothing was learned"', () => {
    const rendered = renderMemorySection([])
    expect(rendered).toContain('No prior-run memory matched')
    expect(rendered).toContain('not by recency')
  })
})
