/**
 * T29 — the run-start memory loader.
 *
 * The RED's clauses: a populated plane returns relevant shards ranked by the routing rules;
 * STALE/DEPRECATED are excluded; an empty plane returns nothing and **does not fabricate**. Plus the
 * two rules the parent's contract adds: **paths are the stronger signal**, and **progressive
 * disclosure** (never the whole plane).
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
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

/**
 * T29 — THE INJECTION RIDES THE EXISTING ONCE-GATE.
 *
 * ⚠ The item is explicit that there must be ONE dedupe mechanism, not two. `recursive.phaseRules` is
 * the call `recursive_phase` makes once per phase entry, so the memory section rides ITS return rather
 * than a mechanism added beside it — asserted here on the runtime call a tool actually makes.
 */
describe('T29 — the injection point is the phase-entry call, and it injects nothing when nothing matches', () => {
  async function mount(): Promise<{ runtime: RecursiveRuntime; root: string; dispose: () => Promise<void> }> {
    const root = mkdtempSync(join(tmpdir(), 'rm-t29i-'))
    const ctx = new Context()
    const runtime = new RecursiveRuntime(ctx, { repoRoot: root })
    await runtime.initRun('r1')
    return { runtime, root, dispose: async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) } }
  }

  it('returns an EMPTY memory section when the plane has nothing relevant', async () => {
    const m = await mount()
    try {
      const rules = await m.runtime.phaseRules('r1')
      expect(rules).not.toBeNull()
      // No section, and a reason that says why — rather than a section that fabricates relevance.
      expect(rules?.memory).toBe('')
      expect(rules?.memoryReason).toContain('empty')
    } finally {
      await m.dispose()
    }
  })

  it('carries a rendered section ON THE SAME CALL once the plane has something relevant', async () => {
    const m = await mount()
    try {
      // A plane entry matching the run's own requirements text, which is the injection query.
      mkdirSync(join(m.root, 'memory', 'domains'), { recursive: true })
      const requirements = readFileSync(join(m.root, '.recursive', 'run', 'r1', '00-requirements.md'), 'utf8')
      const term = requirements.split(/\s+/).filter((word) => word.length > 5)[0] ?? 'requirements'
      writeFileSync(
        join(m.root, 'memory', 'domains', 'shard.md'),
        '## Prior learning\n\nThis run concerns ' + term + ' and its ordering rules.\n',
        'utf8',
      )
      const rules = await m.runtime.phaseRules('r1')
      expect(rules?.memoryReason).toContain('injected 1')
      expect(rules?.memory).toContain('Prior learning')
    } finally {
      await m.dispose()
    }
  })

  /**
   * ⚠ THE MEASURED DEFECT THIS PINS, and it is why the whole temporal axis was dead in live runs.
   *
   * The loader joined `memory/<kind>/` straight onto the root it was handed, so it read
   * `<root>/memory/domains/` — a directory NO WORKSPACE HAS — while `bootstrap.ts` created the plane at
   * `<root>/.recursive/memory/domains/`, `ts-lint.ts` linted it there, and the review bundle read it
   * there. `selectMemory` therefore reported "the memory plane is empty" over a full plane, on every
   * phase of every run, and the shards the phase-8 trigger writes were unreachable by the loader that
   * is supposed to score them.
   */
  it('reads the SCAFFOLDED plane at .recursive/memory/, which is where bootstrap puts it', async () => {
    const m = await mount()
    try {
      mkdirSync(join(m.root, '.recursive', 'memory', 'domains'), { recursive: true })
      const requirements = readFileSync(join(m.root, '.recursive', 'run', 'r1', '00-requirements.md'), 'utf8')
      const term = requirements.split(/\s+/).filter((word) => word.length > 5)[0] ?? 'requirements'
      writeFileSync(
        join(m.root, '.recursive', 'memory', 'domains', 'shard.md'),
        '## Prior learning from the scaffolded plane\n\nThis run concerns ' + term + ' and its ordering rules.\n',
        'utf8',
      )
      const rules = await m.runtime.phaseRules('r1')
      expect(rules?.memoryReason).toContain('injected 1')
      expect(rules?.memory).toContain('Prior learning from the scaffolded plane')
    } finally {
      await m.dispose()
    }
  })

  it('PREFERS the scaffolded plane per kind and never merges the earlier root into it', async () => {
    const m = await mount()
    try {
      const requirements = readFileSync(join(m.root, '.recursive', 'run', 'r1', '00-requirements.md'), 'utf8')
      const term = requirements.split(/\s+/).filter((word) => word.length > 5)[0] ?? 'requirements'
      const body = (title: string) => '## ' + title + '\n\nThis run concerns ' + term + ' and its ordering rules.\n'
      mkdirSync(join(m.root, '.recursive', 'memory', 'domains'), { recursive: true })
      mkdirSync(join(m.root, 'memory', 'domains'), { recursive: true })
      writeFileSync(join(m.root, '.recursive', 'memory', 'domains', 'shard.md'), body('Scaffolded plane'), 'utf8')
      writeFileSync(join(m.root, 'memory', 'domains', 'shard.md'), body('Beside the plane'), 'utf8')

      const selection = selectMemory(m.root, { query: term })
      // ONE answer, not two: the current location wins, and the earlier one is consulted only when the
      // current one has nothing for that kind. Two snapshots of one shard added together would count a
      // shard twice and a duplicated shard would outrank a real one — the rule `readFeedback` follows.
      expect(selection.shards.length).toBe(1)
      expect(selection.shards[0]?.entry.title).toBe('Scaffolded plane')
      expect(selection.shards[0]?.entry.source).toContain('.recursive')
    } finally {
      await m.dispose()
    }
  })
})
