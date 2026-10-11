/**
 * T7 — the plugin's Config: the `recursive` settings namespace.
 *
 * HOW THE SETTINGS SERVICE ACTUALLY SEES THIS, measured against
 * `@deepseek-ai/dsh-settings`'s own types rather than assumed: `describe()` "read[s]
 * active plugin schemas and their live values", and `update(ns, patch, expectedRevision)`
 * "merge[s] editable fields into an entry's config". There is **no `register(...)` call
 * for a plugin to make** — the item's `registerEnforcementSettings(settings)` wording
 * describes a seam that does not exist. **Declaring this schema IS the registration:**
 * the Loader owns the profile entry, the service projects the schema into a form, and an
 * edit re-applies the plugin with the new config. That re-application IS the hot reload,
 * which is why there is no watcher here to keep in sync.
 *
 * VALIDATION IS NOT DUPLICATED. The schema is what the UI reads and what gives the form
 * its shape; `resolveEnforcementConfig` remains the STRICT validator (unknown keys
 * rejected, budgets required to be positive integers, fail-loud at load). A schema that
 * silently coerced a bad value would be a second, weaker contract beside the real one.
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BUDGETS, DEFAULT_ENFORCEMENT_MODE } from './enforcement.ts'

/** One enforcement mode, as the settings form presents it. */
const enforcementMode = z.union([z.const('strict'), z.const('advisory')])

export interface RecursiveModeBudgets {
  maxAuditRounds?: number
  maxRepairAttempts?: number
  maxDelegationDepth?: number
  maxChildrenPerPhase?: number
  maxResultBytes?: number
}

/**
 * ⚠ FU-20 — ONE LEVEL OF THE PROVIDER/MODEL LADDER, as a settings form presents it.
 *
 * `provider` is the SUBAGENT provider (who creates the child: `spawn`, `fork`); `modelProvider` is the LLM
 * provider that SERVES the model (`deepseek-official`). Two names for two ideas, kept apart here because
 * conflating them was a real defect in this feature's first schema.
 */
export interface RecursiveModeSubagentRoute {
  provider?: string
  model?: string
  modelProvider?: string
}

export interface RecursiveModeRouter {
  defaults?: Record<string, string | number | boolean | undefined>
  /** FU-20 — the general subagent route: applies to every delegated child no narrower level claims. */
  subagent?: RecursiveModeSubagentRoute
  /**
   * FU-20 — PER ROLE: "code-reviewer runs on this model". The owner's first ask.
   *
   * ⚠ THIS IS HOW THE SETTING REACHES THE PLUGIN WITHOUT TOUCHING `src/index.ts`. That file already forwards the
   * plugin's whole `router` config section to `setRouterOverrides` (`index.ts:362`), so anything DECLARED here
   * arrives at `loadRouterPolicy` by construction — the schema is the seam, and `index.ts` is not edited.
   */
  roles?: Record<string, RecursiveModeSubagentRoute>
  /** FU-20 — PER PHASE: "phase 3.5 runs on this model". Overrides the role level; see the schema description. */
  phases?: Record<string, RecursiveModeSubagentRoute & { role?: string }>
}

export interface RecursiveModeEnforcement {
  preStep?: 'strict' | 'advisory'
  toolGuards?: 'strict' | 'advisory'
  tamper?: 'strict' | 'advisory'
  budgets?: RecursiveModeBudgets
}

export interface RecursiveModeConfig {
  /** R4 shell split: expose ONLY the client bundle, registering nothing server-side. */
  shellOnly?: boolean
  repoRoot?: string
  /** T7/T28: the enforcement modes and the budgets, editable live. */
  enforcement?: RecursiveModeEnforcement
  /** T7: overrides for the workspace router file — see the schema comment on defaults. */
  router?: RecursiveModeRouter
}

/**
 * The schema the settings service discovers. Field descriptions are the form's help
 * text, so they are written for the person toggling them, not for the reader of this file.
 */
