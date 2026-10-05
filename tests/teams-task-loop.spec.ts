import { describe, it, expect } from 'vitest'
import {
  auditToPass,
  renderTaskHistory,
  isTaskClaimedBy,
  type TeamRuntimeLike,
  type TeamTaskViewLike,
  type AuditRoundOutcome,
} from '../src/teams-loop.ts'

/**
 * T3 (agentTeams task loop): the audit→repair→re-audit loop runs as ONE
 * durable team task — createTask → claim → wait → audit; REVISE edits the SAME
 * task; APPROVE completes it and ONLY THEN locks; REJECT / cap / hang release
 * or interrupt WITHOUT locking.
 */

function makeTask(id: string, revision: number, status: TeamTaskViewLike['status'] = 'pending'): TeamTaskViewLike {
  return {
    id,
    revision,
    subject: 'Audit to pass: run-7 ' + id,
    description: 'drive ' + id + ' to pass',
    status,
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
  }
}

interface FakeTeamOptions {
  /** Outcome per audit round (round 1..n). */
  script: Array<AuditRoundOutcome | Error>
  /** Throw on the nth updateTask call (1-based) to simulate a hung/stuck mutation. */
  failUpdateAt?: number
}

function fakeTeam(opts: FakeTeamOptions) {
  const calls: string[] = []
  const task = makeTask('task-a', 1)
  let revision = 1
  let updateCount = 0
  let roundIndex = 0

  const runtime: TeamRuntimeLike = {
    createTask: async (_caller, request) => {
      calls.push('createTask:' + request.subject)
      return { ...task, revision }
    },
    updateTask: async (_caller, request) => {
      updateCount += 1
      calls.push('updateTask:' + request.action + '@rev' + request.expectedRevision)
      if (opts.failUpdateAt === updateCount) throw new Error('stuck update')
      revision += 1
      const next = { ...task, revision }
      if (request.action === 'claim') next.status = 'in_progress'
      if (request.action === 'release') next.status = 'pending'
      if (request.action === 'complete') next.status = 'completed'
      if (request.action === 'edit') next.status = 'in_progress'
      return next
    },
    waitForChange: async () => {
      calls.push('waitForChange')
      return { timedOut: false }
    },
    interrupt: (_caller, targetName) => {
      calls.push('interrupt:' + targetName)
      return { previousStatus: 'running' }
    },
  }

  const runAuditRound = async (): Promise<AuditRoundOutcome> => {
    const entry = opts.script[roundIndex]
    roundIndex += 1
    if (entry instanceof Error) throw entry
    return entry
  }

  return { calls, runtime, runAuditRound, task }
}

