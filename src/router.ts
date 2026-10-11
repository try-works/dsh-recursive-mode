/**
 * Native router resolution (Phase B R3, PROPOSAL 10.4/10.10): resolves the
 * canonical recursive-router.json policy to a NATIVE DSH subagent provider,
 * keeping the policy file as declarative config and dropping the external-CLI
 * wrappers.
 *
 * ⚠ FU-20 — THE ORDER CHANGED, AND THE HEADER THAT DESCRIBED THE OLD ONE IS REPLACED RATHER THAN LEFT TO MISLEAD.
 * It read "native provider -> external-CLI route (codex/claude) -> self-audit / local-controller fallback", which
 * described a ladder where a CLI could not be chosen on any host that had `spawn` — and where a route naming a
 * CLI that was not installed ended in a self-audit whose prose read as a policy note. That is the exact path a
 * live run took when a delegated review became the authoring agent's own review. The order is now:
 *
 *   1. an EXPLICIT CLI route (a real `cli` name on the route) — honoured because it was asked for by name;
 *   2. the MODEL route — a native provider creating a child that runs on a DSH model, which is the default
 *      posture: the model configured per phase, per role, or generally, and otherwise the SESSION's own model;
 *   3. the floor — `local-controller` or a self-audit, both of which now say so in words a reader cannot mistake
 *      for a routing preference.
 *
 * Workspace-scoped + optionality-preserving: a missing provider, a missing
 * policy, or a failed probe resolves to a LOUD self-audit, never throws and never
 * scans another workspace.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// T9: the per-role model lookup, so there is ONE definition of "which model does this role use".
// ⚠ FU-20: the lookup is now the full LADDER (`resolveSubagentTarget`: per-call → phase → role → general →
// session default), so the decision reports the model that will actually be applied rather than the role
// level's value in isolation. `role-route.ts` imports only `RouterPolicy` as a TYPE from here, which erases at
// runtime — so this is a one-way runtime dependency, not the cycle that bit `policy-globs` earlier.
import { resolveSubagentTarget } from './role-route.ts'
// FU-20: type-only, so this does not make `model-inventory.ts` a runtime dependency of the router.
import type { SessionModelReading } from './model-inventory.ts'

/**
 * ⚠ FU-19 — WHAT A CHILD RUNS ON, WHEN THE USER SAYS SO AND NOTHING MORE SPECIFIC DOES.
 *
 * Optional on purpose, and the reason is the same one the override layer gives below: an absent field must mean
 * "defer to the next level in the precedence", never "reset to nothing". A default here would make every field
 * present and silently shadow the role routes and phase routes forever.
 */
export interface SubagentDefault {
  /** The SUBAGENT provider — who creates the child (`spawn`, `fork`). NOT the LLM provider; see below. */
  provider?: string | null
  /** The model id to ask for. */
  model?: string | null
  /**
   * ⚠ THE LLM PROVIDER — WHO SERVES THE MODEL (`deepseek-official`), which is a DIFFERENT thing from the
   * `provider` field above. Conflating the two was a real defect in this feature's first schema: a plain
   * `provider` could mean either, and a user setting it had no way to know which.
   *
   * Optional: when only a model is named, the plugin looks its provider up from the inventory DSH exposes.
   */
  modelProvider?: string | null
}

/** Per-phase overrides — the narrowest level, and the one that answers "this phase needs a stronger model". */
export interface PhaseRoute {
  role?: string
  /** The subagent provider, as above. */
  provider?: string | null
  model?: string | null
  /** The LLM provider serving `model`, as above. */
  modelProvider?: string | null
}

export interface RouterDefaults {
  when_role_unconfigured: string
  when_cli_unavailable: string
  when_model_unknown: string
  allow_auto_assign_if_single_cli: boolean
  probe_timeout_ms: number
  invoke_timeout_ms: number
  /** FU-19: the general provider/model for delegated subagents, absent when the user has not chosen one. */
  subagent?: SubagentDefault
}

export interface RoleRoute {
  enabled: boolean
  mode: string
  cli: string | null
  model: string | null
  /**
   * FU-19: the provider this role should be served by, when the user has chosen one. Absent means "let the tier
   * ladder decide", which is what every policy scaffolded before this field did.
   *
   * This is the SUBAGENT provider — who creates the child. The LLM provider that serves the model is its own
   * field below, because one name for two ideas is how a configuration becomes a guess.
   */
  provider?: string | null
  /** FU-19: the LLM provider serving this role's `model`. Optional; looked up from the inventory when omitted. */
  modelProvider?: string | null
  fallback: string
}

