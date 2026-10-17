import { describe, it, expect } from 'vitest'
import {
  delegate,
  delegateContinuable,
  resolveContinuableStartSeam,
  resolveOneShotStart,
  drainContinuableChildren,
  drainContinuableDescendants,
  type ContinuableStartSpecLike,
  type SubagentParentHandle,
  type SubagentResultLike,
  type SubagentsRuntimeLike,
} from '../src/delegation.ts'

/**
 * ⚠ THE CONTRACT THIS FILE PINS: DSH 0.2.1-rc.2's activation names are the seam's PREFERRED ones.
 *
 * The rename passed a 1419-test suite because every fake in the repo implemented the RETIRED names
 * (`startContinuable`, `drainContinuableChildren`, `drainContinuableDescendants`, `followup`), so the
 * plugin's new-name probes could be absent and every path still "passed" against a fake. These fakes model
 * the CURRENT host shape — `startActivation(spec)` with the REQUIRED `delivery` field, `sendMessage`, and
 * `drainChildren`/`drainDescendants` — and the one legacy test at the bottom keeps the documented fallback
 * honest. The installed host's own source is checked separately in `tests/delegation-contract.spec.ts`.
 */

const PARENT: SubagentParentHandle = { id: 'parent-1' }

function round(verdict: 'APPROVE' | 'REVISE' | 'REJECT'): SubagentResultLike {
  return {
    structured: { verdict, findings: [{ severity: 'MEDIUM', title: 'finding-a', detail: 'x' }] },
    output: verdict,
    stopReason: 'completed',
    success: true,
  }
}

interface ActivationHostOptions {
  /** Verdicts the settlement observer returns, one per observation. */
  verdicts: Array<'APPROVE' | 'REVISE' | 'REJECT'>
  /** Omit the message id to model an external activation (no local inbox). */
  messageId?: string | null
}

function activationHost(options: ActivationHostOptions) {
  const calls: string[] = []
  const specs: ContinuableStartSpecLike[] = []
  const disposed: string[] = []
  let observations = 0
  const runtime: SubagentsRuntimeLike = {
    startActivation: async (spec) => {
      calls.push('startActivation')
      specs.push(spec)
      return {
        childId: 'child-1',
        ...(options.messageId === null ? {} : { messageId: options.messageId ?? 'msg-initial' }),
        result: Promise.resolve({ output: [{ type: 'text', text: 'settled' }], stopReason: 'completed' }),
        dispose: async () => { disposed.push('activation') },
      }
    },
    sendMessage: async (_parent, childId) => {
      calls.push('sendMessage:' + childId)
      return 'msg-repair-1'
    },
    drainChildren: async (_parent, childIds) => { calls.push('drainChildren:' + childIds.join(',')) },
    drainDescendants: async () => { calls.push('drainDescendants') },
    getProvider: () => ({}),
    list: () => ['spawn'],
  }
  const awaitRoundResult = async () => {
    observations += 1
    return round(options.verdicts[Math.min(observations - 1, options.verdicts.length - 1)] ?? 'APPROVE')
  }
  return { calls, specs, disposed, runtime, awaitRoundResult }
}

