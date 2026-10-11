/**
 * FU-19 step 4 — THE INVENTORY COMES FROM DSH, AND AN UNVERIFIABLE CHOICE SAYS SO.
 *
 * The requirement in the user's words: "provider and model inventory should be resolved from dsh itself, we only
 * concern ourselves with what is configured inside dsh." These tests pin the three-state verdict, because the
 * whole value of this module is that `unverified` is not a synonym for either `available` or `missing`.
 */
import { describe, expect, it } from 'vitest'
import { checkModelChoice, describeInventory, describeSubstitution, findModelProvider, providerIdsText, readSessionModel, subagentProviderNames } from '../src/model-inventory.ts'

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

/**
 * ⚠ FU-20 — THE SESSION'S OWN MODEL, AND THE SUBSTITUTION THAT MUST BE NAMED.
 *
 * Two requirements meet here. The first: *"if no subagents are configured, use default session model"* — which is
 * only actionable if the plugin can SAY which model that is. The second: *"if a configured model cannot be
 * resolved, the outcome must SAY SO and name what it used instead"*.
 *
 * ⚠ WHY THE READING IS TAKEN FROM `session.requestHeader().config`: that is not a convenient guess, it is the
 * FIRST source the harness itself consults when it gives an unconfigured child its model
 * (`packages/subagent/subagent/src/child-agent.ts:69`, called at `continuation.ts:115`). A reading taken from
 * anywhere else could disagree with what the child actually runs on, which would make it worse than no reading.
 */
describe('FU-20 — this session’s own model, read the way the harness reads it', () => {
  const withHeader = (provider: string, model: string) => ({
    session: { requestHeader: () => ({ config: { provider, model } }) },
  })

  it('reads provider and model from the REQUEST HEADER first — the harness’s own first choice', () => {
    const reading = readSessionModel({
      session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) },
      options: { provider: 'created-provider', model: 'created-model' },
    })
    expect(reading.available).toBe(true)
    expect(reading.source).toBe('request-header')
    expect(reading.model).toBe('deepseek-flash')
    expect(reading.provider).toBe('deepseek-official')
  })

  it('falls back to the Agent’s creation options, as the harness does before a session’s first request', () => {
    const reading = readSessionModel({ session: {}, options: { provider: 'p', model: 'm' } })
    expect(reading.available).toBe(true)
    expect(reading.source).toBe('agent-options')
    expect(reading.model).toBe('m')
  })

  it('⚠ an UNREADABLE model is a NAMED finding, never a plausible-looking guess', () => {
    const noParent = readSessionModel(undefined)
    expect(noParent.available).toBe(false)
    expect(noParent.model).toBeNull()
    expect(noParent.note).toContain('no parent Agent was handed to the check')

    const noSeam = readSessionModel({})
    expect(noSeam.available).toBe(false)
    expect(noSeam.note).toContain('carries no session.requestHeader()')

    const emptyHeader = readSessionModel({ session: { requestHeader: () => ({ config: {} }) } })
    expect(emptyHeader.available).toBe(false)
    expect(emptyHeader.note).toContain('nor its creation options named a model')

    const threw = readSessionModel({ session: { requestHeader: () => { throw new Error('boom') } } })
    expect(threw.available).toBe(false)
    expect(threw.note, 'the failure is reported with its own cause, not flattened').toContain('boom')
  })

  it('a provider without a model is NOT a reading: the model is what was asked for', () => {
    const reading = readSessionModel({ session: { requestHeader: () => ({ config: { provider: 'deepseek-official' } }) } })
    expect(reading.available).toBe(false)
    expect(reading.provider).toBeNull()
  })

  it('names the substitute when the session model IS readable', () => {
    const text = describeSubstitution({
      requestedModel: 'gpt-9-turbo',
      reason: 'no provider DSH has advertises model gpt-9-turbo: deepseek-official',
      session: readSessionModel(withHeader('deepseek-official', 'deepseek-flash')),
      requestedProvider: 'deepseek-official',
    })
    expect(text).toContain('SUBSTITUTION')
    expect(text).toContain('gpt-9-turbo')
    expect(text, 'the substitute is NAMED').toContain('deepseek-flash')
    expect(text).toContain('NOT the one that was configured')
  })

  it('and says the name is UNKNOWN rather than inventing one when it is not', () => {
    const text = describeSubstitution({
      requestedModel: 'gpt-9-turbo',
      reason: 'nothing advertises it',
      session: readSessionModel({}),
    })
    expect(text).toContain('SUBSTITUTION')
    expect(text).toContain('could NOT be read here')
    expect(text).toContain('will not invent a name for it')
  })

  it('⚠ a MISSING model check NAMES what runs instead — the message the runtime embeds in its routing note', () => {
    const inventory = { available: true as const, providers: [{ id: 'deepseek-official', models: ['deepseek-flash'] }], note: 'n' }
    const check = checkModelChoice(inventory, 'gpt-9-turbo', null, readSessionModel(withHeader('deepseek-official', 'deepseek-flash')))
    expect(check.verdict).toBe('missing')
    expect(check.reason).toContain('SUBSTITUTION')
    expect(check.reason).toContain('deepseek-flash')
    expect(check.reason, 'and still names what IS available, as before').toContain('deepseek-official')
  })

  it('with no reading supplied the substitution is still reported, and the gap is stated', () => {
    const inventory = { available: true as const, providers: [{ id: 'p', models: ['m'] }], note: 'n' }
    const check = checkModelChoice(inventory, 'nope')
    expect(check.verdict).toBe('missing')
    expect(check.reason).toContain('SUBSTITUTION')
    expect(check.reason).toContain('no parent Agent was handed to the check')
  })
})

