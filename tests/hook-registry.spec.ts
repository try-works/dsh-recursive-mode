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
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
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

/**
 * T27 — the seam is LIVE: a sibling vetoes a REAL tool call.
 *
 * Reaching the registry is not the same as being consulted by it. These cases drive an
 * actual `ctx.tools.execute` through the plugin's own `tools/pre-execute` listener, so a
 * sibling hook is proven to sit in the ENFORCEMENT path — and the guard's pinned
 * contract is proven undisturbed when no hook is registered.
 */
describe('T27 — a sibling hook vetoes a real tool call, and changes nothing when absent', () => {
  async function mountPlugin() {
    const repo = mkdtempSync(join(tmpdir(), 'rm-hookseam-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { repoRoot: repo })
    return {
      ctx,
      repo,
      dispose: async () => {
        await ctx.fiber.dispose()
        rmSync(repo, { recursive: true, force: true })
      },
    }
  }

  function callStatus(m: { ctx: Context; repo: string }, callId: string) {
    return m.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(callId),
      name: 'recursive_status',
      arguments: {},
      agent: { session: { header: { cwd: m.repo } } },
    } as never)
  }

  it('WITHOUT hooks the guard path is untouched (the pinned contract, live)', async () => {
    const m = await mountPlugin()
    try {
      const out = await callStatus(m, 'h1') as { isError?: boolean }
      // No hooks registered: the chain returns `continue` and the tool runs as always.
      expect(out.isError).toBeFalsy()
    } finally {
      await m.dispose()
    }
  })

  it('a sibling hook DENIES a real tool call, naming itself and its reason', async () => {
    const m = await mountPlugin()
    try {
      m.ctx.recursive.hooks.register('pre_trigger', {
        name: 'policy-blocker', priority: 50,
        run: () => ({ decision: 'deny', reason: 'the workspace policy forbids this' }),
      })
      const text = JSON.stringify(await callStatus(m, 'h2'))
      expect(text).toContain('policy-blocker')
      expect(text).toContain('the workspace policy forbids this')
    } finally {
      await m.dispose()
    }
  })

  it('a HOLD is refused with its own wording, because a tool call has nothing to resume', async () => {
    const m = await mountPlugin()
    try {
      m.ctx.recursive.hooks.register('pre_trigger', {
        name: 'waiter', priority: 50,
        run: () => ({ decision: 'hold', reason: 'waiting for the child to settle' }),
      })
      const text = JSON.stringify(await callStatus(m, 'h3'))
      expect(text).toContain('held by pre_trigger hook waiter')
      expect(text).toContain('waiting for the child to settle')
    } finally {
      await m.dispose()
    }
  })
})

/**
 * T38 — the plugin's OWN guard is a hook like any other.
 *
 * The properties that matter are about PEERAGE, not about the guard working (that is
 * `guard-path`'s job, and its 10 pinned tests pass unchanged): the built-in sits on the
 * chain at priority 0, a higher-priority sibling pre-empts it, and the guard's own deny
 * short-circuits a lower-priority sibling exactly as any hook's would.
 */
