/**
 * T9 → FU-19 — per-role model routing, and now a full provider/model ladder.
 *
 * WHY. A delegation would otherwise run on whatever model the child inherits: the reviewer that must be rigorous
 * and the repairer that will iterate many times become the same choice by accident. The item asks for them to
 * differ — and FU-19 extends that to a general default, per-phase overrides, and a per-call choice.
 *
 * ⚠ THE PARAGRAPH THAT USED TO BE HERE WAS TRUE WHEN WRITTEN AND IS NOW FALSE, so it is replaced rather than
 * left to mislead. It said the plugin "cannot by itself force a child onto a model", because
 * `SubagentStartRequestLike` had no model field and model selection was the host's concern. Both halves changed:
 * the harness accepts `agentOptions` on a start, and `delegateReview` now sets `request.agentOptions = { model }`
 * — but ONLY for a provider that declares the `agentOptions` capability, because the harness REJECTS such a start
 * otherwise.
 *
 * SO WHAT THIS MODULE PROMISES TODAY, precisely:
 *   - it resolves WHICH provider and model a child should get, from the ladder in `resolveSubagentTarget`, and it
 *     reports which level chose each value;
 *   - the caller (not this module) applies them, because applying is a decision with consequences — a model on a
 *     provider that cannot take overrides is NOT applied and is REPORTED rather than silently dropped;
 *   - and the model is checked against what DSH actually has (`model-inventory.ts`), with an `unverified` verdict
 *     when there is no inventory to ask, so a choice is never silently approved OR silently replaced.
 *
 * A module that claimed more than that would be lying about where the choice is made. The comment above is the
 * second half of that lesson: a stale rationale is how a working feature gets deleted by accident.
 */
import type { SessionModelReading } from './model-inventory.ts'
import type { RouterPolicy } from './router.ts'

/** What kind of work a role does — the distinction the item is about. */
export type RoleKind = 'review' | 'repair' | 'unknown'

/**
 * The roles this plugin scaffolds, classified by the JOB rather than by seniority.
 *
 * Review work wants rigour and reads carefully once; repair work wants many cheap iterations.
 * An unrecognised role is `unknown` rather than silently assumed to be a reviewer: assuming
 * would put an unreviewed role on the expensive path (or a reviewer on the cheap one) with no
 * signal anywhere, which is the sort of quiet mismatch this item exists to remove.
 */
const REVIEW_ROLES: readonly string[] = ['code-reviewer', 'memory-auditor', 'auditor', 'reviewer']
const REPAIR_ROLES: readonly string[] = ['implementer', 'repairer', 'fixer']

export function roleKindOf(role: string): RoleKind {
  const normalised = role.trim().toLowerCase()
  if (REVIEW_ROLES.includes(normalised)) return 'review'
  if (REPAIR_ROLES.includes(normalised)) return 'repair'
  return 'unknown'
}

/** One role's resolved route: what kind of work it is, and which model the policy names. */
export interface RoleRoute {
  role: string
  kind: RoleKind
  /** The policy's model for this role, or null when it names none. */
  model: string | null
  /** Where the model came from — `unset` is a fact worth carrying, not an absence. */
  source: 'policy' | 'unset'
  /** One self-sufficient sentence, including the unknown-role case. */
  reason: string
}

/**
 * Resolve a role's route from the policy.
 *
 * Never throws and never invents a model: an unknown role, an unconfigured role and a role whose
 * policy entry names no model each produce a route with a reason that says which it is. A caller
 * that wants to refuse an unknown role can; a caller that wants to proceed knows exactly what it
 * is proceeding with.
 */
export function routeForRole(role: string, policy: RouterPolicy): RoleRoute {
  const kind = roleKindOf(role)
  const configured = policy.role_routes?.[role]
  const model = typeof configured?.model === 'string' && configured.model.trim() !== '' ? configured.model : null
  const source: RoleRoute['source'] = model === null ? 'unset' : 'policy'

  if (kind === 'unknown') {
    return {
      role,
      kind,
      model,
      source,
      reason: 'role ' + role + ' is not a role this plugin classifies, so no review/repair expectation is asserted for it'
        + (model === null ? ' and the policy names no model.' : ' (the policy does name model ' + model + ').'),
    }
  }
  if (model === null) {
    return {
      role,
      kind,
      model,
      source,
      reason: kind + ' role ' + role + ' has no model in the policy, so it inherits the child default'
        + ' — the review/repair split is NOT in effect for it.',
    }
  }
  return {
    role,
    kind,
    model,
    source,
    reason: kind + ' role ' + role + ' resolves to model ' + model + ' from the policy.',
  }
}

/**
 * The model the caller should use for a role, or null to inherit.
 *
 * A one-line convenience for a caller that only needs the value; {@link routeForRole} is what a
 * caller should use when it wants to SAY why.
 */
