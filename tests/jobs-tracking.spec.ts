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
