import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUBAGENT_SEAM_CONTRACT } from '../src/delegation.ts'

/**
 * ⚠ THE CONTRACT TEST — THE POINT OF THIS TASK.
 *
 * The 0.2.1-rc.2 rename of `startContinuable` → `startActivation` (and the drain methods) passed a
 * 1419-test suite because EVERY fake implemented the retired names, and BOTH live paths degrade kindly:
 * `hasContinuableSeam` refuses, and the drain returns `{ ok: true }`. A silent no-op is exactly what a green
 * suite cannot see. So this file depends on NO fake: it reads the INSTALLED host's own source/types and
 * asserts every method the seam resolves FIRST still exists there. The NEXT rename fails here, loudly.
 *
 * WHERE "INSTALLED HOST" COMES FROM, in order:
 *   1. `DSH_SUBAGENT_CONTRACT_ROOT` — a test-only override used to prove this test FAILS when a current
 *      method is removed (see the mutation evidence in the task report). It must point at a checkout root.
 *   2. `DSH_HARNESS_ROOT` — the same relocation knob `scripts/link-dsh.mjs` honors.
 *   3. The pinned `link:` targets in this repo's package.json, which is where the linked devDependencies
 *      actually point. This is the host the typecheck and the specs run against.
 *
 * It reads `src/index.ts`/`src/types.ts` when the checkout ships them, and falls back to the built
 * `lib/types/*.d.ts` declarations of a packaged installation. Both carry the service's method names.
 */

/** This repo's root (the spec lives one level down). */
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

interface HostSubagentPackage {
  /** The checkout root the package was found under. */
  root: string
  /** `src/index.ts` or `lib/types/index.d.ts`. */
  index: string
  /** `src/types.ts` or `lib/types/types.d.ts`. */
  types: string
  /** Declared package version, when readable. */
  version: string | null
}

function packageDirCandidates(root: string): string[] {
  return [join(root, 'packages', 'subagent', 'subagent')]
}

function findPackageUnder(root: string): HostSubagentPackage | null {
  for (const pkgDir of packageDirCandidates(root)) {
    const source = { index: join(pkgDir, 'src', 'index.ts'), types: join(pkgDir, 'src', 'types.ts') }
    const built = { index: join(pkgDir, 'lib', 'types', 'index.d.ts'), types: join(pkgDir, 'lib', 'types', 'types.d.ts') }
    for (const layout of [source, built]) {
      if (!existsSync(layout.index) || !existsSync(layout.types)) continue
      let version: string | null = null
      try {
        version = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string }).version ?? null
      } catch {
        // A host without a readable package.json still has source; version is only diagnostic.
      }
      return { root, index: layout.index, types: layout.types, version }
    }
  }
  return null
}

/** Every `link:` target in this repo's devDependencies, with the checkout root each one implies. */
function linkedHarnessRoots(): string[] {
  const roots: string[] = []
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, unknown>
    }
    for (const spec of Object.values(pkg.devDependencies ?? {})) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      let dir = resolve(spec.slice('link:'.length))
      // A dependency under `<checkout>/packages/<group>/<pkg>` is three levels below the root.
      for (let level = 0; level < 6; level += 1) {
        roots.push(dir)
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
  } catch {
    // No package.json: no derived roots; the explicit env knobs still work.
  }
  return roots
}

function locateInstalledHost(): HostSubagentPackage | null {
  const override = process.env.DSH_SUBAGENT_CONTRACT_ROOT
  if (override !== undefined && override !== '') {
    const found = findPackageUnder(resolve(override))
    if (found === null) {
      throw new Error(
        'DSH_SUBAGENT_CONTRACT_ROOT is set to "' + override + '", but it holds no '
        + 'packages/subagent/subagent/{src/lib} contract to read',
      )
    }
    return found
  }
  const harnessRoot = process.env.DSH_HARNESS_ROOT
  const roots = harnessRoot !== undefined && harnessRoot !== ''
    ? [resolve(harnessRoot), ...linkedHarnessRoots()]
    : linkedHarnessRoots()
  for (const root of roots) {
    const found = findPackageUnder(root)
    if (found !== null) return found
  }
  return null
}

/**
 * Method names declared on the host service class. Extracted from the class body so a name that merely
 * appears in a doc comment or a caller does not satisfy the contract.
 */
