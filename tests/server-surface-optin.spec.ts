/**
 * ⚠ THE DEFAULT-INERT REGRESSION — the assertion that would have caught the recursive-surface
 * global leak.
 *
 * WHAT WAS MEASURED, so this file's shape is not arbitrary. Decoding all 496 DSH session logs
 * found this plugin's entire server surface — the 13 `recursive_*` tools plus the `recursive-mode`
 * and twelve `recursive-phase-*` skills — registered inside sessions running a DIFFERENT agent
 * preset (`cordis`, the GUI's "Creator mode"). Session `3c7e83b4`'s `request/header` went from 49
 * tools (0 recursive) at 06:09:48 to 62 tools (13 recursive) at 06:25:05 with NO preset switch, the
 * changed skill catalogue injected at that same second, 13 `tool-addition` entries emitted by the
 * agent loop, and the model's own reasoning recording "The tool catalog now includes the
 * recursive_* tools". It was withdrawn fifteen minutes later.
 *
 * THE MECHANISM, which is why the leak needed a POLARITY fix rather than a better flag check. Both
 * registries are layered by the CALLER's scope and `register`/`registerProvider` bind `this.ctx` to
 * that caller, so a registration made inside the preset's `recursive-realm` group cannot reach a
 * `cordis` agent — the two preset scopes are SIBLINGS. Those registrations therefore landed in the
 * GLOBAL layer, from an unscoped context: the HOST row, applied with `shellOnly` falsy. This bundle
 * shipped TWO rows whose id was the same word (`recursive`), and a guard that fires on the PRESENCE
 * of a key is lost the moment the key is lost — the Loader addresses rows by id, the settings
 * service edits a Loader entry's config, and the Loader re-applies the plugin.
 *
 * WHAT THIS SPEC PINS. Mounting with `{ repoRoot }` ALONE is exactly the shape the host row would
 * have if its config were lost — and it must register NOTHING: no `recursive_*` tool, no skill
 * provider, no `ctx.recursive` service. The surface requires an EXPLICIT `serverSurface: true`.
 * A future edit that restores "register unless told otherwise" fails HERE rather than in a user's
 * session, which is the whole point.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as plugin from '../src/index.ts'
import {
  createRecursiveStatusTool,
  createRecursiveInitTool,
  createRecursiveLockTool,
  createRecursiveLintTool,
  createRecursiveCloseoutTool,
  createRecursiveScratchTool,
  createRecursiveWorktreeTool,
  createRecursivePhaseTool,
} from '../src/index.ts'
// ⚠ THE OTHER FIVE ARE IMPORTED FROM THEIR OWN MODULES, NOT FROM THE ENTRY, AND THAT IS A
// MEASURED FACT RATHER THAN A STYLE CHOICE: the entry re-exports eight of the thirteen creators,
// so `plugin.createRecursiveReviewTool` is `undefined` (a probe over the entry proved it). A spec
// that read them off the module namespace would assert the wrong thing while looking authoritative.
import { createRecursiveAuditTeamTool } from '../src/recursive_audit_team.tool.ts'
import { createRecursiveReviewTool } from '../src/recursive_review.tool.ts'
import { createRecursiveDelegateTool } from '../src/recursive_delegate.tool.ts'
import { createRecursiveAskTool } from '../src/recursive_ask.tool.ts'
import { createRecursivePreviewTool } from '../src/recursive_preview.tool.ts'
import type { SkillsRuntimeLike, SkillProviderLike } from '../src/skills.ts'

/**
 * THE THIRTEEN, written out rather than counted from `src/index.ts` — the same way
 * `tests/continuable-delegate.spec.ts` writes the host's known-global-tools list. Reading the
 * number off the code under test would make this file move with the defect it exists to catch.
 */
const THIRTEEN_TOOLS = [
  'recursive_status',
  'recursive_init',
  'recursive_lock',
  'recursive_lint',
  'recursive_closeout',
  'recursive_scratch',
  'recursive_worktree',
  'recursive_phase',
  'recursive_audit_team',
  'recursive_review',
  'recursive_delegate',
  'recursive_ask',
  'recursive_preview',
] as const