export function modelForRole(role: string, policy: RouterPolicy): string | null {
  return routeForRole(role, policy).model
}

/**
 * ⚠ FU-19 — WHICH PROVIDER AND MODEL A DELEGATED CHILD WOULD ACTUALLY GET, AND WHO CHOSE EACH.
 *
 * ## The words, because they were doing too much work
 *
 * "Provider" is the thing that CREATES a child. In this harness it is resolved by a tier ladder, and the tiers
 * have names that are not self-explanatory:
 *
 *   - **native** — a provider the harness runs ITSELF, in-process. It is what `ctx.subagents` serves; in the
 *     session I measured it advertised exactly two: `spawn` and `fork`. "Native" means "the harness's own",
 *     as opposed to something it shells out to.
 *   - **external-cli** — a registered provider that drives a SEPARATE installed program (Codex, Claude Code and
 *     friends). A child still exists, but the work happens in another process the user installed.
 *   - **self-audit** — no child is created at all: the main agent reviews its own work. This is the honest
 *     fallback, and it is NAMED rather than hidden.
 *   - **local-controller** — the host's own controller. I have not measured this tier's behaviour in a live
 *     session, so I will not describe it further here.
 *
 * ## Why "a provider but no model" — the part my earlier wording got wrong
 *
 * A MODEL CAN BE LEFT UNSET ON PURPOSE, AND THAT IS NOT THE SAME AS "NO MODEL". Absent means **inherited**: the
 * plugin sends no `agentOptions.model` at all, and the child runs on whatever the session/provider default is.
 * That is the measured behaviour — `delegation.ts` forwards `agentOptions` only when the caller supplies them,
 * and `modelForRole` returns null precisely to mean "inherit".
 *
 * So the floor of the ladder is not a gap. A child cannot exist without a provider, so a provider is always
 * resolved (by the ladder, or by the user); a model is only sent when someone actually chose one, because
 * inventing one would silently override the session's own setting — and overriding a user's session default
 * without being asked is worse than inheriting it.
 *
 * ## The precedence, and the labels it reports
 *
 *   per-call override  →  phase route  →  role route  →  general default  →  inherit
 *
 * Every value carries the label of the level that produced it, so "why did this child run on that model?" is
 * answerable from the decision alone rather than by reading this function.
 */
export interface SubagentTarget {
  role: string
  /** The provider that would create the child, or null when nothing resolved one. */
  provider: string | null
  /** The model to ask for, or null meaning INHERIT — do not send `agentOptions.model` at all. */
  model: string | null
  /** Plain-language provenance for each value: which level chose it. */
  chosen: { provider: string; model: string }
  /** One sentence a reader can act on. */
  reason: string
  /**
   * ⚠ FU-20 — WHICH LLM PROVIDER SERVES `model`, when a level named one. The policy has always been able to
   * carry `modelProvider`, and nothing read it: the model travelled and the provider that serves it did not, so
   * a model available from two providers could not be disambiguated and an inventory check could not be told
   * which provider to look in. Carried here, with the same per-value provenance as everything else.
   */
  modelProvider: string | null
  /** FU-20: which level chose `modelProvider`, or `inherit` when no level named one. */
  chosenModelProvider: ChoiceSource
  /**
   * ⚠ FU-20 — WHAT THE CHILD WILL ACTUALLY RUN ON, said in one place.
   *
   * `model: null` means INHERIT, and inheritance is not an absence — the harness copies the parent session's
   * model onto an unconfigured child (`child-agent.ts:99`). So the honest report of the inherit case NAMES that
   * model when the session's own model could be read, and says the name is unknown when it could not. What it
   * must never do is leave the reader to assume a different model was chosen, which is what "inherits the
   * session default" alone invited.
   */
  effectiveModel: string
  /** FU-20: the session-model reading this target was resolved against, when one was supplied. */
  sessionModel: SessionModelReading | null
}

