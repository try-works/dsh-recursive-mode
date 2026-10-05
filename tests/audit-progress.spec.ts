/**
 * T20 — bound recovery on NO-PROGRESS, not on round count.
 *
 * THE PROBLEM WITH A ROUND COUNT. `auditToPass` was bounded by `maxRounds ?? 3`, and
 * three rounds that each find NEW problems are not the same situation as three rounds
 * that repeat the SAME finding: one is progress, the other is a loop. A round count
 * cuts off the first and indulges the second.
 *
 * WHAT BOUNDS IT INSTEAD: a per-round PROGRESS CURSOR (the verdict plus the repair
 * instruction the round produced — the repair is synthesized from the findings, so it
 * is the round's own statement of what was wrong), and a `consecutiveNoProgress`
 * counter that resets only when the cursor CHANGES. The absolute attempt cap stays as
 * a backstop, and the terminal state requires an EXPLICIT resume rather than silently
 * retrying or silently giving up.
 *
 * RECONCILED WITH THE HOST GUARD, deliberately, because the item asked for that
 * decision to be explicit. `@deepseek-ai/dsh-repeat-tool-reminder` detects the same
 * TOOL called with identical arguments, per agent, and is ADVISORY — "it never
 * blocks or delays a legitimate repeated call", and it is cleared by a new user
 * message. T20 counts repeated AUDIT FINDINGS, is durable, HARD (it terminates the
 * loop), and survives turns. Different unit, different posture: complementary, not a
 * duplicate, and no parallel advisory is built here.
 */
import { describe, it, expect } from 'vitest'
import {
  auditToPass,
  renderTaskHistory,
  type AuditRoundOutcome,
  type TeamRuntimeLike,
  type TeamTaskViewLike,
} from '../src/teams-loop.ts'

function makeTask(id: string, revision: number, status: TeamTaskViewLike['status'] = 'pending'): TeamTaskViewLike {
  return {
    id,
    revision,
    subject: 'Audit to pass: run-1 03',
    description: 'drive 03 to pass',
    status,
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
  }
}

/** The same fake shape the loop's own spec uses: a scripted round sequence. */
function fakeTeam(script: Array<AuditRoundOutcome | Error>) {
  const calls: string[] = []
  const task = makeTask('task-a', 1)
  let revision = 1
  let roundIndex = 0
  const runtime: TeamRuntimeLike = {
    createTask: async (_caller, request) => {
      calls.push('createTask:' + request.subject)
      return { ...task, revision }
    },
    updateTask: async (_caller, request) => {
      calls.push('updateTask:' + request.action)
      revision += 1
      const next = { ...task, revision }
      if (request.action === 'claim') next.status = 'in_progress'
      if (request.action === 'release') next.status = 'pending'
      if (request.action === 'complete') next.status = 'completed'
      if (request.action === 'edit') next.status = 'in_progress'
      return next
    },
    waitForChange: async () => ({ timedOut: false }),
    interrupt: () => ({ previousStatus: 'running' }),
  }
  return {
    calls,
    runtime,
    runAuditRound: async (): Promise<AuditRoundOutcome> => {
      const next = script[roundIndex] ?? script[script.length - 1]
      roundIndex += 1
      if (next instanceof Error) throw next
      return next as AuditRoundOutcome
    },
  }
}

function run(script: Array<AuditRoundOutcome | Error>, over: { maxRounds?: number; maxNoProgress?: number } = {}) {
  const fake = fakeTeam(script)
  return auditToPass({
    teams: fake.runtime,
    caller: { id: 'lead' },
    runId: 'run-1',
    phase: '03',
    runAuditRound: fake.runAuditRound,
    lockPhase: async () => {},
    ...over,
  }).then((result) => ({ result, calls: fake.calls }))
}

/** The same repair text every round: a loop, not progress. */
const SAME_FINDING: AuditRoundOutcome = { verdict: 'REVISE', accepted: false, repair: 'Address the findings: leak' }