export interface RouterPolicy {
  version: number
  defaults: RouterDefaults
  role_routes: Record<string, RoleRoute>
  /** FU-19: phase-keyed overrides, e.g. `{ '08': { role: 'memory-auditor' } }`. Absent means none. */
  phase_routes?: Record<string, PhaseRoute>
  cli_overrides: Record<string, unknown>
  custom_clis: unknown[]
}

export type RouteTier = 'native' | 'external-cli' | 'self-audit' | 'local-controller'

/**
 * ⚠ FU-20 — THE POSTURE, WHICH IS A DIFFERENT AXIS FROM THE TIER.
 *
 * The tier says WHO creates the child (a harness provider, an installed CLI program, or nobody at all). The
 * posture says WHAT THAT CHILD RUNS ON — and the owner's directive is exactly a statement about this axis:
 *
 *   *"subagents should not use cli, they should use models configured in dsh."*
 *
 *   - `model` — the child is created by a harness-native provider and runs on a DSH model: the one configured for
 *     its role/phase, or the session's own when nothing is configured. THIS IS THE DEFAULT POSTURE.
 *   - `cli`   — the child is created by an external-CLI provider. Kept, reachable, and never chosen by default:
 *     it takes an explicit `cli` on the route.
 *   - `none`  — no child is created; the authoring agent does the work itself.
 */
export type RoutePosture = 'model' | 'cli' | 'none'

/**
 * ⚠ FU-20 — HOW INDEPENDENT THE DELEGATED WORK ACTUALLY IS, ON EVIDENCE RATHER THAN ON INTENTION.
 *
 * The defect that prompted this directive was a review that reported itself as delegated while the authoring
 * agent reviewed its own work. A boolean `independent` could not have prevented it, because the interesting
 * failures are not binary: a child on the SAME model as its author is a genuinely separate agent with its own
 * context — which is worth having — but it is not a second opinion from a different model, and a record that
 * says "independent" without qualification would overstate it.
 *
 *   - `independent`      — a separate child, on a model that DIFFERS from this session's. Evidenced: the session's
 *     model was read and the two differ.
 *   - `same-model`       — a separate child, on the SAME model as this session. Either the child inherits (which
 *     the harness makes provable — see `independenceOf`) or the configured model equals the one that was read.
 *   - `unverified-model` — a separate child, and whether its model differs could NOT be read. Named rather than
 *     guessed: a caller that wants to claim a second opinion has to supply a session-model reading to get it.
 *   - `self-audit`       — no child. The authoring agent reviews its own work.
 *   - `refused`          — the policy says to ASK rather than to substitute, so nothing was silently chosen.
 */
export type RouteIndependence = 'independent' | 'same-model' | 'unverified-model' | 'self-audit' | 'refused'

export interface RouteDecision {
  tier: RouteTier
  provider?: string
  reason: string
  /**
   * T9: the model the policy names for this role, or null when it names none.
   *
   * Present on EVERY decision because it is attached by the wrapper, never per-return-site.
   *
   * ⚠ THIS COMMENT USED TO SAY THE PLUGIN DOES NOT APPLY IT. That was true when it was written and is false now:
   * `delegateReview` sets `request.agentOptions = { model }` when the provider declares the `agentOptions`
   * capability, and reports a routing note when it does not. So this is still a value a caller can HONOUR, but
   * the plugin now does the honouring — and says so when it cannot.
   *
   * ⚠ FU-20 — AND SINCE FU-20 IT IS THE RESOLVED LADDER VALUE, not only the role level's: a phase route or a
   * per-call override is reflected here, with `chosen.model` naming the level that produced it. Reporting the
   * role's value while the phase's value was the one applied was the same class of defect as the one this
   * directive is about: a record that describes less than the code knows.
   */
  model?: string | null
  /**
   * FU-19: where the provider and model came from, one short label per value, so "why did this child run on
   * that model" is answerable without reading the resolution code.
   */
  chosen?: { provider?: string; model?: string }
  /** FU-20: what the delegated work runs on — see {@link RoutePosture}. */
  posture: RoutePosture
  /** FU-20: how independent it is, on evidence — see {@link RouteIndependence}. */
  independence: RouteIndependence
  /** FU-20: the sentence that goes with `independence`, for a record a human reads. */
  independenceNote: string
  /**
   * FU-20: the declared `when_model_unknown` posture, surfaced so the caller performing the inventory check can
   * honour it. The CHECK itself lives in `model-inventory.ts` (`checkModelChoice`), which never substitutes.
   */
  whenModelUnknown: string
  /**
   * FU-20: true when the policy said to ASK and nothing was substituted. This is the flag that distinguishes
   * "the router decided a self-audit is what happens" from "the router refused to decide for you" — two states
   * that previously produced the same tier and, worse, prose that read like the first one either way.
   */
  refused?: boolean
}

