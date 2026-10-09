/**
 * T7 — the enforcement + router config in a SETTINGS namespace.
 *
 * ⚠ THE ITEM'S PREMISE WAS WRONG, and it was corrected by reading the settings
 * service's own types rather than by assuming (the 8th such correction in this plan).
 * The item says to call `registerEnforcementSettings(settings)` with a `recursive`
 * namespace. `@deepseek-ai/dsh-settings` has **no such method**: its service
 * `describe()`s "active plugin schemas and their live values" and `update(ns, patch,
 * expectedRevision)` "merge[s] editable fields into an entry's config". A plugin does not
 * REGISTER a namespace — **declaring a Config schema IS the registration**, because the
 * Loader owns the profile entry which the service projects into a form.
 *
 * WHAT MAKES IT LIVE, and why there is no watcher: editing the form changes the Loader
 * entry's config, and the Loader re-applies the plugin. That re-application is the hot
 * reload, so the tests below drive `apply` again with a changed config and assert the
 * enforcement flipped — which is the acceptance, expressed in the mechanism that exists.
 *
 * WHAT REMAINS OUT OF SCOPE and is recorded rather than implied: the ROUTER defaults
 * (`recursive-router.json` → `loadRouterPolicy`). The enforcement namespace is wired; the
 * router's is not, so this item is not complete.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config, type RecursiveModeConfig } from '../src/config.ts'
import { loadRouterPolicy } from '../src/router.ts'
import { DEFAULT_BUDGETS, DEFAULT_ENFORCEMENT_MODE } from '../src/enforcement.ts'
import * as plugin from '../src/index.ts'

/** What the settings service would hand the plugin after a form edit. */
function editedConfig(patch: RecursiveModeConfig): RecursiveModeConfig {
  return Config(patch) as RecursiveModeConfig
}

describe('T7 — the plugin declares a Config schema the settings service can discover', () => {
  it('exports Config from the plugin entry, which is where the Loader reads it', () => {
    // The service describes "active plugin schemas", so the export being reachable from
    // the module the Loader mounts is the whole mechanism.
    expect(plugin.Config).toBeDefined()
    expect(typeof (plugin.Config as unknown as (value: unknown) => unknown)).toBe('function')
  })

  it('fills the enforcement namespace with the documented defaults — STRICT, the owner’s decision', () => {
    // ⚠ THE SCHEMA LAYER'S HALF OF THE REVERT GUARD. `editedConfig({})` is a caller that said
    // nothing, so these three values ARE the default; they are written as LITERALS on purpose,
    // because reading them from `DEFAULT_ENFORCEMENT` would make this case move with the code
    // it is meant to hold still. The runtime layer's half is in tests/enforcement.spec.ts.
    const filled = editedConfig({})
    expect(filled.enforcement?.preStep).toBe('strict')
    expect(filled.enforcement?.toolGuards).toBe('strict')
    expect(filled.enforcement?.tamper).toBe('strict')
    expect(filled.enforcement?.budgets).toEqual(DEFAULT_BUDGETS)
    // The two layers cannot drift: the schema default IS the runtime default, one const.
    expect(filled.enforcement).toEqual(expect.objectContaining({
      preStep: DEFAULT_ENFORCEMENT_MODE,
      toolGuards: DEFAULT_ENFORCEMENT_MODE,
      tamper: DEFAULT_ENFORCEMENT_MODE,
    }))
  })

  it('applies one edited field and leaves the rest at their defaults', () => {
    const filled = editedConfig({ enforcement: { toolGuards: 'advisory' } })
    expect(filled.enforcement?.toolGuards).toBe('advisory')
    expect(filled.enforcement?.preStep).toBe('strict')
  })

  it('REJECTS an unknown mode loudly instead of coercing it', () => {
    // The schema gives the form its shape; it must not become a second, weaker contract
    // that silently accepts what the strict resolver would refuse.
    expect(() => editedConfig({ enforcement: { toolGuards: 'nonsense' as never } })).toThrow()
  })

  it('describes each field, because the description IS the form help text', () => {
    const described = (Config as unknown as { toJSON?: () => unknown }).toJSON?.() ?? {}
    const text = JSON.stringify(described)
    expect(text).toContain('toolGuards')
    expect(text).toContain('DENIES')
  })
})

