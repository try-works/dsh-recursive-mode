/**
 * Packaged `recursive-mode` skill (dsh plugin standard).
 *
 * Ships the workflow's operating contract as a bundled skill through
 * `ctx.skills.registerProvider(...)` — the same shape as the shipped
 * `dsh-skill-badge` provider: a `bundled` candidate at `BUNDLED_SKILL_RANK`
 * (600), body read from the package's shipped `skills/recursive-mode/SKILL.md`
 * (never an inlined TS string literal), with a directory resource base so the
 * skill can resolve its own assets. Skills are optional instructions, not
 * session events: this emits nothing and never appends a recursive/* event.
 *
 * Optionality: `skills` is a host-plane registry; when the composition has
 * none, this is a no-op (returns undefined) rather than failing boot.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** Package root: <package>/src/.. — skills/ sits next to src/. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(MODULE_DIR, '..')

/** Precedence rank for packaged/bundled skills (mirrors `BUNDLED_SKILL_RANK`). */
const BUNDLED_SKILL_RANK = 600
const SKILL_NAME = 'recursive-mode'
const PROVIDER_NAME = 'recursive-mode'
const SKILL_BODY_PATH = join(PACKAGE_ROOT, 'skills', SKILL_NAME, 'SKILL.md')
const SKILL_RESOURCE_BASE = join(PACKAGE_ROOT, 'skills', SKILL_NAME)
const SKILL_DESCRIPTION =
  'Drive the recursive-mode workflow: an audit-gated, phase-disciplined loop that carries one requirement from AS-IS through TO-BE plan, implementation, test, and manual QA to locked control-plane state and durable memory. Use whenever the user asks to implement, resume, or advance a recursive run, or when a repo carries a /.recursive/ control plane.'

/** Invocation policy: both the model catalog and user `/name` surfaces may load it. */
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

/** One skill contribution, mirrored from the `dsh-skill` registry contract. */
export interface SkillInvocationPolicyLike {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** Provider-owned base for relative resource resolution. */
export type SkillResourceBaseLike =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** Invocation-neutral summary fields shared by candidates and definitions. */
export interface SkillSummaryLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicyLike
  readonly source: string
  readonly provider: string
  readonly resourceBase?: SkillResourceBaseLike
}

/** Provider catalog entry: a summary plus rank and an opaque locator. */
export interface SkillCandidateLike extends SkillSummaryLike {
  readonly rank: number
  readonly locator: unknown
  readonly path?: string
}

/** Complete loaded skill: a summary plus the markdown instruction body. */
export interface SkillDefinitionLike extends SkillSummaryLike {
  readonly content: string
  readonly path?: string
}

/** Lookup options passed to provider `list`/`get`. */
export interface SkillLookupOptionsLike {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

/** Registration-scoped control borrowed by one provider. */
export interface SkillProviderControlLike {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

/** One source of skills, mirrored from the `dsh-skill` SkillProvider contract. */
export interface SkillProviderLike {
  readonly name: string
  readonly list: (options: SkillLookupOptionsLike) => Promise<readonly SkillCandidateLike[] | { readonly candidates: readonly SkillCandidateLike[]; readonly complete: boolean }>
  readonly get: (candidate: SkillCandidateLike, options: SkillLookupOptionsLike) => Promise<SkillDefinitionLike | undefined>
}

/** Minimal host-realm contract for ctx.skills (the seam we call). */
export interface SkillsRuntimeLike {
  registerProvider(create: (control: SkillProviderControlLike) => SkillProviderLike): () => void
}

/** The bundled candidate, stable across every `list()` call. */
function candidate(): SkillCandidateLike {
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: SKILL_RESOURCE_BASE },
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_BODY_PATH,
    path: SKILL_BODY_PATH,
  }
}

/** Read the shipped operating-contract body (fail loud if the package lost it). */
function readBody(): string {
  return readFileSync(SKILL_BODY_PATH, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** The one bundled provider this plugin contributes. */
function provider(): SkillProviderLike {
  return {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([candidate()]),
    get: async () => ({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      invocation: INVOCATION,
      provider: PROVIDER_NAME,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: SKILL_RESOURCE_BASE },
      content: readBody(),
      path: SKILL_BODY_PATH,
    }),
  }
}

/**
 * Register the packaged `recursive-mode` skill into the host `skills` registry.
 *
 * Reads `ctx.get('skills')` optionally (the registry is host-plane; a
 * composition without it is valid). On success returns the exact disposer that
 * unregisters the provider; on absence returns undefined (a no-op, never a boot
 * failure).
 */
export function registerRecursiveSkill(ctx: Context): (() => void) | undefined {
  const skills = ctx.get('skills')
  if (skills === undefined || skills === null) return undefined
  // SAFETY: the single boundary cast asserts the live ctx.skills satisfies the
  // structural SkillsRuntimeLike seam (registerProvider). The live registry's
  // method is a superset of this seam; the provider we return is a plain owned
  // object read through its own leaf fields, never serialized.
  const registry = skills as SkillsRuntimeLike
  return registry.registerProvider(() => provider())
}