/**
 * The fixture seams the full thirteen need, mounted BEFORE the plugin so its one-shot reads see
 * them. Without `agentTeams` the plugin ships twelve of its thirteen tools (`recursive_audit_team`
 * is registered only when that service is present — `src/index.ts`, FIX 1), so a spec that asserted
 * "thirteen" against a bare composition would be asserting the wrong number.
 */
const TEAM_FIXTURE = {
  async createTask() {
    return { id: 'task-1', revision: 1, status: 'todo', subject: 'fixture' }
  },
  async updateTask() {
    return { id: 'task-1', revision: 2, status: 'done', subject: 'fixture' }
  },
}

/**
 * A skills registry that records BOTH registration routes, so "nothing was registered" cannot be
 * a statement about only one of the two ways this plugin contributes:
 *  - `registerProvider` — the packaged `recursive-mode` skill (`src/skills.ts`).
 *  - `register` — the twelve `recursive-phase-*` runtime skills (`src/skills-phase.ts`).
 */
function recordingSkillsRegistry() {
  const providers: SkillProviderLike[] = []
  const phaseSkills: string[] = []
  const registry: SkillsRuntimeLike & { register: (skill: { name: string }) => () => void } = {
    registerProvider(create) {
      const provider = create({ signal: new AbortController().signal, invalidate: () => {} })
      providers.push(provider)
      return () => {
        const at = providers.indexOf(provider)
        if (at >= 0) providers.splice(at, 1)
      }
    },
    register(skill) {
      phaseSkills.push(skill.name)
      return () => {
        const at = phaseSkills.indexOf(skill.name)
        if (at >= 0) phaseSkills.splice(at, 1)
      }
    },
  }
  return { registry, providers, phaseSkills }
}

/** The global tool surface, read the way the model's catalogue is assembled. */
function globalToolNames(ctx: Context): string[] {
  return (ctx.tools.schemas() as Array<{ name: string }>).map((schema) => schema.name)
}