export const Config = z.object({
  shellOnly: z.boolean().default(false).description(
    'Client-shell only: registers nothing on the server (no tools, no command, no projection).',
  ),
  repoRoot: z.string().description(
    'Control-plane root. Defaults to the process working directory when unset.',
  ),
  /**
   * ⚠ THE THREE MODE DEFAULTS READ `DEFAULT_ENFORCEMENT_MODE` FROM `enforcement.ts`, and
   * that is deliberate: the schema default and the runtime default are the SAME value, and
   * two literals here would be two defaults. A caller that omits the section gets
   * `DEFAULT_ENFORCEMENT` from the runtime; a caller that supplies a partial section gets
   * the resolver's fill. Both must be the enforcing posture — see the const for why.
   */
  enforcement: z.object({
    preStep: enforcementMode.default(DEFAULT_ENFORCEMENT_MODE).description(
      'Phase pre-step enforcement: strict refuses an out-of-order transition, advisory warns and proceeds.',
    ),
    toolGuards: enforcementMode.default(DEFAULT_ENFORCEMENT_MODE).description(
      'Tool guard mode: strict DENIES an out-of-order tool call, advisory allows it and carries the warning.',
    ),
    tamper: enforcementMode.default(DEFAULT_ENFORCEMENT_MODE).description(
      'Tamper detection: strict refuses an artifact whose LockHash no longer matches its body.',
    ),
    budgets: z.object({
      maxAuditRounds: z.natural().default(DEFAULT_BUDGETS.maxAuditRounds).description(
        'Rounds one phase audit loop may run, even while every round makes progress.',
      ),
      maxRepairAttempts: z.natural().default(DEFAULT_BUDGETS.maxRepairAttempts).description(
        'How many times a phase may be sent back for repair before the loop stops.',
      ),
      maxDelegationDepth: z.natural().default(DEFAULT_BUDGETS.maxDelegationDepth).description(
        'Ceiling for the WHOLE recursion. A child narrows it; it is never re-granted per level.',
      ),
      maxChildrenPerPhase: z.natural().default(DEFAULT_BUDGETS.maxChildrenPerPhase).description(
        'Delegated children one phase may start, counted by distinct operation.',
      ),
      maxResultBytes: z.natural().default(DEFAULT_BUDGETS.maxResultBytes).description(
        'Byte ceiling for one tool result, applied after the finding-count cap.',
      ),
    }).description('T28 budgets.'),
  }).description('The enforcement modes plus the T28 budgets.'),
  /**
   * T7 — the ROUTER overrides. Deliberately NO defaults on these fields: `.default()`
   * would make every field present, and a present field overrides the workspace's
   * `recursive-router.json` — so defaulting them would silently shadow the declarative
   * file forever. Absent means "defer to the file"; present means "override it".
   *
   * ⚠ FU-20 — `roles` AND `phases` ARE THE SAME RULE, and the dict shape is load-bearing rather than cosmetic:
   * an entry that names only a `model` must leave the file's provider for that role intact. Each level of the
   * ladder is therefore keyed and merged per FIELD, never wholesale.
   */
  router: z.object({
    defaults: z.object({
      when_role_unconfigured: z.union([z.const('ask'), z.const('fallback-local')]).description(
        'What to do when a role has no configured route. `ask` (the default) invents no route for it; '
        + '`fallback-local` runs it on the local session model. Leave unset to use the workspace router file.',
      ),
      when_cli_unavailable: z.union([z.const('ask'), z.const('fallback-local')]).description(
        'What to do when a route names a CLI that has no registered provider. `ask` substitutes nothing; '
        + '`fallback-local` routes it to the local session MODEL — a real delegated child, never a self-review. '
        + 'Leave unset to use the workspace router file.',
      ),
      when_model_unknown: z.union([z.const('ask'), z.const('fallback-local')]).description(
        'What to do when a routed model is not in the inventory DSH reports. No model is ever substituted '
        + 'silently: the substitution is reported, and named when the session\'s own model could be read. '
        + 'Leave unset to use the workspace router file.',
      ),
      allow_auto_assign_if_single_cli: z.boolean().description(
        'Assign a role automatically when exactly one CLI is configured. Unset defers to the file.',
      ),
      probe_timeout_ms: z.natural().description('CLI capability probe timeout in ms. Unset defers to the file.'),
      invoke_timeout_ms: z.natural().description('Routed CLI invocation timeout in ms. Unset defers to the file.'),
    }).description('Router default policy fields this namespace overrides.'),
    /**
     * ⚠ FU-20 — THE GENERAL SUBAGENT ROUTE, deliberately a SIBLING of `defaults` rather than a key inside it.
     *
     * A pinned property of this namespace is that an unedited `defaults` carries NO present field, because a
     * present field overrides the workspace file — and a nested object schema ALWAYS materializes as `{}`, which
     * is a present field. `settings-config.spec.ts` caught the first version of this change doing exactly that.
     * It lands on the file's `defaults.subagent` in `loadRouterPolicy`, which is the same level of the ladder.
     */
    subagent: z.object({
      provider: z.string().description('Subagent provider (who creates the child): spawn, fork. Unset defers.'),
      model: z.string().description('Model for EVERY delegated child that no narrower level claims. Unset defers.'),
      modelProvider: z.string().description('The LLM provider serving that model. Unset defers.'),
    }).description('The general subagent route — the level above the session default.'),
    /**
     * ⚠ FU-20 — PER ROLE. Lower precedence than `phases`, higher than `defaults.subagent`; the SESSION's own
     * model is the floor below every level, and is what a child inherits when no level names a model.
     */
    roles: z.dict(z.object({
      provider: z.string().description('Subagent provider for this role (who creates the child).'),
      model: z.string().description('Model this role runs on, e.g. code-reviewer -> a stronger model.'),
      modelProvider: z.string().description('The LLM provider serving that model. Unset looks it up in DSH.'),
    })).description(
      'Per-ROLE subagent model, e.g. { "code-reviewer": { "model": "deepseek-pro" } }. A phase route overrides it.',
    ),
    /**
     * ⚠ FU-20 — PER PHASE. The NARROWEST configured level, so it wins over the role route: a phase is the more
     * specific statement of intent ("phase 3.5 needs the strong model"), and the more specific level is the one
     * the user meant. A per-call override from the tool still wins over both.
     */
    phases: z.dict(z.object({
      role: z.string().description('Use this role\'s route for this phase instead of the requested role\'s.'),
      provider: z.string().description('Subagent provider for this phase.'),
      model: z.string().description('Model this phase runs on; overrides the role level.'),
      modelProvider: z.string().description('The LLM provider serving that model.'),
    })).description(
      'Per-PHASE subagent model, e.g. { "3.5": { "model": "deepseek-pro" } }. Overrides the role route.',
    ),
  }).description('Overrides for .recursive/config/recursive-router.json — one path, not two.'),
})
