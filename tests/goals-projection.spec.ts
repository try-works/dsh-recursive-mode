import { describe, it, expect } from 'vitest'
import {
  RUN_TO_GOAL_PHASE, runGoalTag, goalObjective, isRunGoal,
  syncRunGoal, blockRunGoal, resumeRunGoal,
  type GoalServiceLike, type GoalViewLike, type GoalRefLike,
} from '../src/goals-projection.ts'

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

describe('syncRunGoal — create / mutate / no-op / replace / foreign', () => {
  it('creates a run goal when none exists', () => {
    const { service, state } = fakeService()
    const res = syncRunGoal(service, {}, 'r1', 'active')
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
    const res = syncRunGoal(service, {}, 'r1', 'active')
    expect(res.ok).toBe(true)
    expect(state.current?.phase).toBe('active')
    expect(state.current?.objective).toBe('recursive-run:r1 · active')
  })

  it('never clobbers a foreign goal', () => {
    const { service, state } = fakeService(runGoal('other', 'active'))
    const res = syncRunGoal(service, {}, 'r1', 'active')
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
    const res = resumeRunGoal(service, {}, 'r1')
    expect(res.ok).toBe(true)
    expect(state.current?.phase).toBe('active')
  })
})
