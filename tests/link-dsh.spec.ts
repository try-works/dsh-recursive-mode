/**
 * T34 — the repo must be installable from ANY location.
 *
 * THE DEFECT. `package.json` declares the harness dependencies as absolute `link:`
 * specs, but pnpm records the target RELATIVE in the lockfile
 * (`version: link:../../deepseek-harness/...`). Installing therefore only produces
 * working links when the repo sits at exactly the depth the lockfile assumed — two
 * levels below the drive root, beside the checkout. Clone it deeper or on another
 * drive and every `@deepseek-ai/*` module is unresolvable.
 *
 * This spec exercises the REAL command (`node scripts/link-dsh.mjs <repo>`) rather
 * than importing the module, for two reasons: the script must run on plain Node with
 * NO dependencies (it cannot depend on the very links it creates — that would be
 * circular), and running it is what actually proves the entry path works. The temps
 * it builds reproduce the broken shape: recorded targets that exist, and a repo whose
 * depth makes the lockfile's relative path meaningless.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, lstatSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'link-dsh.mjs')

interface Fixture {
  repo: string
  checkout: string
  dispose: () => void
}

/**
 * A repo whose `package.json` records ABSOLUTE link targets into a temp "checkout",
 * which is what this repo really looks like before pnpm rewrites them relative.
 */
function fixture(options: { packages?: string[]; targetsExist?: boolean } = {}): Fixture {
  const packages = options.packages ?? ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis', 'unrelated-dep']
  const root = mkdtempSync(join(tmpdir(), 'rm-linkdsh-'))
  const repo = join(root, 'nested', 'deeper', 'repo')
  const checkout = join(root, 'checkout')
  mkdirSync(repo, { recursive: true })

  const devDependencies: Record<string, string> = { unrelated: '^1.0.0' }
  for (const name of packages) {
    if (name === 'unrelated-dep') {
      devDependencies['unrelated-dep'] = '^2.0.0'
      continue
    }
    const dir = join(checkout, 'packages', name.split('/')[1] as string)
    if (options.targetsExist !== false) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }), 'utf8')
      writeFileSync(join(dir, 'index.js'), 'export const marker = ' + JSON.stringify(name) + '\n', 'utf8')
    }
    devDependencies[name] = 'link:' + dir.replace(/\\/g, '/')
  }
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture-repo', devDependencies }, null, 2), 'utf8')

  return {
    repo,
    checkout,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** Run the real CLI exactly as the package script does. */
function run(repo: string, env: Record<string, string> = {}): { out: string; status: number } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, repo], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { out, status: 0 }
  } catch (err) {
    const e = err as { stdout?: string; status?: number }
    return { out: e.stdout ?? '', status: e.status ?? 1 }
  }
}