/** Which level produced a value. `inherit` is a decision, not an absence. */
export type ChoiceSource = 'per-call' | 'phase' | 'role' | 'general' | 'ladder' | 'inherit'

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function resolveSubagentTarget(input: {
  role: string
  /** The phase the delegation is for, when it is known — the narrowest configured level. */
  phase?: string
  policy: RouterPolicy
  /** A per-call override from the tool: wins over every configured level. */
  override?: { provider?: string | null; model?: string | null }
  /** What the tier ladder resolved. Used when no level named a provider, and labelled as the ladder's. */
  ladderProvider?: string | null
  /**
   * FU-20: this session's own model, when the caller could read it. Used ONLY to NAME what an inheriting child
   * runs on — never to override a configured choice, because a session default must not silently outrank a
   * setting the user made.
   */
  sessionModel?: SessionModelReading | null
}): SubagentTarget {
  const { role, policy } = input
  const phase = input.phase?.trim() ?? ''
  const phaseRoute = phase === '' ? undefined : policy.phase_routes?.[phase]
  /**
   * ⚠ FU-20 — A PHASE ROUTE MAY NAME A DIFFERENT ROLE, AND UNTIL NOW NOTHING READ THAT FIELD.
   *
   * `router.ts` documents `phase_routes` as e.g. `{ '08': { role: 'memory-auditor' } }`, the schema test writes
   * exactly that, and the resolver looked only at the phase's provider and model — so a user could name the
   * auditor for a phase and silently get the original role's configuration instead. The field is now LIVE, and
   * the fallback is deliberate: a phase that names a role with no route of its own still gets the requested
   * role's route rather than dropping to nothing.
   */
  const phaseRole = nonEmpty(phaseRoute?.role)
  const roleRoute = (phaseRole === null ? undefined : policy.role_routes?.[phaseRole]) ?? policy.role_routes?.[role]
  const effectiveRole = phaseRole ?? role
  const general = policy.defaults.subagent

  const pick = (value: string | null | undefined, source: ChoiceSource): { value: string | null; source: ChoiceSource } =>
    ({ value: nonEmpty(value), source })

  const providerChoice = [
    pick(input.override?.provider, 'per-call'),
    pick(phaseRoute?.provider, 'phase'),
    pick(roleRoute?.provider, 'role'),
    pick(general?.provider, 'general'),
    pick(input.ladderProvider, 'ladder'),
  ].find((candidate) => candidate.value !== null) ?? { value: null, source: 'inherit' as ChoiceSource }

  const modelChoice = [
    pick(input.override?.model, 'per-call'),
    pick(phaseRoute?.model, 'phase'),
    pick(roleRoute?.model, 'role'),
    pick(general?.model, 'general'),
  ].find((candidate) => candidate.value !== null) ?? { value: null, source: 'inherit' as ChoiceSource }

  // ⚠ The provider that SERVES the model, resolved with its own provenance rather than copied from the model's:
  // a level may name a model and leave the serving provider to a broader level, which is the same per-value
  // tolerance the two ladders above already have. There is deliberately NO per-call entry: the per-call override
  // shape carries a provider (who creates the child) and a model, and inventing a per-call LLM provider from
  // either of those would be exactly the two-kinds-of-provider confusion this module's header warns about.
  const modelProviderChoice = [
    pick(phaseRoute?.modelProvider, 'phase'),
    pick(roleRoute?.modelProvider, 'role'),
    pick(general?.modelProvider, 'general'),
  ].find((candidate) => candidate.value !== null) ?? { value: null, source: 'inherit' as ChoiceSource }

  const where = (source: ChoiceSource): string => {
    switch (source) {
      case 'per-call': return 'this call'
      case 'phase': return 'the phase ' + phase + ' override'
      case 'role': return 'the ' + effectiveRole + ' role route'
      case 'general': return 'the general subagent default'
      case 'ladder': return 'the provider ladder'
      default: return 'nothing — it is inherited'
    }
  }

  const providerText = providerChoice.value === null
    ? 'no provider was resolved'
    : providerChoice.value + ' (from ' + where(providerChoice.source) + ')'
  const session = input.sessionModel ?? null
  const modelText = modelChoice.value === null
    ? 'no model is sent, so the child inherits the session default'
      + (session !== null && session.available
        ? ' — which is ' + session.provider + '/' + session.model + ' (' + session.note + ')'
        : ' — whose name could not be read here ('
          + (session === null ? 'no session-model reading was supplied' : session.note)
          + '), so the plugin reports it as UNKNOWN rather than naming a model it did not read')
    : modelChoice.value + ' (from ' + where(modelChoice.source) + ')'
      + (modelProviderChoice.value === null || modelChoice.source === 'per-call'
        ? ''
        : ', served by ' + modelProviderChoice.value + ' (from ' + where(modelProviderChoice.source) + ')')

  return {
    role: effectiveRole,
    provider: providerChoice.value,
    model: modelChoice.value,
    chosen: { provider: providerChoice.source, model: modelChoice.source },
    modelProvider: modelProviderChoice.value,
    chosenModelProvider: modelProviderChoice.source,
    effectiveModel: modelChoice.value === null
      ? (session !== null && session.available ? session.provider + '/' + session.model : 'UNKNOWN (the session default, unreadable here)')
      : modelChoice.value,
    sessionModel: session,
    reason: 'child for role ' + effectiveRole + (phase === '' ? '' : ' in phase ' + phase) + ': provider ' + providerText
      + '; model ' + modelText + '.',
  }
}
