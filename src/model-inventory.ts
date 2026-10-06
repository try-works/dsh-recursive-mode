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
): ChoiceCheck {
  const model = modelId.trim()
  if (model === '') {
    return { verdict: 'unverified', reason: 'no model was chosen, so the child inherits the session default' }
  }
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
      return { verdict: 'missing', reason: 'model provider ' + named + ' is not one DSH has: ' + providerIdsText(inventory) }
    }
    return provider.models.includes(model)
      ? { verdict: 'available', reason: 'model ' + model + ' is available from ' + named }
      : { verdict: 'missing', reason: 'provider ' + named + ' does not advertise model ' + model }
  }
  const owner = findModelProvider(inventory, model)
  return owner === null
    ? { verdict: 'missing', reason: 'no provider DSH has advertises model ' + model + ': ' + providerIdsText(inventory) }
    : { verdict: 'available', reason: 'model ' + model + ' is available from ' + owner }
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
