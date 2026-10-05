/**
 * T10 — track a long operation as a NATIVE job.
 *
 * WHY. `lintRun`, `createLinkedWorktree` and `delegateReview` run synchronously in-block,
 * so a hung one is invisible on the board and unstoppable from it. The native registry
 * already owns identity, lifecycle state, a bounded output ring and a kill switch; the
 * plugin should not invent any of that, so this adapts the plugin's long operations onto
 * `ctx.jobs` instead of building a parallel notion of "running".
 *
 * ⚠ AN OPTIONAL SERVICE, DEGRADED HONESTLY. `ctx.jobs` is absent in a composition that does
 * not mount the registry. In that case the work runs DIRECTLY and the result says
 * `tracked: false` — because failing a lint (or a worktree create) merely because no board
 * is attached would be a worse failure than losing the progress display. The caller can
 * always tell which happened, so "untracked" is never silently passed off as "tracked".
 *
 * ⚠ A CANCELLED OPERATION SETTLES `killed`, NOT `failed`. The distinction is the whole
 * point of exposing a kill switch: "the operator stopped this" and "this broke" call for
 * different responses, and a board that renders a deliberate kill as a failure teaches
 * people to distrust the kill switch.
 *
 * ⚠ THE TIMEOUT IS A KILL, NOT A HANG. A deadline reached means the registry's `cancel` is
 * invoked and the outcome is reported as killed with the reason — so a hung operation
 * cannot leave a caller waiting forever on a promise nobody owns.
 *
 * Types are structural (the plugin's established seam style), so this module depends on the
 * SHAPE of the registry rather than on the package, and a test can drive it with a fake
 * without mounting the real service.
 */

/** The producer face the registry hands `run`: identity plus the ring and progress writers. */
export interface JobHandleLike {
  readonly id: string
  append(text: string, options?: { stream?: string }): void
  updateProgress(line: string): void
}

/** How a job ended. Mirrors the registry's own vocabulary verbatim. */
export interface JobOutcomeLike {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  result?: string
}

export interface JobHooksLike {
  cancel(reason?: string): void
  done: Promise<JobOutcomeLike>
}

export interface JobSpecLike {
  kind: string
  label: string
  owner?: unknown
  outputLimitBytes?: number
  run(job: JobHandleLike): JobHooksLike
}

export interface JobsRegistryLike {
  start(spec: JobSpecLike): string
}

/** What one tracked run produced. */
export interface JobRunResult<T> {
  /** False when no registry was available and the work ran inline. */
  tracked: boolean
  /** The registry-issued id, when there was one. */
  jobId?: string
  status: 'completed' | 'killed' | 'failed'
  /** The terminal reason, for the board's status line. */
  detail?: string
  /** The operation's own value; absent when it was killed or threw. */
  value?: T
  /** The error message when the operation threw. */
  error?: string
}

export interface TrackedRunOptions<T> {
  /** Producer kind, also the id prefix: `lint`, `worktree`, `delegation`. */
  kind: string
  /** One-line, model-facing label. */
  label: string
  owner?: unknown
  /** A deadline. Reaching it CANCELS the work rather than abandoning it. */
  timeoutMs?: number
  /** The work. It receives a progress reporter and an abort signal to honour. */
  run: (context: { report: (line: string) => void; signal: AbortSignal }) => Promise<T>
  /** Render the value into the job's terminal result line. */
  render?: (value: T) => string
}

/** The reason used when a deadline cancelled the work. */
export const TIMEOUT_REASON = 'timed out'

/**
 * Run `options.run` as a native job when a registry is available, inline when it is not.
 *
 * Never throws for a failure of the WORK: the outcome carries `status: 'failed'` and the
 * message, because a caller tracking a job wants to read what happened rather than catch it.
 */
