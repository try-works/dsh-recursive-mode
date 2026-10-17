import { describe, it, expect } from 'vitest'
import {
  resolveFollowupSeam,
  type SubagentFollowupOptionsLike,
  type SubagentParentHandle,
  type SubagentsRuntimeLike,
} from '../src/delegation.ts'

/**
 * The follow-up seam is the repair path's only delivery surface: if it resolves to nothing, a REVISE has
 * nowhere to go and the delegation loses the capability it exists to obtain.
 *
 * ⚠ THE PREFERENCE IS PART OF THE CONTRACT. `sendMessage` is the host's REAL method (verified in
 * 0.2.0-rc.2 and 0.2.1-rc.2); `followup` was never a host name at all — it is the name this plugin's older
 * fakes used. A service offering both must be driven through `sendMessage`, or a fake-only shape can become
 * the live path. The legacy name survives as a fallback so those fakes keep exercising the loop.
 */

const PARENT: SubagentParentHandle = { id: 'parent-1' }
const CONTENT = [{ type: 'text', text: 'fix finding-a' }] as const
const OPTIONS: SubagentFollowupOptionsLike = {
  source: { kind: 'coordinator', form: 'relay', senderSessionId: 'parent-1' },
}

describe('resolveFollowupSeam — current name first, legacy fallback second', () => {
  it('prefers sendMessage when BOTH names exist, dropping the plugin-only source and supplying a signal', async () => {
    const calls: string[] = []
    let seenOptions: { signal?: { throwIfAborted: () => void } } | undefined
    const runtime = {
      sendMessage: async (_sender: SubagentParentHandle, targetId: string, content: readonly { type: 'text'; text: string }[], options: { signal?: { throwIfAborted: () => void } }) => {
        calls.push('sendMessage:' + targetId + ':' + content[0]?.text)
        seenOptions = options
        return 'message-1'
      },
      followup: async () => { calls.push('followup'); return 'message-0' },
    } as unknown as SubagentsRuntimeLike

    const seam = resolveFollowupSeam(runtime)
    expect(seam).toBeDefined()
    const id = await seam!(PARENT, 'child-1', CONTENT, OPTIONS)
    expect(id).toBe('message-1')
    expect(calls).toEqual(['sendMessage:child-1:fix finding-a'])
    // `source` is NOT part of the host's options; `signal` IS required by the host type and must be supplied
    // even when the caller omits it (omitting it is the measured `reading 'aborted'` defect class).
    expect(seenOptions).toBeDefined()
    expect(seenOptions).not.toHaveProperty('source')
    expect(typeof seenOptions!.signal?.throwIfAborted).toBe('function')
  })

  it('passes a caller signal through unchanged', async () => {
    const signal = new AbortController().signal
    let received: unknown
    const runtime = {
      sendMessage: async (_sender: unknown, _targetId: string, _content: readonly { type: 'text'; text: string }[], options: { signal?: unknown }) => {
        received = options.signal
        return 'm'
      },
    } as unknown as SubagentsRuntimeLike
    await resolveFollowupSeam(runtime)!(PARENT, 'child-1', CONTENT, { ...OPTIONS, signal })
    expect(received).toBe(signal)
  })

  it('falls back to the LEGACY followup when sendMessage is absent', async () => {
    const calls: string[] = []
    const runtime = {
      followup: async (_parent: SubagentParentHandle, childId: string) => {
        calls.push('followup:' + childId)
        return 'legacy-message'
      },
    } as unknown as SubagentsRuntimeLike
    expect(await resolveFollowupSeam(runtime)!(PARENT, 'child-1', CONTENT, OPTIONS)).toBe('legacy-message')
    expect(calls).toEqual(['followup:child-1'])
  })

  it('returns undefined when the service has neither name, or no service at all', () => {
    expect(resolveFollowupSeam(undefined)).toBeUndefined()
    expect(resolveFollowupSeam({} as SubagentsRuntimeLike)).toBeUndefined()
  })

  it('BINDS the receiver: both host shapes must keep `this`', async () => {
    // The live methods open with `this.requireManager()`; an unbound extraction throws at the first call.
    const service = {
      marker: 'bound',
      async sendMessage(this: { marker: string }) {
        if (this.marker !== 'bound') throw new Error('sendMessage lost its receiver')
        return 'm'
      },
    } as unknown as SubagentsRuntimeLike
    expect(await resolveFollowupSeam(service)!(PARENT, 'c', CONTENT, OPTIONS)).toBe('m')

    const legacy = {
      marker: 'bound',
      async followup(this: { marker: string }) {
        if (this.marker !== 'bound') throw new Error('followup lost its receiver')
        return 'm'
      },
    } as unknown as SubagentsRuntimeLike
    expect(await resolveFollowupSeam(legacy)!(PARENT, 'c', CONTENT, OPTIONS)).toBe('m')
  })
})