describe('T20 — a NON-PROGRESSING audit stops and says why', () => {
  it('identical findings terminate as no-progress rather than running out the cap', async () => {
    const { result } = await run([SAME_FINDING, SAME_FINDING, SAME_FINDING, SAME_FINDING], { maxRounds: 10, maxNoProgress: 2 })
    expect(result.ok).toBe(false)
    expect(result.locked).toBe(false)
    expect(result.reason).toContain('no progress')
    // It stopped EARLY — the absolute cap was 10 and it never reached it.
    expect(result.rounds.length).toBeLessThan(10)
  })

  it('the terminal state DEMANDS an explicit resume', async () => {
    const { result } = await run([SAME_FINDING, SAME_FINDING, SAME_FINDING], { maxRounds: 10, maxNoProgress: 2 })
    expect(result.resumeRequired).toBe(true)
    // A released task, never a locked phase.
    expect(result.locked).toBe(false)
  })

  it('it names the REPEATED instruction, so a human can see what was not fixed', async () => {
    const { result } = await run([SAME_FINDING, SAME_FINDING, SAME_FINDING], { maxRounds: 10, maxNoProgress: 2 })
    expect(result.reason).toContain('leak')
  })

  it('surfaces the counters, because a bound nobody can see is a bound nobody trusts', async () => {
    const { result } = await run([SAME_FINDING, SAME_FINDING, SAME_FINDING], { maxRounds: 10, maxNoProgress: 2 })
    expect(result.attempts).toBeGreaterThan(0)
    expect(result.consecutiveNoProgress).toBeGreaterThanOrEqual(2)
    expect(result.progressCursor).toBeTruthy()
  })
})

describe('T20 — a PROGRESSING audit is not cut short by a round count', () => {
  it('DISTINCT findings keep going: the no-progress bound never fires', async () => {
    const distinct: AuditRoundOutcome[] = [
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: one' },
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: two' },
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: three' },
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: four' },
      { verdict: 'APPROVE', accepted: true },
    ]
    const { result } = await run(distinct, { maxRounds: 10, maxNoProgress: 2 })
    expect(result.ok).toBe(true)
    expect(result.locked).toBe(true)
    // Every round ran: progress was never mistaken for a loop.
    expect(result.rounds.length).toBeGreaterThanOrEqual(5)
    expect(result.consecutiveNoProgress).toBe(0)
  })

  it('the same finding TWICE is still allowed — one repeat is not yet a loop', async () => {
    const script: AuditRoundOutcome[] = [
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: leak' },
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: leak' },
      { verdict: 'APPROVE', accepted: true },
    ]
    const { result } = await run(script, { maxRounds: 10, maxNoProgress: 2 })
    expect(result.ok).toBe(true)
    expect(result.locked).toBe(true)
  })

  it('a CHANGED finding RESETS the counter', async () => {
    const script: AuditRoundOutcome[] = [
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: a' },
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: a' },
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: b' },
      { verdict: 'REVISE', accepted: false, repair: 'Address the findings: b' },
      { verdict: 'APPROVE', accepted: true },
    ]
    const { result } = await run(script, { maxRounds: 10, maxNoProgress: 2 })
    // The run of two 'a' rounds is followed by two 'b' rounds: with the counter reset
    // on change, neither run reaches the limit of 2 CONSECUTIVE no-progress rounds.
    expect(result.ok).toBe(true)
    expect(result.locked).toBe(true)
  })

  it('the ABSOLUTE cap survives as a backstop for a still-progressing loop', async () => {
    // Every round finds something new, so no-progress never fires — the round cap is
    // what stops it, and it must still do so.
    const script: AuditRoundOutcome[] = Array.from({ length: 12 }, (_, i) => ({
      verdict: 'REVISE' as const, accepted: false, repair: 'Address the findings: n' + i,
    }))
    const { result } = await run(script, { maxRounds: 4, maxNoProgress: 99 })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('max rounds')
    expect(result.resumeRequired).toBe(true)
  })
})

describe('T20 — the counters reach the board', () => {
  it('renderTaskHistory shows the progress trail', async () => {
    const { result } = await run([SAME_FINDING, SAME_FINDING, SAME_FINDING], { maxRounds: 10, maxNoProgress: 2 })
    const history = renderTaskHistory(result.taskView, result.rounds)
    expect(history).toContain('round 1')
    expect(history).toMatch(/no-progress|no progress/i)
  })

  it('a rejected audit is NOT reported as a no-progress stop', async () => {
    const { result } = await run([{ verdict: 'REJECT', accepted: false }], { maxRounds: 10 })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('rejected')
    expect(result.resumeRequired).toBeUndefined()
  })
})
