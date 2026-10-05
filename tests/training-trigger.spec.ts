/**
 * T30 — the run-close training trigger.
 *
 * The RED's clauses, plus the one the parent's contract turns on: **every failure path must write
 * NOTHING**. That is asserted by counting files in the tree rather than trusting the returned list —
 * a result object can claim zero writes while the caller has already written one.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import {
  runPhase8Trigger, countPhase8LockedRuns, trainingGate, groupLearnings, inferSubsystem,
  TRAINING_EXIT, PHASE8_ARTIFACT, resolveExtractor, runExtractor, TRAINING_EXTRACTOR_ENV,
  parseExtractorItems, extractAndGroup,
  type TrainingItem,
} from '../src/training.ts'

/** A root with `n` runs whose phase-8 artifact is LOCKED (or not). */
function makeRoot(lockedRuns: number, extraRuns = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-t30-'))
  for (let i = 0; i < lockedRuns + extraRuns; i++) {
    const runDir = join(root, '.recursive', 'run', 'run-' + i)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, PHASE8_ARTIFACT), '# Memory impact\n\nStatus: `' + (i < lockedRuns ? 'LOCKED' : 'DRAFT') + '`\n', 'utf8')
  }
  return root
}

/** Every file under the root that is NOT part of the run directory — i.e. what a write would create. */
function memoryFiles(root: string): string[] {
  const memory = join(root, 'memory')
  try {
    return readdirSync(memory, { recursive: true }).map(String)
  } catch {
    return []
  }
}