describe('T7 — a settings edit changes enforcement LIVE (the acceptance)', () => {
  async function mountWith(config: RecursiveModeConfig) {
    const repo = mkdtempSync(join(tmpdir(), 'rm-t7-'))
    const ctx = new Context()
    // The plugin declares `inject: ['tools']`, so the tools service must be mounted
    // first — without it `ctx.recursive` is never registered and every assertion below
    // would fail on an undefined service rather than on the thing under test.
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { repoRoot: repo, ...config } as never)
    return {
      ctx,
      repo,
      dispose: async () => {
        await ctx.fiber.dispose()
        rmSync(repo, { recursive: true, force: true })
      },
    }
  }

  it('mounting with toolGuards strict makes enforcement strict', async () => {
    const m = await mountWith(editedConfig({ enforcement: { toolGuards: 'strict' } }))
    try {
      expect(m.ctx.recursive.enforcementConfig.toolGuards).toBe('strict')
    } finally {
      await m.dispose()
    }
  })

  it('a RE-APPLICATION with the edited value flips it — the hot-reload path', async () => {
    // This is what the Loader does when the form is saved: dispose, re-apply with the new
    // config. Driving it here is how the acceptance is expressed in the mechanism that
    // actually exists.
    const strict = await mountWith(editedConfig({ enforcement: { toolGuards: 'strict' } }))
    try {
      expect(strict.ctx.recursive.enforcementConfig.toolGuards).toBe('strict')
    } finally {
      await strict.dispose()
    }
    const advisory = await mountWith(editedConfig({ enforcement: { toolGuards: 'advisory' } }))
    try {
      expect(advisory.ctx.recursive.enforcementConfig.toolGuards).toBe('advisory')
    } finally {
      await advisory.dispose()
    }
  })

  it('carries the BUDGETS through to the runtime, so the T28 caps are configurable from the UI', async () => {
    const m = await mountWith(editedConfig({ enforcement: { budgets: { maxDelegationDepth: 5, maxResultBytes: 4_096 } } }))
    try {
      const budgets = m.ctx.recursive.enforcementConfig.budgets
      expect(budgets.maxDelegationDepth).toBe(5)
      expect(budgets.maxResultBytes).toBe(4_096)
      // Untouched caps keep their defaults.
      expect(budgets.maxAuditRounds).toBe(DEFAULT_BUDGETS.maxAuditRounds)
    } finally {
      await m.dispose()
    }
  })

  it('leaves the runtime default ALONE when the caller said nothing about enforcement', async () => {
    // Presence, not truthiness: an absent section is "no opinion", and the runtime's own
    // default must survive it — which is now STRICT on all three gates, the owner's decision.
    // This is the live-path half of the revert guard: `apply` skips `setEnforcementConfig`
    // entirely when `enforcement` is absent, so what is asserted here is the value the runtime
    // falls back to on its own, not a value this test handed it.
    const m = await mountWith({ repoRoot: undefined } as RecursiveModeConfig)
    try {
      expect(m.ctx.recursive.enforcementConfig).toEqual(expect.objectContaining({
        preStep: 'strict', toolGuards: 'strict', tamper: 'strict',
      }))
    } finally {
      await m.dispose()
    }
  })

  it('REFUSES an unknown key in the enforcement section at apply time (fail loud)', async () => {
    // The schema rejects it, and so does the strict resolver — belt and braces, because a
    // config can also arrive from a file rather than the form.
    await expect(mountWith({ enforcement: { nope: true } as never })).rejects.toThrow(/unknown key/)
  })
})

/**
 * T7 part 2 — the ROUTER half, on the same terms as the enforcement half.
 *
 * THE PROPERTY THAT MATTERS MOST is a NEGATIVE one: the router fields must carry **no
 * schema defaults**. A default makes every field PRESENT, and a present field overrides the
 * workspace's `recursive-router.json` — so defaulting them would silently shadow the
 * declarative file forever, which is exactly the "one path, not two" failure the item warns
 * about. That is asserted first, before any behaviour.
 */
describe('T7 — the router overrides, one path and not two', () => {
  it('declares NO defaults, so an unedited namespace cannot shadow the workspace file', () => {
    const filled = editedConfig({}) as { router?: { defaults?: Record<string, unknown> } }
    const defaults = filled.router?.defaults ?? {}
    const present = Object.entries(defaults).filter(([, value]) => value !== undefined)
    expect(present).toEqual([])
  })

  it('lays an override ON TOP of the file, keeping the file’s other values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-t7r-'))
    try {
      const file = join(dir, 'recursive-router.json')
      writeFileSync(file, JSON.stringify({ defaults: { probe_timeout_ms: 111, invoke_timeout_ms: 222 } }), 'utf8')
      const policy = loadRouterPolicy(file, { defaults: { invoke_timeout_ms: 999 } })
      expect(policy.defaults.invoke_timeout_ms).toBe(999)   // the override
      expect(policy.defaults.probe_timeout_ms).toBe(111)    // the file kept its own
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an explicitly UNSET field does NOT erase the file’s value', () => {
    // A form that submits `undefined` for an untouched field must not delete configuration.
    const dir = mkdtempSync(join(tmpdir(), 'rm-t7r2-'))
    try {
      const file = join(dir, 'recursive-router.json')
      writeFileSync(file, JSON.stringify({ defaults: { probe_timeout_ms: 111 } }), 'utf8')
      const policy = loadRouterPolicy(file, { defaults: { probe_timeout_ms: undefined, invoke_timeout_ms: undefined } })
      expect(policy.defaults.probe_timeout_ms).toBe(111)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('with no overrides at all the policy is exactly what the file says', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-t7r3-'))
    try {
      const file = join(dir, 'recursive-router.json')
      writeFileSync(file, JSON.stringify({ defaults: { when_model_unknown: 'fallback-local' } }), 'utf8')
      const withNone = loadRouterPolicy(file)
      const withEmpty = loadRouterPolicy(file, { defaults: {} })
      expect(withNone.defaults.when_model_unknown).toBe('fallback-local')
      expect(withEmpty).toEqual(withNone)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a missing file still yields the built-in defaults, with the override applied', () => {
    const policy = loadRouterPolicy(join(tmpdir(), 'rm-does-not-exist', 'recursive-router.json'), {
      defaults: { probe_timeout_ms: 7 },
    })
    expect(policy.defaults.probe_timeout_ms).toBe(7)
    expect(policy.version).toBe(1)
  })

  it('REACHES the runtime: a mounted plugin carries the router section through', async () => {
    // White-box on purpose: this asserts the WIRING (config -> runtime), which is the part
    // this change adds. `loadRouterPolicy`'s behaviour is covered by the cases above, and a
    // full delegation round trip would test the router rather than the settings seam.
    const repo = mkdtempSync(join(tmpdir(), 'rm-t7r4-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin, {
        repoRoot: repo,
        router: { defaults: { probe_timeout_ms: 4242 } },
      } as never)
      const carried = (ctx.recursive as unknown as { _routerOverrides?: { defaults?: { probe_timeout_ms?: number } } })._routerOverrides
      expect(carried?.defaults?.probe_timeout_ms).toBe(4242)
    } finally {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
