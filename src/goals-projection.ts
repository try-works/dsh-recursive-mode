/**
 * goals-projection.ts (T1, STRENGTHENING-PLAN): project a recursive run into the
 * native `goals` service so the run is a first-class durable, resumable,
 * blockable object — and a gate block is durable + UI-visible rather than a
 * one-line advisory.
 *
 * Pure/structural: this module takes a `GoalServiceLike` seam (the real
 * `ctx.goals` satisfies it structurally) and an opaque `AgentHandle`, and never
 * imports the host `@deepseek-ai/dsh-goal` package. The real service's methods
 * take a live `Agent` and throw if the agent is not the registry's live
 * instance, so callers pass the live agent from a tool/pre-step `exec`.
 *
 * Safety rule: the projection NEVER clobbers a foreign goal. A goal whose
 * objective is not a `recursive-run:<id>` marker is left untouched (only a
 * completed goal may be replaced, per the service contract).
 */
import type { RunState } from './lifecycle.ts'
import { RUN_START_NOT_APPROVED } from './run-start.ts'

/** Native goal phase (mirrors @deepseek-ai/dsh-goal GoalPhase). */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** CSA identity for one exact goal revision. */
export interface GoalRefLike {
  id: string
  revision: number
}

/** Input resolved by the service when the round cap is omitted. */
export interface CreateGoalRequestLike {
  objective: string
  maxGoalRounds?: number
}

/** The subset of the goal view the projection reads. */
export interface GoalViewLike extends GoalRefLike {
  objective?: string
  phase?: GoalPhase
}

/** Opaque handle to the live DSH Agent; the projection never inspects it further. */
export interface AgentHandle {
  session?: { header?: { cwd?: string } }
}

/** Structural seam for the live `goals` service (real methods return GoalView). */
export interface GoalServiceLike {
  get(agent: AgentHandle): GoalViewLike | undefined
  create(agent: AgentHandle, req: CreateGoalRequestLike): GoalViewLike
  block(agent: AgentHandle, ref: GoalRefLike, reason: { code: string; message: string }): GoalViewLike
  pause(agent: AgentHandle, ref: GoalRefLike): GoalViewLike
  resume(agent: AgentHandle, ref: GoalRefLike): GoalViewLike
  complete(agent: AgentHandle, ref: GoalRefLike): GoalViewLike
  clear(agent: AgentHandle, ref: GoalRefLike): GoalRefLike
}

/** Outcome of a run→goal sync. */
export type SyncResult =
  | { ok: true; phase: GoalPhase; ref?: GoalRefLike; created?: boolean }
  | { ok: false; reason: string }

/** Marker embedded in the goal objective so a goal can be matched to its run. */
export function runGoalTag(runId: string): string {
  return 'recursive-run:' + runId
}

/** The durable objective string for a run goal. */
export function goalObjective(runId: string, runState: RunState = 'active'): string {
  return runGoalTag(runId) + ' · ' + runState
}

/** Map a run state onto the native goal phase it should project to. */
export const RUN_TO_GOAL_PHASE = {
  new: 'active', active: 'active', paused: 'paused', blocked: 'blocked', complete: 'complete',
} as const satisfies Record<RunState, GoalPhase>

/** Is this goal's objective the marker for `runId`? */
export function isRunGoal(goal: GoalViewLike | undefined, runId: string): boolean {
  return goal?.objective?.startsWith(runGoalTag(runId)) === true
}

/** Read a live ref (id + revision) for a goal. */
function refOf(goal: GoalViewLike): GoalRefLike {
  return { id: goal.id, revision: goal.revision }
}

/** Commit a phase mutation; the real service returns a truthy GoalView on success. */
function mutatePhase(service: GoalServiceLike, agent: AgentHandle, ref: GoalRefLike, target: GoalPhase): boolean {
  switch (target) {
    case 'blocked': return !!service.block(agent, ref, { code: 'run-gate-block', message: 'recursive run gate block' })
    case 'paused': return !!service.pause(agent, ref)
    case 'complete': return !!service.complete(agent, ref)
    case 'active': return !!service.resume(agent, ref)
  }
}