export interface SubagentProviderLike {
  name: string
  capabilities?: {
    outputSchema?: boolean
    depthLimit?: boolean
    toolFilter?: boolean
    persona?: boolean
    /**
     * T9: whether this provider accepts `agentOptions` (provider/model/reasoning-effort
     * overrides). The harness REJECTS a start that sends them to a provider without this
     * capability, so the caller must ASK rather than assume — see `delegateReview`.
     */
    agentOptions?: boolean
  }
}

export interface CapabilityProbe {
  available: boolean
  provider?: string
  capabilities?: {
    outputSchema: boolean
    depthLimit: boolean
    toolFilter: boolean
    persona: boolean
  }
  reason: string
}

const DEFAULT_POLICY: RouterPolicy = {
  version: 1,
  defaults: {
    when_role_unconfigured: 'ask',
    when_cli_unavailable: 'fallback-local',
    when_model_unknown: 'ask',
    allow_auto_assign_if_single_cli: false,
    probe_timeout_ms: 50000,
    invoke_timeout_ms: 180000,
  },
  role_routes: {},
  cli_overrides: {},
  custom_clis: [],
}

/**
 * T7 — the settings OVERRIDE layer over the declarative file.
 *
 * ONE PATH, NOT TWO (the item's own interaction note): `recursive-router.json` remains the
 * declarative source, and the settings namespace can OVERRIDE individual fields without
 * restating the file. That is why every field here is optional and why the schema declares
 * NO defaults for them: an absent field means "defer to the file", and a default would make
 * every field present and silently shadow the file forever.
 *
 * ⚠ FU-20 — `roles` AND `phases` ARE THE SETTINGS PATH FOR THE OWNER'S "configure a subagent per phase or role".
 *
 * They arrive here without a line changing in `src/index.ts`, which is the whole reason for the shape: that file
 * already forwards the plugin's ENTIRE `router` config section to `setRouterOverrides` (`index.ts:362`), so a
 * field DECLARED on the Config schema reaches this function by construction. `src/index.ts` is owned by another
 * agent and is not edited by this change; the schema in `config.ts` is the seam, and it is sufficient.
 *
 * Merge semantics are PER FIELD and one level deep, matching `defaults`: an override that names only a model
 * leaves the file's provider for that role intact, and an override that names nothing leaves the whole entry
 * alone. Anything coarser would make a one-field settings edit silently erase the rest of a route.
 */
export interface RouterPolicyOverrides {
  defaults?: Partial<RouterPolicy['defaults']>
  /**
   * FU-20: the GENERAL subagent route from the settings namespace. It lands on the file's `defaults.subagent`,
   * because that is the same level of the ladder — but it is a sibling of `defaults` in the SETTINGS namespace
   * rather than a key inside it, and the reason is a pinned property rather than taste: an unedited
   * `router.defaults` must carry NO present field at all, or the namespace would shadow the workspace file. A
   * nested object schema always materializes as `{}`, which is a present field; a sibling is left alone by that
   * assertion and the empty object is dropped here by `isBlank`.
   */
  subagent?: Partial<SubagentDefault>
  /** FU-20: per-role provider/model/modelProvider, e.g. `{ 'code-reviewer': { model: 'deepseek-pro' } }`. */
  roles?: Record<string, Partial<RoleRoute>>
  /** FU-20: per-phase overrides, e.g. `{ '3.5': { role: 'memory-auditor', model: 'deepseek-pro' } }`. */
  phases?: Record<string, Partial<PhaseRoute>>
}

/** Drop keys explicitly set to `undefined`, so "unset" cannot erase a file's value. */
function compact<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {}
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isBlank(entry)) out[key] = entry
  }
  return out as Partial<T>
}