describe('teams-loop.ts — T3 audit-to-pass task loop', () => {
  it('REVISE → APPROVE: one task, edit then complete, lock ONLY after the APPROVE completes', async () => {
    const fake = fakeTeam({
      script: [
        { verdict: 'REVISE', repair: 'fix the missing audit', accepted: true },
        { verdict: 'APPROVE', accepted: true, reason: 'audit passed' },
      ],
    })
    const lockOrder: string[] = []
    const result = await auditToPass({
      teams: fake.runtime,
      caller: { id: 'lead' },
      runId: 'run-7',
      phase: '03.5',
      runAuditRound: fake.runAuditRound,
      lockPhase: async () => { lockOrder.push('lock:' + fake.calls.join(',')) },
    })
    expect(result.ok).toBe(true)
    expect(result.locked).toBe(true)
    expect(result.taskId).toBe('task-a')
    expect(result.rounds.map(r => r.verdict)).toEqual(['REVISE', 'REVISE', 'APPROVE'])
    // One durable task throughout.
    const taskIds = new Set([result.taskId, ...result.rounds.map(() => result.taskId)])
    expect(taskIds.size).toBe(1)
    // Lock happened only after the complete transition (its snapshot shows it).
    expect(lockOrder.length).toBe(1)
    expect(lockOrder[0]).toContain('updateTask:complete')
    // Call order: createTask → claim → wait → edit → wait → complete.
    expect(fake.calls).toEqual([
      'createTask:Audit to pass: run-7 03.5',
      'updateTask:claim@rev1',
      'waitForChange',
      'updateTask:edit@rev2',
      'waitForChange',
      'updateTask:complete@rev3',
    ])
    // The REVISE repair landed on the same task's description.
    expect(result.rounds[1].repair).toBe('fix the missing audit')
  })

  it('REJECT: release the task, NO lock, ok:false', async () => {
    const fake = fakeTeam({
      script: [{ verdict: 'REJECT', accepted: false, reason: 'audit rejected' }],
    })
    let locked = false
    const result = await auditToPass({
      teams: fake.runtime,
      caller: { id: 'lead' },
      runId: 'run-7',
      phase: '03.5',
      runAuditRound: fake.runAuditRound,
      lockPhase: async () => { locked = true },
    })
    expect(result.ok).toBe(false)
    expect(result.locked).toBe(false)
    expect(locked).toBe(false)
    expect(fake.calls).toContain('updateTask:release@rev2')
    expect(result.reason).toContain('rejected')
  })

  it('round cap: release, NO lock, loud failure', async () => {
    const fake = fakeTeam({
      script: [
        { verdict: 'REVISE', repair: 'r1', accepted: true },
        { verdict: 'REVISE', repair: 'r2', accepted: true },
      ],
    })
    let locked = false
    const result = await auditToPass({
      teams: fake.runtime,
      caller: { id: 'lead' },
      runId: 'run-7',
      phase: '03.5',
      maxRounds: 2,
      runAuditRound: fake.runAuditRound,
      lockPhase: async () => { locked = true },
    })
    expect(result.ok).toBe(false)
    expect(result.locked).toBe(false)
    expect(locked).toBe(false)
    expect(result.reason).toContain('max rounds')
    // Release happens against the post-edit revision (rev3 after edit of rev2).
    expect(fake.calls).toContain('updateTask:release@rev4')
  })

  it('stuck reviewer: interrupt by name, NO lock, the error surfaces', async () => {
    const fake = fakeTeam({
      script: [new Error('reviewer hung')],
    })
    let locked = false
    const result = await auditToPass({
      teams: fake.runtime,
      caller: { id: 'lead' },
      runId: 'run-7',
      phase: '03.5',
      reviewerName: 'auditor-3',
      runAuditRound: fake.runAuditRound,
      lockPhase: async () => { locked = true },
    })
    expect(result.ok).toBe(false)
    expect(result.locked).toBe(false)
    expect(locked).toBe(false)
    expect(result.reason).toContain('reviewer hung')
    expect(fake.calls).toContain('interrupt:auditor-3')
  })

  it('audit failure without an interrupt seam: still fails loud, never throws', async () => {
    const fake = fakeTeam({ script: [new Error('boom')] })
    const noInterrupt: TeamRuntimeLike = {
      createTask: fake.runtime.createTask,
      updateTask: fake.runtime.updateTask,
    }
    const result = await auditToPass({
      teams: noInterrupt,
      caller: { id: 'lead' },
      runId: 'run-7',
      phase: '03.5',
      runAuditRound: fake.runAuditRound,
      lockPhase: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('boom')
    expect(result.locked).toBe(false)
  })

  it('renderTaskHistory lists the per-phase task + round trail (pure)', () => {
    const task = makeTask('task-a', 4, 'completed')
    const text = renderTaskHistory(task, [
      { round: 1, verdict: 'REVISE', repair: 'fix x', taskRevision: 2 },
      { round: 2, verdict: 'APPROVE', taskRevision: 4 },
    ])
    expect(text).toContain('task task-a (completed, rev 4)')
    expect(text).toContain('round 1: REVISE (task rev 2) — fix x')
    expect(text).toContain('round 2: APPROVE (task rev 4)')
    expect(renderTaskHistory(undefined, [])).toBe('')
  })

  it('isTaskClaimedBy is board-facing and status-aware', () => {
    expect(isTaskClaimedBy(makeTask('t', 1, 'in_progress'), 'me')).toBe(false)
    const claimed = { ...makeTask('t', 1, 'in_progress'), ownerName: 'me' }
    expect(isTaskClaimedBy(claimed, 'me')).toBe(true)
    expect(isTaskClaimedBy({ ...claimed, status: 'pending' }, 'me')).toBe(false)
  })
})

/**
 * T19 — operation identity for the audit loop, through an INJECTED seam.
 *
 * The seam is injected rather than imported because `auditToPass` is pure over its
 * seams — no `runDir`, no filesystem — which is what lets the whole loop be driven by
 * fakes. These cases are the acceptance in executable form: a COMPLETED audit-to-pass
 * is a recognised no-op rather than a second task, while a rejected or capped one
 * stays retryable, because only a finished operation is a repeat.
 */
describe('auditToPass — T19 operation identity', () => {
  /** An index that records in memory and answers lookups. */
  function memoryIndex(seed: Array<{ id: string; outcome?: string }> = []) {
    const records: Array<{ id: string; act: string; at: string; outcome?: string }> = []
    return {
      records,
      seam: {
        find: (id: string) => seed.find((r) => r.id === id) ?? records.find((r) => r.id === id) ?? null,
        record: (record: { id: string; act: string; at: string; outcome?: string }) => { records.push(record) },
      },
    }
  }

  async function run(index: ReturnType<typeof memoryIndex>, script: FakeTeamOptions['script']) {
    const fake = fakeTeam({ script })
    const result = await auditToPass({
      teams: fake.runtime,
      caller: { id: 'lead' },
      runId: 'run-9',
      phase: '04',
      runAuditRound: fake.runAuditRound,
      lockPhase: async () => {},
      operations: index.seam,
    })
    return { result, calls: fake.calls }
  }

  it('RECORDS the operation and one entry per round', async () => {
    const index = memoryIndex()
    const { result } = await run(index, [
      { verdict: 'REVISE', accepted: false, repair: 'fix it' },
      { verdict: 'APPROVE', accepted: true },
    ])
    expect(result.locked).toBe(true)
    const whole = index.records.find((r) => r.act === 'audit-to-pass')
    expect(whole).toBeDefined()
    expect(whole!.outcome).toBe('applied')
    // One entry per round, each with its own deterministic id and its verdict.
    const roundRecords = index.records.filter((r) => r.act === 'audit-round')
    expect(roundRecords.map((r) => r.outcome)).toEqual(['REVISE', 'REVISE', 'APPROVE'])
    expect(new Set(roundRecords.map((r) => r.id)).size).toBe(3)
  })

  it('a COMPLETED audit-to-pass is a recognised no-op — no second task', async () => {
    const first = memoryIndex()
    await run(first, [{ verdict: 'APPROVE', accepted: true }])
    const applied = first.records.find((r) => r.act === 'audit-to-pass')!
    // Second call, same run and phase, index carrying the completed operation.
    const second = memoryIndex([{ id: applied.id, outcome: 'applied' }])
    const { result, calls } = await run(second, [{ verdict: 'APPROVE', accepted: true }])
    expect(result.recognisedRepeat).toBe(true)
    expect(result.ok).toBe(true)
    // No task was created on the repeat — that is the whole point.
    expect(calls.filter((c) => c.startsWith('createTask'))).toEqual([])
    expect(result.rounds).toEqual([])
  })

  it('BUT a rejected or capped audit stays retryable (only a finished op is a repeat)', async () => {
    const index = memoryIndex()
    const { result, calls } = await run(index, [{ verdict: 'REJECT', accepted: false }])
    expect(result.ok).toBe(false)
    const whole = index.records.find((r) => r.act === 'audit-to-pass')!
    expect(whole.outcome).toBe('unaccepted')
    // A retry with that record present must RUN, not short-circuit.
    const retry = memoryIndex([{ id: whole.id, outcome: 'unaccepted' }])
    const again = await run(retry, [{ verdict: 'APPROVE', accepted: true }])
    expect(again.result.recognisedRepeat).toBeUndefined()
    expect(again.calls.some((c) => c.startsWith('createTask'))).toBe(true)
  })

  it('a DIFFERENT phase is a different operation, so it is never mistaken for a repeat', async () => {
    const index = memoryIndex()
    await run(index, [{ verdict: 'APPROVE', accepted: true }])
    const applied = index.records.find((r) => r.act === 'audit-to-pass')!
    const other = memoryIndex([{ id: applied.id, outcome: 'applied' }])
    const fake = fakeTeam({ script: [{ verdict: 'APPROVE', accepted: true }] })
    const result = await auditToPass({
      teams: fake.runtime,
      caller: { id: 'lead' },
      runId: 'run-9',
      phase: '05',
      runAuditRound: fake.runAuditRound,
      lockPhase: async () => {},
      operations: other.seam,
    })
    expect(result.recognisedRepeat).toBeUndefined()
    expect(fake.calls.some((c) => c.startsWith('createTask'))).toBe(true)
  })

  it('WITHOUT the seam the loop behaves exactly as before', async () => {
    const fake = fakeTeam({ script: [{ verdict: 'APPROVE', accepted: true }] })
    const result = await auditToPass({
      teams: fake.runtime,
      caller: { id: 'lead' },
      runId: 'run-9',
      phase: '04',
      runAuditRound: fake.runAuditRound,
      lockPhase: async () => {},
    })
    expect(result.locked).toBe(true)
    expect(result.recognisedRepeat).toBeUndefined()
  })
})
