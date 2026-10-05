/**
 * T29 — the run-start memory loader.
 *
 * The RED's clauses: a populated plane returns relevant shards ranked by the routing rules;
 * STALE/DEPRECATED are excluded; an empty plane returns nothing and **does not fabricate**. Plus the
 * two rules the parent's contract adds: **paths are the stronger signal**, and **progressive
 * disclosure** (never the whole plane).
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMemoryIndex, selectMemory, MAX_MEMORY_DOCS } from '../src/memory.ts'

/** A plane with one shard per kind; `body` is the shard's markdown. */
function plane(shards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-t29-'))
  // The registry lives IN `memory/`, so its directory must exist first — my own first version wrote
  // the file into a directory nobody had created.
  mkdirSync(join(root, 'memory'), { recursive: true })
  writeFileSync(join(root, 'memory', 'MEMORY.md'), '# Memory\n', 'utf8')
  for (const [kind, body] of Object.entries(shards)) {
    mkdirSync(join(root, 'memory', kind), { recursive: true })
    writeFileSync(join(root, 'memory', kind, 'shard.md'), body, 'utf8')
  }
  return root
}

const QUERY = 'the lock chain rejects an out-of-order artifact'

describe('T29 — a populated plane returns what is relevant', () => {
  it('ranks a matching shard above an unrelated one', () => {
    const root = plane({
      domains: '## Lock chain ordering\n\nThe lock chain rejects an out-of-order artifact transition.\n',
      patterns: '## Colour palette\n\nUnrelated guidance about palette selection.\n',
    })
    try {
      const selection = selectMemory(root, { query: QUERY })
      expect(selection.injected).toBe(true)
      expect(selection.shards.length).toBe(1)
      expect(selection.shards[0].entry.title).toContain('Lock chain')
      // The unrelated entry is not a weak match: a zero score is NO match.
      expect(selection.shards.map((shard) => shard.entry.title).join()).not.toContain('Colour')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('WEIGHTS PATHS HIGHER than wording, per the parent', () => {
    const root = plane({
      domains: '## Lock chain ordering\n\nThe lock chain rejects an out-of-order artifact.\n',
      patterns: '## Transition notes\n\nNotes about the lock chain and artifacts.\n',
    })
    try {
      // The query alone favours neither; the changed PATH decides.
      const selection = selectMemory(root, { query: 'lock chain artifact', files: ['src/phase-graph.ts', 'memory/domains/shard.md'] })
      expect(selection.shards[0].entry.source).toContain('domains')
      expect(selection.shards[0].matched.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('T29 — retired memory is never injected', () => {
  it('EXCLUDES an entry marked STALE or DEPRECATED', () => {
    const root = plane({
      domains: '## Old lock rule\n\nStatus: `DEPRECATED`\n\nThe lock chain used to allow out-of-order artifacts.\n',
      patterns: '## Current lock rule\n\nStatus: `ACTIVE`\n\nThe lock chain rejects an out-of-order artifact.\n',
    })
    try {
      const selection = selectMemory(root, { query: QUERY })
      expect(selection.shards.map((shard) => shard.entry.title)).toEqual(['Current lock rule'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('says nothing is injected when the ONLY match is retired', () => {
    const root = plane({
      domains: '## Old lock rule\n\nStatus: `STALE`\n\nThe lock chain rejects an out-of-order artifact.\n',
    })
    try {
      const selection = selectMemory(root, { query: QUERY })
      expect(selection.injected).toBe(false)
      expect(selection.shards).toEqual([])
      expect(selection.reason).toContain('rather than fabricating memory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('T29 — nothing relevant means NOTHING injected', () => {
  it('does not fabricate from an EMPTY plane', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-t29e-'))
    try {
      expect(loadMemoryIndex(root)).toEqual([])
      const selection = selectMemory(root, { query: QUERY })
      expect(selection.injected).toBe(false)
      expect(selection.shards).toEqual([])
      expect(selection.reason).toContain('empty')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not fabricate from a plane with no match — the parent’s rule verbatim', () => {
    const root = plane({ domains: '## Colour palette\n\nNothing about locks here.\n' })
    try {
      const selection = selectMemory(root, { query: QUERY })
      expect(selection.injected).toBe(false)
      expect(selection.shards).toEqual([])
      expect(selection.reason).toContain('rather than fabricating memory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('T29 — progressive disclosure: router first, then at most maxDocs', () => {
  it('CAPS the shards rather than injecting the whole plane', () => {
    const shards: Record<string, string> = {}
    for (let i = 0; i < 6; i++) {
      shards['domains'] = (shards['domains'] ?? '') + '## Lock chain note ' + i + '\n\nThe lock chain rejects an out-of-order artifact, note ' + i + '.\n\n'
    }
    const root = plane(shards)
    try {
      const all = selectMemory(root, { query: QUERY, maxDocs: 99 })
      expect(all.shards.length).toBeGreaterThan(MAX_MEMORY_DOCS)
      // The DEFAULT is the progressive-disclosure cap, not everything.
      const capped = selectMemory(root, { query: QUERY })
      expect(capped.shards.length).toBeLessThanOrEqual(MAX_MEMORY_DOCS)
      expect(capped.reason).toContain('capped at maxDocs')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