/**
 * ⚠ FU-20 — "NOT SET" IS NOT THE SAME AS "SET TO NOTHING", AND AN EMPTY OBJECT IS THE FORMER.
 *
 * A settings form projects an untouched `z.object`/`z.dict` field as `{}`, not as `undefined`. Taken literally
 * that is a VALUE, and merging it would OVERWRITE the workspace file's entry with an empty object — the exact
 * silent shadowing this overlay layer exists to prevent, and one `settings-config.spec.ts` pins by name
 * ("declares NO defaults, so an unedited namespace cannot shadow the workspace file"). It caught this change
 * doing it. Only an empty PLAIN object is blank: `false` and `0` are real values and are kept.
 */
function isBlank(value: unknown): boolean {
  if (value === undefined) return true
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0
}

/**
 * FU-20 — merge one level of per-key overrides onto the file's entries.
 *
 * An entry whose override compacts to NOTHING is dropped rather than written as `{}`: an empty entry would
 * claim the user configured something, and the distinction between "absent" and "empty" is one this file's
 * callers already rely on (`provider-model-policy.spec.ts` pins it for `defaults.subagent` and `phase_routes`).
 */
function mergeEntries<T extends object>(
  base: Record<string, T> | undefined,
  overrides: Record<string, Partial<T>> | undefined,
): Record<string, T> | undefined {
  const applied = overrides === undefined ? [] : Object.entries(overrides)
    .map(([key, value]) => [key, compact(value)] as const)
    .filter(([, value]) => Object.keys(value).length > 0)
  if (applied.length === 0) return base
  const out: Record<string, T> = { ...(base ?? {}) }
  for (const [key, value] of applied) {
    out[key] = { ...(out[key] ?? ({} as T)), ...value }
  }
  return out
}

/** Parse recursive-router.json. A missing/invalid file yields a default self-audit policy (never throws). */
export function loadRouterPolicy(path?: string, overrides?: RouterPolicyOverrides): RouterPolicy {
  const base = readRouterPolicy(path)
  const applied = compact(overrides?.defaults) as Record<string, unknown>
  // FU-20: the general subagent route, merged PER FIELD from either spelling (a caller may set it on
  // `defaults.subagent`, as the policy FILE does, or on `subagent`, as the settings namespace does).
  const subagent = compact({
    ...(typeof applied.subagent === 'object' && applied.subagent !== null ? applied.subagent : {}),
    ...compact(overrides?.subagent),
  })
  if (Object.keys(subagent).length > 0) applied.subagent = subagent
  else delete applied.subagent
  const roles = mergeEntries(base.role_routes, overrides?.roles)
  const phases = mergeEntries(base.phase_routes, overrides?.phases)
  const defaults = Object.keys(applied).length === 0 ? base.defaults : { ...base.defaults, ...applied }
  if (defaults === base.defaults && roles === base.role_routes && phases === base.phase_routes) return base
  return {
    ...base,
    defaults,
    role_routes: roles ?? {},
    // Kept ABSENT when the file had none and no override supplies one — see `mergeEntries`.
    ...(phases === undefined ? {} : { phase_routes: phases }),
  }
}

/** The file (or the built-in default) — the declarative source the overrides sit on top of. */
function readRouterPolicy(path?: string): RouterPolicy {
  if (!path || !existsSync(path)) return DEFAULT_POLICY
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RouterPolicy>
    return {
      version: typeof raw.version === 'number' ? raw.version : 1,
      // The spread carries `subagent` through when the file declares it and leaves it absent when it does not —
      // which is exactly the tolerance FU-19 needs, with no extra code.
      defaults: { ...DEFAULT_POLICY.defaults, ...(raw.defaults ?? {}) },
      role_routes: raw.role_routes ?? {},
      // Phase overrides are carried only when the file has them: an empty object would claim the user configured
      // something, and absence is a fact worth keeping distinct from emptiness.
      ...(raw.phase_routes === undefined ? {} : { phase_routes: raw.phase_routes }),
      cli_overrides: raw.cli_overrides ?? {},
      custom_clis: raw.custom_clis ?? [],
    }
  } catch {
    return DEFAULT_POLICY
  }
}

/** Default router policy path inside a workspace root. */
export function routerPolicyPath(root: string): string {
  return join(root, '.recursive', 'config', 'recursive-router.json')
}

