import { describe, it, expect } from 'vitest'
import {
  delegateContinuable,
  interruptContinuable,
  drainContinuableChildren,
  readVerdictFromStructured,
  readRepairFromStructured,
  type SubagentResultLike,
  type SubagentsRuntimeLike,
  type ContinuableStartSpecLike,
  type SubagentParentHandle,
} from '../src/delegation.ts'

/**
 * T4 (continuable subagents): a multi-round child keeps ONE durable session —
 * startContinuable once, followup (repair) to the SAME child, no start().
 */

interface ScriptedRound {
  verdict: 'APPROVE' | 'REVISE' | 'REJECT'
  output?: string
}

function makeRoundResult(round: ScriptedRound): SubagentResultLike {
  return {
    structured: { verdict: round.verdict, findings: [{ severity: 'MEDIUM', title: 'finding-a', detail: 'x' }] },
    output: round.output ?? 'out-' + round.verdict,
    stopReason: 'completed',
    success: true,
  }
}

/** Fake continuable seam: records the call sequence + child ids. */
function fakeContinuableRuntime(script: ScriptedRound[]) {
  const calls: string[] = []
  let followupCount = 0
  const runtime: SubagentsRuntimeLike = {
    start: async () => { calls.push('start'); return { output: 'one-shot', stopReason: 'completed', success: true } },
    startContinuable: async (spec: ContinuableStartSpecLike) => {
      calls.push('startContinuable:' + (spec.childId ?? 'allocated'))
      return { childId: 'child-1', messageId: 'msg-initial' }
    },
    followup: async (_parent: SubagentParentHandle, childId: string, content: readonly { type: 'text'; text: string }[]) => {
      followupCount += 1
      const text = content[0]?.text ?? ''
      calls.push('followup:' + childId + ':' + text.slice(0, 20))
      return 'msg-followup-' + followupCount
    },
  }
  // Round outcomes: one per observation (initial round then each followup).
  const outcomes = script.map(makeRoundResult)
  const awaitRoundResult = async () => outcomes.shift() ?? null
  return { calls, runtime, awaitRoundResult }
}

