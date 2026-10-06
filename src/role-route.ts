/**
 * T9 — per-role model routing: the REVIEW role and the REPAIR role are different jobs.
 *
 * WHY. A delegation currently runs on whatever model the child inherits: the reviewer that must
 * be rigorous and the repairer that will iterate many times are the same choice by accident. The
 * item asks for them to differ.
 *
 * ⚠ WHAT I MEASURED, AND IT CHANGES WHAT THIS MODULE CAN PROMISE (15th premise correction in this
 * plan). The router policy ALREADY declares a per-role `model` (`RouterPolicy.role_routes[role]
 * .model`, and every scaffolded route sets it), but **nothing reads it**: `RouteDecision` carries
 * only `{tier, provider?, reason}`, so the field is parsed and dropped. And the plugin's
 * `SubagentStartRequestLike` has **no model field at all** — the harness addresses subagent model
 * selection through its own `subagent-model-selection` settings namespace, which is a HOST
 * concern. So the plugin cannot by itself force a child onto a model, and a module that claimed to
 * would be lying about where the choice is made.
 *
 * WHAT THE PLUGIN CAN HONESTLY DO, and what this module does: make the per-role choice EXPLICIT,
 * TESTED and VISIBLE — name the role's kind, resolve the policy's model for it, and say plainly
 * when the policy leaves it unset. That turns a dead config field into a decision a reader can
 * act on, and it gives the caller something to honour instead of a null nobody notices.
 */
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
}): SubagentTarget {
  const { role, policy } = input
  const phase = input.phase?.trim() ?? ''
  const phaseRoute = phase === '' ? undefined : policy.phase_routes?.[phase]
  const roleRoute = policy.role_routes?.[role]
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

  const where = (source: ChoiceSource): string => {
    switch (source) {
      case 'per-call': return 'this call'
      case 'phase': return 'the phase ' + phase + ' override'
      case 'role': return 'the ' + role + ' role route'
      case 'general': return 'the general subagent default'
      case 'ladder': return 'the provider ladder'
      default: return 'nothing — it is inherited'
    }
  }

  const providerText = providerChoice.value === null
    ? 'no provider was resolved'
    : providerChoice.value + ' (from ' + where(providerChoice.source) + ')'
  const modelText = modelChoice.value === null
    ? 'no model is sent, so the child inherits the session default'
    : modelChoice.value + ' (from ' + where(modelChoice.source) + ')'

  return {
    role,
    provider: providerChoice.value,
    model: modelChoice.value,
    chosen: { provider: providerChoice.source, model: modelChoice.source },
    reason: 'child for role ' + role + (phase === '' ? '' : ' in phase ' + phase) + ': provider ' + providerText
      + '; model ' + modelText + '.',
  }
}