/**
 * T9 — attach the role's model to the decision. ⚠ FU-20 — and now the resolved LADDER's model, plus the two
 * things a reader needs to judge the result: what the delegated work runs on, and how independent it is.
 *
 * ⚠ WHY A WRAPPER AND NOT SIX EDITS. `resolveRoleInner` has six return sites, and adding the
 * model to each would leave a decision shape that carries it on some paths and not others — a
 * trap for the next reader, and exactly the kind of quiet inconsistency this plan keeps
 * refusing to ship. Attaching it ONCE, at the seam where the decision leaves, makes the field
 * present on EVERY path by construction. The policy lookup itself lives in `role-route.ts`
 * (`resolveSubagentTarget`, formerly `modelForRole`), so there is one definition of "which model
 * does this role use", not two.
 *
 * ⚠ FU-20 — WHY THE INDEPENDENCE VERDICT IS COMPUTED HERE AND NOT AT THE RETURN SITES. It depends on the
 * LADDER's answer (is a model named at all?) as well as on the tier's (is a child created at all?), and those
 * are resolved on either side of the call. Composing them in one place is what makes "independent", "same model",
 * "self-audit" and "refused" exhaustive and mutually exclusive rather than emergent from six ifs.
 */
export function resolveRole(
  role: string,
  policy: RouterPolicy,
  providers: Record<string, SubagentProviderLike>,
  /**
   * FU-20 — the context that makes the answer complete rather than merely correct: the phase (the narrowest
   * configured level) and, when the caller has it, a reading of the session's own model. Absent is fine and is
   * reported as such — no caller is required to know something it cannot see.
   */
  context?: {
    phase?: string
    override?: { provider?: string | null; model?: string | null }
    session?: SessionModelReading | null
  },
): RouteDecision {
  const inner = resolveRoleInner(role, policy, providers)
  const session = context?.session ?? null
  const target = resolveSubagentTarget({
    role,
    ...(context?.phase === undefined ? {} : { phase: context.phase }),
    policy,
    ...(context?.override === undefined ? {} : { override: context.override }),
    ladderProvider: inner.provider ?? null,
    sessionModel: session,
  })
  const verdict = independenceOf(inner, target, session)
  return {
    ...inner,
    model: target.model,
    chosen: target.chosen,
    independence: verdict.independence,
    independenceNote: verdict.note,
    reason: inner.reason + ' ' + verdict.note,
  }
}

/**
 * FU-20 — "IS THIS REVIEW INDEPENDENT?", ANSWERED FROM WHAT WAS RESOLVED RATHER THAN FROM WHAT WAS INTENDED.
 *
 * ⚠ THE `same-model` CASE IS THE ONE THAT MATTERS, and it is PROVABLE rather than inferred. The harness itself
 * resolves an unconfigured child's model in `packages/subagent/subagent/src/child-agent.ts:99`
 * (`resolveChildAgentOptions`): it copies the parent's provider and model onto the child unless the request
 * overrides them. So a delegation that sends no `agentOptions.model` — which is exactly what "no model is
 * configured" produces — runs on the SESSION'S OWN MODEL BY CONSTRUCTION. Calling that an independent second
 * opinion would be a claim the code cannot support; saying so is the point of this function.
 */
