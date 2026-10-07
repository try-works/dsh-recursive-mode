/**
 * ⚠ FU-19 — WRITING THE USER'S PROVIDER/MODEL CHOICES BACK TO THE POLICY FILE.
 *
 * `recursive-router.json` is the plugin's own declarative config, and `bootstrap.ts` already writes it once when a
 * workspace is scaffolded. This module is the second writer: it changes ONE level of ONE thing and leaves every
 * other byte of the file alone.
 *
 * ## Three rules, each of which exists because the opposite would be a defect
 *
 * 1. **PRESERVE WHAT WE DO NOT UNDERSTAND.** The file is read as `Record<string, unknown>` and mutated in place,
 *    never rebuilt from our types. A policy carrying a field this version has never heard of — a hand-written
 *    `cli_overrides`, a future schema addition — keeps it. Rebuilding from the schema would silently delete a
 *    user's configuration the first time they used a verb, which is the worst kind of data loss because it looks
 *    like the verb worked.
 *
 * 2. **`clear` MEANS ABSENCE, NOT EMPTINESS.** The schema's own rule is that an absent field DEFERS to the next
 *    level of precedence. So clearing must DELETE the key rather than set it to null or to an empty string: a
 *    present-but-empty value would stop the deferral and pin the choice to nothing, which is a different state
 *    from "unconfigured" and not one a user can see. Absence is the honest representation of "I have no opinion".
 *
 * 3. **WRITE ATOMICALLY.** A temp file and a rename, the same pattern the preset installer used, before it was retired. A policy file
 *    half-written because a process died mid-write would make `loadRouterPolicy` fall back to the built-in
 *    self-audit policy — and it does that SILENTLY, on purpose (it never throws). So a torn write here would look
 *    exactly like "the user configured nothing", for every role, until someone read the file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { routerPolicyPath } from './router.ts'

/** Which level a write targets. The narrowest matching level wins at resolution time. */
export type SelectionScope = 'general' | 'phase' | 'role'

/** What to write. Every field is optional; omitting one leaves that field alone. */
export interface SelectionPatch {
  scope: SelectionScope
  /** Required for `phase` and `role`. */
  phase?: string
  /** Required for `role`. */
  role?: string
  /** The SUBAGENT provider — who creates the child. */
  provider?: string
  /** The model id. */
  model?: string
  /** The LLM provider — who SERVES the model. Not the same thing as `provider` above. */
  modelProvider?: string
  /** Remove the named fields instead of setting them. With no field names, removes the whole level. */
  clear?: boolean
}

export interface SelectionWriteResult {
  path: string
  /** One sentence, naming the level, what changed, and the rule that history is untouched. */
  message: string
  /** Whether anything actually changed — a no-op write still rewrites the file, but says it was already so. */
  changed: boolean
}

const SCOPED_FIELDS = ['provider', 'model', 'modelProvider'] as const

/**
 * A selector name, cleaned of the quotes a shell-typed argument often carries. `--role ""` must mean "no role"
 * rather than a route literally named two quote characters — a defect this writer's own spec caught when the verb
 * was wired to it.
 */
