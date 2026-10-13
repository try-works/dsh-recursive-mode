import { describe, it, expect } from 'vitest'
import {
  delegateContinuable,
  interruptContinuable,
  drainContinuableChildren,
  readVerdictFromStructured,
  readRepairFromStructured,
  defaultReviewToolFilter,
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
    expect(result.refused).toBeUndefined()
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

  it('no continuable seam REFUSES — it never dispatches a one-shot child', async () => {
    // ⚠ T35, ENFORCED. Delegation is ALWAYS continuable unless the caller asks for one-shot, and
    // `delegateContinuable` is only reached by callers that did NOT ask. A one-shot child cannot be
    // resumed (the harness rejects it), so substituting one silently forfeits the repair path — the
    // capability the caller delegated to obtain — and reports it as success. This test previously
    // asserted the opposite ("falls back to one-shot delegate (never drops)"), which is how the
    // violation survived: the tests encoded the fallback as correct.
    const calls: string[] = []
    const oneShotOnly: SubagentsRuntimeLike = {
      start: async () => { calls.push('start'); return { output: 'one-shot', stopReason: 'completed', success: true } },
    }
    const result = await delegateContinuable({
      subagents: oneShotOnly,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
    })
    expect(result.refused).toBe('continuable-unavailable')
    expect(result.ok).toBe(false)
    expect(result.accepted).toBe(false)
    // THE POINT: no child was dispatched at all.
    expect(calls).not.toContain('start')
    // And the refusal names what is missing rather than leaving the cause undecidable.
    expect(result.missing).toBeDefined()
    expect(result.reason).toContain('REFUSED')
    expect(result.reason).toContain('mode: "one-shot"')
  })

  it('the refusal names EVERY missing piece (seam, runtime, or live parent)', async () => {
    // Three distinct conditions land in the same branch. The report must say which, because a live
    // run once spent three rounds on an undecidable "no continuable seam or no live parent".
    const seamButNoParent: SubagentsRuntimeLike = {
      start: async () => ({ output: 'x', stopReason: 'completed', success: true }),
      startContinuable: async () => ({ childId: 'c1', messageId: 'm1' }),
      sendMessage: async () => 'm2',
    }
    const result = await delegateContinuable({
      subagents: seamButNoParent,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      awaitRoundResult: async () => null,
      // no parent → the exact live Agent is the missing piece
    })
    expect(result.refused).toBe('continuable-unavailable')
    expect(result.missing).toContain('parent')
  })

  it('binds the host\'s `sendMessage` as the follow-up seam, so the repair loop is reachable', async () => {
    // ⚠ THE DEFECT THIS CATCHES: the live host's follow-up method is `sendMessage`
    // (packages/subagent/subagent/src/index.ts:279), NOT `followup`. While the seam probe
    // required `followup`, `hasContinuableSeam` was false against the real service EVERY time, so
    // delegateContinuable silently took the one-shot fallback and the T4 repair loop never ran.
    // A service offering ONLY `sendMessage` must therefore engage the continuable path.
    const calls: string[] = []
    let sentOptions: { signal?: unknown } | undefined
    const sendMessageOnly: SubagentsRuntimeLike = {
      start: async () => { calls.push('start'); return { output: 'one-shot', stopReason: 'completed', success: true } },
      startContinuable: async () => { calls.push('startContinuable'); return { childId: 'c1', messageId: 'm1' } },
      // The host's real shape: (sender, targetId, content, options) with options = { signal }.
      sendMessage: async (_sender, _targetId, _content, options) => {
        calls.push('sendMessage')
        sentOptions = options
        return 'm2'
      },
    }
    const rounds = [makeRoundResult({ verdict: 'REVISE' }), makeRoundResult({ verdict: 'APPROVE' })]
    let i = 0
    const result = await delegateContinuable({
      subagents: sendMessageOnly,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      parent: { id: 'parent-1' },
      awaitRoundResult: async () => rounds[Math.min(i++, rounds.length - 1)]!,
    })
    // The continuable path engaged: startContinuable once, sendMessage for the REVISE.
    expect(result.refused).toBeUndefined()
    expect(calls).toContain('startContinuable')
    expect(calls).toContain('sendMessage')
    expect(calls).not.toContain('start')
    // The adapter must SUPPLY a signal when the caller omits one — the host types it as required,
    // and omitting it is the same class of defect that broke the one-shot fallback.
    expect(sentOptions).toBeDefined()
    expect(sentOptions!.signal).toBeDefined()
  })

  it('calls startContinuable BOUND — a host method using `this` must not be extracted loose', async () => {
    // ⚠ THE DEFECT THIS CATCHES, AND IT WAS LIVE: the plugin captured
    // `const startContinuable = subagents?.startContinuable`, detaching `this`. The real host method
    // opens with `this.requireContinuations()` (packages/subagent/subagent/src/index.ts:261), so the
    // first host call threw `Cannot read properties of undefined (reading 'requireContinuations')` and
    // NO child was ever created — even after the seam name and the tool filter were correct. Verified
    // live: binding the receiver is the difference between "no child" and a real durable child that
    // runs, settles and is filed. This fake reproduces the host's receiver use, so an unbound
    // extraction throws here instead of in production.
    const service = {
      // `this` is REQUIRED — exactly like the host.
      requireContinuations(): string { return 'ok' },
      async startContinuable(_spec: ContinuableStartSpecLike) {
        if (this.requireContinuations() !== 'ok') throw new Error('unreachable')
        return { childId: 'bound-child', messageId: 'm1' }
      },
      async sendMessage() { return 'm2' },
      start: async () => ({ output: 'one-shot', stopReason: 'completed', success: true }),
    }
    const seen: string[] = []
    const rounds = [makeRoundResult({ verdict: 'APPROVE' })]
    let i = 0
    const result = await delegateContinuable({
      subagents: service as unknown as SubagentsRuntimeLike,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      parent: { id: 'parent-1' },
      awaitRoundResult: async (childId) => { seen.push(String(childId)); return rounds[Math.min(i++, rounds.length - 1)]! },
    })
    // The bound call reached the host and produced the child, rather than throwing.
    expect(result.childId).toBe('bound-child')
    expect(seen).toContain('bound-child')
    expect(result.refused).toBeUndefined()
  })

  it('defaultReviewToolFilter names tools that actually exist', () => {
    // ⚠ THE DEFECT THIS CATCHES: the filter named `fs_read`, which is not a tool in any
    // composition. The live host rejected it — `tools.restrict() names unknown global tool
    // "fs_read"` — killing the child before it started. The vocabulary below is the host's own
    // "known global tools" list, captured from a headless session (2026-10-13).
    const KNOWN_GLOBAL_TOOLS = new Set([
      'create_goal', 'edit', 'exit_plan_mode', 'get_goal', 'glob', 'grep', 'interrupt_agent',
      'job_kill', 'job_list', 'job_output', 'list_agents', 'pwsh', 'read', 'read_image',
      'recursive_ask', 'recursive_closeout', 'recursive_delegate', 'recursive_init',
      'recursive_lint', 'recursive_lock', 'recursive_phase', 'recursive_preview',
      'recursive_review', 'recursive_scratch', 'recursive_status', 'recursive_worktree',
      'send_message', 'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal',
      'web_fetch', 'web_search', 'workflow', 'write',
    ])
    const filter = defaultReviewToolFilter() as { allow: string[] }
    expect(Array.isArray(filter.allow)).toBe(true)
    for (const name of filter.allow) {
      expect(KNOWN_GLOBAL_TOOLS.has(name), `"${name}" is not a known global tool`).toBe(true)
    }
    // The reviewer must be able to read; it must NOT be able to write.
    expect(filter.allow).toContain('read')
    expect(filter.allow).not.toContain('write')
    expect(filter.allow).not.toContain('edit')
  })

  it('continuable seam WITHOUT an observer REFUSES (never a fake APPROVE)', async () => {
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
    // ⚠ REFUSES and dispatches nothing. Without an observer the loop could never see a settlement,
    // so any "result" would be an approval nobody observed. The old behaviour substituted a one-shot
    // child and reported `accepted: true` from it — an approval the caller never asked for.
    expect(result.refused).toBe('continuable-unavailable')
    expect(result.accepted).toBe(false)
    expect(result.ok).toBe(false)
    expect(startContinuableCalled).toBe(false)
  })

  it('continuable seam WITHOUT a live parent REFUSES (never fabricates authority)', async () => {
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
    expect(result.refused).toBe('continuable-unavailable')
    expect(result.missing).toContain('parent')
    expect(result.accepted).toBe(false)
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
    // ⚠ AND THE REASON IS ACTIONABLE, not merely true. A caller that reads this sentence and nothing else must
    // be able to resume the round: the advice "resume with the SAME child" is unactionable without the id, and
    // the word that killed a live run's child on paper — a failure — must not be assertable here.
    expect(result.reason, 'the reason says the child may still be working, not that it is gone')
      .toContain('may still be working')
    expect(result.reason).toContain('childId child-1')
    expect(result.reason).toContain('PARKED, not failed')
    expect(result.reason).not.toContain('never ran')
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
