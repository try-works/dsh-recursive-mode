/**
 * T34 — re-link the `@deepseek-ai/*` devDependencies at whatever depth this repo
 * happens to sit.
 *
 * THE DEFECT THIS FIXES. `package.json` declares each harness dependency as
 * `link:D:/deepseek-harness/packages/...` — an ABSOLUTE path — but pnpm records the
 * target RELATIVE in the lockfile (`version: link:../../deepseek-harness/...`). So
 * `pnpm install` only produces working links when the repo sits at exactly the depth
 * the lockfile assumed: two levels below the drive root, beside the checkout. Clone
 * it anywhere else — deeper, or on another drive — and every `@deepseek-ai/*` module
 * becomes unresolvable: `tsc` reports `TS2307: Cannot find module` for all of `src/`,
 * and the specs that import them fail to load. A public repo that cannot be cloned
 * anywhere is a defect, not a documentation gap.
 *
 * THE FIX, AND WHY IT IS THIS ONE. The absolute targets are already IN
 * `package.json`, so the links can be rebuilt from it with no network, no registry
 * and no re-resolution — which matters because the pinned revision is a local
 * checkout that is not published. `DSH_HARNESS_ROOT` relocates the whole set when the
 * checkout itself moved. An absent checkout DEGRADES with a clear message and exit 0
 * rather than failing the install: a machine without the harness can still read the
 * repo, and the failure it will see is the honest "this module is not linked".
 *
 * Windows note: directory symlinks need elevation, junctions do not — so this uses
 * `junction` on win32, which is also what pnpm itself does.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** The package name prefix every harness dependency shares. */
export const LINKED_SCOPE = '@deepseek-ai/'

/**
 * Layout directories that the inferred common prefix must not swallow: dropping one
 * of these from a link target would point it at the wrong place.
 */
const LAYOUT_SEGMENTS = new Set(['packages', 'vendor'])

/**
 * The root the recorded absolute targets share, so a moved checkout can be
 * relocated coherently. Returns null when the specs do not share one (which would
 * mean the repo was hand-edited into an inconsistent state).
 *
 * The common prefix can OVERSHOOT into a layout directory: when every dependency
 * happens to live under one subtree (all under `packages/`, say), the prefix stops
 * at `packages` and re-rooting would silently drop that segment, pointing every link
 * at `<root>/<pkg>` instead of `<root>/packages/<pkg>`. This repo's real dependency
 * set spans `packages/` and `vendor/`, so the prefix already lands on the checkout
 * root — but a set that does not must not silently produce wrong targets, so a
 * trailing layout segment is stripped. `DSH_HARNESS_ROOT` therefore always means the
 * CHECKOUT ROOT, which is what a user would expect to pass.
 * @param {{ [name: string]: string }} devDependencies
 * @returns {string | null}
 */
export function pinnedRootOf(devDependencies) {
  const targets = linkTargetsOf(devDependencies).map((entry) => entry.target)
  if (targets.length === 0) return null
  const split = targets.map((target) => target.split(/[\\/]/))
  const first = split[0]
  const common = []
  for (let i = 0; i < first.length; i += 1) {
    const candidate = first[i]
    if (!split.every((parts) => parts[i] === candidate)) break
    common.push(candidate)
  }
  if (common.length > 1 && LAYOUT_SEGMENTS.has(common[common.length - 1])) common.pop()
  return common.join('/') || null
}

/**
 * Every scoped dependency declared as a `link:` spec, with its absolute target.
 * @param {{ [name: string]: string }} devDependencies
 * @returns {Array<{ name: string; target: string }>}
 */
