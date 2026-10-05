/**
 * T30 — the run-close training trigger.
 *
 * The RED's clauses, plus the one the parent's contract turns on: **every failure path must write
 * NOTHING**. That is asserted by counting files in the tree rather than trusting the returned list —
 * a result object can claim zero writes while the caller has already written one.
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  runPhase8Trigger, countPhase8LockedRuns, trainingGate, groupLearnings, inferSubsystem,
  TRAINING_EXIT, PHASE8_ARTIFACT, type TrainingItem,
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
      expect(result.writes).toEqual(['memory/domains/lock.md'])
      expect(written).toEqual(['memory/domains/lock.md'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
