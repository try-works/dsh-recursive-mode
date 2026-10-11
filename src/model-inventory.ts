/**
 * ⚠ FU-19 — THE PROVIDER AND MODEL INVENTORY, RESOLVED FROM DSH ITSELF.
 *
 * The requirement, in the user's words: *"provider and model inventory should be resolved from dsh itself, we only
 * concern ourselves with what is configured inside dsh."* So this module does not keep a list, does not ship a
 * table of known models, and does not guess. It asks the host what it has.
 *
 * ## Where the truth lives (measured, not assumed)
 *
 * `packages/llm/llm/src/index.ts` does `super(ctx, 'llm')`, so the service a plugin reaches is `ctx.llm`:
 *
 *   - `ctx.llm.listProviders()`                        → the providers DSH has
 *   - `await ctx.llm.listModels(providerId)`           → that provider's models
 *   - `await ctx.llm.resolveModelInfo(providerId, id)` → model detail (reasoning efforts, defaults)
 *
 * `api/session-controller/src/catalog.ts` builds the BROWSER model catalog from exactly that trio, so a plugin
 * reading the same calls is reading what the UI shows. The service is resolved as an OPTIONAL seam, like every
 * other host service this plugin uses.
 *
 * ## ⚠ TWO DIFFERENT THINGS ARE CALLED "PROVIDER", AND CONFLATING THEM WAS A REAL DEFECT IN THIS FEATURE
 *
 *   - a **SUBAGENT provider** creates the child — `spawn`, `fork` — and comes from `ctx.subagents.list()`;
 *   - an **LLM provider** serves the model — `deepseek-official` — and comes from `ctx.llm.listProviders()`.
 *
 * A policy field called plain `provider` could mean either, and a user setting it would have no way to know which.
 * So this module deals ONLY in the second kind, and the policy names it `modelProvider` for exactly that reason.
 *
 * ## ⚠ THE THREE-STATE VERDICT, WHICH IS THE POINT OF THE WHOLE MODULE
 *
 * A checker that answers only yes/no forces a lie in one direction or the other: either an unverifiable choice is
 * reported as fine (a silent pass, which this project has fixed ten times over) or it is reported as wrong (a
 * refusal to do something the user asked for, on the strength of a service that merely was not mounted). The
 * verdict therefore has three states, and `unverified` is not a synonym for either:
 *
 *   - `available`  — the model is in the inventory; the choice is real
 *   - `missing`    — the inventory answered and does NOT have it; the caller should say so, and must NOT swap it
 *   - `unverified` — there was no inventory to ask; nothing is claimed, and nothing is replaced
 */
import type { SubagentProviderLike } from './router.ts'

/**
 * The structural view of `ctx.llm` this module needs. Structural rather than imported, like every other seam in
 * this plugin: the harness packages are peer dependencies, and a plugin that imported their types would not load
 * on a host that mounts a compatible service under its own class.
 */
export interface LlmInventoryLike {
  listProviders(): ReadonlyArray<{ id: string }>
  listModels(providerId: string): Promise<ReadonlyArray<{ id: string }>> | ReadonlyArray<{ id: string }>
}

/** One provider and the models it advertises. */
export interface InventoryProvider {
  id: string
  models: string[]
}

/** The inventory, when there was one to read. */
export interface InventoryAvailable {
  available: true
  providers: InventoryProvider[]
  /** One sentence naming what was read, for the record. */
  note: string
}

/** The inventory was not readable, and why — never an empty inventory pretending to be one. */
export interface InventoryUnavailable {
  available: false
  reason: string
}

export type ModelInventory = InventoryAvailable | InventoryUnavailable

/**
 * Read the provider/model inventory from the host.
 *
 * Never throws: a provider whose model list fails is recorded with a NAME and no models rather than dropping the
 * whole inventory, because "this provider would not answer" and "there are no providers" are different facts.
 */
