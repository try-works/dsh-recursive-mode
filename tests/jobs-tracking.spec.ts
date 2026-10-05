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

/**
 * T39 — the DELEGATION's round await is the hangable part, and it is now a job.
 *
 * The property under test is a NEGATIVE one, and it is the whole reason the wrapper is safe
 * to add: the seam's contract is `SubagentResultLike | null` where a null means PARKED, so
 * every non-completed job outcome returns `null` rather than throwing or inventing a result.
 * A PARKED round must therefore park — NOT settle as a failure — and that holds by
 * construction rather than by a special case.
 *
 * ⚠ The pre-emptive kill T39's plan predicted is NOT reachable yet, and this suite does not
 * pretend otherwise: `delegateReview` has no interrupt seam (measured — its input carries
 * none and this module has no interrupt path; the audit loop has one only because IT receives
 * the teams runtime). The job gives the board visibility; pre-emption needs that seam first.
 */
describe('T39 — a delegation round shows as a job', () => {
  const POLICY = {
    version: 1,
    role_routes: {
      'code-reviewer': { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
    },
    cli_overrides: {},
    custom_clis: [],
  }

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'rm-t39-'))
    const runDir = join(root, '.recursive', 'run', 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '03-implementation-summary.md'), '# Impl\n\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n', 'utf8')
    const cfg = join(root, '.recursive', 'config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'recursive-router.json'), JSON.stringify(POLICY), 'utf8')
    return root
  }

  /** The continuable lifecycle the round await runs inside. */
  function fakeSubagents() {
    return {
      startContinuable: async (spec: { childId?: string }) => ({ childId: spec.childId ?? 'c1', messageId: 'm1' }),
      followup: async () => ({ messageId: 'm2' }),
    } as never
  }

  function jobRecorder() {
    const specs: JobSpecLike[] = []
    const progress: string[] = []
    const registry: JobsRegistryLike = {
      start(spec) {
        specs.push(spec)
        spec.run({ id: 'delegation-1', append: () => {}, updateProgress: (line) => progress.push(line) })
        return 'delegation-1'
      },
    }
    return { registry, specs, progress }
  }

  async function review(
    root: string,
    jobs: JobsRegistryLike | undefined,
    round: () => Promise<unknown>,
    interrupt?: (childId: string, reason: string) => void,
  ) {
    const ctx = new Context()
    const runtime = new RecursiveRuntime(ctx, { repoRoot: root, ...(jobs === undefined ? {} : { jobs }) })
    const out = await runtime.delegateReview({
      root,
      runId: 'run-1',
      phase: '3',
      role: 'code-reviewer',
      delegationId: 'd1',
      childId: 'c1',
      artifactPath: join(root, '.recursive', 'run', 'run-1', '03-implementation-summary.md'),
      upstreamArtifacts: [],
      auditQuestions: ['does it work?'],
      requiredOutput: 'verdict',
      mode: 'continuable',
      subagents: fakeSubagents(),
      parent: {},
      providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
      awaitRoundResult: round,
      ...(interrupt === undefined ? {} : { interrupt }),
    } as never)
    return out as { evaluation?: { accepted?: boolean; reason?: string }; error?: unknown; delegationMode?: string }
  }

  it('starts a job kinded delegation for the round, with a progress line', async () => {
    const root = makeRoot()
    const jobs = jobRecorder()
    try {
      await review(root, jobs.registry, async () => ({
        success: true, stopReason: 'completed', structured: { verdict: 'APPROVE', findings: [], references: [] },
      }))
      expect(jobs.specs.length).toBe(1)
      expect(jobs.specs[0].kind).toBe('delegation')
      expect(jobs.specs[0].label).toContain('run-1')
      expect(jobs.progress).toContain('awaiting the review round')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a PARKED round still parks — it is NOT settled as a failure', async () => {
    // The safety property: a null from the seam means parked, and the wrapper must not turn
    // that into a settlement. Asserted through the OUTCOME rather than the internal flag.
    const root = makeRoot()
    const jobs = jobRecorder()
    try {
      const out = await review(root, jobs.registry, async () => null)
      expect(out.delegationMode).toBe('continuable')
      // Parked is not approved...
      expect(out.evaluation?.accepted).toBe(false)
      // ...and, crucially, not an ERROR either: parking is an ordinary waiting state.
      expect(out.error ?? null).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('WITHOUT a registry the round behaves exactly as before', async () => {
    const root = makeRoot()
    try {
      const out = await review(root, undefined, async () => null)
      expect(out.delegationMode).toBe('continuable')
      expect(out.evaluation?.accepted).toBe(false)
      expect(out.error ?? null).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a job KILL reaches the LIVE CHILD — the pre-emptive kill, which T10 could not have', async () => {
    // The child is modelled as COOPERATIVE, which is what the interrupt seam assumes: it
    // finishes when interrupted. That is the difference from the synchronous call sites —
    // there, a kill could only stop us WAITING; here it stops the WORK.
    const root = makeRoot()
    const interrupts: Array<[string, string]> = []
    let releaseRound: (value: unknown) => void = () => {}
    const round = () => new Promise<unknown>((resolve) => { releaseRound = resolve })
    const registry: JobsRegistryLike = {
      start(spec) {
        const hooks = spec.run({ id: 'delegation-2', append: () => {}, updateProgress: () => {} })
        // A kill from the board, exactly as a hung delegation would be stopped.
        hooks.cancel('the operator stopped it')
        return 'delegation-2'
      },
    }
    try {
      const out = await review(root, registry, round, (childId, reason) => {
        interrupts.push([childId, reason])
        releaseRound({ success: false, stopReason: 'interrupted' })
      })
      // The child was REACHED, with the caller's own reason — pre-emptive, not a stopped wait.
      expect(interrupts).toEqual([['c1', 'the operator stopped it']])
      // And nothing was fabricated from it: an interrupted child is not an approval. The
      // reason names the VERDICT (the interrupted child returned none), not the stop reason —
      // which is what the delegation checks first, and worth pinning so a later reader does
      // not `fix` the assertion that used to be here by changing the code.
      expect(out.evaluation?.accepted).toBe(false)
      expect(out.evaluation?.reason).toBeTruthy()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('with NO interrupt seam the kill still parks and never throws — the honest no-seam case', async () => {
    const root = makeRoot()
    const registry: JobsRegistryLike = {
      start(spec) {
        const hooks = spec.run({ id: 'delegation-3', append: () => {}, updateProgress: () => {} })
        hooks.cancel('stopped with nobody listening')
        return 'delegation-3'
      },
    }
    try {
      // The round resolves normally here (nobody was interrupted to release it), which is
      // exactly the situation the no-seam case produces: the kill cannot reach the child, and
      // the wrapper says so by parking rather than by inventing a failure.
      const out = await review(root, registry, async () => null)
      expect(out.evaluation?.accepted).toBe(false)
      expect(out.error ?? null).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the PRODUCTION seam is used BY DEFAULT — subagents.interrupt, with the ancestor authority', async () => {
    // The capability having no live user was the honest gap T39 recorded. This case closes it
    // by passing NO explicit `interrupt`: the runtime must build the provider itself, from the
    // same seam the continuable lifecycle uses, with the parent Agent as the authority.
    const root = makeRoot()
    const ctx = new Context()
    const interrupts: Array<{ childId: string; authority: unknown }> = []
    const parent = { id: 'parent-agent' }
    let releaseRound: (value: unknown) => void = () => {}
    const registry: JobsRegistryLike = {
      start(spec) {
        const hooks = spec.run({ id: 'delegation-4', append: () => {}, updateProgress: () => {} })
        hooks.cancel('a board kill')
        return 'delegation-4'
      },
    }
    const runtime = new RecursiveRuntime(ctx, { repoRoot: root, jobs: registry })
    try {
      await runtime.delegateReview({
        root,
        runId: 'run-1',
        phase: '3',
        role: 'code-reviewer',
        delegationId: 'd1',
        childId: 'c1',
        artifactPath: join(root, '.recursive', 'run', 'run-1', '03-implementation-summary.md'),
        upstreamArtifacts: [],
        auditQuestions: ['does it work?'],
        requiredOutput: 'verdict',
        mode: 'continuable',
        parent,
        subagents: {
          startContinuable: async (spec: { childId?: string }) => ({ childId: spec.childId ?? 'c1', messageId: 'm1' }),
          followup: async () => ({ messageId: 'm2' }),
          interrupt: (childId: string, authority: unknown) => {
            interrupts.push({ childId, authority })
            releaseRound({ success: false, stopReason: 'interrupted' })
          },
        },
        providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
        awaitRoundResult: () => new Promise<unknown>((resolve) => { releaseRound = resolve }),
        // DELIBERATELY NO `interrupt` — that is the whole point of this case.
      } as never)
      expect(interrupts.length).toBe(1)
      expect(interrupts[0].childId).toBe('c1')
      // The seam's own authority shape, and the parent we passed rather than a bare id.
      expect(interrupts[0].authority).toEqual({ kind: 'ancestor', agent: parent })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