describe('T38 — the built-in tool guard runs on the chain', () => {
  async function mountWithRun() {
    const repo = mkdtempSync(join(tmpdir(), 'rm-t38-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { repoRoot: repo })
    await ctx.recursive.initRun('t38-run')
    const runDir = join(repo, '.recursive', 'run', 't38-run')
    return {
      ctx, repo, runDir,
      dispose: async () => {
        await ctx.fiber.dispose()
        rmSync(repo, { recursive: true, force: true })
      },
    }
  }

  it('is registered at priority 0, so it is the baseline others may pre-empt', async () => {
    const m = await mountWithRun()
    try {
      const chain = m.ctx.recursive.hooks.list('pre_trigger')
      const guard = chain.find((entry) => entry.name === 'builtin-tool-guard')
      expect(guard).toBeDefined()
      expect(guard!.priority).toBe(0)
      // A gating point, so its default failure policy is fail_closed.
      expect(guard!.onError).toBe('fail_closed')
    } finally {
      await m.dispose()
    }
  })

  it('a HIGHER-priority sibling pre-empts it: the guard never runs', async () => {
    const m = await mountWithRun()
    try {
      m.ctx.recursive.hooks.register('pre_trigger', {
        name: 'pre-empting-sibling', priority: 100,
        run: () => ({ decision: 'deny', reason: 'stopped before the guard looked' }),
      })
      const result = await m.ctx.recursive.hooks.run('pre_trigger', {
        tool: 'recursive_status', args: {}, exec: { name: 'recursive_status', arguments: {} },
        root: m.repo, runId: 't38-run',
      })
      expect(result.decision).toBe('deny')
      // ONLY the sibling ran: the built-in's absence is the evidence it was pre-empted.
      expect(result.ran.map((r) => r.name)).toEqual(['pre-empting-sibling'])
    } finally {
      await m.dispose()
    }
  })

  it('the guard DENYING short-circuits a lower-priority sibling, as any hook would', async () => {
    const m = await mountWithRun()
    try {
      // STRICT mode is what makes the guard DENY. In advisory mode an out-of-order lock
      // is an `ask` that `coerceAskToDecision` turns into an allow-with-warning, so the
      // chain continues and nothing is short-circuited — my first version of this test
      // asserted a denial under advisory, which is not what advisory does. Strict is now
      // ALSO the default; it stays stated here so this case tests denial rather than the
      // default, and the advisory case below states its mode for the same reason.
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      let siblingRan = false
      m.ctx.recursive.hooks.register('pre_trigger', {
        name: 'late-sibling', priority: -100,
        run: () => { siblingRan = true },
      })
      const result = await m.ctx.recursive.hooks.run('pre_trigger', {
        tool: 'recursive_lock',
        args: { artifact: '01-as-is.md' },
        exec: { name: 'recursive_lock', arguments: { artifact: '01-as-is.md' } },
        root: m.repo,
        runId: 't38-run',
      })
      expect(result.decision).toBe('deny')
      // The guard decided and the lower-priority sibling did NOT run. Asserted by presence and
      // absence rather than by exact chain contents: T13 later added a second built-in
      // (`exit-plan-mode-gate`), and a test that pinned the whole list would have to be edited
      // every time a built-in is added, which is how an assertion stops meaning anything.
      expect(result.ran.map((r) => r.name)).toContain('builtin-tool-guard')
      expect(result.ran.map((r) => r.name)).not.toContain('late-sibling')
      expect(siblingRan).toBe(false)
    } finally {
      await m.dispose()
    }
  })

  it('the guard’s decision reaches the caller VERBATIM through a real tool call', async () => {
    const m = await mountWithRun()
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await m.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('t38-a'),
        name: 'recursive_lock',
        arguments: { runId: 't38-run', artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      const text = JSON.stringify(out)
      // The guard's own monotonic lock-order wording, not a wrapper's paraphrase.
      expect(text).toContain('monotonic lock-order')
    } finally {
      await m.dispose()
    }
  })

  it('in ADVISORY mode the same call is allowed with the guard’s warning kept', async () => {
    // ⚠ ADVISORY IS REQUESTED EXPLICITLY HERE, because it is no longer the default: an `ask`
    // under advisory is an allow that CARRIES the warning — never a silent pass. Relying on the
    // default would have tested strict and called it advisory; the behaviour under test is the
    // advisory one, so the test states the mode it needs rather than inheriting it.
    const m = await mountWithRun()
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'advisory' })
      const result = await m.ctx.recursive.hooks.run('pre_trigger', {
        tool: 'recursive_lock',
        args: { artifact: '01-as-is.md' },
        exec: { name: 'recursive_lock', arguments: { artifact: '01-as-is.md' } },
        root: m.repo,
        runId: 't38-run',
      })
      expect(result.decision).toBe('continue')
      // Found BY NAME: the chain now carries more than one built-in (T13 added the plan gate),
      // so indexing `ran[0]` would be asserting whichever hook happens to sort first.
      const guardRecord = result.ran.find((entry) => entry.name === 'builtin-tool-guard')
      const decision = guardRecord?.annotations?.guardDecision as { kind: string; warn?: string }
      expect(decision.kind).toBe('allow')
      expect(decision.warn).toContain('monotonic lock-order')
    } finally {
      await m.dispose()
    }
  })
})