function cleanName(value: string | undefined): string {
  return (value ?? '').replace(/^["']|["']$/g, '').trim()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Where a scope's patch lives inside the policy object, creating the container only when a write needs it. */
function containerFor(policy: Record<string, unknown>, patch: SelectionPatch): Record<string, unknown> | null {
  if (patch.scope === 'general') {
    return asRecord(policy.defaults) ?? null
  }
  if (patch.scope === 'phase') {
    const key = cleanName(patch.phase)
    if (key === '') return null
    const routes = asRecord(policy.phase_routes) ?? {}
    const existing = asRecord(routes[key]) ?? {}
    routes[key] = existing
    policy.phase_routes = routes
    return existing
  }
  const role = cleanName(patch.role)
  if (role === '') return null
  const routes = asRecord(policy.role_routes) ?? {}
  const existing = asRecord(routes[role]) ?? {}
  routes[role] = existing
  policy.role_routes = routes
  return existing
}

/** Apply one patch to a policy object IN PLACE. Returns whether anything changed, or a refusal reason. */
export function applySelectionPatch(
  policy: Record<string, unknown>,
  patch: SelectionPatch,
): { changed: boolean } | { refused: string } {
  if (patch.scope === 'phase' && cleanName(patch.phase) === '') {
    return { refused: 'a phase-scoped choice needs a phase, e.g. --phase 03' }
  }
  if (patch.scope === 'role' && cleanName(patch.role) === '') {
    return { refused: 'a role-scoped choice needs a role, e.g. --role code-reviewer' }
  }

  // A role route carries `model` at its own top level (that is where the pre-FU-19 schema put it), so the fields
  // are written there and NOT nested under a `subagent` object the way the general default is.
  const target = patch.scope === 'general'
    ? (() => {
      const defaults = asRecord(policy.defaults) ?? {}
      policy.defaults = defaults
      const subagent = asRecord(defaults.subagent) ?? {}
      defaults.subagent = subagent
      return subagent
    })()
    : containerFor(policy, patch)
  if (target === null) return { refused: 'the policy target could not be created' }

  const names = SCOPED_FIELDS.filter((field) => patch[field] !== undefined)
  let changed = false

  if (patch.clear === true) {
    // Clear the named fields, or the whole level when none were named. DELETE, never blank — see rule 2 above.
    const removals = names.length > 0 ? names : [...SCOPED_FIELDS]
    for (const field of removals) {
      if (field in target) {
        delete target[field]
        changed = true
      }
    }
    // And drop a now-empty general container, so "cleared" leaves no residue that could shadow a lower level.
    if (patch.scope === 'general') {
      const defaults = asRecord(policy.defaults)
      const subagent = defaults === null ? null : asRecord(defaults.subagent)
      if (subagent !== null && Object.keys(subagent).length === 0) {
        delete defaults!.subagent
        changed = true
      }
    }
    return { changed }
  }

  for (const field of names) {
    const value = patch[field]
    const next = typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    if (next === null) {
      // An empty string is not a choice: treat it as "clear this field" rather than storing a blank that would
      // stop the deferral to the next level.
      if (field in target) {
        delete target[field]
        changed = true
      }
      continue
    }
    if (target[field] !== next) {
      target[field] = next
      changed = true
    }
  }
  return { changed }
}

/**
 * Write a selection patch to a workspace's policy file.
 *
 * Returns a refusal instead of throwing when the patch is incomplete, and a message that always states the rule
 * the objective names: this applies to future delegations and never rewrites a run's recorded history.
 */
export function writePolicySelection(
  root: string,
  patch: SelectionPatch,
  options: { path?: string } = {},
): SelectionWriteResult | { refused: string } {
  const path = options.path ?? routerPolicyPath(root)
  let policy: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      policy = asRecord(JSON.parse(readFileSync(path, 'utf8'))) ?? {}
    } catch {
      return { refused: 'the policy file at ' + path + ' is not readable JSON, so it was left untouched rather than overwritten' }
    }
  }

  const applied = applySelectionPatch(policy, patch)
  if ('refused' in applied) return applied

  const level = patch.scope === 'general'
    ? 'the general subagent default'
    : patch.scope === 'phase'
      ? 'the phase ' + (patch.phase ?? '') + ' override'
      : 'the ' + (patch.role ?? '') + ' role route'

  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(dirname(path), '.recursive-router.json.tmp')
    writeFileSync(tmp, JSON.stringify(policy, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    return { refused: 'the policy could not be written: ' + (err instanceof Error ? err.message : String(err)) }
  }

  return {
    path,
    changed: applied.changed,
    message: (applied.changed ? 'updated ' : 'already as requested: ') + level
      + '. This applies to FUTURE delegations only — it never rewrites a run\'s recorded history.',
  }
}
