import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { requirementsContent, worktreeContent, detectGitContext, type GitContext } from '../src/init-templates.ts'

const GOLDEN = fileURLToPath(new URL('./fixtures/recursive-init-golden', import.meta.url))

/** The repo root the golden was captured in (parity: it is printed verbatim). */
const GOLDEN_ROOT = 'D:\\DEV\\tmp\\r5-init-golden'
/** The HEAD commit of that capture-time repo (parity: printed in four places). */
const GOLDEN_SHA = 'd1026ee77d022fde4c5900b2e6af5a34e9dd02e0'

/**
 * The git facts the golden fixture encodes, as literals.
 *
 * This spec used to recover them by calling `detectGitContext(GOLDEN_ROOT)`
 * against the capture-time temp repo. That made a byte-parity assertion depend
 * on mutable state outside the repository, and it broke the moment that temp
 * repo stopped resolving — its `.git` survived but the repository did not
 * (`git rev-parse` reports "not a git repository"), so detection returned `{}`
 * and the template fell back to `<resolve-before-locking>`. The failure read as
 * a code regression when nothing in `src/` had changed.
 *
 * `worktreeContent` takes the context as a PARAMETER, so the spec supplies it.
 * The assertion stays byte-exact and now has no ambient input. Coverage of the
 * detection path itself — which the old arrangement provided only by accident —
 * lives in the `detectGitContext` block below, against a repo this spec creates.
 */
const GOLDEN_CONTEXT: Partial<GitContext> = {
  baselineType: 'local commit',
  baselineReference: GOLDEN_SHA,
  comparisonReference: 'working-tree',
  normalizedBaseline: GOLDEN_SHA,
  normalizedComparison: 'working-tree',
  normalizedDiffCommand: 'git diff --name-only ' + GOLDEN_SHA,
  baseBranch: 'master',
  worktreeBranch: 'master',
  baseCommit: GOLDEN_SHA,
  isWorktree: false,
  upstreamBranch: null,
  notes:
    'recursive-init prefilled this executable diff basis from the current HEAD commit. If Phase 0 later changes the chosen baseline, update every diff-basis field and rerun lint before locking.',
}

/** Run git in `dir`, capturing stdout only (stderr suppressed, never throws). */
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** Create a throwaway repo with one commit so detection has real facts to read. */
function makeRepo(branch: string): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'recursive-gitctx-'))
  git(dir, 'init', '-q', '-b', branch)
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'Recursive Mode Test')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  git(dir, 'add', 'seed.txt')
  git(dir, 'commit', '-q', '-m', 'seed')
  return { dir, head: git(dir, 'rev-parse', 'HEAD') }
}

describe('init-templates canonical parity', () => {
  it('requirementsContent matches canonical recursive-init (934 B)', () => {
    const golden = readFileSync(join(GOLDEN, '00-requirements.md'), 'utf8')
    const got = requirementsContent('r5-golden', 'feature', '')
    expect(got).toBe(golden)
  })

  it('worktreeContent matches canonical recursive-init (2910 B) with git context', () => {
    const golden = readFileSync(join(GOLDEN, '00-worktree.md'), 'utf8')
    const got = worktreeContent('r5-golden', GOLDEN_ROOT, GOLDEN_CONTEXT, null)
    expect(got).toBe(golden)
  })
})

describe('detectGitContext — hermetic', () => {
  it('prefills the executable diff basis from a live repo HEAD', () => {
    const { dir, head } = makeRepo('main')
    try {
      const { context, error } = detectGitContext(dir)
      expect(error).toBeNull()
      expect(context.baseCommit).toBe(head)
      expect(context.baselineReference).toBe(head)
      expect(context.normalizedBaseline).toBe(head)
      expect(context.normalizedDiffCommand).toBe('git diff --name-only ' + head)
      expect(context.baselineType).toBe('local commit')
      expect(context.comparisonReference).toBe('working-tree')
      expect(context.baseBranch).toBe('main')
      expect(context.worktreeBranch).toBe('main')

      // The prefill must round-trip into the template as a resolved basis.
      const doc = worktreeContent('r6-live', dir, context, error)
      expect(doc).toContain('- Base commit: `' + head + '`')
      expect(doc).toContain('- Normalized diff command: `git diff --name-only ' + head + '`')
      expect(doc).not.toContain('<resolve-before-locking>')
      expect(doc).toContain('detected the current repository context and prefilled the Phase 0 diff basis')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to the placeholder path when HEAD cannot be resolved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recursive-nogit-'))
    try {
      const { context, error } = detectGitContext(dir)
      expect(context).toEqual({})
      expect(error).toMatch(/Unable to resolve HEAD commit for Phase 0 diff basis prefill/)
      // The template must remain lockable-by-hand rather than throwing.
      const doc = worktreeContent('r7-nogit', dir, context, error)
      expect(doc).toContain('- Base commit: `<resolve-before-locking>`')
      expect(doc).toContain('could not prefill the Phase 0 diff basis automatically')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