function independenceOf(
  inner: { tier: RouteTier; posture: RoutePosture; refused?: boolean },
  target: { model: string | null; sessionModel?: SessionModelReading | null },
  session: SessionModelReading | null,
): { independence: RouteIndependence; note: string } {
  if (inner.refused === true) {
    return {
      independence: 'refused',
      note: '⚠ NOTHING WAS SUBSTITUTED: the policy says to ASK rather than pick a fallback, so no child was '
        + 'quietly started and no self-review was quietly substituted. The choice is yours to make.',
    }
  }
  if (inner.tier === 'self-audit' || inner.tier === 'local-controller') {
    return {
      independence: 'self-audit',
      note: '⚠ INDEPENDENCE LOST: no child session is created for this work, so the AUTHORING agent performs it '
        + 'on its own output. This is a SELF-AUDIT and must not be recorded, described or reported as an '
        + 'independent review. To restore a genuinely independent reviewer, configure a DSH model for this role '
        + 'or phase in the router policy — a delegated child is what makes the review independent.',
    }
  }
  if (inner.posture === 'cli') {
    // ⚠ AN EXTERNAL CLI RUNS ON ITS OWN MODEL, and this plugin did not resolve which. Saying "inherits the
    // session model" here would be false — the harness's parent-model inheritance is an IN-PROCESS child
    // behaviour (`child-agent.ts:99`), not something a separate installed program does. So the model
    // relationship is reported as unverified rather than copied from the in-process case.
    return {
      independence: 'unverified-model',
      note: 'DELEGATED TO AN EXTERNAL CLI: a child exists, so the review is not a self-audit, but its model is '
        + 'chosen inside the CLI program ('
        + (target.model === null ? 'no DSH model was configured for it' : 'the configured value is ' + target.model)
        + ') and is not something this plugin resolved — so no claim is made about whether it differs from this '
        + 'session\'s model.',
    }
  }
  if (target.model === null) {
    const named = session !== null && session.available ? ' (' + session.provider + '/' + session.model + ')' : ''
    return {
      independence: 'same-model',
      note: 'SEPARATE AGENT, SAME MODEL: no model is configured for this work, so the child INHERITS this '
        + 'session\'s own model' + named + ' — the harness copies the parent\'s model onto an unconfigured child '
        + '(child-agent.ts:99). The delegation is independent by AGENT and CONTEXT, which is real, but it is NOT '
        + 'a second opinion from a different model, and it must not be described as one.',
    }
  }
  const matchesSession = session !== null && session.available && session.model === target.model
  if (matchesSession) {
    return {
      independence: 'same-model',
      note: 'SEPARATE AGENT, SAME MODEL: the configured model ' + target.model + ' IS the model this session '
        + 'runs on, so the child is independent by AGENT and CONTEXT but not by MODEL.',
    }
  }
  if (session === null || !session.available) {
    // ⚠ A SEPARATE CHILD IS NOT THE SAME CLAIM AS A DIFFERENT MODEL, and this is the branch where conflating
    // them would put a second unsupported claim in the record. The child is real; whether it is on another model
    // is not known here, so it is reported as unverified rather than asserted.
    return {
      independence: 'unverified-model',
      note: 'INDEPENDENT DELEGATION by AGENT and CONTEXT: a child session is created on ' + target.model
        + ', and it is not the authoring agent. Whether that model DIFFERS from this session\'s own was NOT read '
        + 'here (' + (session === null ? 'no session-model reading was supplied' : session.note)
        + '), so a difference is not claimed.',
    }
  }
  return {
    independence: 'independent',
    note: 'INDEPENDENT DELEGATION: a child session is created on ' + target.model + ', which is a DIFFERENT '
      + 'model from this session\'s own (' + session.model + '), so the review is independent in both agent and model.',
  }
}

/**
 * What the TIER ladder can decide on its own: WHO creates the child, and the posture that follows.
 *
 * ⚠ FU-20 — the model, the provenance labels, and the independence verdict are deliberately NOT here. They are
 * composed once, in `resolveRole`, from this answer plus the ladder's. That split is what keeps every return site
 * below from having to restate them — the trap the T9 wrapper comment describes, one axis over.
 */
type TierDecision = Omit<RouteDecision, 'independence' | 'independenceNote' | 'model' | 'chosen'>

/**
 * Resolve a role to a tier, preferring a native provider whose name maps to
 * the role (e.g. role 'code-reviewer' -> provider 'code-reviewer' or the
 * generic spawn/fork provider). External CLIs ride their provider rows; else
 * the policy fallback.
 *
 * ⚠ FU-20 — THE ORDER IS NOW DELIBERATE, AND IT IS NOT THE OLD ORDER. The old ladder tried
 * native → external-CLI → self-audit, so a route that named a CLI was only reached when no native provider
 * existed — a CLI could never actually be chosen on a host that had `spawn`. It also ignored every one of the
 * three declared `when_*` postures, which is why the policy file read as though it were deciding when it was
 * not. The new order is:
 *
 *   1. an EXPLICITLY configured CLI route (a real `cli` name on the route) — the user asked for it by name;
 *   2. the MODEL route — a harness-native provider creating a child that runs on a DSH model, which is the
 *      DEFAULT POSTURE and what "subagents should not use cli" means;
 *   3. the floor — `local-controller` or a self-audit, both of them LOUD.
 *
 * `when_cli_unavailable` is honoured at step 1 and `when_role_unconfigured` at step 3; the scaffolded
 * `mode: 'external-cli'` with a NULL `cli` is not a CLI route at all, which is what stops the observed
 * "external-cli with no CLI configured → self-audit" path from silently recurring.
 */