export async function runTracked<T>(
  jobs: JobsRegistryLike | null | undefined,
  options: TrackedRunOptions<T>,
): Promise<JobRunResult<T>> {
  if (jobs === null || jobs === undefined || typeof jobs.start !== 'function') {
    // No board to report to: do the work, and SAY it was untracked.
    try {
      const value = await options.run({ report: () => {}, signal: new AbortController().signal })
      return { tracked: false, status: 'completed', value }
    } catch (err) {
      return {
        tracked: false,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  let value: T | undefined
  let error: string | undefined
  // Captured from inside the synchronous starter so the caller can await it after
  // `start` returns the id — the registry's contract is that `run` is called once,
  // synchronously, and that its returned hooks are the only handle on the work.
  let captured: JobHooksLike | null = null

  const jobId = jobs.start({
    kind: options.kind,
    label: options.label,
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    run: (job) => {
      const controller = new AbortController()
      const done = (async (): Promise<JobOutcomeLike> => {
        try {
          value = await options.run({
            report: (line) => job.updateProgress(line),
            signal: controller.signal,
          })
          return { status: 'completed', result: options.render ? options.render(value) : undefined }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // A cancelled operation reports KILLED, not failed: the signal being aborted is how
          // a deliberate stop reaches the work, and "stopped" is not "broken". Checked BEFORE
          // recording an error, so a kill does not ALSO leave an `error` behind — an error
          // field says "something broke", and carrying one beside `killed` contradicts the
          // status a board is rendering.
          if (controller.signal.aborted) {
            return { status: 'killed', detail: abortReason(controller.signal) }
          }
          error = message
          return { status: 'failed', detail: message }
        }
      })()
      captured = {
        cancel: (reason?: string) => {
          // Abort first so the work can wind down, and record the reason for the outcome.
          controller.abort(reason ?? 'cancelled')
        },
        done,
      }
      return captured
    },
  })

  const hooks = captured as JobHooksLike | null
  if (hooks === null) {
    // The registry did not invoke `run`, so there is no handle on the work at all. Report
    // it rather than pretending a job exists.
    return { tracked: true, jobId, status: 'failed', error: 'the job registry did not start the work' }
  }

  if (options.timeoutMs === undefined) {
    const outcome = await hooks.done
    return { tracked: true, jobId, ...outcome, ...(value === undefined ? {} : { value }), ...(error === undefined ? {} : { error }) }
  }

  const outcome = await withDeadline(hooks, options.timeoutMs)
  return { tracked: true, jobId, ...outcome, ...(value === undefined ? {} : { value }), ...(error === undefined ? {} : { error }) }
}

/**
 * Await the outcome, or cancel the work and report a kill when the deadline passes.
 *
 * The timer is always cleared, so a completed run does not keep the process alive — a
 * leaked timer in a long-lived plugin is a slow leak that only shows up much later.
 */
async function withDeadline(hooks: JobHooksLike, timeoutMs: number): Promise<JobOutcomeLike> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      hooks.done,
      new Promise<JobOutcomeLike>((resolve) => {
        timer = setTimeout(() => {
          hooks.cancel(TIMEOUT_REASON)
          // The outcome is reported here rather than awaited again: `cancel` is documented
          // as eventually settling `done`, and a producer that ignores the signal must not
          // be able to hold the caller hostage.
          resolve({ status: 'killed', detail: TIMEOUT_REASON })
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The abort reason as a string, whatever the caller passed. */
function abortReason(signal: AbortSignal): string {
  const reason = (signal as unknown as { reason?: unknown }).reason
  if (typeof reason === 'string' && reason !== '') return reason
  return 'cancelled'
}

/**
 * A board-facing one-liner for one run: what happened, and whether it was even tracked.
 *
 * Says "untracked" OUT LOUD rather than omitting the field, so a reader never has to infer
 * from a missing id whether the job ran without a board or the board lost it.
 */
export function describeJobRun<T>(result: JobRunResult<T>): string {
  const where = result.tracked ? 'job ' + (result.jobId ?? '(no id)') : 'untracked (no job registry)'
  const why = result.detail ?? result.error
  return result.status + ' — ' + where + (why === undefined ? '' : ': ' + why)
}
