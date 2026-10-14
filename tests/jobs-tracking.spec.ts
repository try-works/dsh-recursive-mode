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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { readJobRuns } from '../src/job-log.ts'
import { getLockStatus } from '../src/lock.ts'
import { ensureMemoryPlane, writeCompliantRun } from './compliant-artifact.ts'
import {
  runTracked, describeJobRun, TIMEOUT_REASON,
  type JobHooksLike, type JobSpecLike, type JobsRegistryLike,
} from '../src/jobs-runner.ts'

/**
 * THE REGISTRY'S OWN REFUSAL, VERBATIM.
 *
 * Copied from the harness rather than paraphrased (`packages/jobs/jobs-local/src/index.ts`, the
 * `servesOwner` preflight in `start`) because the whole point of the case below is that a refusal
 * with THIS text — the one a live diagnostic run recorded twice — must not be able to stop the work.
 * A paraphrase would let the test pass against a message the real registry never produces.
 */
const REGISTRY_REFUSAL = 'background jobs unavailable: no job controller serves this agent '
  + '(load @deepseek-ai/dsh-tool-jobs in its composition)'

/**
 * A runtime mounted the way the LIVE HOST mounts it — through the plugin's own `apply`, not by
 * constructing `RecursiveRuntime` directly.
 *
 * ⚠ WHY THAT MATTERS, measured: `apply` is where the `jobs` seam is attached (`ctx.inject(['jobs'], …)`
 * in `src/index.ts`), so a spec that constructs the runtime itself exercises a runtime whose late-attach
 * wiring was never installed — the same shape of mistake that hid the original defect. The registry is
 * provided by a separate plugin row (as the loader's `tool-jobs` row does), and `mountRuntime` is
 * deliberately NOT given the registry as a `RecursiveRuntime` config argument: that is the one-shot
 * constructor path, which the main host makes unnecessary and which these cases exist to distinguish from.
 */
async function mountRuntime(root: string, jobs?: JobsRegistryLike) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (jobs !== undefined) {
    await ctx.plugin({
      name: 'fixture:jobs',
      apply(providerCtx: Context) { providerCtx.provide('jobs', jobs) },
    })
    // A fiber activation is a microtask chain, so a macrotask boundary is what makes the provided
    // service observable to the plugin's injecting row rather than racy.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
  await ctx.plugin(plugin as never, { serverSurface: true, repoRoot: root } as never)
  return ctx
}

/**
 * A run whose artifact MEETS the phase standard. Required by every case below that expects work to
 * actually start.
 *
 * ⚠ THIS IS NOT FIXTURE DRESSING — it is what stops the assertions being vacuous, and the first draft of
 * these cases proved it the hard way. With no artifact on disk, `lintArtifact` returns
 * `{ errors: ['Artifact not found'], passed: false }` BEFORE `runTracked` is reached, so `jobs.specs`
 * stayed empty and an "untracked" assertion passed over an operation that was never attempted. Every
 * case below therefore drives a real lint over a real artifact, and the ones that expect a refusal assert
 * the refusal's own wording.
 */