function resolveRoleInner(
  role: string,
  policy: RouterPolicy,
  providers: Record<string, SubagentProviderLike>,
): TierDecision {
  const base = { whenModelUnknown: policy.defaults.when_model_unknown }
  const route = policy.role_routes[role]
  if (!route || !route.enabled) {
    // ⚠ `when_role_unconfigured`. The declared default is 'ask': do not invent a route for a role nobody
    // configured. `fallback-local` is the caller SAYING they want the local default, and that is now a real
    // child on the session's model rather than a self-review — the distinction this knob was always about.
    if (policy.defaults.when_role_unconfigured !== 'fallback-local') {
      return {
        ...base,
        tier: 'self-audit',
        posture: 'none',
        refused: true,
        reason: 'role ' + role + ' is unconfigured or disabled, and `when_role_unconfigured` is `ask`, so no '
          + 'route was invented for it',
      }
    }
    const fallback = nativeProviderFor(role, providers)
    if (fallback !== null) {
      return {
        ...base,
        tier: 'native',
        provider: fallback,
        posture: 'model',
        reason: 'role ' + role + ' is unconfigured or disabled, but `when_role_unconfigured` is `fallback-local`, '
          + 'so it runs on the local session model through native provider ' + fallback,
      }
    }
    return {
      ...base,
      tier: 'self-audit',
      posture: 'none',
      reason: 'role ' + role + ' is unconfigured or disabled and no native provider is registered, so '
        + '`when_role_unconfigured: fallback-local` has no local route to fall back to',
    }
  }

  // 1. An EXPLICIT CLI route. Reachable by configuration and by nothing else.
  const cli = typeof route.cli === 'string' && route.cli.trim() !== '' ? route.cli.trim() : null
  if (route.mode === 'external-cli' && cli !== null) {
    for (const name of [cli, 'codex', 'claude-code']) {
      if (providers[name]) {
        return {
          ...base,
          tier: 'external-cli',
          provider: name,
          posture: 'cli',
          reason: 'external CLI ' + cli + ' was explicitly configured for ' + role
            + ' and resolves to provider ' + name,
        }
      }
    }
    // ⚠ THE OBSERVED DEFECT LIVED HERE. This branch used to return a self-audit whose reason read as a policy
    // note, which is how a delegated review became the author's own review without anyone noticing. It now
    // either refuses loudly (`ask`) or takes the LOCAL MODEL route (`fallback-local`) — and never self-audits
    // while a native provider could still create a child.
    if (policy.defaults.when_cli_unavailable !== 'fallback-local') {
      return {
        ...base,
        tier: 'self-audit',
        posture: 'none',
        refused: true,
        reason: 'external CLI ' + cli + ' is configured for ' + role + ' but has no registered provider, and '
          + '`when_cli_unavailable` is `ask`',
      }
    }
    const local = nativeProviderFor(role, providers)
    if (local !== null) {
      return {
        ...base,
        tier: 'native',
        provider: local,
        posture: 'model',
        reason: 'external CLI ' + cli + ' is configured for ' + role + ' but has no registered provider, so '
          + '`when_cli_unavailable: fallback-local` routes it to the LOCAL MODEL through native provider ' + local
          + ' — a real delegated child, not a self-review',
      }
    }
    // No local route either: the floor, and the wrapper makes it loud.
    return {
      ...base,
      tier: 'self-audit',
      posture: 'none',
      reason: 'external CLI ' + cli + ' is configured for ' + role + ' but has no registered provider, and no '
        + 'native provider is registered either, so there is no local model route to fall back to',
    }
  }

  // 2. THE MODEL ROUTE — the default posture, and the one the directive asks for.
  const native = nativeProviderFor(role, providers)
  if (native !== null) {
    return {
      ...base,
      tier: 'native',
      provider: native,
      posture: 'model',
      reason: 'native provider ' + native + ' is registered, so ' + role + ' is delegated to a child that runs on '
        + 'a DSH model rather than on an external CLI',
    }
  }

  // 3. THE FLOOR — nobody can create a child.
  if (route.fallback === 'local-controller') {
    return { ...base, tier: 'local-controller', posture: 'none', reason: 'policy fallback local-controller' }
  }
  return {
    ...base,
    tier: 'self-audit',
    posture: 'none',
    reason: 'no native provider and no available external CLI can create a child for ' + role
      + '; policy fallback ' + (route.fallback || 'self-audit'),
  }
}

/**
 * The native provider that would create a child for this role: the role's own name first, then the harness's
 * generic providers. One definition, so the model route and the `fallback-local` paths cannot disagree about
 * which provider is available.
 */