async function mount(config: Record<string, unknown>) {
  const repo = mkdtempSync(join(tmpdir(), 'rm-optin-'))
  const ctx = new Context()
  const skills = recordingSkillsRegistry()
  // Both `provide` and `set`, measured in `tests/e2e-harness.spec.ts`: `provide` declares the
  // service and `set` puts the value where `ctx.get('skills')` — what this plugin calls — finds it.
  ctx.provide('skills', skills.registry as never)
  ;(ctx as unknown as { set: (key: string, value: unknown) => void }).set('skills', skills.registry)
  ctx.provide('agentTeams', TEAM_FIXTURE as never)
  ;(ctx as unknown as { set: (key: string, value: unknown) => void }).set('agentTeams', TEAM_FIXTURE)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // ⚠ THE HELPER DELIBERATELY ADDS NOTHING: the opt-in is the SUBJECT of this spec, so every mount
  // states it for itself. A helper that injected `serverSurface: true` would make the three inert
  // cases below pass for the wrong reason — measured, because an earlier draft of this file did
  // exactly that and the "registers nothing" case failed with thirteen tools.
  await ctx.plugin(plugin as never, { repoRoot: repo, ...config } as never)
  return {
    ctx,
    repo,
    skills,
    tools: () => globalToolNames(ctx),
    recursiveTools: () => globalToolNames(ctx).filter((name) => name.startsWith('recursive_')),
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

describe('⚠ DEFAULT-INERT: a bare mount registers NOTHING (the global-leak regression)', () => {
  it('a mount with ONLY { repoRoot } registers no recursive_* tool and no skill provider', async () => {
    const m = await mount({})
    try {
      // The leak's exact signature: thirteen names in a session that never asked for them.
      expect(m.recursiveTools()).toEqual([])
      // ⚠ THE REGISTRY IS PRESENT AND READABLE, which is what makes the empty set above mean
      // "registered nothing" rather than "could not be read". Measured: a bare `ToolRuntime` mounts
      // the registry with no tools of its own, so the positive control is the OPT-IN case below,
      // which records thirteen names through this very method — not a tool count here.
      expect(typeof m.ctx.tools?.schemas).toBe('function')
      // Neither skills route may fire: the packaged provider OR the phase-runtime skills.
      expect(m.skills.providers).toEqual([])
      expect(m.skills.phaseSkills).toEqual([])
      // And the service itself is absent — nothing was left behind under a different name.
      expect(m.ctx.get('recursive') as unknown).toBeUndefined()
    } finally {
      await m.dispose()
    }
  })

  it('an EXPLICIT serverSurface: false is inert too, so a cleared flag and an absent one agree', async () => {
    const m = await mount({ serverSurface: false })
    try {
      expect(m.recursiveTools()).toEqual([])
      expect(m.skills.providers).toEqual([])
      expect(m.skills.phaseSkills).toEqual([])
      expect(m.ctx.get('recursive') as unknown).toBeUndefined()
    } finally {
      await m.dispose()
    }
  })

  it('shellOnly: true stays an explicit "do nothing", independently of the new flag', async () => {
    // The belt-and-braces statement the host shell row carries. It must not be the ONLY thing
    // standing between a bare row and a global registration, which is what the case above proves.
    const m = await mount({ shellOnly: true })
    try {
      expect(m.recursiveTools()).toEqual([])
      expect(m.skills.providers).toEqual([])
      expect(m.skills.phaseSkills).toEqual([])
      expect(m.ctx.get('recursive') as unknown).toBeUndefined()
    } finally {
      await m.dispose()
    }
  })
})

describe('the opt-in registers the WHOLE surface', () => {
  it('serverSurface: true registers all thirteen tools, both skill routes, and the service', async () => {
    const m = await mount({ serverSurface: true })
    try {
      const registered = m.recursiveTools()
      // ⚠ EXACTLY THIRTEEN: the set first (a wrong or invented name is named), then the count (a
      // fourteenth silently joining the catalogue is caught, which a `toContain` set would miss).
      for (const name of THIRTEEN_TOOLS) {
        expect(registered, `${name} must be registered under the opt-in`).toContain(name)
      }
      expect(registered.length).toBe(13)
      expect([...registered].sort()).toEqual([...THIRTEEN_TOOLS].sort())
      // Both skill routes: the packaged provider and the twelve phase-runtime skills.
      expect(m.skills.providers.map((provider) => provider.name)).toEqual(['recursive-mode'])
      expect(m.skills.phaseSkills.length).toBe(12)
      expect(m.skills.phaseSkills[0]).toMatch(/^recursive-phase-/)
      // The service the tools are built on.
      expect(m.ctx.get('recursive')).toBeDefined()
    } finally {
      await m.dispose()
    }
  })

  it('the THIRTEEN creators this spec names are the thirteen the plugin ships', () => {
    // One assertion per imported creator, so a creator that stopped existing fails here as
    // `undefined` rather than sliding silently out of the count above.
    const creators = [
      createRecursiveStatusTool,
      createRecursiveInitTool,
      createRecursiveLockTool,
      createRecursiveLintTool,
      createRecursiveCloseoutTool,
      createRecursiveScratchTool,
      createRecursiveWorktreeTool,
      createRecursivePhaseTool,
      createRecursiveAuditTeamTool,
      createRecursiveReviewTool,
      createRecursiveDelegateTool,
      createRecursiveAskTool,
      createRecursivePreviewTool,
    ]
    expect(creators.length).toBe(13)
    for (const creator of creators) expect(typeof creator).toBe('function')
  })
})

/**
 * The CONFIG CONTRACT, asserted where the settings service reads it: the schema is what shapes the
 * form, so `serverSurface` must be discoverable there and must default to the inert value.
 */
describe('the schema declares the opt-in and defaults it to INERT', () => {
  it('fills serverSurface with false for a caller that said nothing', () => {
    const filled = plugin.Config({}) as { serverSurface?: boolean }
    expect(filled.serverSurface).toBe(false)
  })

  it('describes the field, because the description IS the form help text', () => {
    const described = (plugin.Config as unknown as { toJSON?: () => unknown }).toJSON?.() ?? {}
    const text = JSON.stringify(described)
    expect(text).toContain('serverSurface')
    expect(text).toContain('registers NOTHING')
  })
})
