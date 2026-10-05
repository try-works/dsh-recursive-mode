/**
 * T39 — the board-facing job log.
 *
 * The properties that matter here are the ones that keep observability from becoming a
 * liability: recording NEVER throws (a completed lint must not be reported as a failure
 * because a log file could not be written), a missing or damaged file reads as EMPTY rather
 * than as an error, and `tracked: false` is recorded explicitly so a reader can tell "ran
 * without a board" from "the board lost it".
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { jobsLogPath, readJobRuns, recordJobRun, renderJobLog } from '../src/job-log.ts'
import type { JobRunResult } from '../src/jobs-runner.ts'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-joblog-'))
  mkdirSync(join(root, '.recursive', 'run', 'r1'), { recursive: true })
  return root
}

function completed(over: Partial<JobRunResult<unknown>> = {}): JobRunResult<unknown> {
  return { tracked: true, jobId: 'lint-1', status: 'completed', value: 1, ...over } as JobRunResult<unknown>
}

describe('T39 — a run is recorded where the run id is KNOWN', () => {
  it('writes one line to the run layer, beside the run’s other records', () => {
    const root = makeRoot()
    try {
      expect(recordJobRun(root, 'r1', { kind: 'lint', label: 'lint r1 01-as-is.md', result: completed() })).toBe(true)
      const lines = readFileSync(jobsLogPath(root, 'r1'), 'utf8').trim().split('\n')
      expect(lines.length).toBe(1)
      const record = JSON.parse(lines[0]) as Record<string, unknown>
      expect(record.kind).toBe('lint')
      expect(record.status).toBe('completed')
      expect(record.jobId).toBe('lint-1')
      expect(record.tracked).toBe(true)
      // The zero-emission invariant: a file in the run layer, never a session event.
      expect(jobsLogPath(root, 'r1').endsWith(join('run', 'r1', 'jobs', 'jobs.jsonl'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records UNTRACKED explicitly, so a reader can tell it from a lost job', () => {
    const root = makeRoot()
    try {
      recordJobRun(root, 'r1', { kind: 'lint', label: 'lint r1', result: completed({ tracked: false, jobId: undefined }) })
      const [record] = readJobRuns(root, 'r1')
      expect(record.tracked).toBe(false)
      expect(record.jobId).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries the terminal reason for a killed or failed run', () => {
    const root = makeRoot()
    try {
      recordJobRun(root, 'r1', { kind: 'worktree', label: 'worktree r1', result: { tracked: true, status: 'killed', detail: 'the operator stopped it' } })
      recordJobRun(root, 'r1', { kind: 'lint', label: 'lint r1', result: { tracked: true, status: 'failed', error: 'boom' } })
      const records = readJobRuns(root, 'r1')
      expect(records[0].detail).toBe('the operator stopped it')
      expect(records[1].detail).toBe('boom')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('APPENDS rather than replacing, so a run’s history accumulates', () => {
    const root = makeRoot()
    try {
      recordJobRun(root, 'r1', { kind: 'lint', label: 'first', result: completed() })
      recordJobRun(root, 'r1', { kind: 'lint', label: 'second', result: completed() })
      expect(readJobRuns(root, 'r1').map((record) => record.label)).toEqual(['first', 'second'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('T39 — observability never becomes a liability', () => {
  it('NEVER throws when the log cannot be written', () => {
    // A file where the jobs DIRECTORY should be, so mkdir fails for real.
    const root = makeRoot()
    try {
      writeFileSync(join(root, '.recursive', 'run', 'r1', 'jobs'), 'not a directory', 'utf8')
      expect(() => recordJobRun(root, 'r1', { kind: 'lint', label: 'lint', result: completed() })).not.toThrow()
      expect(recordJobRun(root, 'r1', { kind: 'lint', label: 'lint', result: completed() })).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads a MISSING log as empty, never as an error', () => {
    const root = makeRoot()
    try {
      expect(readJobRuns(root, 'nope')).toEqual([])
      expect(renderJobLog(root, 'nope')).toContain('no job runs recorded')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips a DAMAGED line rather than losing the whole log', () => {
    // One bad line must not blind the board to every other run.
    const root = makeRoot()
    try {
      recordJobRun(root, 'r1', { kind: 'lint', label: 'good', result: completed() })
      writeFileSync(jobsLogPath(root, 'r1'), readFileSync(jobsLogPath(root, 'r1'), 'utf8') + '{not json\n', 'utf8')
      recordJobRun(root, 'r1', { kind: 'lint', label: 'also good', result: completed() })
      expect(readJobRuns(root, 'r1').map((record) => record.label)).toEqual(['good', 'also good'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to invent a path when the run or root is empty', () => {
    expect(recordJobRun('', 'r1', { kind: 'lint', label: 'x', result: completed() })).toBe(false)
    expect(recordJobRun('/tmp', '', { kind: 'lint', label: 'x', result: completed() })).toBe(false)
  })
})

describe('T39 — the board rendering points at what needs attention', () => {
  it('names the job when there was one, and says UNTRACKED when there was not', () => {
    const root = makeRoot()
    try {
      recordJobRun(root, 'r1', { kind: 'lint', label: 'lint r1', result: completed() })
      recordJobRun(root, 'r1', { kind: 'lint', label: 'inline r1', result: completed({ tracked: false, jobId: undefined }) })
      const rendered = renderJobLog(root, 'r1')
      expect(rendered).toContain('completed [lint] lint-1: lint r1')
      expect(rendered).toContain('untracked: inline r1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shows a kill with its reason rather than as a bare status', () => {
    const root = makeRoot()
    try {
      recordJobRun(root, 'r1', { kind: 'delegation', label: 'round r1', result: { tracked: true, status: 'killed', detail: 'the operator stopped it' } })
      expect(renderJobLog(root, 'r1')).toContain('killed [delegation]')
      expect(renderJobLog(root, 'r1')).toContain('the operator stopped it')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