async function mountRuntimeOverCompliantRun(root: string, runId: string, artifact: string, jobs?: JobsRegistryLike) {
  const scaffold = new Context()
  await scaffold.plugin(RecursiveRuntime, { repoRoot: root })
  try {
    await scaffold.recursive.initRun(runId)
  } finally {
    await scaffold.fiber.dispose()
  }
  writeCompliantRun(root, runId, [artifact])
  return await mountRuntime(root, jobs)
}

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

  it('RECORDS the run in the run layer, so the board has it without polling', async () => {
    // T39's surfacing: the board reads a file rather than subscribing, because the run id is
    // known HERE and an event would not carry it.
    const { root } = makeRun()
    const ctx = new Context()
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root })
      await runtime.lintArtifact('r1', '01-as-is.md')
      const records = readJobRuns(root, 'r1')
      expect(records.length).toBe(1)
      expect(records[0].kind).toBe('lint')
      expect(records[0].label).toContain('01-as-is.md')
      // No registry in this case, so the log SAYS the run was untracked.
      expect(records[0].tracked).toBe(false)
      expect(records[0].status).toBe('completed')
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
      // T39's recording: the board finds the round in the RUN LAYER, keyed by the run it
      // belongs to rather than by a job id nobody can map back.
      const records = readJobRuns(root, 'run-1')
      expect(records.length).toBe(1)
      expect(records[0].kind).toBe('delegation')
      expect(records[0].tracked).toBe(true)
      expect(records[0].jobId).toBe('delegation-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records a PARKED round too — an unobserved round is still a run the board should see', async () => {
    const root = makeRoot()
    const jobs = jobRecorder()
    try {
      await review(root, jobs.registry, async () => null)
      const records = readJobRuns(root, 'run-1')
      expect(records.length).toBe(1)
      // The JOB completed (the seam returned normally); what parked is the ROUND. Recording
      // the job's own outcome is what keeps those two facts from being conflated.
      expect(records[0].status).toBe('completed')
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

  it('the PRODUCTION seam is used BY DEFAULT — subagents.interrupt, with the ancestor authority', async () => {    // The capability having no live user was the honest gap T39 recorded. This case closes it
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

  it('resolves the seam from the COMPOSITION when the caller passes none', async () => {
    // ⚠ THE DEFECT THIS CLOSES, measured rather than assumed: `recursive_review.tool.ts` — the
    // only production caller of `delegateReview` — passes no `subagents`, and the runtime then
    // reported "no ctx.subagents runtime available (self-audit fallback)" on a host that had
    // mounted the service all along. So its rounds never reached a child. Here the seam is
    // given to the RUNTIME (exactly as index.ts does it) and NOT to the call.
    const root = makeRoot()
    const ctx = new Context()
    const calls: string[] = []
    const seam = {
      startContinuable: async (spec: { childId?: string }) => {
        calls.push('startContinuable')
        return { childId: spec.childId ?? 'c1', messageId: 'm1' }
      },
      followup: async () => ({ messageId: 'm2' }),
    }
    const runtime = new RecursiveRuntime(ctx, { repoRoot: root, subagents: seam as never })
    try {
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
        parent: {},
        providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
        awaitRoundResult: async () => null,
        // DELIBERATELY NO `subagents` HERE.
      } as never) as { error?: unknown }
      // A child was actually started, and the self-audit fallback is gone.
      expect(calls).toContain('startContinuable')
      expect(out.error ?? null).toBeNull()
      // The round is recorded under the run it belongs to, as at every other site.
      expect(readJobRuns(root, 'run-1')[0].kind).toBe('delegation')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * THE FROZEN-RUN DEFECT, AND THE THREE THINGS THAT FIX IT — asserted separately, because a single
 * end-to-end case would let one half of the fix cover for another.
 *
 * WHAT A LIVE DIAGNOSTIC RUN RECORDED (four runs, the same way each time): `recursive_lock` failed
 * TWICE with `background jobs unavailable: no job controller serves this agent (load
 * @deepseek-ai/dsh-tool-jobs in its composition)`, and `recursive_lint` failed the same way. Locking is
 * the only way to advance a run, so the chain FROZE AT PHASE 0 — twelve artifacts stayed `Status: DRAFT`,
 * `.recursive/locks/` was never created, and `operations.jsonl` recorded no lock operation at all. The
 * gates were all correct; they never ran, because a TRACKING call threw first.
 *
 * ⚠ THE THREE LAYERS, AND WHY EACH NEEDS ITS OWN CASE:
 *   (1) `runTracked` protected only an ABSENT registry, so a registry that was mounted and REFUSED threw
 *       out of `jobs.start` and killed the operation. Case 2/3 below drive exactly that refusal;
 *   (2) no `runTracked` call carried `owner`, and the real registry checks only the GLOBAL controller
 *       layer without one, where a preset's realm-scoped `tool-jobs` never registers. Cases 1 and 4
 *       assert the owner reaches the spec — the only thing this plugin can control, since the registry's
 *       serving decision belongs to the harness;
 *   (3) the registry is resolved with ONE `ctx.get('jobs')` at apply time, so a registry mounted by a
 *       later loader layer was never seen. Case 5 asserts the late attach.
 *  Case 6 is the acceptance: THE LOCK ITSELF, through the runtime, with a refusing registry.
 *
 * ⚠ WHAT WOULD MAKE THESE PASS VACUOUSLY, stated so a green is not read as more than it is: a fake
 * registry that never throws would make cases 2/3/6 pass without exercising the degradation at all —
 * which is why each asserts the refusal reason it produced. A `mountRuntime` whose `ctx.recursive` were
 * not the service under test would make case 6 pass over a runtime that never locked — which is why it
 * asserts the LOCK FIELDS on disk, not only the returned status. And a compliant fixture that the linter
 * refused for some other reason would make case 6 fail loudly rather than pass quietly, which is the
 * safe direction; the sibling `lock-gate.spec.ts` proves the fixture's compliance independently, in its
 * own suite, so this file's lock case cannot be green because the linter was never consulted.
 */
describe('THE FROZEN-RUN DEFECT — a TRACKING failure must never fail the WORK', () => {
  /**
   * ⚠ AN EXPLICIT TIMEOUT, because these cases drive a REAL lock over a REAL compliant run through a real
   * mounted runtime, and the lock path lints the whole run. Measured: ~2.2s alone on a quiet machine, but
   * 5.8-7.6s while the suite's other files run in parallel — against vitest's 5000ms default that made this
   * block fail for LOAD rather than for logic, which is how a green suite started reporting a defect that
   * was not there. The assertion that proves the fix is expensive on purpose (it reaches the linter), so the
   * budget is raised HERE rather than globally: a slow test is a fact about this test, not about the suite.
   */
  const LOCK_TIMEOUT_MS = 30_000

  /** A run whose artifacts meet the phase standard, so a lock can actually be reached. */
  const RUN = 'job-run'
  const ARTIFACT = '00-requirements.md'

  /**
   * A registry that REFUSES EVERY START with the harness's own wording — the closest a fake gets to
   * "mounted, but no controller serves this agent". It records what it was asked for, so a case can show
   * the plugin really tried before degrading, which is the difference between this and a registry that
   * was simply never mounted.
   */
  function refusingJobs() {
    const specs: JobSpecLike[] = []
    const registry: JobsRegistryLike = {
      start(spec) {
        specs.push(spec)
        throw new Error(REGISTRY_REFUSAL)
      },
    }
    return { registry, specs }
  }

  /**
   * A registry that models the harness's OWN owner rule: it ACCEPTS a spec that carries an owner it
   * serves, and REFUSES one that carries none — which is exactly `LocalJobRegistry.start`
   * (`resolveOwner(spec.owner)` then `servesOwner(owner)`: no owner means the GLOBAL layer is consulted,
   * where a preset's realm-scoped `tool-jobs` controller never registers).
   *
   * ⚠ WHY THIS EXISTS AND A BLANKET REFUSAL WAS NOT ENOUGH. With a fake that throws unconditionally, the
   * OWNER half of the fix contributes nothing to the acceptance case: the lock would still succeed with no
   * owner at all, so the case would be green while proving only the degradation half. A mutation that
   * reverted `owner: agentOwner(agent)` left that case passing — measured, not assumed. This fake makes
   * the acceptance case depend on BOTH halves, so neither can be reverted without a failure.
   */
  function ownerServingJobs() {
    const specs: JobSpecLike[] = []
    const registry: JobsRegistryLike = {
      start(spec) {
        specs.push(spec)
        // The same shape of lookup the real registry performs, and the same refusal when it finds nothing.
        if (spec.owner === undefined) throw new Error(REGISTRY_REFUSAL)
        spec.run({ id: 'lint-1', append: () => {}, updateProgress: () => {} })
        return 'lint-1'
      },
    }
    return { registry, specs }
  }

  /** A registry that accepts, so what a call hands it can be read back. */
  function recordingJobs() {
    const specs: JobSpecLike[] = []
    const registry: JobsRegistryLike = {
      start(spec) {
        specs.push(spec)
        // The real contract: `run` is invoked synchronously and its hooks are the handle.
        spec.run({ id: 'lint-1', append: () => {}, updateProgress: () => {} })
        return 'lint-1'
      },
    }
    return { registry, specs }
  }

  it('THE OWNER IS PASSED: the lint call carries the calling agent id the registry needs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-jobs-owner-'))
    const jobs = recordingJobs()
    const ctx = await mountRuntimeOverCompliantRun(root, RUN, ARTIFACT, jobs.registry)
    try {
      await ctx.recursive.lintArtifact(RUN, ARTIFACT, { id: 'agent-7', session: { header: { cwd: root } } })
      // ⚠ ANTI-VACUITY: the job must actually have been started. `lintArtifact` short-circuits on a
      // missing artifact, so an empty `specs` here would mean nothing was ever requested.
      expect(jobs.specs).toHaveLength(1)
      // ⚠ THE ASSERTION THAT FAILS ON THE OLD CODE: with no owner the registry resolves `undefined` and
      // consults only the global controller layer, which is why a mounted registry refused the job.
      expect(jobs.specs[0].owner).toBe('agent-7')
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('NO OWNER IS INVENTED: an agent with no id leaves the field ABSENT, not undefined-but-present', async () => {
    // The other half of `agentOwner`: passing a non-answer is worse than passing none, because the
    // registry's `resolveOwner` throws `session "…" has no live agent` for an id it cannot resolve.
    const root = mkdtempSync(join(tmpdir(), 'rm-jobs-noid-'))
    const jobs = recordingJobs()
    const ctx = await mountRuntimeOverCompliantRun(root, RUN, ARTIFACT, jobs.registry)
    try {
      await ctx.recursive.lintArtifact(RUN, ARTIFACT, { session: { header: { cwd: root } } })
      expect(jobs.specs).toHaveLength(1)
      expect('owner' in jobs.specs[0]).toBe(false)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('A REFUSAL DEGRADES TO INLINE: the work RUNS, reports untracked, and records the reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-jobs-refuse-'))
    const jobs = refusingJobs()
    const ctx = await mountRuntimeOverCompliantRun(root, RUN, ARTIFACT, jobs.registry)
    try {
      const result = await ctx.recursive.lintArtifact(RUN, ARTIFACT, { id: 'agent-7' })
      // The plugin really tried, so this is about a REFUSAL rather than about a registry that was absent.
      expect(jobs.specs).toHaveLength(1)
      // ⚠ THE WORK RAN ANYWAY. `lintArtifact` reports a non-completed job through its own error path, so
      // an operation that died with the refusal would carry the refusal in `errors` — it does not.
      expect(result.artifact).toBe(ARTIFACT)
      expect(result.runId).toBe(RUN)
      expect(result.errors).not.toContain('Artifact not found')
      expect(result.errors.join('\n')).not.toContain('no job controller serves this agent')
      // ⚠ THE TRACKING WAS REPORTED, NOT SWALLOWED — as `untracked`, with the harness's own wording.
      const recorded = readJobRuns(root, RUN)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].kind).toBe('lint')
      expect(recorded[0].tracked).toBe(false)
      expect(recorded[0].status).toBe('completed')
      expect(recorded[0].jobId).toBeUndefined()
      expect(recorded[0].detail).toContain('no job controller serves this agent')
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('AN INLINE WORK FAILURE IS STILL A FAILURE OF THE WORK — only the TRACKING may degrade', async () => {
    // ⚠ THE OVER-CATCH GUARD, asserted on the RUNNER rather than through a run fixture so the two facts
    // cannot be confused: if the protected region were widened to cover the work itself, a broken lint
    // would come back `completed`. A refusal to TRACK and a failure to WORK are two facts, and only the
    // first one is allowed to be absorbed.
    const result = await runTracked(
      { start() { throw new Error(REGISTRY_REFUSAL) } },
      { kind: 'lint', label: 'lint', run: async () => { throw new Error('the linter blew up') } },
    )
    expect(result.tracked).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('the linter blew up')
    // Both reasons survive: the work's in `error`, the tracking's in `detail`.
    expect(result.detail).toContain('no job controller serves this agent')
  })

  it('THE WORKTREE CREATE ALSO CARRIES THE OWNER — the same call shape, on the other call site', async () => {
    // The third `runTracked` call site, and the second kind of long operation the item names. A non-git
    // directory makes the CREATE fail while leaving the JOB started, which is what lets the spec read the
    // spec the registry received — and the failure path must be unchanged by the wrapping.
    const root = mkdtempSync(join(tmpdir(), 'rm-jobs-worktree-'))
    const jobs = refusingJobs()
    const ctx = await mountRuntime(root, jobs.registry)
    try {
      await expect(ctx.recursive.initRun('wt-run', { id: 'agent-9' }, { createWorktree: true })).rejects.toThrow()
      expect(jobs.specs).toHaveLength(1)
      expect(jobs.specs[0].kind).toBe('worktree')
      // The owner reached the worktree site too — this is the assertion that fails without it.
      expect(jobs.specs[0].owner).toBe('agent-9')
      // And the refusal to track did not replace the create's own outcome: the create still threw.
      await expect(ctx.recursive.initRun('wt-run', { id: 'agent-9' }, { createWorktree: true })).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('⚠ THE LOCK STILL LOCKS: `recursive_lock` advances the run while the registry REFUSES every job', async () => {
    // ⚠ THIS IS THE ACCEPTANCE, AND IT IS THE CASE THAT FAILS ON THE UNFIXED CODE. `lockArtifact` calls
    // the linter, the linter is a tracked operation, and locking is the only way a run advances — so a
    // throwing `jobs.start` here reproduces the live freeze exactly: no lock, no `.recursive/locks/`, and
    // a run stuck at phase 0 with every artifact left DRAFT.
    //
    // ⚠ AND NOTHING ABOUT THE GATE IS RELAXED BY THIS FIX: the lock is still refused when the artifact is
    // below standard, because the WORK (the lint verdict) still decides. What changed is only that a
    // refusal to TRACK can no longer be mistaken for a refusal to LOCK.
    const root = mkdtempSync(join(tmpdir(), 'rm-jobs-lock-'))
    // ⚠ THE OWNER-SERVING FAKE, NOT THE BLANKET REFUSAL — see `ownerServingJobs`. The acceptance case
    // must depend on BOTH halves of the fix: this registry accepts the lint carrying the owner (so the
    // lock's lint gate passes and the artifact locks) and would refuse it without one (so removing the
    // owner fails this case).
    const jobs = ownerServingJobs()
    const ctx = await mountRuntimeOverCompliantRun(root, RUN, ARTIFACT, jobs.registry)
    const runDir = join(root, '.recursive', 'run', RUN)
    try {
      const result = await ctx.recursive.lockArtifact(RUN, ARTIFACT, false, { id: 'agent-7' })
      // ⚠ THE JOB WAS ACCEPTED, so the lock's lint gate passed a TRACKED lint rather than degrading to an
      // inline one. This is what makes the case about the owner as well as about the protection.
      expect(jobs.specs.length, 'the lock path must really have tracked the lint').toBeGreaterThan(0)
      expect(jobs.specs[0].owner, 'the tracked lint must carry the owner the registry serves').toBe('agent-7')
      // The artifact advanced, and it advanced FOR REAL: status, hash, and the field on disk.
      expect(result.status).toBe('LOCKED')
      expect(result.lockHash).toMatch(/^[a-f0-9]{64}$/)
      expect(getLockStatus(join(runDir, ARTIFACT))).toBe('LOCKED')
      expect(readFileSync(join(runDir, ARTIFACT), 'utf8')).toContain('Status: `LOCKED`')
      // And the lint was recorded as a TRACKED run, which is what a fixed live run would show.
      const lintRunRecord = readJobRuns(root, RUN).find((record) => record.kind === 'lint')
      expect(lintRunRecord).toBeDefined()
      expect(lintRunRecord?.tracked).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }, LOCK_TIMEOUT_MS)

  it('⚠ A LOCK IS NOT BLOCKED BY A REGISTRY THAT REFUSES EVERY JOB — the live freeze, reproduced', async () => {
    // ⚠ THE USER-FACING ACCEPTANCE, AND THE CASE THAT FAILS ON THE UNFIXED CODE. This is the live defect
    // in one call: a registry that is MOUNTED (so the absent-registry degradation does not apply) and that
    // REFUSES the job. Before the fix `jobs.start` sat outside the guard, so the refusal threw out of
    // `runTracked`, out of `lintArtifact`, and out of `lockArtifact` — and since locking is the only way a
    // run advances, EVERY live run froze at phase 0 with all twelve artifacts left DRAFT and
    // `.recursive/locks/` never created.
    //
    // ⚠ WHY THIS IS A SEPARATE CASE FROM THE OWNER-SERVING ONE ABOVE, deliberately: that registry ACCEPTS
    // the owner, so it proves the owner half and never reaches the degradation; this registry refuses
    // whatever it is handed, so it proves the degradation half. Neither substitutes for the other.
    const root = mkdtempSync(join(tmpdir(), 'rm-jobs-lock-refuse-'))
    const jobs = refusingJobs()
    const ctx = await mountRuntimeOverCompliantRun(root, RUN, ARTIFACT, jobs.registry)
    const runDir = join(root, '.recursive', 'run', RUN)
    try {
      const result = await ctx.recursive.lockArtifact(RUN, ARTIFACT, false, { id: 'agent-7' })
      // The registry really refused, and the call still succeeded: the work ran INLINE.
      expect(jobs.specs.length, 'the lock path must really have attempted to track the lint').toBeGreaterThan(0)
      expect(result.status).toBe('LOCKED')
      expect(getLockStatus(join(runDir, ARTIFACT))).toBe('LOCKED')
      // The degradation is on the record: untracked, with the registry's own reason rather than a silence.
      const lintRunRecord = readJobRuns(root, RUN).find((record) => record.kind === 'lint')
      expect(lintRunRecord).toBeDefined()
      expect(lintRunRecord?.tracked).toBe(false)
      expect(lintRunRecord?.detail).toContain('no job controller serves this agent')
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }, LOCK_TIMEOUT_MS)

  it('⚠ THE STANDARD GATE STILL BITES: the lock is still REFUSED when the artifact is below standard', async () => {
    // ⚠ THE OTHER HALF OF THE ACCEPTANCE, and the reason the case above is not evidence that the gate was
    // weakened. The TWO facts are deliberately separated by ROOT, because the fixture that makes a lock
    // reachable is run-LEVEL (the memory plane and an executable diff basis) and a missing run prerequisite
    // would refuse the lock for a reason that has nothing to do with the artifact under test:
    //   • root A holds a compliant run, so the lock SUCCEEDS and proves the tracking refusal did not block it;
    //   • root B is the SCAFFOLD's own output — `recursive_init`'s templates, which are 19 FAILs under
    //     `lintRun` — so the same call with the same refusing registry must still be REFUSED, by the
    //     LINTER's verdict rather than by the registry.
    const root = mkdtempSync(join(tmpdir(), 'rm-jobs-gate-'))
    const scaffold = new Context()
    await scaffold.plugin(RecursiveRuntime, { repoRoot: root })
    try {
      await scaffold.recursive.initRun(RUN)
    } finally {
      await scaffold.fiber.dispose()
    }
    const jobs = refusingJobs()
    const ctx = await mountRuntime(root, jobs.registry)
    try {
      const message = await ctx.recursive.lockArtifact(RUN, ARTIFACT, false, { id: 'agent-7' }).then(
        () => null, (error: Error) => error.message,
      )
      expect(message, 'a below-standard artifact must still be refused').not.toBeNull()
      expect(message).toContain('does not meet the phase standard')
      // And the refusal still came from the LINTER rather than from the registry: the tracked lint really
      // ran and its FAIL list is what the message carries.
      expect(jobs.specs.length, 'the lint gate must have consulted the linter').toBeGreaterThan(0)
      expect(message).not.toContain('no job controller serves this agent')
      expect(getLockStatus(join(root, '.recursive', 'run', RUN, ARTIFACT))).toBe('DRAFT')
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }, LOCK_TIMEOUT_MS)
})