export async function describeInventory(llm: LlmInventoryLike | null | undefined): Promise<ModelInventory> {
  if (llm === null || llm === undefined) {
    return {
      available: false,
      reason: 'no llm service is mounted, so the provider and model inventory could not be read from DSH',
    }
  }
  let providerIds: string[]
  try {
    providerIds = llm.listProviders().map((entry) => entry.id).filter((id) => typeof id === 'string' && id !== '')
  } catch (err) {
    return { available: false, reason: 'llm.listProviders() failed: ' + (err instanceof Error ? err.message : String(err)) }
  }

  const providers: InventoryProvider[] = []
  for (const id of providerIds) {
    try {
      const models = await llm.listModels(id)
      providers.push({ id, models: models.map((model) => model.id).filter((modelId) => typeof modelId === 'string' && modelId !== '') })
    } catch {
      // Named, kept, and empty: a provider that would not answer is not the same as a provider with no models.
      providers.push({ id, models: [] })
    }
  }
  return {
    available: true,
    providers,
    note: 'read from DSH: ' + providers.length + ' provider(s), '
      + providers.reduce((sum, provider) => sum + provider.models.length, 0) + ' model(s)',
  }
}

/** Which LLM provider advertises a model id — the lookup that makes `modelProvider` optional for the user. */
export function findModelProvider(inventory: ModelInventory, modelId: string): string | null {
  if (!inventory.available) return null
  const wanted = modelId.trim()
  if (wanted === '') return null
  for (const provider of inventory.providers) {
    if (provider.models.includes(wanted)) return provider.id
  }
  return null
}

export type ChoiceVerdict = 'available' | 'missing' | 'unverified'

export interface ChoiceCheck {
  verdict: ChoiceVerdict
  /** One sentence, always present, always saying which of the three states this is and why. */
  reason: string
}

/**
 * Check a model choice against the inventory — and say `unverified` rather than guessing when there is none.
 *
 * ⚠ IT NEVER CHANGES THE CHOICE. A caller that receives `missing` must report it; it must not quietly substitute
 * a model the inventory does have, because silently running a child on a different model than the user asked for
 * is precisely the failure this whole feature exists to prevent.
 */
export function checkModelChoice(
  inventory: ModelInventory,
  modelId: string,
  modelProvider?: string | null,
  /**
   * ⚠ FU-20 — WHAT THE CHILD RUNS ON INSTEAD, so a `missing` verdict can NAME the substitution.
   *
   * Optional because the check is also called where no parent Agent exists; when it is omitted the substitution
   * is still reported, and the report says precisely that the name was not readable at this call site rather
   * than quietly leaving the reader to assume the requested model took effect.
   */
  session?: SessionModelReading | null,
): ChoiceCheck {
  const model = modelId.trim()
  if (model === '') {
    return { verdict: 'unverified', reason: 'no model was chosen, so the child inherits the session default' }
  }
  const reading = session ?? readSessionModel(undefined)
  const substitution = (reason: string): string => describeSubstitution({
    requestedModel: model,
    reason,
    session: reading,
    requestedProvider: modelProvider ?? null,
  })
  if (!inventory.available) {
    return {
      verdict: 'unverified',
      reason: 'model ' + model + ' is UNVERIFIED: ' + inventory.reason
        + ' — it was neither accepted as available nor replaced with another',
    }
  }
  const named = typeof modelProvider === 'string' && modelProvider.trim() !== '' ? modelProvider.trim() : null
  if (named !== null) {
    const provider = inventory.providers.find((entry) => entry.id === named)
    if (provider === undefined) {
      return { verdict: 'missing', reason: substitution('model provider ' + named + ' is not one DSH has: ' + providerIdsText(inventory)) }
    }
    return provider.models.includes(model)
      ? { verdict: 'available', reason: 'model ' + model + ' is available from ' + named }
      : { verdict: 'missing', reason: substitution('provider ' + named + ' does not advertise model ' + model) }
  }
  const owner = findModelProvider(inventory, model)
  return owner === null
    ? { verdict: 'missing', reason: substitution('no provider DSH has advertises model ' + model + ': ' + providerIdsText(inventory)) }
    : { verdict: 'available', reason: 'model ' + model + ' is available from ' + owner }
}