function serviceMethodNames(indexSource: string): string[] {
  const classAt = indexSource.indexOf('export class SubagentRuntime')
  const body = classAt >= 0 ? indexSource.slice(classAt) : indexSource
  const names = new Set<string>()
  for (const match of body.matchAll(/^ {2}(?:(?:private|protected|public|static|readonly|async)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/gm)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return [...names]
}

/** One named interface's body from a declaration file, or null when the interface is absent. */
function interfaceBody(source: string, name: string): string | null {
  const match = new RegExp('export interface ' + name + '\\s*\\{([\\s\\S]*?)\\n\\}').exec(source)
  return match?.[1] ?? null
}

describe('INSTALLED HOST CONTRACT — every current method the seam resolves exists in the host source', () => {
  const host = locateInstalledHost()

  it('LOCATES the installed host source (a missing checkout must not silently skip this contract)', () => {
    expect(
      host,
      'No installed DSH subagent package was found. Point DSH_HARNESS_ROOT (or DSH_SUBAGENT_CONTRACT_ROOT) at '
      + 'the checkout; skipping would let the next rename pass unnoticed.',
    ).not.toBeNull()
  })

  it('the seam resolves these names FIRST, and every one is declared on the host service', () => {
    const indexSource = readFileSync(host!.index, 'utf8')
    const methods = serviceMethodNames(indexSource)
    const missing = Object.values(SUBAGENT_SEAM_CONTRACT.current).filter((name) => !methods.includes(name))
    expect(
      missing,
      'The seam resolves these host methods FIRST, but the installed host ('
      + (host!.version ?? 'unknown version') + ' at ' + host!.root + ') no longer declares them: '
      + missing.join(', ') + '. Rename the seam with the host — a green suite against old-named fakes is a '
      + 'silent no-op, not a pass.',
    ).toEqual([])
    // Sanity: the extraction really found the service's methods, not an empty string.
    expect(methods.length).toBeGreaterThan(5)
  })

  it('the CURRENT activation contract still has the REQUIRED delivery field the seam passes', () => {
    const typesSource = readFileSync(host!.types, 'utf8')
    const spec = interfaceBody(typesSource, 'SubagentActivationSpec')
    expect(spec, 'SubagentActivationSpec is gone from the host types').not.toBeNull()
    // Required (no `?`) and exactly the two policies the host documents.
    expect(spec).toMatch(/readonly delivery:\s*'parent'\s*\|\s*'caller'/)
  })

  it('SubagentActivation still returns childId (+ local messageId), a result, and dispose()', () => {
    const typesSource = readFileSync(host!.types, 'utf8')
    const activation = interfaceBody(typesSource, 'SubagentActivation')
    expect(activation, 'SubagentActivation is gone from the host types').not.toBeNull()
    expect(activation).toContain('readonly childId')
    // Optional on the host because an external backend has no local inbox; a continuable child has one.
    expect(activation).toMatch(/readonly messageId\?:\s*MessageId/)
    expect(activation).toContain('readonly result:')
    expect(activation).toContain('dispose():')
    // The one-shot path relies on `result`/`dispose`; the continuable path relies on the identities only.
    expect(activation).toMatch(/result:\s*Promise<SubagentResult>/)
  })

  it('the follow-up and kill-switch shapes the seam calls still exist', () => {
    const typesSource = readFileSync(host!.types, 'utf8')
    const sendOptions = interfaceBody(typesSource, 'SubagentSendMessageOptions')
    expect(sendOptions, 'SubagentSendMessageOptions is gone from the host types').not.toBeNull()
    // The adapter supplies a signal because the host types it as REQUIRED.
    expect(sendOptions).toMatch(/readonly signal:\s*AbortSignal/)
    // The kill-switch authority is a TYPE ALIAS on the host (not an interface):
    //   { kind: 'user'; parentSessionId } | { kind: 'ancestor'; agent }
    expect(typesSource, 'SubagentInterruptAuthority is gone from the host types')
      .toMatch(/export type SubagentInterruptAuthority\s*=[\s\S]*?readonly kind: 'user'/)
    expect(typesSource).toMatch(/SubagentInterruptAuthority[\s\S]*?readonly parentSessionId:/)
  })

  it('⚠ the names the seam keeps as LEGACY fallbacks are really retired on this host', () => {
    // This is the other half of the contract: it proves the fallbacks cannot be the live path on THIS host,
    // so a preference that silently reverted to them would be caught by the behaviour specs, not excused by
    // an aliased host. A future host that re-introduces an alias fails here for a deliberate re-review.
    const methods = serviceMethodNames(readFileSync(host!.index, 'utf8'))
    const retired = ['startContinuable', 'drainContinuableChildren', 'drainContinuableDescendants', 'start', 'followup']
    for (const name of retired) {
      expect(
        methods,
        'the installed host now declares "' + name + '", which the seam treats as a LEGACY fallback. '
        + 'Re-check which name is current before changing the preference.',
      ).not.toContain(name)
    }
  })

  it('the seam contract table keeps the current and legacy sets DISJOINT', () => {
    const current = new Set<string>(Object.values(SUBAGENT_SEAM_CONTRACT.current))
    for (const legacy of Object.values(SUBAGENT_SEAM_CONTRACT.legacy)) {
      expect(current.has(legacy), '"' + legacy + '" must not be both current and legacy').toBe(false)
    }
    expect(Object.keys(SUBAGENT_SEAM_CONTRACT.current).length).toBeGreaterThanOrEqual(5)
  })
})
