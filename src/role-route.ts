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