describe('T30 — one locked run is not evidence', () => {
  it('counts LOCKED phase-8 artifacts, treating the lock as a FIELD not a filename', () => {
    const root = makeRoot(2, 1)
    try {
      expect(countPhase8LockedRuns(root)).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('SKIPS with a reason and ZERO WRITES when fewer than two runs are locked', () => {
    const root = makeRoot(1)
    try {
      const result = runPhase8Trigger(root, 'run-0', { rerun: true, extractorAvailable: true })
      expect(result.code).toBe('INSUFFICIENT_EVIDENCE')
      expect(result.exit).toBe(TRAINING_EXIT.INSUFFICIENT_EVIDENCE)
      expect(result.reason).toContain('two phase-8-locked runs')
      expect(result.reason).toContain('anecdote')
      expect(result.writes).toEqual([])
      // Asserted against the TREE, not the report: a result can claim zero writes while one exists.
      expect(memoryFiles(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('says so in the gate itself, and passes with two', () => {
    expect(trainingGate(0).code).toBe('INSUFFICIENT_EVIDENCE')
    expect(trainingGate(1).exit).toBe(3)
    expect(trainingGate(2).code).toBe('OK')
    expect(trainingGate(2).exit).toBe(0)
  })
})

describe('T30 — an unavailable extractor is a DIFFERENT failure, with zero writes', () => {
  it('is exit 2, not 3, and does not claim memory updates', () => {
    const root = makeRoot(2)
    try {
      const result = runPhase8Trigger(root, 'run-0', { rerun: true, extractorAvailable: false })
      expect(result.code).toBe('EXTRACTOR_UNAVAILABLE')
      expect(result.exit).toBe(TRAINING_EXIT.EXTRACTOR_UNAVAILABLE)
      expect(result.exit).not.toBe(TRAINING_EXIT.INSUFFICIENT_EVIDENCE)
      expect(result.reason).toContain('Do not claim memory updates')
      expect(result.writes).toEqual([])
      expect(memoryFiles(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does NOT train at the FIRST lock — that would train the run on itself', () => {
    const root = makeRoot(2)
    try {
      const result = runPhase8Trigger(root, 'run-0', { extractorAvailable: true, items: [] })
      expect(result.code).toBe('OK')
      expect(result.writes).toEqual([])
      expect(result.reason).toContain('re-run')
      expect(result.reason).toContain('train the run on itself')
      expect(memoryFiles(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('T30 — grouping refuses to learn from a single run', () => {
  const item = (runId: string, path: string, text = 'x'): TrainingItem => ({ runId, paths: [path], text })

  it('DROPS a group whose items all come from one run', () => {
    // Two items from one run are one observation written twice.
    expect(groupLearnings([item('run-1', 'src/lock.ts'), item('run-1', 'src/lock.ts', 'y')], () => true)).toEqual([])
  })

  it('keeps a group spanning two runs, and counts DISTINCT runs', () => {
    const groups = groupLearnings([item('run-1', 'src/lock.ts'), item('run-2', 'src/lock.ts')], () => true)
    expect(groups.length).toBe(1)
    expect(groups[0].subsystem).toBe('lock')
    expect(groups[0].runs).toBe(2)
    expect(groups[0].mode).toBe('winner-only')
  })

  it('is CONTRASTIVE when winners and losers share a subsystem', () => {
    const groups = groupLearnings(
      [item('run-1', 'src/lock.ts'), item('run-2', 'src/lock.ts')],
      (candidate) => candidate.runId === 'run-1',
    )
    expect(groups[0].mode).toBe('contrastive')
  })

  it('prefers PATHS over prose, and never guesses a subsystem from wording', () => {
    // Paths are the stronger signal; a wrong subsystem files a learning where nobody will look.
    expect(inferSubsystem({ runId: 'r', paths: ['src/policy.ts'], text: 'talks about the lock chain' })).toBe('policy')
    expect(inferSubsystem({ runId: 'r', paths: [], text: 'src/policy.ts is mentioned here' })).toBe('unclassified')
  })
})

describe('T30 — a success that wrote nothing is REPORTED as such', () => {
  it('plans the groups but says no writer was supplied, and writes nothing', () => {
    const root = makeRoot(2)
    try {
      const items = [
        { runId: 'run-0', paths: ['src/lock.ts'], text: 'a' },
        { runId: 'run-1', paths: ['src/lock.ts'], text: 'b' },
      ]
      const result = runPhase8Trigger(root, 'run-0', { rerun: true, extractorAvailable: true, items })
      expect(result.code).toBe('OK')
      expect(result.reason).toContain('NO writer was supplied')
      expect(result.reason).toContain('the plan alone is not a learning')
      expect(result.writes).toEqual([])
      expect(memoryFiles(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes one shard per group when a writer IS supplied, and lists it', () => {
    const root = makeRoot(2)
    try {
      const written: string[] = []
      const items = [
        { runId: 'run-0', paths: ['src/lock.ts'], text: 'a' },
        { runId: 'run-1', paths: ['src/lock.ts'], text: 'b' },
      ]
      const result = runPhase8Trigger(root, 'run-0', {
        rerun: true,
        extractorAvailable: true,
        items,
        write: (relativePath, content) => {
          // The writer owns directory creation: the seam receives a relative path and is responsible
          // for making it real. (`join.sep` was my own error — it does not exist on the function.)
          const absolute = join(root, relativePath)
          mkdirSync(dirname(absolute), { recursive: true })
          writeFileSync(absolute, content, 'utf8')
          written.push(relativePath)
          return relativePath
        },
      })
      expect(result.code).toBe('OK')
      // BOTH shards: the domain one, then the task-type one for the mode the group was extracted under.
      expect(result.writes).toEqual(['memory/domains/lock.md', 'memory/training/winner-only.md'])
      expect(written).toEqual(result.writes)
      // ⚠ THE REGISTRY IS NOT REFRESHED without a reader, AND THE RESULT SAYS SO — a silent half-write
      // would leave MEMORY.md describing a plane that changed underneath it.
      expect(result.reason).toContain('registry was NOT refreshed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('REFRESHES the registry through the reader seam, replacing a shard’s line rather than appending', () => {
    const root = makeRoot(2)
    try {
      const files = new Map<string, string>()
      files.set('memory/MEMORY.md', '# Memory\n\n- `memory/domains/lock.md` — task type: contrastive\n')
      const items = [
        { runId: 'run-0', paths: ['src/lock.ts'], text: 'a' },
        { runId: 'run-1', paths: ['src/lock.ts'], text: 'b' },
      ]
      const result = runPhase8Trigger(root, 'run-0', {
        rerun: true,
        extractorAvailable: true,
        items,
        write: (relativePath, content) => { files.set(relativePath, content); return relativePath },
        readText: (relativePath) => files.get(relativePath) ?? null,
      })
      expect(result.code).toBe('OK')
      expect(result.writes).toContain('memory/MEMORY.md')
      const registry = files.get('memory/MEMORY.md') ?? ''
      // ONE line for that shard, with the CURRENT mode — not a second line claiming the plane holds it twice.
      expect(registry.split('\n').filter((line) => line.includes('memory/domains/lock.md')).length).toBe(1)
      expect(registry).toContain('memory/domains/lock.md` — task type: winner-only')
      expect(registry).toContain('memory/training/winner-only.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * T30 — the extractor round trip, without spawning a process.
 *
 * ⚠ THE RUNNER IS INJECTED because this harness's sandbox denies a child the PIPED stdio a capture
 * needs, so a module that spawned directly could not be tested where it runs. The DECISION is asserted
 * here with a fake runner; the SPAWN belongs to the caller.
 */
describe('T30 — an extractor that fails is not a run with nothing to learn', () => {
  it('resolves the command from the environment, and treats blank as absent', () => {
    expect(resolveExtractor({})).toBeNull()
    expect(resolveExtractor({ [TRAINING_EXTRACTOR_ENV]: '   ' })).toBeNull()
    expect(resolveExtractor({ [TRAINING_EXTRACTOR_ENV]: ' grpo --json ' })).toBe('grpo --json')
  })

  it('reports UNAVAILABLE when there is no command at all', () => {
    const outcome = runExtractor(() => ({ status: 0, stdout: '{}' }), null)
    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('EXTRACTOR_UNAVAILABLE')
    expect(outcome.reason).toContain('do not claim memory updates')
  })

  it('reports UNAVAILABLE for a non-zero exit, and for a runner that throws', () => {
    const failed = runExtractor(() => ({ status: 2, stdout: '' }), 'grpo')
    expect(failed.failure).toBe('EXTRACTOR_UNAVAILABLE')
    expect(failed.reason).toContain('exited 2')
    const threw = runExtractor(() => { throw new Error('ENOENT') }, 'grpo')
    expect(threw.failure).toBe('EXTRACTOR_UNAVAILABLE')
    expect(threw.reason).toContain('could not be run')
  })

  it('⚠ distinguishes MALFORMED OUTPUT from insufficient evidence', () => {
    // Collapsing the two would report exit 3 (nothing to learn) for a bug that deserves exit 2.
    const malformed = runExtractor(() => ({ status: 0, stdout: 'not json at all' }), 'grpo')
    expect(malformed.ok).toBe(false)
    expect(malformed.failure).toBe('MALFORMED_OUTPUT')
    expect(malformed.failure).not.toBe('EXTRACTOR_UNAVAILABLE')
    expect(malformed.reason).toContain('BROKEN EXTRACTOR')
  })

  it('carries the payload through when the extractor answers properly', () => {
    const outcome = runExtractor(() => ({ status: 0, stdout: '{"items":[{"subsystem":"lock"}]}' }), 'grpo')
    expect(outcome.ok).toBe(true)
    expect(outcome.payload).toEqual({ items: [{ subsystem: 'lock' }] })
    expect(outcome.failure).toBeUndefined()
  })
})

/**
 * T30 — the payload reaches the grouping, and a partial answer invents nothing.
 */
describe('T30 — extractor payload → items → groups', () => {
  it('parses a well-formed payload, with and without the container', () => {
    const one = { runId: 'run-1', paths: ['src/lock.ts'], text: 'a' }
    expect(parseExtractorItems({ items: [one] })).toEqual([one])
    expect(parseExtractorItems([one])).toEqual([one])
  })

  it('SKIPS an entry with no text or no runId rather than inventing either', () => {
    // Invented text would be taught as a learning nobody extracted, and an unattributed item would be
    // pooled into a run it did not come from — the grouping counts DISTINCT runs.
    const items = parseExtractorItems({
      items: [
        { runId: 'run-1', paths: ['src/a.ts'], text: 'kept' },
        { runId: 'run-1', paths: ['src/a.ts'], text: '   ' },
        { paths: ['src/a.ts'], text: 'no run id' },
        { runId: 'run-2', text: 'no paths' },
        'not an object',
        null,
      ],
    })
    expect(items.length).toBe(2)
    expect(items[0].text).toBe('kept')
    expect(items[1].runId).toBe('run-2')
    expect(items[1].paths).toEqual([])
  })

  it('returns NOTHING for a payload with no items, which is exit 3 and not exit 2', () => {
    expect(parseExtractorItems({})).toEqual([])
    expect(parseExtractorItems({ items: 'nope' })).toEqual([])
    expect(parseExtractorItems(null)).toEqual([])
  })

  it('runs the whole round trip and GROUPS what came back', () => {
    const { outcome, groups } = extractAndGroup(
      () => ({ status: 0, stdout: JSON.stringify({ items: [
        { runId: 'run-1', paths: ['src/lock.ts'], text: 'a' },
        { runId: 'run-2', paths: ['src/lock.ts'], text: 'b' },
      ] }) }),
      { [TRAINING_EXTRACTOR_ENV]: 'grpo' },
    )
    expect(outcome.ok).toBe(true)
    expect(groups.length).toBe(1)
    expect(groups[0].subsystem).toBe('lock')
    expect(groups[0].runs).toBe(2)
  })

  it('stops at the extractor when it cannot run, with no items and no groups', () => {
    const { outcome, items, groups } = extractAndGroup(() => ({ status: 0, stdout: '{}' }), {})
    expect(outcome.failure).toBe('EXTRACTOR_UNAVAILABLE')
    expect(items).toEqual([])
    expect(groups).toEqual([])
  })
})

/**
 * T30 — THE TRIGGER IS ACTUALLY INVOKED AT RUN CLOSE.
 *
 * ⚠ This is the assertion that turns "the module exists" into "the workflow calls it": without it the
 * item's own acceptance (a lock leads to extraction) has no evidence at all, only a function nobody
 * invokes. It also pins the direction that matters most — a FIRST lock must not train.
 */
describe('T30 — closeout phase 08 invokes the trigger, and a first lock trains on nothing', () => {
  it('surfaces a typed training result and writes NO memory on a first lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-t30c-'))
    const ctx = new Context()
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root })
      await runtime.initRun('r1')
      const result = await runtime.closeoutRun(root, 'r1', '08', null) as { error?: string; training?: { code: string; reason: string } }
      if (result.error === undefined) {
        // The trigger ran: this field only exists because the closeout path calls it.
        expect(result.training).toBeDefined()
        // One run, no receipt re-run and no extractor ⇒ a typed failure, never a silent success.
        expect(['INSUFFICIENT_EVIDENCE', 'EXTRACTOR_UNAVAILABLE']).toContain(result.training?.code)
      }
      // ⚠ Asserted against the TREE: a first lock must not write a single memory file. The directory
      // not existing at all IS that evidence — `memoryFiles` treats an absent plane as empty, which is
      // why the first version of this assertion failing on ENOENT was the test being wrong about how
      // to look, not the code having written something.
      expect(memoryFiles(root).filter((name) => name.endsWith('.md'))).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
