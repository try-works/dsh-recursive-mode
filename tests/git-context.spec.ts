/**
 * Worktree + branch awareness (R?): gitFacts / isLinkedWorktree /
 * resolveBaseBranch / verifyBranchBase / verifyWorktreeBranch, plus
 * detectGitContext base-vs-worktree branch split and the lint-time
 * verifyRecordedBranches guard.
 *
 * Builds real git repos + linked worktrees to assert live-git behavior
 * (dev/stage/main style promotion source resolution).
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitFacts, isLinkedWorktree, resolveBaseBranch, verifyBranchBase, verifyWorktreeBranch } from '../src/git-context.ts'
import { detectGitContext } from '../src/init-templates.ts'
import { verifyRecordedBranches, getRunDiffBasis } from '../src/ts-lint.ts'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** Fresh git repo with an initial commit on `main`. */
function freshGitRepo(tag: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'wt-' + tag + '-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, 'dummy.txt'), 'hello', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
  return repo
}

/** Create a linked worktree at <repo>/.worktrees/<name> on branch <branch> (based on <base>). */
function createWorktree(repo: string, name: string, branch: string, base = 'main'): string {
  const wtDir = join(repo, '.worktrees', name)
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, wtDir, base], { cwd: repo, stdio: 'ignore' })
  return wtDir
}

describe('git-context.ts — worktree + branch facts', () => {
  it('main checkout: isWorktree=false, branch resolves', () => {
    const repo = freshGitRepo('main')
    try {
      const facts = gitFacts(repo)
      expect(facts.isWorktree).toBe(false)
      expect(facts.branch).toBe('main')
      expect(facts.headSha).toBeTruthy()
      expect(facts.detached).toBe(false)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('linked worktree: isWorktree=true, distinct branch', () => {
    const repo = freshGitRepo('linked')
    try {
      const wt = createWorktree(repo, 'feature', 'dev/feature-a')
      const facts = gitFacts(wt)
      expect(facts.isWorktree).toBe(true)
      expect(facts.branch).toBe('dev/feature-a')
      expect(facts.toplevel).toBe(wt.replace(/\\/g, '/').replace(/\/$/, ''))
      // base (main) is an ancestor of the feature branch
      const baseCheck = verifyBranchBase(wt, 'main', 'dev/feature-a')
      expect(baseCheck.ok).toBe(true)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('resolveBaseBranch infers the upstream promotion source (dev/stage/main)', () => {
    const repo = freshGitRepo('upstream')
    try {
      // create a `dev` branch to act as the upstream promotion source
      execFileSync('git', ['checkout', '-q', '-b', 'dev'], { cwd: repo, stdio: 'ignore' })
      writeFileSync(join(repo, 'devfile.txt'), 'dev', 'utf8')
      execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'dev work'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo, stdio: 'ignore' })
      // feature worktree with upstream tracking dev -> base resolves to dev
      const wt = createWorktree(repo, 'feature', 'feature/x')
      execFileSync('git', ['branch', '--set-upstream-to', 'dev', 'feature/x'], { cwd: wt, stdio: 'ignore' })
      const facts = gitFacts(wt)
      expect(facts.upstreamBranch).toBe('dev')
      expect(resolveBaseBranch(facts)).toBe('dev')
      // main checkout with upstream origin/main -> base resolves to main
      execFileSync('git', ['branch', '--set-upstream-to', 'dev', 'main'], { cwd: repo, stdio: 'ignore' })
      const mainFacts = gitFacts(repo)
      expect(mainFacts.upstreamBranch).toBe('dev')
      expect(resolveBaseBranch(mainFacts)).toBe('dev')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('detectGitContext records distinct base vs worktree branch in a worktree', () => {
    const repo = freshGitRepo('detect')
    try {
      // create a `dev` branch as the promotion source
      execFileSync('git', ['checkout', '-q', '-b', 'dev'], { cwd: repo, stdio: 'ignore' })
      writeFileSync(join(repo, 'devfile.txt'), 'dev', 'utf8')
      execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'dev work'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo, stdio: 'ignore' })
      const wt = createWorktree(repo, 'feature', 'feature/b')
      execFileSync('git', ['branch', '--set-upstream-to', 'dev', 'feature/b'], { cwd: wt, stdio: 'ignore' })
      const { context } = detectGitContext(wt)
      expect(context.isWorktree).toBe(true)
      expect(context.upstreamBranch).toBe('dev')
      expect(context.baseBranch).toBe('dev')
      expect(context.worktreeBranch).toBe('feature/b')
      expect(context.baseBranch).not.toBe(context.worktreeBranch)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('verifyWorktreeBranch fails when the recorded branch does not match live HEAD', () => {
    const repo = freshGitRepo('mismatch')
    try {
      const wt = createWorktree(repo, 'feature', 'feature/c')
      expect(verifyWorktreeBranch(wt, 'feature/c').ok).toBe(true)
      expect(verifyWorktreeBranch(wt, 'main').ok).toBe(false)
      expect(verifyWorktreeBranch(wt, 'feature/c').reason).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('verifyBranchBase fails when the worktree branch is not based on the recorded base', () => {
    const repo = freshGitRepo('notbased')
    try {
      // base `dev` branch that diverges; feature based on main, not dev
      git(repo, 'checkout', '-q', '-b', 'dev')
      writeFileSync(join(repo, 'devfile.txt'), 'dev', 'utf8')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'dev work')
      git(repo, 'checkout', '-q', 'main')
      const wt = createWorktree(repo, 'feature', 'feature/d')
      // feature is based on main; recorded base 'dev' is NOT an ancestor
      expect(verifyBranchBase(wt, 'dev', 'feature/d').ok).toBe(false)
      expect(verifyBranchBase(wt, 'main', 'feature/d').ok).toBe(true)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})

describe('ts-lint verifyRecordedBranches — lint-time worktree/branch guard', () => {
  it('emits FAIL when recorded worktree branch mismatches live checkout', () => {
    const repo = freshGitRepo('lintmiss')
    try {
      const wt = createWorktree(repo, 'feature', 'feature/e')
      const runDir = join(wt, '.recursive', 'run', 'r1')
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, '00-worktree.md'), [
        '## Diff Basis For Later Audits',
        '- Base branch: `main`',
        '- Worktree branch: `wrong-branch`', // intentionally wrong
      ].join('\n'), 'utf8')
      const basis = getRunDiffBasis(runDir)
      const fails = verifyRecordedBranches(wt, basis, runDir)
      expect(fails.some(m => /wrong-branch/.test(m))).toBe(true)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('passes when recorded worktree + base branch match live git', () => {
    const repo = freshGitRepo('lintok')
    try {
      const wt = createWorktree(repo, 'feature', 'feature/f')
      const runDir = join(wt, '.recursive', 'run', 'r1')
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, '00-worktree.md'), [
        '## Diff Basis For Later Audits',
        '- Base branch: `main`',
        '- Worktree branch: `feature/f`',
      ].join('\n'), 'utf8')
      const basis = getRunDiffBasis(runDir)
      const fails = verifyRecordedBranches(wt, basis, runDir)
      expect(fails).toEqual([])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('no branch fields recorded -> defer, no FAIL', () => {
    const repo = freshGitRepo('lintnone')
    try {
      const runDir = join(repo, '.recursive', 'run', 'r1')
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, '00-worktree.md'), '## Diff Basis For Later Audits\n- Normalized diff command: `git diff --name-only HEAD`\n', 'utf8')
      const basis = getRunDiffBasis(runDir)
      expect(verifyRecordedBranches(repo, basis, runDir)).toEqual([])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
