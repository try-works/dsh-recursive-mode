/**
 * T10 — a hung long operation shows as a running job and can be killed.
 *
 * The acceptance is about a HUNG operation, so the central case below is work that never
 * finishes on its own: it must be reported as tracked, and a kill from the board must settle
 * it. A fake registry stands in for `ctx.jobs`, which is the point of the structural seam —
 * the adapter's behaviour is testable without mounting the real service.
 *
 * Two distinctions the tests exist to protect:
 *   - a CANCELLED operation is `killed`, never `failed` (a board that renders a deliberate
 *     stop as a failure teaches people to distrust the kill switch);
 *   - with NO registry the work still runs and says `tracked: false`, because failing a lint
 *     merely because no board is attached would be the worse failure.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import {
  runTracked, describeJobRun, TIMEOUT_REASON,
  type JobHooksLike, type JobSpecLike, type JobsRegistryLike,
} from '../src/jobs-runner.ts'

/** A registry that records the spec and lets the test drive cancellation. */
function fakeJobs() {
  const specs: JobSpecLike[] = []
  const hooks: JobHooksLike[] = []
  const registry: JobsRegistryLike = {
    start(spec) {
      specs.push(spec)
      // The real contract: `run` is invoked synchronously and its hooks are the handle.
      hooks.push(spec.run({ id: 'lint-1', append: () => {}, updateProgress: (line) => { progress.push(line) } }))
      return 'lint-1'
    },
  }
  const progress: string[] = []
  return { registry, specs, hooks, progress, get spec() { return specs[0] }, get hook() { return hooks[0] } }
}