export function linkTargetsOf(devDependencies) {
  const out = []
  for (const [name, spec] of Object.entries(devDependencies ?? {})) {
    if (!name.startsWith(LINKED_SCOPE)) continue
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    out.push({ name, target: spec.slice('link:'.length).replace(/\\/g, '/') })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Where each dependency should point, given an optional relocated checkout root.
 * @param {{ devDependencies?: object, harnessRoot?: string | null }} input
 * @returns {Array<{ name: string; target: string; exists: boolean }>}
 */
export function planLinks(input) {
  const targets = linkTargetsOf(input.devDependencies)
  const pinned = pinnedRootOf(input.devDependencies)
  const root = input.harnessRoot ?? pinned
  return targets.map(({ name, target }) => {
    let resolvedTarget = target
    if (input.harnessRoot && pinned && target.startsWith(pinned)) {
      const rest = relative(pinned, target).split(sep).join('/')
      resolvedTarget = join(input.harnessRoot, rest).replace(/\\/g, '/')
    }
    return { name, target: resolvedTarget, exists: existsSync(resolvedTarget) }
  })
}

/** Where a scoped package's link lives inside the repo. */
export function linkPathOf(repoRoot, name) {
  return join(repoRoot, 'node_modules', ...name.split('/'))
}

/** True when the path is already a link (or junction) to the wanted target. */
function alreadyLinked(path, target) {
  try {
    const stat = lstatSync(path)
    if (!stat.isSymbolicLink()) return false
    const current = readlinkSync(path).replace(/\\/g, '/')
    return resolve(current) === resolve(target)
  } catch {
    return false
  }
}

/**
 * Create or repair every harness link under `<repoRoot>/node_modules`.
 *
 * Idempotent, and never throws for a missing checkout: the caller gets a report so
 * it can print an honest message instead of a stack trace.
 * @param {{ repoRoot: string; devDependencies?: object; harnessRoot?: string | null; log?: (line: string) => void }} input
 * @returns {{ linked: string[]; repaired: string[]; missing: string[]; ok: boolean[] }}
 */
export function linkDsh(input) {
  const log = input.log ?? (() => {})
  const plan = planLinks({ devDependencies: input.devDependencies, harnessRoot: input.harnessRoot })
  const linked = []
  const repaired = []
  const missing = []
  for (const entry of plan) {
    if (!entry.exists) {
      missing.push(entry.name)
      continue
    }
    const path = linkPathOf(input.repoRoot, entry.name)
    if (alreadyLinked(path, entry.target)) {
      repaired.push(entry.name)
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    try {
      rmSync(path, { recursive: true, force: true })
      symlinkSync(entry.target, path, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(entry.name)
    } catch (err) {
      // One un-linkable package must not abort the rest: the remaining links are
      // still worth having, and the caller reports what failed.
      log('  ! ' + entry.name + ': ' + (err instanceof Error ? err.message : String(err)))
      missing.push(entry.name)
    }
  }
  return { linked, repaired, missing, ok: plan.map((entry) => entry.exists) }
}

/** Read this repo's devDependencies (the absolute targets live there, not in the lockfile). */
export function readDevDependencies(repoRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    return pkg.devDependencies ?? {}
  } catch {
    return {}
  }
}

function main() {
  const repoRoot = resolve(process.argv[2] ?? process.cwd())
  const harnessRoot = process.env.DSH_HARNESS_ROOT ? resolve(process.env.DSH_HARNESS_ROOT) : null
  const devDependencies = readDevDependencies(repoRoot)
  const planned = planLinks({ devDependencies, harnessRoot })

  if (planned.length === 0) {
    console.log('[link-dsh] no ' + LINKED_SCOPE + '* link: dependencies to place')
    return
  }
  const absentRoot = planned.every((entry) => !entry.exists)
  if (absentRoot) {
    console.log('[link-dsh] the DSH checkout was not found at ' + (harnessRoot ?? pinnedRootOf(devDependencies)))
    console.log('[link-dsh] set DSH_HARNESS_ROOT to its location to link ' + planned.length + ' packages, e.g.')
    console.log('[link-dsh]   DSH_HARNESS_ROOT=/path/to/deepseek-harness pnpm run link:dsh')
    console.log('[link-dsh] continuing WITHOUT links: typecheck and tests will report unresolved modules')
    return
  }

  const report = linkDsh({ repoRoot, devDependencies, harnessRoot })
  const placed = report.linked.length
  const kept = report.repaired.length
  console.log('[link-dsh] linked ' + placed + ', already correct ' + kept + ', unresolved ' + report.missing.length)
  if (report.missing.length > 0) {
    console.log('[link-dsh] unresolved: ' + report.missing.join(', '))
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1]).replace(/\\/g, '/')).href) {
  main()
}
