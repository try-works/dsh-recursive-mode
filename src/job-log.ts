/**
 * T39 — surface job runs to the board as a durable, file-backed log.
 *
 * WHY A FILE AND NOT AN EVENT BUS. The native registry offers
 * `jobs.events.subscribe(filter, listener)`, and subscribing was the first thing this looked
 * like it should do. It is the wrong seam for THIS job: an event carries a job id and a
 * status, but **not the run a job belongs to** — and the plugin's board reads the RUN LAYER.
 * Subscribing would therefore mean parsing run ids back out of our own labels, which is a
 * mapping that breaks silently the day a label changes. The call site already knows the run
 * it started work for, so the run id is recorded where it is KNOWN and read where it is
 * NEEDED. That also keeps the zero-emission invariant: a file in the run layer, never a
 * session event.
 *
 * ⚠ BEST-EFFORT BY DESIGN, exactly like the guard log and the settlement log: a failed log
 * write must never change the outcome of work that already ran. Recording is observability;
 * letting observability fail a lint would be the tail wagging the dog.
 *
 * ⚠ AND IT SAYS WHETHER THE RUN WAS TRACKED. `tracked: false` is recorded rather than left
 * implicit, because a reader must be able to tell "this job ran without a board" from "the
 * board lost it" — the same distinction `describeJobRun` makes for a caller.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { JobRunResult } from './jobs-runner.ts'

/** One recorded run, as the board reads it. */
export interface JobLogRecord {
  at: string
  /** The producer kind: `lint`, `worktree`, `delegation`. */
  kind: string
  label: string
  /** False when there was no registry and the work ran inline. */
  tracked: boolean
  jobId?: string
  status: 'completed' | 'killed' | 'failed'
  detail?: string
}

/** Where a run's job log lives, beside its other run-layer records. */
export function jobsLogPath(root: string, runId: string): string {
  return join(root, '.recursive', 'run', runId, 'jobs', 'jobs.jsonl')
}

/**
 * Append one run to the log. Never throws: an unwritable log is not a reason for a completed
 * lint to be reported as a failure.
 *
 * @returns true when the line was written, false when it could not be — so a caller that
 * cares can say so without this function deciding for it.
 */
export function recordJobRun(
  root: string,
  runId: string,
  entry: { kind: string; label: string; result: JobRunResult<unknown> },
): boolean {
  if (root === '' || runId === '') return false
  try {
    const path = jobsLogPath(root, runId)
    mkdirSync(dirname(path), { recursive: true })
    const record: JobLogRecord = {
      at: new Date().toISOString(),
      kind: entry.kind,
      label: entry.label,
      tracked: entry.result.tracked,
      status: entry.result.status,
    }
    if (entry.result.jobId !== undefined) record.jobId = entry.result.jobId
    const detail = entry.result.detail ?? entry.result.error
    if (detail !== undefined) record.detail = detail
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** Read a run's job log. A missing or damaged file reads as empty — never an error. */
export function readJobRuns(root: string, runId: string): JobLogRecord[] {
  const path = jobsLogPath(root, runId)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as JobLogRecord
          return typeof parsed?.kind === 'string' && typeof parsed?.status === 'string' ? [parsed] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/**
 * A board-facing rendering: one line per run, newest last, with the untracked and
 * non-completed cases called out rather than implied.
 */
export function renderJobLog(root: string, runId: string): string {
  const records = readJobRuns(root, runId)
  if (records.length === 0) return 'no job runs recorded for this run'
  return records
    .map((record) => {
      const where = record.tracked ? (record.jobId ?? 'job') : 'untracked'
      const why = record.detail === undefined ? '' : ' — ' + record.detail
      return record.status + ' [' + record.kind + '] ' + where + ': ' + record.label + why
    })
    .join('\n')
}
