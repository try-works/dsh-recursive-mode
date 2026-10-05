/**
 * T3: model the audit→repair→re-audit loop as agentTeams Tasks.
 *
 * The recursion concept's core state machine, expressed over the native
 * `agentTeams` service: ONE durable task per phase carries the loop —
 * createTask (pending) → claim (in_progress) → audit round → on REVISE* updateTask(edit, repair instruction) → re-audit the SAME task → on APPROVE
 * updateTask(complete) → lock. A stuck reviewer is interrupted through the
 * team's own kill switch; a REJECT or round-cap releases the task and fails
 * loud — a lock NEVER happens before an APPROVE verdict.
 *
 * Everything here is a structural seam (TeamRuntimeLike / TeamTaskViewLike)
 * so the whole loop is unit-testable with a fake team; the live `agentTeams`
 * service satisfies the seam without an adapter. The caller Agent passes
 * through as an opaque `TeamCallerHandle` (never serialized; workspace-scoped
 * invariant).
 */

/** Verdict vocabulary shared with T4 (matches the delegated review schema). */
export type AuditVerdict = 'APPROVE' | 'REVISE' | 'REJECT'

/**
 * Opaque handle to the live Team member/lead Agent authorizing task mutations.
 * The seam uses it only for identity/authority and never inspects or serializes it.
 */
export interface TeamCallerHandle {
  readonly id?: string
  readonly session?: { readonly header?: { readonly cwd?: string } }
}

/**
 * T19: the ONLY import this module takes. Everything else it needs arrives through
 * its injected seams, which is what keeps the loop drivable by fakes — but operation
 * identity must be computed with the SAME canonical rule as every other operation in
 * the plugin, so it comes from the shared module rather than a local copy. That would
 * be the one place two implementations could silently disagree.
 */
import { canonicalInput, operationId } from './identity.ts'

/** Minimal cancellation shape (a live AbortSignal satisfies it). */
export interface TeamAbortSignalLike {
  readonly throwIfAborted: () => void
}

/** Task identity: a branded string in the live service. */
export type TeamTaskIdLike = string

/** Task status vocabulary (mirrors the live TeamTaskStatus). */
export type TeamTaskStatusLike = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Task action vocabulary (mirrors the live TeamTaskAction; the loop uses a subset). */
export type TeamTaskActionLike = 'claim' | 'release' | 'edit' | 'complete'

/** One runtime-enriched task view (the fields the loop reads/writes). */
export interface TeamTaskViewLike {
  readonly id: TeamTaskIdLike
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatusLike
  readonly blockedBy: TeamTaskIdLike[]
  readonly writeScopes: string[]
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
}

/** A wait observation (mirrors TeamWaitResult). */
export interface TeamWaitResultLike {
  readonly timedOut: boolean
}

/** Create-task request (mirrors CreateTeamTaskRequest). */
export interface CreateTeamTaskRequestLike {
  subject: string
  description: string
  blockedBy?: readonly TeamTaskIdLike[]
  writeScopes?: readonly string[]
}

/** Compare-and-set task transition (mirrors UpdateTeamTaskRequest). */
export interface UpdateTeamTaskRequestLike {
  taskId: TeamTaskIdLike
  expectedRevision: number
  action: TeamTaskActionLike
  subject?: string
  description?: string
  blockedBy?: readonly TeamTaskIdLike[]
  writeScopes?: readonly string[]
  owner?: string
}

/**
 * The agentTeams seam the loop calls. `waitForChange`/`interrupt`/`getTask`/
 * `listTasks` are optional (loops degrade: no wait, no kill switch, no board
 * re-read) — `createTask`/`updateTask` are hard requirements.
 */