describe('T34 — the harness links are rebuilt from package.json, not the lockfile', () => {
  it('creates WORKING links for every scoped link: dependency', () => {
    const f = fixture()
    try {
      const { out, status } = run(f.repo)
      expect(status).toBe(0)
      expect(out).toContain('linked 2')
      // A link that resolves is the whole point: read a file THROUGH it.
      const through = join(f.repo, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js')
      expect(existsSync(through)).toBe(true)
      expect(readFileSync(through, 'utf8')).toContain('@deepseek-ai/dsh-tools')
    } finally {
      f.dispose()
    }
  })

  it('leaves NON-scoped dependencies alone', () => {
    const f = fixture()
    try {
      run(f.repo)
      expect(existsSync(join(f.repo, 'node_modules', 'unrelated-dep'))).toBe(false)
    } finally {
      f.dispose()
    }
  })

  it('is IDEMPOTENT: a second run re-links nothing', () => {
    const f = fixture()
    try {
      run(f.repo)
      const second = run(f.repo)
      expect(second.status).toBe(0)
      expect(second.out).toContain('linked 0')
      expect(second.out).toContain('already correct 2')
    } finally {
      f.dispose()
    }
  })

  it('REPAIRS a link that points somewhere stale (the moved-checkout case)', () => {
    const f = fixture()
    try {
      const stale = join(f.repo, 'node_modules', '@deepseek-ai')
      mkdirSync(stale, { recursive: true })
      // A leftover plain directory where a link should be — pnpm leaves these behind
      // when a previous install could not resolve the target.
      mkdirSync(join(stale, 'dsh-tools'), { recursive: true })
      run(f.repo)
      expect(lstatSync(join(stale, 'dsh-tools')).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(stale, 'dsh-tools', 'index.js'), 'utf8')).toContain('dsh-tools')
    } finally {
      f.dispose()
    }
  })

  it('DSH_HARNESS_ROOT relocates the whole set when the checkout MOVED', () => {
    const f = fixture()
    try {
      // A second checkout at a different path, same layout.
      const moved = join(f.repo, '..', '..', '..', 'moved-checkout')
      mkdirSync(join(moved, 'packages', 'dsh-tools'), { recursive: true })
      writeFileSync(join(moved, 'packages', 'dsh-tools', 'package.json'), '{"name":"@deepseek-ai/dsh-tools"}', 'utf8')
      writeFileSync(join(moved, 'packages', 'dsh-tools', 'index.js'), 'export const marker = "moved"\n', 'utf8')
      const { status } = run(f.repo, { DSH_HARNESS_ROOT: moved })
      expect(status).toBe(0)
      // dsh-tools exists in the moved root and resolves there...
      const linked = readFileSync(join(f.repo, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'), 'utf8')
      expect(linked).toContain('moved')
      // ...while cordis does NOT exist there, so it is reported, not fabricated.
      expect(existsSync(join(f.repo, 'node_modules', '@deepseek-ai', 'cordis'))).toBe(false)
    } finally {
      f.dispose()
    }
  })

  it('REPAIRS a BROKEN JUNCTION, which is the state a wrong-depth clone leaves', () => {
    // THE CASE THAT MATTERS, and the one the plain-directory case above does NOT
    // cover: pnpm at the wrong depth creates links to a relative path that does not
    // exist. `rmSync(recursive: true)` does not reliably remove such a junction, so
    // the removal silently failed and every symlinkSync after it threw EEXIST — a
    // whole clone left unlinked behind a cheerful "unresolved 15".
    const f = fixture()
    try {
      const scoped = join(f.repo, 'node_modules', '@deepseek-ai')
      mkdirSync(scoped, { recursive: true })
      symlinkSync(join(f.repo, '..', '..', 'no-such-checkout', 'vendor', 'cordis'), join(scoped, 'cordis'), 'junction')
      expect(existsSync(join(scoped, 'cordis', 'index.js'))).toBe(false)

      const { out, status } = run(f.repo)
      expect(status).toBe(0)
      expect(out).toContain('linked 2')
      expect(out).not.toContain('FAILED to link')
      // The broken junction was replaced with a working link.
      expect(readFileSync(join(scoped, 'cordis', 'index.js'), 'utf8')).toContain('@deepseek-ai/cordis')
    } finally {
      f.dispose()
    }
  })

  it('REPLACES a plain file squatting on the link path', () => {
    // Not a failure case but a real one: a stray file (or a half-written install)
    // where a link belongs is removed and replaced, rather than aborting the rest of
    // the links. A forced symlink FAILURE is environment-specific and is covered by
    // the `errors` array the CLI prints unconditionally — the property that matters
    // is that a failure can never be reported as success, which the report shape
    // guarantees (missing is populated from the same branch that records the error).
    const f = fixture()
    try {
      const scoped = join(f.repo, 'node_modules', '@deepseek-ai')
      mkdirSync(scoped, { recursive: true })
      writeFileSync(join(scoped, 'dsh-tools'), 'in the way', 'utf8')
      const { out, status } = run(f.repo)
      expect(status).toBe(0)
      expect(out).toContain('linked 2')
      expect(readFileSync(join(scoped, 'dsh-tools', 'index.js'), 'utf8')).toContain('@deepseek-ai/dsh-tools')
    } finally {
      f.dispose()
    }
  })

  it('an ABSENT checkout degrades with a clear message and exit 0, never a crash', () => {
    const f = fixture({ targetsExist: false })
    try {
      const { out, status } = run(f.repo)
      // Exit 0 on purpose: a machine without the harness can still read the repo, and
      // the failure it eventually sees is the honest "this module is not linked".
      expect(status).toBe(0)
      expect(out).toContain('DSH_HARNESS_ROOT')
      expect(out).toContain('WITHOUT links')
    } finally {
      f.dispose()
    }
  })

  it('reports a repo with nothing to link instead of pretending it did work', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-linknone-'))
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"x","devDependencies":{"left-pad":"^1"}}', 'utf8')
      const { out, status } = run(root)
      expect(status).toBe(0)
      expect(out).toContain('no @deepseek-ai/* link: dependencies')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