/**
 * Sync a run's durable goal to the requested phase. Safe: never touches a goal
 * whose objective is not this run's marker, and never re-creates over a
 * non-complete foreign goal.
 *
 * ⚠ `approved` IS THE PHASE-0 GATE, and it defaults to the SAFE direction. A goal is not a label:
 * `create` returns an ARMED view and the harness starts driving autonomous goal rounds for the
 * session, so creating one is starting the run. The owner's rule is that phase 0 requires explicit
 * approval, which means the projection must be unable to arm anything on its own — hence a default of
 * `false` and an explicit refusal in EVERY branch that would call `create`, including the two
 * replace-a-completed-goal branches (an unapproved run cannot have reached `complete`, but "cannot
 * happen" is what the single unguarded branch relied on too).
 *
 * ⚠ AND IT IS REACHED ON ORDINARY WORK, so the unapproved path is QUIET AND IDEMPOTENT: no goal is
 * created, nothing is written, no error is thrown, and the run's artifacts are untouched. The caller
 * reads {@link RUN_START_NOT_APPROVED} to tell "this run has not been started yet" apart from a real
 * failure, so a normal phase step never surfaces a warning.
 *
 * `approved` is passed IN rather than read here because this module is pure: it takes the goal service
 * seam and nothing else, and the plugin's own filesystem reads live in the runtime (see
 * `RecursiveRuntime.readRunStartApproval`).
 */
export function syncRunGoal(
  service: GoalServiceLike | undefined | null,
  agent: AgentHandle,
  runId: string,
  runState: RunState,
  approved = false,
): SyncResult {
  if (!service) return { ok: false, reason: 'no goals service' }
  const target = RUN_TO_GOAL_PHASE[runState]
  const current = service.get(agent)

  // 1. Existing goal for this run -> mutate to the requested phase (no-op at target).
  if (current && isRunGoal(current, runId)) {
    const phase = current.phase ?? 'active'
    const ref = refOf(current)
    if (phase === target) return { ok: true, phase: target, ref }
    // A completed goal is final: the contract allows it to be REPLACED, not resumed.
    if (phase === 'complete') {
      if (!approved) return { ok: false, reason: RUN_START_NOT_APPROVED }
      const created = service.create(agent, { objective: goalObjective(runId, runState) })
      return { ok: true, phase: target, ref: refOf(created), created: true }
    }
    const ok = mutatePhase(service, agent, ref, target)
    return ok ? { ok: true, phase: target, ref } : { ok: false, reason: 'goal mutation failed' }
  }

  // 2. A completed goal may be replaced; every other current phase must be
  //    cleared or resumed instead. Never clobber a foreign goal.
  if (current) {
    if (current.phase === 'complete') {
      if (!approved) return { ok: false, reason: RUN_START_NOT_APPROVED }
      const created = service.create(agent, { objective: goalObjective(runId, runState) })
      return { ok: true, phase: target, ref: refOf(created), created: true }
    }
    return { ok: false, reason: 'a non-matching active goal exists (foreign goal not touched)' }
  }

  // 3. No current goal. This is where the defect lived: scaffolding a run armed it. A run with no
  //    phase-0 approval stays goal-less — the spec exists, the run does not.
  if (!approved) return { ok: false, reason: RUN_START_NOT_APPROVED }
  const created = service.create(agent, { objective: goalObjective(runId, runState) })
  return { ok: true, phase: target, ref: refOf(created), created: true }
}

/**
 * Block the current run goal (used on a gate-block). Never touches a foreign goal.
 *
 * ⚠ A RUN THAT WAS NEVER STARTED HAS NO GOAL TO BLOCK, so this reports the unapproved state in the
 * same words as {@link syncRunGoal} rather than "no current goal to block": the caller's question is
 * "why is there no goal", and the answer must not depend on which entry point happened to ask.
 */
export function blockRunGoal(service: GoalServiceLike | undefined | null, agent: AgentHandle, runId: string, reason: { code: string; message: string }): SyncResult {
  if (!service) return { ok: false, reason: 'no goals service' }
  const current = service.get(agent)
  if (!current) return { ok: false, reason: RUN_START_NOT_APPROVED }
  if (!isRunGoal(current, runId)) return { ok: false, reason: 'current goal is not for this run (foreign goal not touched)' }
  const ref = refOf(current)
  const ok = !!service.block(agent, ref, reason)
  return ok ? { ok: true, phase: 'blocked', ref } : { ok: false, reason: 'goal block failed' }
}

/**
 * Bridge a run's blocked goal back to active (used on a reopen).
 *
 * ⚠ REOPEN IS NOT A BACK DOOR TO STARTING A RUN. It routes through {@link syncRunGoal}, so a reopen of
 * an unapproved run cannot create the goal that init deliberately withheld. An APPROVED run is
 * unaffected: its approval outlives the reopen, because the approval is a durable line in the run's
 * own Phase 0 artifact rather than a value held in memory (verified in `tests/run-start-approval.spec.ts`).
 */
export function resumeRunGoal(service: GoalServiceLike | undefined | null, agent: AgentHandle, runId: string, approved = false): SyncResult {
  return syncRunGoal(service, agent, runId, 'active', approved)
}