describe('current host contract — startActivation + delivery, drainChildren, sendMessage', () => {
  it('delegateContinuable calls startActivation with delivery:\'parent\' and reaches an APPROVE', async () => {
    const host = activationHost({ verdicts: ['REVISE', 'APPROVE'] })
    const result = await delegateContinuable({
      subagents: host.runtime,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review phase 03.5',
      parent: PARENT,
      awaitRoundResult: host.awaitRoundResult,
    })

    expect(result.refused).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.accepted).toBe(true)
    expect(result.childId).toBe('child-1')
    expect(host.calls.filter((call) => call === 'startActivation')).toHaveLength(1)
    // ⚠ THE REQUIRED FIELD, IN THE PLACE THE HOST READS IT. Without `'parent'` a current host rejects the
    // spec outright; with the wrong policy the settlement never reaches the inbox the repair loop reads.
    expect(host.specs[0]?.delivery).toBe('parent')
    expect(host.specs[0]?.provider).toBe('spawn')
    expect(host.specs[0]?.label).toBe('rev-1')
    expect(host.specs[0]?.request.prompt).toEqual([{ type: 'text', text: 'review phase 03.5' }])
    // The repair went to the SAME durable child through the host's real follow-up method.
    expect(host.calls).toContain('sendMessage:child-1')
    expect(result.messageIds).toEqual(['msg-initial', 'msg-repair-1'])
    // The activation is NOT disposed here: the same child receives follow-ups, so the closeout drain owns
    // its release. A dispose here would end the child after the first round.
    expect(host.disposed).toEqual([])
  })

  it('⚠ PREFERENCE: when BOTH names exist, only the CURRENT names are used', async () => {
    const calls: string[] = []
    const runtime = {
      startActivation: async (spec: ContinuableStartSpecLike) => {
        calls.push('startActivation')
        expect(spec.delivery).toBe('parent')
        return {
          childId: 'current-child',
          messageId: 'm1',
          result: Promise.resolve({ output: [], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
      startContinuable: async () => { calls.push('startContinuable'); return { childId: 'legacy-child', messageId: 'm0' } },
      sendMessage: async () => { calls.push('sendMessage'); return 'm2' },
      followup: async () => { calls.push('followup'); return 'm3' },
      drainChildren: async () => { calls.push('drainChildren') },
      drainContinuableChildren: async () => { calls.push('drainContinuableChildren') },
    } as unknown as SubagentsRuntimeLike
    const rounds = [round('REVISE'), round('APPROVE')]
    let i = 0
    const result = await delegateContinuable({
      subagents: runtime,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      parent: PARENT,
      awaitRoundResult: async () => rounds[Math.min(i++, rounds.length - 1)]!,
    })
    expect(result.accepted).toBe(true)
    expect(result.childId).toBe('current-child')
    expect(calls).toContain('startActivation')
    expect(calls).not.toContain('startContinuable')
    expect(calls).toContain('sendMessage')
    expect(calls).not.toContain('followup')
  })

  it('a current activation WITHOUT a messageId fails loud (a continuable child must be observable)', async () => {
    const host = activationHost({ verdicts: ['APPROVE'], messageId: null })
    const result = await delegateContinuable({
      subagents: host.runtime,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      parent: PARENT,
      awaitRoundResult: host.awaitRoundResult,
    })
    expect(result.ok).toBe(false)
    expect(result.refused).toBeUndefined()
    expect(result.reason).toContain('messageId')
    expect(result.accepted).toBe(false)
  })

  it('resolveContinuableStartSeam reports the name it resolved to', () => {
    const both = {
      startActivation: async () => ({ childId: 'c', messageId: 'm', result: Promise.resolve({}), dispose: async () => {} }),
      startContinuable: async () => ({ childId: 'c', messageId: 'm' }),
    } as unknown as SubagentsRuntimeLike
    expect(resolveContinuableStartSeam(both)?.name).toBe('startActivation')
    const legacyOnly = {
      startContinuable: async () => ({ childId: 'c', messageId: 'm' }),
    } as unknown as SubagentsRuntimeLike
    expect(resolveContinuableStartSeam(legacyOnly)?.name).toBe('startContinuable')
    expect(resolveContinuableStartSeam({} as SubagentsRuntimeLike)).toBeUndefined()
    expect(resolveContinuableStartSeam(undefined)).toBeUndefined()
  })

  it('drainContinuableChildren prefers drainChildren and reports WHICH names a bare host lacks', async () => {
    const calls: string[] = []
    const both = {
      drainChildren: async (_parent: SubagentParentHandle, childIds: readonly string[]) => { calls.push('drainChildren:' + childIds.join(',')) },
      drainContinuableChildren: async () => { calls.push('drainContinuableChildren') },
    } as unknown as SubagentsRuntimeLike
    expect((await drainContinuableChildren(both, PARENT, ['c1', 'c2'])).ok).toBe(true)
    expect(calls).toEqual(['drainChildren:c1,c2'])

    const bare = { start: async () => ({}) } as SubagentsRuntimeLike
    const noSeam = await drainContinuableChildren(bare, PARENT, ['c1'])
    expect(noSeam.ok).toBe(true)
    expect(noSeam.reason, 'the no-op names the method it looked for').toContain('drainChildren')
    expect(noSeam.reason).toContain('drainContinuableChildren')
  })

  it('drainContinuableDescendants prefers drainDescendants and keeps the legacy fallback', async () => {
    const calls: string[] = []
    const both = {
      drainDescendants: async () => { calls.push('drainDescendants') },
      drainContinuableDescendants: async () => { calls.push('drainContinuableDescendants') },
    } as unknown as SubagentsRuntimeLike
    expect((await drainContinuableDescendants(both, [PARENT])).ok).toBe(true)
    expect(calls).toEqual(['drainDescendants'])

    const legacyOnly = {
      drainContinuableDescendants: async () => { calls.push('drainContinuableDescendants') },
    } as unknown as SubagentsRuntimeLike
    expect((await drainContinuableDescendants(legacyOnly, [PARENT])).ok).toBe(true)
    expect(calls).toEqual(['drainDescendants', 'drainContinuableDescendants'])

    const noSeam = await drainContinuableDescendants({} as SubagentsRuntimeLike, [PARENT])
    expect(noSeam.ok).toBe(true)
    expect(noSeam.reason).toContain('drainDescendants')
  })
})

describe('one-shot delegation — the current host has NO start(), only startActivation', () => {
  it('delegate uses startActivation with delivery:\'caller\' and maps the host result', async () => {
    const calls: string[] = []
    let delivery: string | undefined
    const runtime = {
      startActivation: async (spec: ContinuableStartSpecLike) => {
        calls.push('startActivation')
        delivery = spec.delivery
        return {
          childId: 'child-9',
          messageId: 'm1',
          result: Promise.resolve({
            output: [{ type: 'text', text: '{"verdict":"APPROVE"}' }],
            structured: { verdict: 'APPROVE' },
            stopReason: 'completed',
          }),
          dispose: async () => { calls.push('dispose') },
        }
      },
      start: async () => { calls.push('start'); return { output: 'legacy', success: true } },
    } as unknown as SubagentsRuntimeLike

    const result = await delegate({
      subagents: runtime,
      provider: 'spawn',
      request: { prompt: [{ type: 'text', text: 'review' }], label: 'rev-1' },
    })
    expect(calls).toContain('startActivation')
    expect(calls).not.toContain('start')
    expect(delivery, 'one-shot delivery must NOT also inject a second copy into the parent inbox').toBe('caller')
    expect(result.output).toBe('{"verdict":"APPROVE"}')
    expect(result.structured).toEqual({ verdict: 'APPROVE' })
    expect(result.stopReason).toBe('completed')
    expect(result.success).toBe(true)
    expect(calls).toContain('dispose')
  })

  it('a non-completed stop reason is mapped to success:false (never accepted)', async () => {
    const runtime = {
      startActivation: async () => ({
        childId: 'c',
        messageId: 'm',
        result: Promise.resolve({ output: [], stopReason: 'error' }),
        dispose: async () => {},
      }),
    } as unknown as SubagentsRuntimeLike
    const result = await delegate({ subagents: runtime, provider: 'spawn', request: { prompt: [] } })
    expect(result.success).toBe(false)
    expect(result.stopReason).toBe('error')
  })

  it('resolveOneShotStart reports which name runs, and is undefined without either', () => {
    const both = { startActivation: async () => ({ childId: 'c', result: Promise.resolve({}), dispose: async () => {} }), start: async () => ({}) } as unknown as SubagentsRuntimeLike
    expect(resolveOneShotStart(both)?.name).toBe('startActivation')
    expect(resolveOneShotStart({ start: async () => ({}) } as SubagentsRuntimeLike)?.name).toBe('start')
    expect(resolveOneShotStart({} as SubagentsRuntimeLike)).toBeUndefined()
  })
})

/**
 * ⚠ EXACTLY ONE LEGACY TEST, DELIBERATELY. The documented fallbacks exist because the package's peer range
 * still admits 0.2.0-rc.2, whose host really did expose these names. Proving ONE full round still works
 * through them keeps the fallback honest without letting the legacy names be the only path any spec exercises
 * (the defect that hid the rename).
 */
describe('LEGACY fallback — a 0.2.0-rc.2 host still completes one repair round', () => {
  it('uses startContinuable + followup when the current names are absent', async () => {
    const calls: string[] = []
    let startSpec: ContinuableStartSpecLike | undefined
    const runtime = {
      startContinuable: async (spec: ContinuableStartSpecLike) => {
        calls.push('startContinuable')
        startSpec = spec
        return { childId: 'legacy-child', messageId: 'm1' }
      },
      followup: async () => { calls.push('followup'); return 'm2' },
    } as unknown as SubagentsRuntimeLike
    const rounds = [round('REVISE'), round('APPROVE')]
    let i = 0
    const result = await delegateContinuable({
      subagents: runtime,
      provider: 'spawn',
      label: 'rev-1',
      prompt: 'review',
      parent: PARENT,
      awaitRoundResult: async () => rounds[Math.min(i++, rounds.length - 1)]!,
    })
    expect(result.accepted).toBe(true)
    expect(result.childId).toBe('legacy-child')
    expect(calls).toEqual(['startContinuable', 'followup'])
    // The delivery policy travels on the spec even to a legacy host, which ignores the extra field.
    expect(startSpec?.delivery).toBe('parent')
  })

  it('the legacy drain names still release children when the current ones are absent', async () => {
    const released: string[] = []
    const runtime = {
      drainContinuableChildren: async (_parent: SubagentParentHandle, childIds: readonly string[]) => { released.push(...childIds) },
    } as unknown as SubagentsRuntimeLike
    expect((await drainContinuableChildren(runtime, PARENT, ['legacy-c1'])).ok).toBe(true)
    expect(released).toEqual(['legacy-c1'])
  })
})
