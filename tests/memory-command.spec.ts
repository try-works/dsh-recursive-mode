import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { executeRecursiveCommand } from '../src/commands.ts'
import { FEEDBACK_FILE } from '../src/memory-feedback.ts'
import { loadMemoryIndex } from '../src/memory.ts'

/**
 * FU-13 P4 — THE SELECTOR RUNS FROM THE COMMAND SURFACE, WITH NO AGENT LOOP.
 *
 * What these tests hold to account: the verb reaches the real selector, prints the SCORE COMPONENTS (so "why
 * did the agent get this?" is answerable from a shell rather than only from a test), passes the counters in,
 * reports what it excluded, and refuses an empty query.
 *
 * ⚠ AND ONE FIXTURE LESSON, learned by failing: key the feedback book from `loadMemoryIndex(...).source`
 * rather than by constructing a path. The source is whatever the loader reports, and a hand-built path
 * silently fails to match - which looked exactly like a broken wiring and was not one.
 */
describe('FU-13 P4: the memory verb', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-memory-verb-'))
    mkdirSync(join(root, 'memory', 'domains'), { recursive: true })
    writeFileSync(join(root, 'memory', 'domains', 'locks.md'),
      '## Lock chain ordering\n\nThe lock chain orders receipts by phase. See src/locks/chain.ts.\n', 'utf8')
    writeFileSync(join(root, 'memory', 'domains', 'retired.md'),
      '## Retired note\n\nStatus: `DEPRECATED`\n\nThe lock chain used to order differently.\n', 'utf8')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('prints the selected entries WITH their score components', () => {
    const result = executeRecursiveCommand(root, 'memory lock chain ordering phase')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('cite by title')
    expect(result.text).toContain('Lock chain ordering')
    expect(result.text).toContain('score ')
    expect(result.text).toContain('query-match')
  })

  it('reports what it EXCLUDED rather than silently ranking less', () => {
    const result = executeRecursiveCommand(root, 'memory lock chain ordering')
    expect(result.text).toContain('Excluded')
    expect(result.text).toContain('Retired note')
    expect(result.text).toContain('DEPRECATED')
  })

  it('passes the counters IN, so a reinforced entry leads from the command surface too', () => {
    // Two shards with the SAME body, so only the counters can separate them; sources read from the loader.
    writeFileSync(join(root, 'memory', 'domains', 'other.md'),
      '## Zeta note\n\nThe lock chain orders receipts by phase. See src/locks/chain.ts.\n', 'utf8')
    const zeta = loadMemoryIndex(root).find((e) => e.title === 'Zeta note')?.source ?? 'x'
    expect(zeta, 'the loader must report a source to key the book by').not.toBe('x')

    const plain = executeRecursiveCommand(root, 'memory orders receipts phase')
      // The counter lives under the `.recursive` control plane now, so the fixture must create that
    // directory before writing into it — a scratch repo has no memory plane until something makes
    // one. The path itself comes from the module constant, so this fixture follows the source.
    mkdirSync(join(root, '.recursive', 'memory'), { recursive: true })
    writeFileSync(join(root, FEEDBACK_FILE), JSON.stringify({ [zeta]: { applied: 3, contradicted: 0 } }), 'utf8')
    const favoured = executeRecursiveCommand(root, 'memory orders receipts phase')

    // Without counters the tie-break decides; WITH them the reinforced shard leads - the assertion that
    // fails if the verb forgets to hand the book to the selector.
    const plainFirst = (plain.text ?? '').split('\n').find((line) => line.startsWith('### '))
    expect(plainFirst, 'without counters the title tie-break decides').toContain('Lock chain ordering')
    const firstHeading = (favoured.text ?? '').split('\n').find((line) => line.startsWith('### '))
    expect(firstHeading, 'the reinforced shard must lead').toContain('Zeta note')
    expect(favoured.text ?? '', 'and the reason must be named').toContain('feedback')
  })

  it('refuses an empty query, and says so when the plane is empty', () => {
    const noQuery = executeRecursiveCommand(root, 'memory')
    expect(noQuery.kind).toBe('error')
    expect(noQuery.text).toContain('requires a query')

    const bare = mkdtempSync(join(tmpdir(), 'rm-memory-verb-bare-'))
    try {
      const empty = executeRecursiveCommand(bare, 'memory anything at all')
      expect(empty.kind).toBe('success')
      expect(empty.text).toContain('memory plane is empty')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('accepts --phase without leaking the flag into the query', () => {
    const withFlag = executeRecursiveCommand(root, 'memory lock chain ordering --phase 04')
    expect(withFlag.kind).toBe('success')
    expect(withFlag.text).toContain('Lock chain ordering')
  })
})