/**
 * ⚠ FU-20 — THE SESSION'S OWN MODEL, WHICH IS THE DEFAULT A CHILD INHERITS.
 *
 * ## Why this exists at all
 *
 * The owner's directive: *"if no subagents are configured, use default session model."* That default is not a
 * number this plugin may invent — and for a long time the honest report of it was "the child inherits the session
 * default", which NAMES NOTHING. The point of this module is that everything said about a model is resolved from
 * DSH rather than guessed, so the session's model has to be READ from DSH too.
 *
 * ## Where the truth lives (measured in the harness, not assumed)
 *
 * `packages/subagent/subagent/src/child-agent.ts:69` — `parentAgentOptionsForDelegation(parent)` — is the
 * function the harness itself calls (`continuation.ts:115`) to decide what an unconfigured child runs on. It
 * reads, in this exact order:
 *
 *   1. `parent.session.requestHeader()?.config` — "the latest request header owns provider, model, and reasoning
 *      effort after request-time selection";
 *   2. `parent.options` — "creation options remain the fallback before the first request".
 *
 * This module reads the SAME two places in the SAME order, which is the only way its answer can be the answer the
 * harness will actually use. It is a structural read of the live Agent the delegation already holds for
 * attribution — no service, no new dependency, and no name guessed.
 *
 * ## ⚠ AND WHEN IT CANNOT BE READ, IT SAYS SO INSTEAD OF PICKING A NAME
 *
 * `available: false` is a real outcome with a false-able reason, not an empty reading: a caller told "the
 * effective model is unknown" can put that in the record, whereas a caller given a plausible default would put a
 * FICTION in the record. The second failure is strictly worse, and it is the one this module exists to prevent.
 */