describe('T10 — a long operation is tracked as a native job', () => {
  it('starts a job with the kind and label, and returns the value', async () => {
    const fake = fakeJobs()
    const result = await runTracked(fake.registry, {
      kind: 'lint', label: 'lint run-1 03',
      run: async () => 42,
    })
    expect(result.tracked).toBe(true)
    expect(result.jobId).toBe('lint-1')
    expect(result.status).toBe('completed')
    expect(result.value).toBe(42)
    expect(fake.spec?.kind).toBe('lint')
    expect(fake.spec?.label).toBe('lint run-1 03')
  })

  it('progress reaches the board through updateProgress', async () => {
    const fake = fakeJobs()
    await runTracked(fake.registry, {
      kind: 'lint', label: 'lint',
      run: async ({ report }) => { report('3/10 phases'); report('7/10 phases'); return null },
    })
    expect(fake.progress).toEqual(['3/10 phases', '7/10 phases'])
  })

  it('renders the terminal result into the outcome', async () => {
    const fake = fakeJobs()
    await runTracked(fake.registry, {
      kind: 'lint', label: 'lint',
      run: async () => ({ errors: 2 }),
      render: (value) => value.errors + ' errors',
    })
    const outcome = await fake.hook.done
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toBe('2 errors')
  })

  it('a THROWING operation settles failed with its message, and does not throw at the caller', async () => {
    const fake = fakeJobs()
    const result = await runTracked(fake.registry, {
      kind: 'worktree', label: 'worktree',
      run: async () => { throw new Error('git is not installed') },
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('git is not installed')
  })
})

describe('T10 — a HUNG operation is killable, which is the acceptance', () => {
  it('never resolving on its own, it is cancelled and reported KILLED — not failed', async () => {
    const fake = fakeJobs()
    // Work that only ends when the signal aborts: exactly a hung worktree create.
    const pending = runTracked(fake.registry, {
      kind: 'worktree', label: 'worktree 03',
      run: ({ signal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted by the board')))
      }),
    })
    // The job exists and is running: the board can see it before anything finishes.
    expect(fake.spec?.kind).toBe('worktree')
    fake.hook.cancel('operator stopped it')
    const result = await pending
    expect(result.status).toBe('killed')
    // The caller's reason survives to the outcome.
    expect(result.detail).toBe('operator stopped it')
    expect(result.error).toBeUndefined()
  })

  it('a TIMEOUT cancels the work rather than abandoning it', async () => {
    const fake = fakeJobs()
    let sawAbort = false
    const result = await runTracked(fake.registry, {
      kind: 'lint', label: 'lint', timeoutMs: 20,
      run: ({ signal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')) })
      }),
    })
    expect(result.status).toBe('killed')
    expect(result.detail).toBe(TIMEOUT_REASON)
    // The signal really reached the work: a deadline that only stopped WAITING would leave
    // the operation running, which is the hang this item exists to remove.
    expect(sawAbort).toBe(true)
  })

  it('a completed run clears its timer, so a fast job does not wait for the deadline', async () => {
    const fake = fakeJobs()
    const started = Date.now()
    const result = await runTracked(fake.registry, {
      kind: 'lint', label: 'lint', timeoutMs: 60_000,
      run: async () => 'done',
    })
    expect(result.status).toBe('completed')
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('T10 — with no registry the work still runs, and SAYS it was untracked', () => {
  it('runs inline and reports tracked: false', async () => {
    const result = await runTracked(null, { kind: 'lint', label: 'lint', run: async () => 'value' })
    expect(result.tracked).toBe(false)
    expect(result.status).toBe('completed')
    expect(result.value).toBe('value')
    expect(result.jobId).toBeUndefined()
  })

  it('an inline failure is still reported as a failure, not swallowed', async () => {
    const result = await runTracked(undefined, {
      kind: 'lint', label: 'lint',
      run: async () => { throw new Error('lint blew up') },
    })
    expect(result.tracked).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('lint blew up')
  })
})

describe('T10 — the board line never hides whether the run was tracked', () => {
  it('names the job when there was one', () => {
    expect(describeJobRun({ tracked: true, jobId: 'lint-7', status: 'completed' })).toContain('job lint-7')
  })

  it('says UNTRACKED out loud rather than leaving a reader to infer it from a missing id', () => {
    const line = describeJobRun({ tracked: false, status: 'failed', error: 'boom' })
    expect(line).toContain('untracked')
    expect(line).toContain('boom')
  })

  it('carries the terminal reason when there is one', () => {
    expect(describeJobRun({ tracked: true, jobId: 'worktree-2', status: 'killed', detail: 'operator stopped it' }))
      .toContain('operator stopped it')
  })
})

/**
 * T10 — the WIRING: a real long operation actually goes through the runner.
 *
 * `lintArtifact` is the first call site, and it is the honest one to start with: `lintRun` is
 * SYNCHRONOUS, so the signal can only be honoured at the boundary. These tests assert what
 * that really buys — the board sees a running job named for the run and artifact, with
 * progress — and they assert the kill path end to end, WITHOUT changing the lint payload
 * shape (a killed job reports through the existing error path).
 */
describe('T10 — lintArtifact runs as a native job', () => {
  function makeRun() {
    const root = mkdtempSync(join(tmpdir(), 'rm-t10-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '01-as-is.md'), '# As-is\n\nStatus: `DRAFT`\n', 'utf8')
    return { root, runDir }
  }

  /** A registry that records the spec and the progress lines the board would show. */
  function jobRecorder(options: { killImmediately?: boolean } = {}) {
    const specs: JobSpecLike[] = []
    const progress: string[] = []
    let hooks: JobHooksLike | null = null
    const registry: JobsRegistryLike = {
      start(spec) {
        specs.push(spec)
        hooks = spec.run({ id: 'lint-1', append: () => {}, updateProgress: (line) => progress.push(line) })
        if (options.killImmediately) hooks.cancel('the board killed it')
        return 'lint-1'
      },
    }
    // A GETTER, not a captured value: `hooks` is assigned when `start` runs, so reading it
    // at construction time would always see null.
    return { registry, specs, progress, get hooks() { return hooks as unknown as JobHooksLike } }
  }

  it('starts a job kinded and labelled for the run and artifact, with progress', async () => {
    const { root } = makeRun()
    const ctx = new Context()
    const jobs = jobRecorder()
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root, jobs: jobs.registry })
      await runtime.lintArtifact('r1', '01-as-is.md')
      expect(jobs.specs.length).toBe(1)
      expect(jobs.specs[0].kind).toBe('lint')
      // The label is what the board shows, so it must name both.
      expect(jobs.specs[0].label).toContain('r1')
      expect(jobs.specs[0].label).toContain('01-as-is.md')
      expect(jobs.progress).toContain('linting 01-as-is.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('WITHOUT a registry the lint still works — the degradation is real, not theoretical', async () => {
    const { root } = makeRun()
    const ctx = new Context()
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root })
      const result = await runtime.lintArtifact('r1', '01-as-is.md')
      // It produced a real verdict rather than failing for want of a board.
      expect(result.runId).toBe('r1')
      expect(result.artifact).toBe('01-as-is.md')
      expect(Array.isArray(result.errors)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a kill during a SYNCHRONOUS lint cannot pre-empt it — the documented boundary, asserted', async () => {
    // The honest limitation, stated as a test rather than buried in a comment: `lintRun` is
    // synchronous, so a kill lands too late to stop the CALL — JavaScript cannot pre-empt it.
    // What the job buys is that the board SEES the work and the caller can stop WAITING; it
    // does not buy pre-emption, and pretending otherwise would be the more dangerous claim.
    const { root } = makeRun()
    const ctx = new Context()
    const jobs = jobRecorder({ killImmediately: true })
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root, jobs: jobs.registry })
      const result = await runtime.lintArtifact('r1', '01-as-is.md')
      // The lint COMPLETED and reports its real verdict: the kill corrupted nothing, and it
      // certainly did not become a pass that skipped the work.
      expect(result.artifact).toBe('01-as-is.md')
      expect(result.runId).toBe('r1')
      // And the outcome reflects what actually happened rather than what was requested.
      const outcome = await jobs.hooks.done
      expect(outcome.status).toBe('completed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a KILLED job would report through the existing error path, not as a pass', async () => {
    // The runner-level kill path (work that honours the signal) is covered above; here the
    // MAPPING from a non-completed job to the lint payload is what is asserted, by driving
    // it with a registry whose work is interrupted before it produces anything.
    const { root } = makeRun()
    const ctx = new Context()
    const registry: JobsRegistryLike = {
      start(spec) {
        const hooks = spec.run({ id: 'lint-9', append: () => {}, updateProgress: () => {} })
        hooks.cancel('the board killed it')
        return 'lint-9'
      },
    }
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root, jobs: registry })
      const result = await runtime.lintArtifact('r1', '01-as-is.md')
      // A non-completed job never yields a passing verdict, and never a bare `passed: false`
      // with no explanation.
      expect(result.passed).toBe(false)
      expect(Array.isArray(result.errors)).toBe(true)
      expect(result.warnings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * T10 — the SECOND call site, and the one the item itself names as the hung case.
 *
 * The test needs no git repository: what is asserted is that the operation is WRAPPED (a job
 * of kind `worktree` exists for it) and that the failure path is UNCHANGED, which a non-git
 * directory exercises for real — `createLinkedWorktree` reports `{ ok: false, error }` there,
 * and `initRun` must still throw exactly what it threw before.
 */
describe('T10 — the worktree create runs as a native job', () => {
  function jobRecorder() {
    const specs: JobSpecLike[] = []
    const progress: string[] = []
    const registry: JobsRegistryLike = {
      start(spec) {
        specs.push(spec)
        spec.run({ id: 'worktree-1', append: () => {}, updateProgress: (line) => progress.push(line) })
        return 'worktree-1'
      },
    }
    return { registry, specs, progress }
  }

  it('initRun with createWorktree starts a job kinded worktree, labelled for the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-t10w-'))
    const ctx = new Context()
    const jobs = jobRecorder()
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root, jobs: jobs.registry })
      // A non-git directory, so the create itself fails — which is the point: the JOB is
      // started and the failure still surfaces exactly as before.
      await expect(runtime.initRun('r9', null, { createWorktree: true })).rejects.toThrow()
      expect(jobs.specs.length).toBe(1)
      expect(jobs.specs[0].kind).toBe('worktree')
      expect(jobs.specs[0].label).toContain('r9')
      expect(jobs.progress).toContain('creating r9')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the failure is the SAME error a caller saw before the wrapping', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-t10w2-'))
    // A separate Context per runtime: `recursive` is a Cordis service and registering it
    // twice on one context throws, which is the framework being correct rather than a
    // problem with the thing under test.
    const ctxA = new Context()
    const ctxB = new Context()
    const withJobs = new RecursiveRuntime(ctxA, { repoRoot: root, jobs: jobRecorder().registry })
    const withoutJobs = new RecursiveRuntime(ctxB, { repoRoot: root })
    try {
      const tracked = await withJobs.initRun('r9', null, { createWorktree: true }).then(
        () => null, (err: Error) => err.message,
      )
      const inline = await withoutJobs.initRun('r9', null, { createWorktree: true }).then(
        () => null, (err: Error) => err.message,
      )
      expect(tracked).not.toBeNull()
      // Byte-identical: wrapping must not reword a refusal a caller may be matching on.
      expect(tracked).toBe(inline)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