export interface TeamRuntimeLike {
  createTask(caller: TeamCallerHandle, request: CreateTeamTaskRequestLike): Promise<TeamTaskViewLike>
  updateTask(caller: TeamCallerHandle, request: UpdateTeamTaskRequestLike): Promise<TeamTaskViewLike>
  getTask?(caller: TeamCallerHandle, id: TeamTaskIdLike): TeamTaskViewLike
  listTasks?(caller: TeamCallerHandle): TeamTaskViewLike[]
  waitForChange?(caller: TeamCallerHandle, timeoutMs: number, signal: TeamAbortSignalLike | undefined): Promise<TeamWaitResultLike>
  interrupt?(caller: TeamCallerHandle, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' }
}

/** One audit round's outcome (the verdict + synthesized repair + acceptance). */
export interface AuditRoundOutcome {
  readonly verdict: AuditVerdict
  /** Repair instruction synthesized from findings (REVISE only). */
  readonly repair?: string
  /** Whether the underlying delegation result itself was accepted. */
  readonly accepted: boolean
  readonly reason?: string
}

/** One completed loop round (the task revision trail for the board history). */
export interface AuditLoopRound {
  readonly round: number
  readonly verdict: AuditVerdict
  readonly repair?: string
  readonly taskRevision: number
  /**
   * T20: true when this round produced the SAME progress cursor as its predecessor —
   * the same finding, restated. Rendered so the board shows a loop as a loop.
   */
  readonly noProgress?: boolean
}

/** The auditToPass result. */
export interface AuditToPassResult {
  readonly ok: boolean
  readonly reason?: string
  /** The durable task the loop ran on (revision trail lives on the team log). */
  readonly taskId?: TeamTaskIdLike
  readonly rounds: AuditLoopRound[]
  /** True only when an APPROVE verdict completed the task and locked the phase. */
  readonly locked: boolean
  /** Latest task view (board-facing per-phase history). */
  readonly taskView?: TeamTaskViewLike
  /**
   * T19: true when this call was recognised as a repeat of an audit-to-pass that had
   * already completed for this run and phase, so no second task was created. The
   * caller must read the PHASE's lock state itself — this result cannot claim the
   * artifact is locked, because a recognised repeat performs no locking.
   */
  readonly recognisedRepeat?: boolean
  /**
   * T20: how many rounds ran. The absolute backstop, reported so a caller can see how
   * close the loop came to its cap.
   */
  readonly attempts?: number
  /** T20: consecutive rounds that produced the SAME progress cursor. */
  readonly consecutiveNoProgress?: number
  /** T20: the last round's progress cursor — what the round said was wrong. */
  readonly progressCursor?: string
  /** T28: how many repairs were requested before the loop stopped. */
  readonly repairAttempts?: number
  /**
   * T20: true when the loop stopped in a state that must NOT be retried
   * automatically — no progress, or the attempt cap. The caller has to decide to
   * resume, deliberately, rather than a loop quietly grinding on or quietly giving up.
   */
  readonly resumeRequired?: boolean
}

/**
 * T19: the operation-index seam.
 *
 * INJECTED, not imported. `auditToPass` is pure over its seams — it has no `runDir`
 * and no filesystem access, which is exactly what lets the whole loop be driven by
 * fakes in tests. Reaching for `recordOperation` directly would have traded that away
 * for one line of convenience, so the caller supplies persistence instead.
 */
export interface AuditOperationsSeamLike {
  /** The previously recorded attempt for an id, or null when it is new. */
  find?: (id: string) => { id: string; outcome?: string } | null
  /** Record one attempt. Best-effort: a failed write must not change the loop's outcome. */
  record?: (record: { id: string; act: string; at: string; outcome?: string }) => void
}

/** Inputs for one audit-to-pass loop. */
export interface AuditToPassInput {
  /** The agentTeams seam. */
  readonly teams: TeamRuntimeLike
  /** Exact live Team member/lead authorizing the task mutations. */
  readonly caller: TeamCallerHandle
  /** Phase + run identity (task subject/description vocabulary). */
  readonly runId: string
  readonly phase: string
  /** Optional task blockers (previous-phase task ids). */
  readonly blockedBy?: readonly TeamTaskIdLike[]
  /** Write scopes for the phase artifact (advisory, overlap-warned). */
  readonly writeScopes?: readonly string[]
  /**
   * T19: the operation index, injected. Absent it, the loop runs exactly as before —
   * no pre-check, no records, no behaviour change.
   */
  readonly operations?: AuditOperationsSeamLike
  /** Run ONE audit round for the current task; live usage delegates (T4). */
  readonly runAuditRound: (round: number, task: TeamTaskViewLike) => Promise<AuditRoundOutcome>
  /** Lock the phase artifact — called ONLY after an APPROVE verdict. */
  readonly lockPhase: () => Promise<void>
  /** Team member name to interrupt on a stuck reviewer (defaults to the role). */
  readonly reviewerName?: string
  /** Round cap (fail loud past it; no lock). */
  readonly maxRounds?: number
  /**
   * T20: how many CONSECUTIVE rounds may repeat the same progress cursor before the
   * loop stops and demands a resume. Default 2, so three identical rounds terminate:
   * the first sets the cursor and the next two repeat it. Absent the bound, a phase
   * could restate one unfixed finding until the attempt cap, which is the wrong
   * budget — a round count indulges a loop while cutting off genuine progress.
   */
  readonly maxNoProgress?: number
  /**
   * T28: the configurable caps. `maxAuditRounds` is the absolute round ceiling and
   * `maxRepairAttempts` bounds how many times a phase may be sent back for repair
   * even when every round finds something NEW — the case T20's no-progress bound
   * deliberately lets run. Both are optional so an existing caller keeps its
   * behaviour, with the round cap falling back to `maxRounds ?? 3`.
   */
  readonly budgets?: { readonly maxAuditRounds?: number; readonly maxRepairAttempts?: number }
  /** Per-round wait timeout before the audit round runs (skipped without the seam). */
  readonly waitTimeoutMs?: number
}

/** Whether a view is the loop's expected task (guards CAS against foreign ids). */
function isSameTask(task: TeamTaskViewLike, id: TeamTaskIdLike): boolean {
  return task.id === id
}

/**
 * Render a per-phase task history (board-facing; pure). One line per round plus
 * the final task status — no live data, no mutation.
 */
export function renderTaskHistory(task: TeamTaskViewLike | undefined, rounds: readonly AuditLoopRound[]): string {
  const lines: string[] = []
  if (task !== undefined) {
    lines.push('task ' + task.id + ' (' + task.status + ', rev ' + task.revision + '): ' + task.subject)
  }
  for (const round of rounds) {
    const repair = round.repair ? ' — ' + round.repair : ''
    const marker = round.noProgress ? ' [no progress]' : ''
    lines.push('round ' + round.round + ': ' + round.verdict + ' (task rev ' + round.taskRevision + ')' + repair + marker)
  }
  // T20: a loop should LOOK like a loop on the board, not just end like one.
  const noProgressRounds = rounds.filter((round) => round.noProgress === true).length
  if (noProgressRounds > 0) {
    lines.push('no progress: ' + noProgressRounds + ' round(s) restated the same finding — an explicit resume is required')
  }
  return lines.join('\n')
}

/**
 * T3 driver: audit the phase until it passes, on ONE durable team task.
 *
 * Transition trail (the fake records exactly this order):
 *   createTask(pending) → claim(in_progress) → waitForChange → audit round
 *   → REVISE: updateTask(edit, repair) → waitForChange → re-audit SAME task
 *   → APPROVE: updateTask(complete) → lockPhase()
 *   → REJECT / cap / stuck: updateTask(release) + interrupt, NO lock.
 */
/**
 * T19 wrapper: recognise a repeat, then record what happened.
 *
 * The identity covers this run and phase. A call whose operation was already recorded
 * as APPLIED returns immediately without creating a second task — the acceptance's
 * "recognised no-op rather than a second execution". Every other outcome (rejected,
 * capped, errored) records as `unaccepted`, so a retry still runs: a failed audit must
 * stay retryable, and only a COMPLETED one is a repeat.
 *
 * Per-round entries are recorded after the loop from the result's own round trail.
 * That is one write per call instead of one per round, and it keeps the loop body
 * free of persistence — but it does mean a crash MID-loop leaves the whole operation
 * unrecorded, which is the honest trade for not threading a writer through every
 * branch.
 */
export async function auditToPass(input: AuditToPassInput): Promise<AuditToPassResult> {
  const operation = operationId({ act: 'audit-to-pass', input: { runId: input.runId, phase: input.phase } })
  const prior = input.operations?.find?.(operation) ?? null
  if (prior?.outcome === 'applied') {
    return {
      ok: true,
      reason: 'recognised repeat: an audit-to-pass for ' + input.runId + ' ' + input.phase +
        ' already completed, so no second task was created',
      rounds: [],
      locked: false,
      recognisedRepeat: true,
    }
  }

  const result = await runAuditToPass(input)
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  input.operations?.record?.({
    id: operation,
    act: 'audit-to-pass',
    at,
    outcome: result.ok && result.locked ? 'applied' : 'unaccepted',
  })
  for (const round of result.rounds) {
    input.operations?.record?.({
      id: operationId({ act: 'audit-round', input: { runId: input.runId, phase: input.phase, round: round.round } }),
      act: 'audit-round',
      at,
      outcome: round.verdict,
    })
  }
  return result
}

async function runAuditToPass(input: AuditToPassInput): Promise<AuditToPassResult> {
  const { teams, caller, runId, phase, runAuditRound, lockPhase } = input
  const maxRounds = input.maxRounds ?? input.budgets?.maxAuditRounds ?? 3
  // T28: the repair budget. Absent a configured cap, repairs are unbounded here on
  // purpose — the round cap and the no-progress bound still apply, and inventing a
  // silent default would change the behaviour of every existing caller.
  const maxRepairAttempts = input.budgets?.maxRepairAttempts ?? Number.POSITIVE_INFINITY
  let repairAttempts = 0
  // T20: the no-progress bound, and the counters that make it visible.
  const maxNoProgress = input.maxNoProgress ?? 2
  let consecutiveNoProgress = 0
  let progressCursor = ''
  let attempts = 0
  const waitTimeoutMs = input.waitTimeoutMs ?? 30_000
  const waitForChange = teams.waitForChange
  const interrupt = teams.interrupt
  const rounds: AuditLoopRound[] = []

  const createRequest: CreateTeamTaskRequestLike = {
    subject: 'Audit to pass: ' + runId + ' ' + phase,
    description: 'drive ' + phase + ' through draft → audit → repair → re-audit → pass → lock for run ' + runId,
  }
  if (input.blockedBy !== undefined) createRequest.blockedBy = input.blockedBy
  if (input.writeScopes !== undefined) createRequest.writeScopes = input.writeScopes
  const task = await teams.createTask(caller, createRequest)

  const claim = await teams.updateTask(caller, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
  if (!isSameTask(claim, task.id)) return { ok: false, reason: 'claim returned a foreign task', taskId: task.id, rounds, locked: false, taskView: claim }

  let current = claim
  rounds.push({ round: 0, verdict: 'REVISE', taskRevision: current.revision })

  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      // Wait for team activity before the round (bounded; skipped without the seam).
      if (waitForChange !== undefined) {
        await waitForChange(caller, waitTimeoutMs, undefined)
      }
      const outcome = await runAuditRound(round, current)
      if (!isSameTask(current, task.id)) return { ok: false, reason: 'round observed a foreign task', taskId: task.id, rounds, locked: false, taskView: current }

      // T20 — THE PROGRESS CURSOR. A round's statement of what is wrong is its verdict
      // plus the repair it produced (that repair is synthesized from the findings, so
      // it is the round's own summary of the problem). The SAME cursor twice running
      // means the previous repair did not change anything, which is a loop; a CHANGED
      // cursor is progress and resets the counter. Canonical JSON, so two structurally
      // identical rounds cannot differ by key order.
      attempts = round
      const cursor = canonicalInput({ verdict: outcome.verdict, repair: outcome.repair ?? '', reason: outcome.reason ?? '' })
      const repeated = cursor === progressCursor
      consecutiveNoProgress = repeated ? consecutiveNoProgress + 1 : 0
      progressCursor = cursor

      if (outcome.verdict === 'APPROVE') {
        const completed = await teams.updateTask(caller, { taskId: task.id, expectedRevision: current.revision, action: 'complete' })
        await lockPhase()
        rounds.push({ round, verdict: 'APPROVE', taskRevision: completed.revision })
        return { ok: outcome.accepted, reason: outcome.accepted ? 'audit passed and phase locked' : 'verdict APPROVE but delegation not accepted', taskId: task.id, rounds, locked: true, taskView: completed, attempts, consecutiveNoProgress, progressCursor }
      }

      if (outcome.verdict === 'REJECT') {
        // A rejected audit is not a pass: release the task and fail loud.
        const released = await teams.updateTask(caller, { taskId: task.id, expectedRevision: current.revision, action: 'release' })
        rounds.push({ round, verdict: 'REJECT', taskRevision: released.revision })
        return { ok: false, reason: 'audit rejected at round ' + round, taskId: task.id, rounds, locked: false, taskView: released }
      }

      // REVISE: record the repair instruction on the SAME task and re-audit.
      const repair = outcome.repair ?? 'REVISE: address the review findings and re-submit.'
      const edited = await teams.updateTask(caller, {
        taskId: task.id,
        expectedRevision: current.revision,
        action: 'edit',
        description: current.description + '\nround ' + round + ' repair: ' + repair,
      })
      current = edited
      repairAttempts += 1
      rounds.push({ round, verdict: 'REVISE', repair, taskRevision: edited.revision, ...(repeated ? { noProgress: true } : {}) })

      // T28 — THE REPAIR BUDGET. Checked before the no-progress bound because it is
      // the wider stopping condition: a repair budget catches a loop that keeps
      // finding NEW things, which is precisely the loop the no-progress bound is
      // designed not to stop.
      if (repairAttempts >= maxRepairAttempts) {
        const released = await teams.updateTask(caller, { taskId: task.id, expectedRevision: current.revision, action: 'release' })
        return {
          ok: false,
          reason: 'repair budget reached: ' + repairAttempts + ' repair attempt(s) without an APPROVE',
          taskId: task.id,
          rounds,
          locked: false,
          taskView: released,
          attempts,
          repairAttempts,
          consecutiveNoProgress,
          progressCursor,
          resumeRequired: true,
        }
      }

      // T20 — STOP THE LOOP, DO NOT SPEND THE CAP ON IT. A phase that restates the
      // same finding has not been repaired, and more rounds will not repair it. The
      // terminal state demands an EXPLICIT resume: silently grinding on wastes the
      // budget, and silently giving up hides an unfixed phase.
      if (consecutiveNoProgress >= maxNoProgress) {
        const released = await teams.updateTask(caller, { taskId: task.id, expectedRevision: current.revision, action: 'release' })
        return {
          ok: false,
          reason: 'no progress: ' + consecutiveNoProgress + ' consecutive rounds repeated the same finding (' + repair + ')',
          taskId: task.id,
          rounds,
          locked: false,
          taskView: released,
          attempts,
          consecutiveNoProgress,
          progressCursor,
          resumeRequired: true,
        }
      }
    }
    // Round cap: release and fail loud — never lock without an APPROVE. T20 keeps the
    // cap as the ABSOLUTE backstop for a loop that keeps making progress.
    const released = await teams.updateTask(caller, { taskId: task.id, expectedRevision: current.revision, action: 'release' })
    return {
      ok: false,
      reason: 'max rounds reached without an APPROVE',
      taskId: task.id,
      rounds,
      locked: false,
      taskView: released,
      attempts,
      consecutiveNoProgress,
      progressCursor,
      resumeRequired: true,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A stuck reviewer is interrupted through the team kill switch (the task
    // itself stays for a later resume); best-effort, never replaces the error.
    if (interrupt !== undefined) {
      try {
        interrupt(caller, input.reviewerName ?? 'auditor')
      } catch { /* interrupt is best-effort */ }
    }
    return {
      ok: false,
      reason: message,
      taskId: task.id,
      rounds,
      locked: false,
      taskView: current,
      attempts,
      consecutiveNoProgress,
      progressCursor,
      resumeRequired: true,
    }
  }
}

/** Whether a task view is currently claimed by the named owner (board-facing). */
export function isTaskClaimedBy(task: TeamTaskViewLike, ownerName: string): boolean {
  return task.ownerName === ownerName && task.status === 'in_progress'
}