export interface SessionModelSeamLike {
  readonly session?: {
    readonly requestHeader?: () => { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined
  }
  readonly options?: { readonly provider?: string; readonly model?: string }
}

/** Which of the harness's two sources produced the reading. `unreadable` is a finding, not an absence. */
export type SessionModelSource = 'request-header' | 'agent-options' | 'unreadable'

export interface SessionModelReading {
  /** True only when a model id was actually read. A provider alone does not make the model known. */
  available: boolean
  provider: string | null
  model: string | null
  source: SessionModelSource
  /** One sentence, always present: what was read, or precisely why nothing could be. */
  note: string
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Read the model this session runs on, the way the harness reads it for an inheriting child.
 *
 * Never throws. A parent that is absent, a copy without the live session, or a `requestHeader()` that fails each
 * produce `available: false` with the reason — because every one of those is a DIFFERENT fact about why the name
 * is unknown, and a caller recording "the model was unknown" deserves to know which.
 */
export function readSessionModel(parent: SessionModelSeamLike | null | undefined): SessionModelReading {
  if (parent === null || parent === undefined) {
    return {
      available: false,
      provider: null,
      model: null,
      source: 'unreadable',
      note: 'no parent Agent was handed to the check, so this session\'s own model could not be read',
    }
  }

  // 1. The request header — the harness's FIRST choice, and the one that wins after request-time selection.
  let requestConfig: { readonly provider?: string; readonly model?: string } | undefined
  let headerError: string | null = null
  if (typeof parent.session?.requestHeader === 'function') {
    try {
      requestConfig = parent.session.requestHeader()?.config
    } catch (err) {
      headerError = err instanceof Error ? err.message : String(err)
    }
  }
  const headerModel = text(requestConfig?.model)
  if (headerModel !== null) {
    return {
      available: true,
      provider: text(requestConfig?.provider),
      model: headerModel,
      source: 'request-header',
      note: 'read from the parent session\'s request header config (the source the harness uses first)',
    }
  }

  // 2. Creation options — the harness's fallback before the session's first request.
  const optionModel = text(parent.options?.model)
  if (optionModel !== null) {
    return {
      available: true,
      provider: text(parent.options?.provider),
      model: optionModel,
      source: 'agent-options',
      note: 'read from the parent Agent\'s creation options (the harness\'s fallback before the first request)',
    }
  }

  const why = headerError !== null
    ? 'the parent session\'s requestHeader() threw: ' + headerError
    : typeof parent.session?.requestHeader === 'function'
      ? 'neither the parent session\'s request header nor its creation options named a model'
      : 'the parent handle carries no session.requestHeader(), so only its creation options could be read, and they named no model'
  return {
    available: false,
    provider: text(parent.options?.provider),
    model: null,
    source: 'unreadable',
    note: why,
  }
}

/** `provider/model`, or the honest phrase for whichever half is missing. */
export function describeSessionModel(reading: SessionModelReading): string {
  if (reading.available) {
    const provider = reading.provider ?? '(provider not named)'
    return provider + '/' + (reading.model as string) + ' — ' + reading.note
  }
  return 'UNKNOWN — ' + reading.note
}

/**
 * ⚠ FU-20 — WHAT THE READER IS TOLD WHEN THE CHOSEN MODEL IS NOT THE MODEL THAT RUNS.
 *
 * THE DEFECT THIS REPLACES, in the owner's words: a delegated review "silently degraded into the authoring agent
 * reviewing its own work", and the log read as a POLICY NOTE rather than as a loss of independence. The same
 * failure applies one level down: a configured model that DSH does not have is not applied, and a report saying
 * only "the model was not applied" leaves the reader unable to tell WHICH model the child actually ran on.
 *
 * So this function answers exactly three things, in this order, and never guesses a name it does not have:
 *   1. what was asked for;
 *   2. why it was not applied;
 *   3. what runs instead — NAMED when the session's model could be read, and explicitly UNKNOWN when it could not.
 */
export function describeSubstitution(input: {
  requestedModel: string
  reason: string
  session: SessionModelReading
  requestedProvider?: string | null
}): string {
  const asked = input.requestedProvider === undefined || input.requestedProvider === null || input.requestedProvider === ''
    ? input.requestedModel
    : input.requestedProvider + '/' + input.requestedModel
  const instead = input.session.available
    ? 'the child runs instead on ' + describeSessionModel(input.session)
    : 'the child runs instead on whatever this session inherits, whose name could NOT be read here (' + input.session.note + ')'
  return 'SUBSTITUTION: ' + asked + ' was NOT applied — ' + input.reason + ', so ' + instead
    + '; the model this child actually uses is NOT the one that was configured'
    + (input.session.available ? '' : ', and this plugin will not invent a name for it')
}

/** The provider ids, for a message that tells the caller what IS available instead of only what is not. */
export function providerIdsText(inventory: ModelInventory): string {
  if (!inventory.available) return '(inventory unavailable)'
  if (inventory.providers.length === 0) return '(no providers)'
  return inventory.providers.map((provider) => provider.id).join(', ')
}

/**
 * Which subagent providers the host actually offers — the OTHER kind of provider, kept adjacent on purpose so the
 * two are never confused in a message.
 */
export function subagentProviderNames(seam: { list?: () => unknown } | null | undefined): string[] {
  if (seam === null || seam === undefined || typeof seam.list !== 'function') return []
  try {
    const listed = seam.list()
    return Array.isArray(listed) ? listed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/** The declared capabilities of a subagent provider, or null when it is not registered. */
export function capabilitiesOf(
  providers: Record<string, SubagentProviderLike>,
  name: string,
): SubagentProviderLike['capabilities'] | null {
  return providers[name]?.capabilities ?? null
}
