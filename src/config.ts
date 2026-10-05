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
import { DEFAULT_BUDGETS } from './enforcement.ts'

/** One enforcement mode, as the settings form presents it. */
const enforcementMode = z.union([z.const('strict'), z.const('advisory')])

export interface RecursiveModeBudgets {
  maxAuditRounds?: number
  maxRepairAttempts?: number
  maxDelegationDepth?: number
  maxChildrenPerPhase?: number
  maxResultBytes?: number
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
  enforcement: z.object({
    preStep: enforcementMode.default('advisory').description(
      'Phase pre-step enforcement: strict refuses an out-of-order transition, advisory warns and proceeds.',
    ),
    toolGuards: enforcementMode.default('advisory').description(
      'Tool guard mode: strict DENIES an out-of-order tool call, advisory allows it and carries the warning.',
    ),
    tamper: enforcementMode.default('advisory').description(
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
})
