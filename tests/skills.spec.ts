import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { registerRecursiveSkill, type SkillsRuntimeLike, type SkillProviderLike, type SkillCandidateLike } from '../src/skills.ts'

/**
 * Packaged skill (dsh plugin standard): the plugin ships a `recursive-mode`
 * skill through `ctx.skills.registerProvider(...)` — the `dsh-skill-badge`
 * bundled-provider shape (`source: 'bundled'`, `BUNDLED_SKILL_RANK`), so the
 * workflow's operating contract is discoverable in-catalog and loadable via
 * the standard `skill` tool.
 */

/** Fake skills registry: records the one provider registered against it. */
function fakeSkillsRegistry() {
  const providers: SkillProviderLike[] = []
  const registry: SkillsRuntimeLike = {
    registerProvider(create) {
      const provider = create({ signal: new AbortController().signal, invalidate: () => {} })
      providers.push(provider)
      return () => { providers.splice(providers.indexOf(provider), 1) }
    },
  }
  return { registry, providers }
}

/** Normalize a provider `list()` result to its candidate array (array form or observation form). */
function candidatesOf(listed: readonly SkillCandidateLike[] | { readonly candidates: readonly SkillCandidateLike[]; readonly complete: boolean }): readonly SkillCandidateLike[] {
  return 'candidates' in listed ? listed.candidates : listed
}

function contextWith(skills?: SkillsRuntimeLike) {
  const ctx = new Context()
  if (skills !== undefined) ctx.provide('skills', skills)
  return ctx
}

describe('src/skills.ts — packaged recursive-mode skill (dsh plugin standard)', () => {
  it('registers a bundled provider via ctx.skills.registerProvider', async () => {
    const { registry, providers } = fakeSkillsRegistry()
    const disposer = registerRecursiveSkill(contextWith(registry))
    expect(disposer).toBeTypeOf('function')
    expect(providers.length).toBe(1)
    expect(providers[0].name).toBe('recursive-mode')
  })

  it('lists one bundled candidate at BUNDLED_SKILL_RANK with model+user invocation', async () => {
    const { registry, providers } = fakeSkillsRegistry()
    registerRecursiveSkill(contextWith(registry))
    const listed = await providers[0].list({})
    const candidates = candidatesOf(listed)
    expect(candidates.length).toBe(1)
    const candidate = candidates[0]
    expect(candidate.name).toBe('recursive-mode')
    expect(candidate.provider).toBe('recursive-mode')
    expect(candidate.source).toBe('bundled')
    expect(candidate.rank).toBe(600)
    expect(candidate.invocation.modelInvocable).toBe(true)
    expect(candidate.invocation.userInvocable).toBe(true)
    expect(candidate.description).toBeTypeOf('string')
    expect(candidate.description.length).toBeGreaterThan(0)
  })

  it('loads the operating-contract body through get()', async () => {
    const { registry, providers } = fakeSkillsRegistry()
    registerRecursiveSkill(contextWith(registry))
    const listed = await providers[0].list({})
    const candidates = candidatesOf(listed)
    const definition = await providers[0].get(candidates[0], {})
    expect(definition).toBeDefined()
    if (definition === undefined) throw new Error('provider get() returned undefined for a listed candidate')
    expect(definition.name).toBe('recursive-mode')
    expect(definition.source).toBe('bundled')
    // The body is the workflow operating contract, not the full spec.
    expect(definition.content).toContain('recursive-mode')
    expect(definition.content).toContain('draft')
    expect(definition.content).toContain('audit')
    expect(definition.content).toContain('lock')
  })

  it('disposes the registration (unregisters the provider)', async () => {
    const { registry, providers } = fakeSkillsRegistry()
    const disposer = registerRecursiveSkill(contextWith(registry))
    if (disposer === undefined) throw new Error('expected a disposer')
    expect(providers.length).toBe(1)
    disposer()
    expect(providers.length).toBe(0)
  })

  it('no-ops when the host composition supplies no skills registry', () => {
    const disposer = registerRecursiveSkill(contextWith(undefined))
    expect(disposer).toBeUndefined()
  })
})