describe('delegation.ts — T4 continuable delegation', () => {
  it('multi-round: startContinuable once, followup (REVISE) to the SAME child, APPROVE ends; start() never called', async () => {
    const fake = fakeContinuableRuntime([
      { verdict: 'REVISE' },
      { verdict: 'APPROVE' },
    ])
    const result = await delegateContinuable({
      subagents: fake.runtime,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review phase 03.5',
      parent: { id: 'parent-1' },
      awaitRoundResult: fake.awaitRoundResult,
    })
    expect(result.ok).toBe(true)
    expect(result.accepted).toBe(true)
    expect(result.childId).toBe('child-1')
    expect(result.fellBackToOneShot).toBeUndefined()
    expect(result.rounds.length).toBe(2)
    expect(result.rounds[0].revise).toBe(true)
    expect(result.rounds[0].repair).toContain('finding-a')
    expect(result.rounds[1].result?.structured).toMatchObject({ verdict: 'APPROVE' })
    // Exactly one durable child: no one-shot start(), one followup to that child.
    expect(fake.calls.filter(c => c.startsWith('startContinuable')).length).toBe(1)
    expect(fake.calls.filter(c => c === 'start').length).toBe(0)
    expect(fake.calls.filter(c => c.startsWith('followup:child-1')).length).toBe(1)
  })

  it('REJECT verdict ends without a followup and is not accepted', async () => {
    const fake = fakeContinuableRuntime([{ verdict: 'REJECT' }])
    const result = await delegateContinuable({
      subagents: fake.runtime,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      parent: { id: 'parent-1' },
      awaitRoundResult: fake.awaitRoundResult,
    })
    expect(result.accepted).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('REJECT')
    expect(fake.calls.filter(c => c.startsWith('followup')).length).toBe(0)
  })

  it('max rounds reached without APPROVE fails loud (no silent accept)', async () => {
    const fake = fakeContinuableRuntime([
      { verdict: 'REVISE' },
      { verdict: 'REVISE' },
      { verdict: 'REVISE' },
    ])
    const result = await delegateContinuable({
      subagents: fake.runtime,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      maxRounds: 3,
      parent: { id: 'parent-1' },
      awaitRoundResult: fake.awaitRoundResult,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('max rounds')
    // 3 REVISE observations: initial round + 3 pushed followup rounds = 4 entries.
    expect(result.rounds.length).toBe(4)
  })

  it('no continuable seam falls back to one-shot delegate (never drops)', async () => {
    const oneShot: SubagentsRuntimeLike = {
      start: async () => ({ output: 'one-shot', stopReason: 'completed', success: true }),
    }
    const result = await delegateContinuable({
      subagents: oneShot,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
    })
    expect(result.fellBackToOneShot).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.accepted).toBe(true)
  })

  it('one-shot fallback with a REVISE verdict is not accepted', async () => {
    const oneShot: SubagentsRuntimeLike = {
      start: async () => ({ structured: { verdict: 'REVISE' }, output: 'o', stopReason: 'completed', success: true }),
    }
    const result = await delegateContinuable({
      subagents: oneShot,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
    })
    expect(result.fellBackToOneShot).toBe(true)
    expect(result.accepted).toBe(false)
  })

  it('continuable seam WITHOUT an observer falls back to one-shot (never a fake APPROVE)', async () => {
    let startContinuableCalled = false
    const seamOnly: SubagentsRuntimeLike = {
      start: async () => ({ output: 'one-shot', stopReason: 'completed', success: true }),
      startContinuable: async () => { startContinuableCalled = true; return { childId: 'c1', messageId: 'm1' } },
      followup: async () => 'unused',
    }
    const result = await delegateContinuable({
      subagents: seamOnly,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      parent: { id: 'parent-1' },
      // no awaitRoundResult
    })
    expect(result.fellBackToOneShot).toBe(true)
    expect(result.accepted).toBe(true)
    expect(startContinuableCalled).toBe(false)
  })

  it('continuable seam WITHOUT a live parent falls back to one-shot (never fabricates authority)', async () => {
    let startContinuableCalled = false
    const seamOnly: SubagentsRuntimeLike = {
      start: async () => ({ output: 'one-shot', stopReason: 'completed', success: true }),
      startContinuable: async () => { startContinuableCalled = true; return { childId: 'c1', messageId: 'm1' } },
      followup: async () => 'unused',
    }
    const result = await delegateContinuable({
      subagents: seamOnly,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      // no parent — the live followup authorizes by exact live Agent identity
      awaitRoundResult: async () => ({ output: 'x', stopReason: 'completed', success: true }),
    })
    expect(result.fellBackToOneShot).toBe(true)
    expect(result.accepted).toBe(true)
    expect(startContinuableCalled).toBe(false)
  })

  it('startContinuable failure preserves the child identity and reports ok:false', async () => {
    const failing: SubagentsRuntimeLike = {
      start: async () => ({ output: 'one-shot', stopReason: 'completed', success: true }),
      startContinuable: async () => { throw new Error('materialization failed') },
      followup: async () => 'unused',
    }
    const result = await delegateContinuable({
      subagents: failing,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      childId: 'reserved-1',
      parent: { id: 'parent-1' },
      awaitRoundResult: async () => ({ output: 'x', stopReason: 'completed', success: true }),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('materialization failed')
    expect(result.accepted).toBe(false)
  })

  it('no settlement (null observation) fails loud', async () => {
    const fake = fakeContinuableRuntime([])
    const result = await delegateContinuable({
      subagents: fake.runtime,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      parent: { id: 'parent-1' },
      awaitRoundResult: fake.awaitRoundResult,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no settlement')
  })

  it('interruptContinuable kills with user authority (keepInbox) and no-ops without a seam', () => {
    const interrupted: Array<{ target: string; authority: unknown }> = []
    const runtime: SubagentsRuntimeLike = {
      start: async () => ({ output: 'x', stopReason: 'completed', success: true }),
      interrupt: (target, authority) => { interrupted.push({ target, authority }) },
    }
    expect(interruptContinuable(runtime, 'child-1', 'parent-9').ok).toBe(true)
    expect(interrupted.length).toBe(1)
    expect(interrupted[0].target).toBe('child-1')
    expect(interrupted[0].authority).toMatchObject({ kind: 'user', parentSessionId: 'parent-9' })
    const bare: SubagentsRuntimeLike = { start: async () => ({ output: 'x', stopReason: 'completed', success: true }) }
    expect(interruptContinuable(bare, 'child-1', 'parent-9').ok).toBe(false)
  })

  it('drainContinuableChildren releases children on closeout; no-op when seam is absent', async () => {
    const drained: string[] = []
    const runtime: SubagentsRuntimeLike = {
      start: async () => ({ output: 'x', stopReason: 'completed', success: true }),
      drainContinuableChildren: async (_parent, ids) => { drained.push(...ids) },
    }
    const result = await drainContinuableChildren(runtime, { id: 'parent' }, ['child-1', 'child-2'])
    expect(result.ok).toBe(true)
    expect(drained).toEqual(['child-1', 'child-2'])
    const bare: SubagentsRuntimeLike = { start: async () => ({ output: 'x', stopReason: 'completed', success: true }) }
    expect((await drainContinuableChildren(bare, {}, ['child-1'])).ok).toBe(true)
  })

  it('readVerdictFromStructured / readRepairFromStructured parse the review schema (pure)', () => {
    expect(readVerdictFromStructured({ structured: { verdict: 'APPROVE' } })).toBe('APPROVE')
    expect(readVerdictFromStructured({ structured: { verdict: 'REVISE' } })).toBe('REVISE')
    expect(readVerdictFromStructured({ structured: {} })).toBe('APPROVE')
    expect(readRepairFromStructured({ structured: { findings: [{ severity: 'HIGH', title: 'leak', detail: 'd' }] } })).toContain('leak')
    expect(readRepairFromStructured({ structured: {} })).toContain('REVISE')
  })
})

/**
 * T36 — the loop is RESUMABLE across turns.
 *
 * There is no parent-side await-settlement promise, so a round that has not settled
 * yet must be reported rather than waited on. That makes two behaviours load-bearing:
 * an unsettled round PARKS (preserving the child id, never accepting), and a later
 * turn RESUMES that same child instead of starting a second one. Without resume, a
 * turn-shaped caller would orphan the child already doing the work.
 *
 * Note the contrast with the pinned test above: `readVerdictFromStructured` returns
 * APPROVE for a result with no verdict, which is fine where the caller re-evaluates.
 * A review round reads its verdict from `reply.md` through the FAIL-CLOSED reader in
 * `tests/reply-verdict.spec.ts` instead, so prose is never an approval.
 */
describe('delegation.ts — T36 turn-shaped continuation', () => {
  const PARENT = { id: 'parent-1' } as SubagentParentHandle

  it('an unsettled round PARKS: child id preserved, nothing accepted', async () => {
    // An empty script means the observer has no settlement to report.
    const fake = fakeContinuableRuntime([])
    const result = await delegateContinuable({
      subagents: fake.runtime,
      provider: 'spawn',
      label: 'delegation-1',
      prompt: 'review it',
      parent: PARENT,
      awaitRoundResult: fake.awaitRoundResult,
    })
    expect(result.parked).toBe(true)
    expect(result.accepted).toBe(false)
    expect(result.childId).toBe('child-1')
    expect(result.reason).toContain('still working')
  })

  it('RESUMING observes the existing child and NEVER starts another', async () => {
    const fake = fakeContinuableRuntime([{ verdict: 'APPROVE' }])
    const result = await delegateContinuable({
      subagents: fake.runtime,
      provider: 'spawn',
      label: 'delegation-1',
      prompt: 'review it',
      parent: PARENT,
      awaitRoundResult: fake.awaitRoundResult,
      resumeChild: 'child-1',
    })
    expect(fake.calls.filter(c => c.startsWith('startContinuable'))).toHaveLength(0)
    expect(fake.calls).not.toContain('start')
    expect(result.childId).toBe('child-1')
    expect(result.accepted).toBe(true)
    expect(result.parked).toBeUndefined()
  })

  it('a RESUMED round that REVISEs followups the SAME child', async () => {
    const fake = fakeContinuableRuntime([{ verdict: 'REVISE' }, { verdict: 'APPROVE' }])
    const result = await delegateContinuable({
      subagents: fake.runtime,
      provider: 'spawn',
      label: 'delegation-1',
      prompt: 'review it',
      parent: PARENT,
      awaitRoundResult: fake.awaitRoundResult,
      resumeChild: 'child-1',
    })
    expect(fake.calls.filter(c => c.startsWith('startContinuable'))).toHaveLength(0)
    // The repair went to the SAME durable child, which is the whole point.
    expect(fake.calls.some(c => c.startsWith('followup:child-1:'))).toBe(true)
    expect(result.accepted).toBe(true)
  })

  it('park then resume is the cross-turn shape: the second call finishes the round', async () => {
    // Turn 1: nothing settled.
    const turn1 = fakeContinuableRuntime([])
    const parked = await delegateContinuable({
      subagents: turn1.runtime, provider: 'spawn', label: 'd1', prompt: 'review it',
      parent: PARENT, awaitRoundResult: turn1.awaitRoundResult,
    })
    expect(parked.parked).toBe(true)

    // Turn 2: the caller passes the child it was given, and the verdict is there.
    const turn2 = fakeContinuableRuntime([{ verdict: 'APPROVE' }])
    const finished = await delegateContinuable({
      subagents: turn2.runtime, provider: 'spawn', label: 'd1', prompt: 'review it',
      parent: PARENT, awaitRoundResult: turn2.awaitRoundResult,
      resumeChild: parked.childId!,
    })
    expect(finished.accepted).toBe(true)
    expect(finished.childId).toBe(parked.childId)
    expect(turn2.calls.filter(c => c.startsWith('startContinuable'))).toHaveLength(0)
  })
})
