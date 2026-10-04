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
