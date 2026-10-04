/**
 * T3: model the audit→repair→re-audit loop as agentTeams Tasks.
 *
 * The recursion concept's core state machine, expressed over the native
 * `agentTeams` service: ONE durable task per phase carries the loop —
 * createTask (pending) → claim (in_progress) → audit round → on REVISE
 * updateTask(edit, repair instruction) → re-audit the SAME task → on APPROVE
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
  /** Run ONE audit round for the current task; live usage delegates (T4). */
  readonly runAuditRound: (round: number, task: TeamTaskViewLike) => Promise<AuditRoundOutcome>
  /** Lock the phase artifact — called ONLY after an APPROVE verdict. */
  readonly lockPhase: () => Promise<void>
  /** Team member name to interrupt on a stuck reviewer (defaults to the role). */
  readonly reviewerName?: string
  /** Round cap (fail loud past it; no lock). */
  readonly maxRounds?: number
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
    lines.push('round ' + round.round + ': ' + round.verdict + ' (task rev ' + round.taskRevision + ')' + repair)
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
export async function auditToPass(input: AuditToPassInput): Promise<AuditToPassResult> {
  const { teams, caller, runId, phase, runAuditRound, lockPhase } = input
  const maxRounds = input.maxRounds ?? 3
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

      if (outcome.verdict === 'APPROVE') {
        const completed = await teams.updateTask(caller, { taskId: task.id, expectedRevision: current.revision, action: 'complete' })
        await lockPhase()
        rounds.push({ round, verdict: 'APPROVE', taskRevision: completed.revision })
        return { ok: outcome.accepted, reason: outcome.accepted ? 'audit passed and phase locked' : 'verdict APPROVE but delegation not accepted', taskId: task.id, rounds, locked: true, taskView: completed }
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
      rounds.push({ round, verdict: 'REVISE', repair, taskRevision: edited.revision })
    }
    // Round cap: release and fail loud — never lock without an APPROVE.
    const released = await teams.updateTask(caller, { taskId: task.id, expectedRevision: current.revision, action: 'release' })
    return { ok: false, reason: 'max rounds reached without an APPROVE', taskId: task.id, rounds, locked: false, taskView: released }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A stuck reviewer is interrupted through the team kill switch (the task
    // itself stays for a later resume); best-effort, never replaces the error.
    if (interrupt !== undefined) {
      try {
        interrupt(caller, input.reviewerName ?? 'auditor')
      } catch { /* interrupt is best-effort */ }
    }
    return { ok: false, reason: message, taskId: task.id, rounds, locked: false, taskView: current }
  }
}

/** Whether a task view is currently claimed by the named owner (board-facing). */
export function isTaskClaimedBy(task: TeamTaskViewLike, ownerName: string): boolean {
  return task.ownerName === ownerName && task.status === 'in_progress'
}
