import { describe, it, expect } from 'vitest'
import {
  RUN_TO_GOAL_PHASE, runGoalTag, goalObjective, isRunGoal,
  syncRunGoal, blockRunGoal, resumeRunGoal,
  type GoalServiceLike, type GoalViewLike, type GoalRefLike,
} from '../src/goals-projection.ts'
import { RUN_START_NOT_APPROVED } from '../src/run-start.ts'

/** Structural fake of the goals service that mutates a single current goal. */
function fakeService(initial?: GoalViewLike) {
  let revision = initial?.revision ?? 1
  const state = { current: initial }
  const mutate = (phase: GoalViewLike['phase'], ref: GoalRefLike): GoalViewLike => {
    if (!state.current || state.current.id !== ref.id) throw new Error('goal revision mismatch')
    state.current = { ...state.current, phase, revision: ref.revision + 1 }
    return state.current
  }
  const service: GoalServiceLike = {
    get: () => state.current,
    create: (_agent, req) => {
      const created: GoalViewLike = { id: 'g' + (++revision), revision, objective: req.objective, phase: 'active' }
      state.current = created
      return created
    },
    block: (_agent, ref) => mutate('blocked', ref),
    pause: (_agent, ref) => mutate('paused', ref),
    resume: (_agent, ref) => mutate('active', ref),
    complete: (_agent, ref) => mutate('complete', ref),
    clear: (_agent, ref) => { state.current = undefined; return { id: ref.id, revision: ref.revision + 1 } },
  }
  return { service, state }
}

function runGoal(runId: string, phase: GoalViewLike['phase'] = 'active', id = 'g1', revision = 1): GoalViewLike {
  return { id, revision, objective: runGoalTag(runId) + ' · ' + (phase ?? 'active'), phase }
}

describe('goals-projection.ts — map + tag + isRunGoal', () => {
  it('maps every run state onto a native goal phase', () => {
    expect(RUN_TO_GOAL_PHASE).toEqual({ new: 'active', active: 'active', paused: 'paused', blocked: 'blocked', complete: 'complete' })
  })

  it('builds a run-marker objective and matches goals by it', () => {
    expect(runGoalTag('r1')).toBe('recursive-run:r1')
    expect(goalObjective('r1', 'blocked')).toBe('recursive-run:r1 · blocked')
    expect(isRunGoal(runGoal('r1'), 'r1')).toBe(true)
    expect(isRunGoal(runGoal('r2'), 'r1')).toBe(false)
    expect(isRunGoal(undefined, 'r1')).toBe(false)
  })
})

/**
 * PHASE 0 — THE APPROVAL GATE ON CREATION.
 *
 * `goals.create` returns an ARMED goal, and an armed goal is the harness driving autonomous rounds for
 * the session. So creating one is not bookkeeping: it is STARTING THE RUN. The owner's rule is that
 * phase 0 requires explicit approval to start a run and goal, which makes the UNPROVED case the one to
 * pin first — the projection must be unable to arm anything on its own, in every branch, with a default
 * that fails closed.
 */
