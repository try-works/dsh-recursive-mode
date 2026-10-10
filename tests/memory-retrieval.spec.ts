/**
 * T14 — memory retrieval into the review bundle.
 *
 * The properties pinned here are the ones that keep retrieval TRUSTWORTHY: the same inputs always
 * give the same selection (a reviewer whose context shuffles cannot be compared with itself), an
 * unrelated note is EXCLUDED rather than ranked last (padding costs attention for nothing), and an
 * empty result SAYS it is not conclusive rather than reading as "nothing was ever learned".
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
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
    // ⚠ `training` IS PART OF THE LAYOUT, not an addition to it: `bootstrap.ts` scaffolds
    // `.recursive/memory/training/`, the shipped router documents it as a shard kind, and the phase-8
    // trigger writes `memory/training/<task-type>.md` and registers that path in `MEMORY.md`. Leaving it
    // out of this list made the trigger's own output unreadable by the plugin's loader.
    expect([...MEMORY_KINDS]).toEqual(['domains', 'patterns', 'episodes', 'training', 'skills'])
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

/**
 * T14 — THE ACCEPTANCE: a reviewer actually RECEIVES the memory.
 *
 * Asserted by reading the written bundle FILE, because the prompt references the bundle by path —
 * so the only place a section can be seen by the reviewer is inside that document. A test that
 * checked the prompt instead would pass while the reviewer saw nothing.
 */
describe('T14 — the bundle the reviewer reads carries the retrieved memory', () => {
  function makeRootWithMemory(): string {
    const root = mkdtempSync(join(tmpdir(), 'rm-t14-'))
    const runDir = join(root, '.recursive', 'run', 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '03-implementation-summary.md'), '# Impl\n\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n', 'utf8')
    // A prior-run note that MATCHES the review's phase/role query, and one that does not.
    mkdirSync(join(root, '.recursive', 'memory', 'patterns'), { recursive: true })
    writeFileSync(
      join(root, '.recursive', 'memory', 'patterns', 'locking.md'),
      '# Lock ordering\nAlways lock the upstream phase before implementation.\n',
      'utf8',
    )
    mkdirSync(join(root, '.recursive', 'memory', 'domains'), { recursive: true })
    writeFileSync(join(root, '.recursive', 'memory', 'domains', 'billing.md'), '# Billing\nInvoices.\n', 'utf8')
    return root
  }

  it('writes the memory section into the bundle body, with its source', async () => {
    const root = makeRootWithMemory()
    const ctx = new Context()
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root })
      await runtime.delegateReview({
        root,
        runId: 'run-1',
        phase: '03-implementation-summary',
        role: 'code-reviewer',
        delegationId: 'd1',
        childId: 'c1',
        artifactPath: join(root, '.recursive', 'run', 'run-1', '03-implementation-summary.md'),
        upstreamArtifacts: [],
        auditQuestions: ['does the implementation summary hold up?'],
        requiredOutput: 'verdict',
        mode: 'continuable',
        parent: {},
        providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
        subagents: {
          startContinuable: async () => ({ childId: 'c1', messageId: 'm1' }),
          followup: async () => ({ messageId: 'm2' }),
        },
        awaitRoundResult: async () => null,
      } as never)
      const bundleDir = join(root, '.recursive', 'run', 'run-1', 'evidence', 'review-bundles')
      const bundleFile = readdirSync(bundleDir).find((name) => name.endsWith('-bundle.md'))
      expect(bundleFile).toBeDefined()
      const bundle = readFileSync(join(bundleDir, bundleFile as string), 'utf8')
      // The reviewer can READ the rule and CITE it, which is what "compounds rather than resets" means.
      expect(bundle).toContain('## Prior-run memory')
      expect(bundle).toContain('Lock ordering')
      expect(bundle).toContain('lock the upstream phase')
      expect(bundle).toContain('locking.md')
      // And the unrelated note is absent: padding costs attention and buys nothing.
      expect(bundle).not.toContain('Invoices.')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('adds NO memory section when nothing matches, so an empty result is not dressed up', async () => {
    const root = makeRootWithMemory()
    // Remove the memory layer entirely: a composition with no memory must produce a clean bundle.
    rmSync(join(root, '.recursive', 'memory'), { recursive: true, force: true })
    const ctx = new Context()
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root })
      await runtime.delegateReview({
        root,
        runId: 'run-1',
        phase: '03-implementation-summary',
        role: 'code-reviewer',
        delegationId: 'd1',
        childId: 'c1',
        artifactPath: join(root, '.recursive', 'run', 'run-1', '03-implementation-summary.md'),
        upstreamArtifacts: [],
        auditQuestions: ['does it hold up?'],
        requiredOutput: 'verdict',
        mode: 'continuable',
        parent: {},
        providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
        subagents: {
          startContinuable: async () => ({ childId: 'c1', messageId: 'm1' }),
          followup: async () => ({ messageId: 'm2' }),
        },
        awaitRoundResult: async () => null,
      } as never)
      const bundleDir = join(root, '.recursive', 'run', 'run-1', 'evidence', 'review-bundles')
      const bundleFile = readdirSync(bundleDir).find((name) => name.endsWith('-bundle.md'))
      const bundle = readFileSync(join(bundleDir, bundleFile as string), 'utf8')
      expect(bundle).not.toContain('## Prior-run memory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