function nativeProviderFor(
  role: string,
  providers: Record<string, SubagentProviderLike>,
): string | null {
  for (const name of [role, 'spawn', 'fork', 'dsh-sdk']) {
    if (providers[name]) return name
  }
  return null
}


/** Probe a single provider and return its advertised capabilities. */
export function probeCapabilities(provider: SubagentProviderLike | undefined): CapabilityProbe {
  if (!provider) {
    return { available: false, reason: 'no provider registered' }
  }
  const caps = provider.capabilities
  return {
    available: true,
    provider: provider.name,
    capabilities: {
      outputSchema: caps?.outputSchema ?? false,
      depthLimit: caps?.depthLimit ?? false,
      toolFilter: caps?.toolFilter ?? false,
      persona: caps?.persona ?? false,
    },
    reason: 'provider ' + provider.name + ' probed',
  }
}

/**
 * Probe the router-relevant capability for a role. No provider -> available
 * false with a concrete reason (the self-audit fallback trigger).
 */
export function capabilityProbe(input: {
  providers: Record<string, SubagentProviderLike>
  role: string
  policy?: RouterPolicy
}): CapabilityProbe {
  const policy = input.policy ?? DEFAULT_POLICY
  const decision = resolveRole(input.role, policy, input.providers)
  if (decision.tier === 'self-audit' || decision.tier === 'local-controller') {
    return { available: false, reason: decision.reason }
  }
  const provider = input.providers[decision.provider ?? '']
  return probeCapabilities(provider)
}

/**
 * Render the Delegation Decision Basis prose the phase doc records.
 *
 * ⚠ FU-20 — THIS PROSE IS WHERE A READER LEARNS WHETHER THE REVIEW WAS INDEPENDENT, and until now it did not say.
 * It read *"subagents are available (spawn); code-reviewer work is delegated by default when the context bundle
 * is complete, with self-audit as the guaranteed fallback"* — a sentence in which "self-audit as the guaranteed
 * fallback" is grammatically a SAFETY NET and semantically the loss of the whole point. A live run read that
 * line, took the fallback, and recorded its own review of its own work.
 *
 * The words now match the reality on both paths:
 *   - a child IS created → the basis names the provider and says what independence it actually bought, with the
 *     same-model case stated rather than dressed up as a second opinion;
 *   - no child → the basis opens with INDEPENDENCE LOST and says the review is the author's own, because that is
 *     the one fact a reviewer of the resulting record most needs and the one the old wording buried.
 */
export function delegationDecisionBasis(input: {
  role: string
  available: boolean
  provider?: string
  fallback: string
  /**
   * FU-20: what the delegated work runs on and how independent that makes it. Optional so every existing caller
   * keeps working; when it is absent the prose still refuses to imply independence it cannot evidence.
   */
  independence?: RouteIndependence
  model?: string | null
  sessionModel?: SessionModelReading | null
}): string {
  const { role, available, provider, fallback } = input
  if (available && provider) {
    const model = typeof input.model === 'string' && input.model.trim() !== '' ? input.model : null
    const sameModel = input.independence === 'same-model'
    const on = model === null
      ? 'on the session\'s own model'
        + (input.sessionModel !== null && input.sessionModel !== undefined && input.sessionModel.available
          ? ' (' + input.sessionModel.provider + '/' + input.sessionModel.model + ', ' + input.sessionModel.note + ')'
          : ' (whose name could not be read here, so it is reported as unknown rather than guessed)')
      : 'on model ' + model
    return 'subagents are available (' + provider + '); ' + role + ' work is delegated to a SEPARATE child session '
      + on + ', which is what makes the review independent of the author'
      + (sameModel
        ? ' — but the child runs on the SAME model as this session, so the independence is of AGENT and CONTEXT, '
          + 'not of MODEL, and this must not be described as a second opinion from a different model.'
        : '.')
      + ' ' + fallback + ' remains the guaranteed fallback, and any fallback is REPORTED with its reason rather '
      + 'than taken silently.'
  }
  return '⚠ INDEPENDENCE LOST: no native subagent provider is available for ' + role + ' (probe failed, timed out, '
    + 'or no provider is registered). No child session is created, so this review is a SELF-AUDIT performed by the '
    + 'AUTHORING agent on its own output — it is NOT an independent review, and it must not be recorded, described '
    + 'or reported as one. The ' + fallback + ' path is preserved rather than weakened, and the missing '
    + 'independence is stated here rather than left for a reader to infer: configure a DSH model for this role or '
    + 'phase to restore a genuinely independent reviewer.'
}

