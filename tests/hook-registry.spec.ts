/**
 * T27 — the hook registry.
 *
 * NOTE ON PROCESS: this item's module was written before its spec, unlike every other
 * item in this plan. The reason is narrow — `src/hooks.ts` is a NEW file with no
 * existing behaviour to protect, so there was no RED state to establish — but it is
 * recorded rather than glossed, because "RED first" is the discipline that caught the
 * T19 timing bug and a silent exception would erode it.
 *
 * The properties below are the item's own RED list: order by priority with a
 * deterministic tie-break, the first deny short-circuits, a throw is denied under
 * fail_closed and skipped under fail_open, and the DEFAULTS differ by point.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import {
  HOOK_POINTS, GATING_POINTS, OBSERVING_POINTS, createHookRegistry, hookFingerprint,
  isGating, isObserving, type HookOutcome,
} from '../src/hooks.ts'

/** A hook that always answers the same way. */
function answering(name: string, priority: number, outcome: HookOutcome | void, extra: Record<string, unknown> = {}) {
  return { name, priority, run: () => outcome, ...extra }
}

describe('T27 — the five points map onto the seams, and each knows its kind', () => {
  it('names exactly the five points the item specifies', () => {
    expect([...HOOK_POINTS]).toEqual(['pre_turn', 'pre_generate', 'post_generate', 'pre_trigger', 'post_trigger'])
  })

  it('partitions them into gating and observing, with no point in both', () => {
    for (const point of HOOK_POINTS) {
      expect(isGating(point)).toBe(!isObserving(point))
    }
    expect([...GATING_POINTS, ...OBSERVING_POINTS].sort()).toEqual([...HOOK_POINTS].sort())
  })
})