describe('syncRunGoal — PHASE 0: no approval, no goal', () => {
  it('creates NO goal when no approval has been given (the defect this closes)', () => {
    const { service, state } = fakeService()
    const res = syncRunGoal(service, {}, 'r1', 'active')
    expect(res).toEqual({ ok: false, reason: RUN_START_NOT_APPROVED })
    expect(state.current).toBeUndefined()
    // The objective of the bug is printed rather than assumed: this is exactly the goal that used to
    // exist with no approval of any kind.
    expect(state.current?.objective).not.toBe('recursive-run:r1 · active')
  })

  it('REFUSES to replace a completed goal for this run without approval', () => {
    const { service, state } = fakeService(runGoal('r1', 'complete'))
    const res = syncRunGoal(service, {}, 'r1', 'active')
    expect(res.ok).toBe(false)
    expect(state.current?.phase).toBe('complete')
  })

  it('REFUSES to replace a completed FOREIGN goal without approval', () => {
    // Branch 2 is the one that "cannot happen" for an unapproved run — which is exactly the reasoning a
    // single unguarded branch relied on. Both replace paths are gated, so neither is a way in.
    const { service, state } = fakeService(runGoal('other', 'complete'))
    const res = syncRunGoal(service, {}, 'r1', 'active')
    expect(res.ok).toBe(false)
    expect(state.current?.objective).toBe('recursive-run:other · complete')
  })

  it('is QUIET and IDEMPOTENT across repeated phase steps before approval', () => {
    // `syncRunGoal` is reached on ordinary work, so the unapproved state must be a stable value, not an
    // error raised once per step: the caller has to be able to tell "not started yet" from a failure.
    const { service, state } = fakeService()
    const seen = ['active', 'paused', 'blocked', 'complete', 'active'].map((phase) => {
      const res = syncRunGoal(service, {}, 'r1', phase as never)
      return res
    })
    for (const res of seen) expect(res).toEqual({ ok: false, reason: RUN_START_NOT_APPROVED })
    expect(state.current).toBeUndefined()
  })

  it('does not block or resume a goal that was never created', () => {
    const { service, state } = fakeService()
    // A run that was never started has no goal, so neither entry point may invent one on the way past.
    expect(blockRunGoal(service, {}, 'r1', { code: 'x', message: 'y' }).ok).toBe(false)
    expect(resumeRunGoal(service, {}, 'r1').ok).toBe(false)
    expect(state.current).toBeUndefined()
  })

  it('reopen is NOT a back door: an approved run still re-arms, an unapproved one still does not', () => {
    const approved = fakeService(runGoal('r1', 'blocked'))
    expect(syncRunGoal(approved.service, {}, 'r1', 'active', true).ok).toBe(true)
    expect(approved.state.current?.phase).toBe('active')

    const unapproved = fakeService()
    expect(resumeRunGoal(unapproved.service, {}, 'r1', false).ok).toBe(false)
    expect(unapproved.state.current).toBeUndefined()
  })
})

describe('syncRunGoal — create / mutate / no-op / replace / foreign', () => {
  it('creates an ARMED run goal once phase 0 is approved', () => {
    const { service, state } = fakeService()
    const res = syncRunGoal(service, {}, 'r1', 'active', true)
    expect(res.ok).toBe(true)
    expect(state.current?.objective).toBe('recursive-run:r1 · active')
    expect(state.current?.phase).toBe('active')
  })

  it('mutates an existing run goal to the requested phase', () => {
    const { service, state } = fakeService(runGoal('r1', 'active'))
    const res = syncRunGoal(service, {}, 'r1', 'blocked')
    expect(res.ok).toBe(true)
    expect(state.current?.phase).toBe('blocked')
  })

  it('is a no-op when already at the requested phase', () => {
    const initial = runGoal('r1', 'paused')
    const { service, state } = fakeService(initial)
    const res = syncRunGoal(service, {}, 'r1', 'paused')
    expect(res.ok).toBe(true)
    expect(state.current).toEqual(initial)
  })

  it('replaces a completed run goal on a new phase (never resumes it)', () => {
    const { service, state } = fakeService(runGoal('r1', 'complete'))
    const res = syncRunGoal(service, {}, 'r1', 'active', true)
    expect(res.ok).toBe(true)
    expect(state.current?.phase).toBe('active')
    expect(state.current?.objective).toBe('recursive-run:r1 · active')
  })

  it('never clobbers a foreign goal', () => {
    const { service, state } = fakeService(runGoal('other', 'active'))
    const res = syncRunGoal(service, {}, 'r1', 'active', true)
    expect(res.ok).toBe(false)
    expect(state.current?.objective).toBe('recursive-run:other · active')
    expect(state.current?.phase).toBe('active')
  })

  it('reports ok:false when no goals service is present', () => {
    expect(syncRunGoal(null, {}, 'r1', 'active').ok).toBe(false)
  })
})

describe('blockRunGoal / resumeRunGoal', () => {
  it('blocks the current run goal with a durable reason', () => {
    const { service, state } = fakeService(runGoal('r1', 'active'))
    const res = blockRunGoal(service, {}, 'r1', { code: 'prerequisite-blockers', message: 'monotonic lock-order' })
    expect(res.ok).toBe(true)
    expect(state.current?.phase).toBe('blocked')
  })

  it('does not block a foreign goal', () => {
    const { service, state } = fakeService(runGoal('other', 'active'))
    const res = blockRunGoal(service, {}, 'r1', { code: 'x', message: 'y' })
    expect(res.ok).toBe(false)
    expect(state.current?.phase).toBe('active')
  })

  it('re-arms a blocked run goal to active', () => {
    const { service, state } = fakeService(runGoal('r1', 'blocked'))
    const res = resumeRunGoal(service, {}, 'r1', true)
    expect(res.ok).toBe(true)
    expect(state.current?.phase).toBe('active')
  })
})
