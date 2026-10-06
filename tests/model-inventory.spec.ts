/**
 * FU-19 step 4 — THE INVENTORY COMES FROM DSH, AND AN UNVERIFIABLE CHOICE SAYS SO.
 *
 * The requirement in the user's words: "provider and model inventory should be resolved from dsh itself, we only
 * concern ourselves with what is configured inside dsh." These tests pin the three-state verdict, because the
 * whole value of this module is that `unverified` is not a synonym for either `available` or `missing`.
 */
import { describe, expect, it } from 'vitest'
import { checkModelChoice, describeInventory, findModelProvider, providerIdsText, subagentProviderNames } from '../src/model-inventory.ts'

const llm = (providers: Record<string, string[] | Error>) => ({
  listProviders: () => Object.keys(providers).map((id) => ({ id })),
  listModels: async (providerId: string) => {
    const entry = providers[providerId]
    if (entry instanceof Error) throw entry
    return (entry ?? []).map((id) => ({ id }))
  },
})

describe('FU-19: the model inventory is read from DSH', () => {
  it('reads providers and their models', async () => {
    const inventory = await describeInventory(llm({ 'deepseek-official': ['deepseek-flash', 'deepseek-pro'] }))
    expect(inventory.available).toBe(true)
    if (!inventory.available) return
    expect(inventory.providers).toEqual([{ id: 'deepseek-official', models: ['deepseek-flash', 'deepseek-pro'] }])
    expect(inventory.note).toContain('1 provider(s), 2 model(s)')
  })

  it('a provider that will not answer is kept and named, not dropped', async () => {
    const inventory = await describeInventory(llm({ ok: ['a'], broken: new Error('nope') }))
    expect(inventory.available).toBe(true)
    if (!inventory.available) return
    expect(inventory.providers).toEqual([{ id: 'ok', models: ['a'] }, { id: 'broken', models: [] }])
  })

  it('NO llm service is a named unavailability, never an empty inventory pretending to be one', async () => {
    const inventory = await describeInventory(null)
    expect(inventory.available).toBe(false)
    if (inventory.available) return
    expect(inventory.reason).toContain('no llm service is mounted')
    expect(inventory.reason).toContain('could not be read from DSH')
  })

  it('a model that IS configured is available, and the provider is found for the user', async () => {
    const inventory = await describeInventory(llm({ 'deepseek-official': ['deepseek-flash'] }))
    expect(checkModelChoice(inventory, 'deepseek-flash').verdict).toBe('available')
    expect(findModelProvider(inventory, 'deepseek-flash')).toBe('deepseek-official')
  })

  it('a model that is NOT configured is missing, and the message says what IS available', async () => {
    const inventory = await describeInventory(llm({ 'deepseek-official': ['deepseek-flash'] }))
    const check = checkModelChoice(inventory, 'gpt-9-turbo')
    expect(check.verdict).toBe('missing')
    expect(check.reason).toContain('deepseek-official')
    expect(providerIdsText(inventory)).toBe('deepseek-official')
  })

  it('a named model provider that DSH does not have is missing, not silently ignored', async () => {
    const inventory = await describeInventory(llm({ 'deepseek-official': ['deepseek-flash'] }))
    const check = checkModelChoice(inventory, 'deepseek-flash', 'some-other-service')
    expect(check.verdict).toBe('missing')
    expect(check.reason).toContain('some-other-service')
  })

  it('⚠ WITH NO INVENTORY THE VERDICT IS UNVERIFIED — not fine, and not refused', async () => {
    const inventory = await describeInventory(null)
    const check = checkModelChoice(inventory, 'deepseek-flash')
    expect(check.verdict).toBe('unverified')
    expect(check.reason).toContain('UNVERIFIED')
    expect(check.reason, 'the sentence must state that nothing was replaced').toContain('nor replaced')
  })

  it('no model chosen is unverified and says it is an inheritance, not a problem', async () => {
    const inventory = await describeInventory(llm({ p: ['m'] }))
    const check = checkModelChoice(inventory, '   ')
    expect(check.verdict).toBe('unverified')
    expect(check.reason).toContain('inherits the session default')
  })

  it('subagent providers are read from their OWN service, since they are the other kind of provider', () => {
    expect(subagentProviderNames({ list: () => ['spawn', 'fork'] })).toEqual(['spawn', 'fork'])
    expect(subagentProviderNames(null)).toEqual([])
    expect(subagentProviderNames({ list: () => { throw new Error('x') } })).toEqual([])
  })
})