describe('T27 — the chain is ordered by priority, deterministically', () => {
  it('runs higher priority first', async () => {
    const registry = createHookRegistry()
    const order: string[] = []
    registry.register('pre_trigger', { name: 'low', priority: 1, run: () => { order.push('low') } })
    registry.register('pre_trigger', { name: 'high', priority: 10, run: () => { order.push('high') } })
    registry.register('pre_trigger', { name: 'mid', priority: 5, run: () => { order.push('mid') } })
    const result = await registry.run('pre_trigger', {})
    expect(order).toEqual(['high', 'mid', 'low'])
    expect(result.ran.map((r) => r.name)).toEqual(['high', 'mid', 'low'])
  })

  it('breaks TIES by registration order, so the chain is reproducible', async () => {
    // An ordering that depended on object keys or on scheduling would be an ordering
    // nobody could reason about.
    const registry = createHookRegistry()
    const order: string[] = []
    registry.register('pre_trigger', { name: 'first', priority: 5, run: () => { order.push('first') } })
    registry.register('pre_trigger', { name: 'second', priority: 5, run: () => { order.push('second') } })
    registry.register('pre_trigger', { name: 'third', priority: 5, run: () => { order.push('third') } })
    await registry.run('pre_trigger', {})
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('keeps points separate: a hook on one point never runs for another', async () => {
    const registry = createHookRegistry()
    let ran = false
    registry.register('pre_turn', { name: 'turn-only', priority: 1, run: () => { ran = true } })
    await registry.run('pre_trigger', {})
    expect(ran).toBe(false)
  })
})

describe('T27 — the first decisive hook short-circuits', () => {
  it('a DENY stops the chain, and the later hooks are absent from the trail', async () => {
    const registry = createHookRegistry()
    const order: string[] = []
    registry.register('pre_trigger', { name: 'denier', priority: 10, run: () => ({ decision: 'deny', reason: 'not allowed' }) })
    registry.register('pre_trigger', { name: 'never', priority: 1, run: () => { order.push('never') } })
    const result = await registry.run('pre_trigger', {})
    expect(result.decision).toBe('deny')
    expect(result.reason).toBe('not allowed')
    expect(order).toEqual([])
    // Their ABSENCE from `ran` is the evidence they were not run.
    expect(result.ran.map((r) => r.name)).toEqual(['denier'])
  })

  it('a HOLD short-circuits too, and is distinguishable from a deny', async () => {
    const registry = createHookRegistry()
    registry.register('pre_turn', { name: 'waiter', priority: 10, run: () => ({ decision: 'hold', reason: 'waiting for the child' }) })
    const result = await registry.run('pre_turn', {})
    expect(result.decision).toBe('hold')
    expect(result.reason).toBe('waiting for the child')
  })

  it('no decisive hook means continue, with every hook recorded', async () => {
    const registry = createHookRegistry()
    registry.register('pre_trigger', { name: 'a', priority: 2, run: () => ({ decision: 'continue' }) })
    registry.register('pre_trigger', { name: 'b', priority: 1, run: () => {} })
    const result = await registry.run('pre_trigger', {})
    expect(result.decision).toBe('continue')
    expect(result.ran.map((r) => r.name)).toEqual(['a', 'b'])
  })
})

describe('T27 — failure behaviour defaults by POINT, and that is the point', () => {
  it('a GATING point fails CLOSED: a throwing hook denies the chain', async () => {
    const registry = createHookRegistry()
    registry.register('pre_trigger', { name: 'boom', priority: 1, run: () => { throw new Error('kaboom') } })
    const result = await registry.run('pre_trigger', {})
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('boom')
    expect(result.reason).toContain('kaboom')
    expect(isGating('pre_trigger')).toBe(true)
  })

  it('an OBSERVING point fails OPEN: a throwing hook is skipped and the chain continues', async () => {
    // An observing hook must not break the turn it was only watching.
    const registry = createHookRegistry()
    registry.register('post_trigger', { name: 'boom', priority: 10, run: () => { throw new Error('kaboom') } })
    registry.register('post_trigger', { name: 'after', priority: 1, run: () => {} })
    const result = await registry.run('post_trigger', {})
    expect(result.decision).toBe('continue')
    expect(result.ran.map((r) => r.name)).toEqual(['boom', 'after'])
    expect(result.ran[0].error).toContain('kaboom')
  })

  it('an explicit onError OVERRIDES the point default, in both directions', async () => {
    const skip = createHookRegistry()
    skip.register('pre_trigger', { name: 'boom', priority: 1, onError: 'fail_open', run: () => { throw new Error('x') } })
    skip.register('pre_trigger', { name: 'after', priority: 0, run: () => {} })
    expect((await skip.run('pre_trigger', {})).ran.map((r) => r.name)).toEqual(['boom', 'after'])

    const deny = createHookRegistry()
    deny.register('post_trigger', { name: 'boom', priority: 1, onError: 'fail_closed', run: () => { throw new Error('x') } })
    const denied = await deny.run('post_trigger', {})
    // A fail_closed OBSERVING hook still cannot actually stop the streamed message —
    // the observe-only rule wins — but its decision is recorded as a deny.
    expect(denied.ran[0].decision).toBe('deny')
  })

  it('a TIMEOUT is a failure, so the chain does not wait forever on a hung hook', async () => {
    const registry = createHookRegistry({ timeoutMs: { pre_trigger: 20 } })
    registry.register('pre_trigger', { name: 'hang', priority: 1, run: () => new Promise<void>(() => {}) })
    const started = Date.now()
    const result = await registry.run('pre_trigger', {})
    expect(result.decision).toBe('deny')
    expect(result.ran[0].error).toContain('timed out')
    // It gave up on the hook rather than waiting for it.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('a per-binding timeout overrides the point default', () => {
    const registry = createHookRegistry({ timeoutMs: { pre_trigger: 5_000 } })
    registry.register('pre_trigger', { name: 'quick', priority: 1, timeoutMs: 12, run: () => {} })
    expect(registry.list('pre_trigger')[0].timeoutMs).toBe(12)
  })
})

describe('T27 — observe-only points cannot deny, and the attempt is VISIBLE', () => {
  it('a deny from post_generate is downgraded, recorded, and surfaced as an annotation', async () => {
    // The message has already streamed, so a deny here would be a veto that vetoes
    // nothing. Silently ignoring it would hide a hook's real intent from its author;
    // silently obeying it would be a lie about what happened.
    const registry = createHookRegistry()
    registry.register('post_generate', { name: 'too-late', priority: 1, run: () => ({ decision: 'deny', reason: 'I object' }) })
    const result = await registry.run('post_generate', {})
    expect(result.decision).toBe('continue')
    const record = result.ran[0]
    expect(record.decision).toBe('continue')
    expect(record.downgraded).toBe(true)
    expect(record.annotations?.overriddenDecision).toBe('deny')
    expect(record.annotations?.overriddenReason).toBe('I object')
  })

  it('a deny from post_trigger is downgraded the same way', async () => {
    const registry = createHookRegistry()
    registry.register('post_trigger', { name: 'too-late', priority: 1, run: () => ({ decision: 'deny' }) })
    expect((await registry.run('post_trigger', {})).ran[0].downgraded).toBe(true)
  })

  it('a GATING point is NOT downgraded — a deny there still stops the chain', async () => {
    const registry = createHookRegistry()
    registry.register('pre_generate', { name: 'on-time', priority: 1, run: () => ({ decision: 'deny', reason: 'no' }) })
    expect((await registry.run('pre_generate', {})).decision).toBe('deny')
  })
})

describe('T27 — mutations are silent, so annotations are the channel', () => {
  it('carries annotations from the hook to the trail', async () => {
    const registry = createHookRegistry()
    registry.register('pre_trigger', {
      name: 'annotator', priority: 1,
      run: () => ({ decision: 'continue', annotations: { normalizedPath: '/x/y', tightened: true } }),
    })
    const result = await registry.run('pre_trigger', {})
    expect(result.ran[0].annotations).toEqual({ normalizedPath: '/x/y', tightened: true })
  })

  it('records a duration per hook, so a slow hook is visible', async () => {
    const registry = createHookRegistry()
    registry.register('pre_trigger', { name: 'timed', priority: 1, run: () => {} })
    const result = await registry.run('pre_trigger', {})
    expect(typeof result.ran[0].durationMs).toBe('number')
    expect(result.ran[0].durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('T27 — registration is guarded, and reversible', () => {
  it('rejects an unknown point, an empty name, and a non-finite priority', () => {
    const registry = createHookRegistry()
    expect(() => registry.register('nope' as never, { name: 'x', priority: 1, run: () => {} })).toThrow(/unknown hook point/)
    expect(() => registry.register('pre_trigger', { name: '  ', priority: 1, run: () => {} })).toThrow(/non-empty name/)
    expect(() => registry.register('pre_trigger', { name: 'x', priority: Number.NaN, run: () => {} })).toThrow(/finite priority/)
  })

  it('a disposer WITHDRAWS a hook, so a sibling plugin can unregister cleanly', async () => {
    const registry = createHookRegistry()
    let ran = 0
    const dispose = registry.register('pre_trigger', { name: 'temporary', priority: 1, run: () => { ran += 1 } })
    await registry.run('pre_trigger', {})
    dispose()
    await registry.run('pre_trigger', {})
    expect(ran).toBe(1)
    expect(registry.list('pre_trigger')).toEqual([])
  })

  it('list() shows the chain in EXECUTION order with its policy, which is what a board reads', () => {
    const registry = createHookRegistry()
    registry.register('pre_trigger', { name: 'b', priority: 1, run: () => {} })
    registry.register('pre_trigger', { name: 'a', priority: 9, run: () => {}, onError: 'fail_open' })
    expect(registry.list('pre_trigger')).toEqual([
      { point: 'pre_trigger', name: 'a', priority: 9, onError: 'fail_open', timeoutMs: 5_000 },
      { point: 'pre_trigger', name: 'b', priority: 1, onError: 'fail_closed', timeoutMs: 5_000 },
    ])
  })

  it('clear() empties a point or the whole registry', () => {
    const registry = createHookRegistry()
    registry.register('pre_trigger', { name: 'a', priority: 1, run: () => {} })
    registry.register('pre_turn', { name: 'b', priority: 1, run: () => {} })
    registry.clear('pre_trigger')
    expect(registry.list().map((entry) => entry.name)).toEqual(['b'])
    registry.clear()
    expect(registry.list()).toEqual([])
  })

  it('a fingerprint is stable for the same binding, so a board can diff it', () => {
    const one = { point: 'pre_trigger' as const, name: 'a', priority: 1, onError: 'fail_closed' }
    expect(hookFingerprint(one)).toBe(hookFingerprint({ ...one }))
    expect(hookFingerprint(one)).not.toBe(hookFingerprint({ ...one, priority: 2 }))
  })
})

/**
 * T27 — THE ACCEPTANCE: a sibling participates without patching this plugin.
 *
 * Reaching the registry through the MOUNTED plugin is the whole claim. A registry that
 * only exists inside a test proves the chain works; reaching it through `ctx.recursive`
 * proves a sibling can use it.
 */
describe('T27 — a sibling plugin can participate through the mounted service', () => {
  it('registers on the plugin runtime and runs in its chain', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-hooks-'))
    const ctx = new Context()
    try {
      await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
      const order: string[] = []
      // Exactly what a sibling plugin would write — no patching, no reaching into
      // internals, just the public service.
      const dispose = ctx.recursive.hooks.register('pre_trigger', {
        name: 'sibling-check',
        priority: 100,
        run: () => { order.push('sibling'); return { decision: 'continue', annotations: { from: 'sibling' } } },
      })
      const result = await ctx.recursive.hooks.run('pre_trigger', { name: 'write', arguments: {} })
      expect(order).toEqual(['sibling'])
      expect(result.ran[0].annotations).toEqual({ from: 'sibling' })
      // And it can withdraw cleanly again.
      dispose()
      expect(ctx.recursive.hooks.list('pre_trigger')).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('a sibling hook can DENY a gating point, so participation is real and not decorative', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-hooks2-'))
    const ctx = new Context()
    try {
      await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
      ctx.recursive.hooks.register('pre_trigger', {
        name: 'sibling-veto', priority: 1,
        run: () => ({ decision: 'deny', reason: 'the sibling says no' }),
      })
      const result = await ctx.recursive.hooks.run('pre_trigger', {})
      expect(result.decision).toBe('deny')
      expect(result.reason).toBe('the sibling says no')
    } finally {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
