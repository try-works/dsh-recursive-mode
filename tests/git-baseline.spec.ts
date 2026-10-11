/**
 * FU — THE GIT BASELINE HOLE: a repo with NO COMMITS used to pass the `gitRequired` notice silently
 * (`git rev-parse --git-dir` succeeds in it, so the old single null-check never fired), which locked
 * ZERO of twelve artifacts because Phase 0 recorded the literal `<resolve-before-locking>` placeholder
 * and lint died resolving it. Three things are pinned here, against REAL temp repositories:
 *
 *   1. `gitBaselineProblem` is ONE total verdict naming each unusable-baseline state distinctly, with a
 *      non-repo tested BEFORE no-commits so a non-repo never reports the misleading second cause.
 *   2. `recursive_phase`'s `gitRequired` fires for all three states (not just the not-a-repo one).
 *   3. `initRun` makes the first commit itself in a no-commit repo, staging ONLY the paths that call
 *      scaffolded — an unrelated untracked file in the same repo must NOT enter that commit — and the
 *      commit is best-effort: a failure (hook, no identity, etc.) reports into `result.firstCommit` and
 *      never fails init.
 *
 * ⚠ WHAT WOULD MAKE THESE ASSERTIONS PASS VACUOUSLY:
 *   - asserting only "a commit exists" would pass over a `git add -A` that swept in unrelated work, so
 *     the unrelated-file case asserts the tree does NOT contain the unrelated path; the mutation pass
 *     swaps the explicit pathspecs for `git add -A` and confirms THIS assertion goes red.
 *   - asserting only "gitRequired is a string" would pass over the wrong cause, so the no-commits case
 *     asserts the notice names NO COMMITS and NOT the not-a-repo sentence.
 *   - the identity case asserts the author in `git log` is the PLACEHOLDER, not merely that the commit
 *     landed — a retry that silently inherited ambient config would fail that.
 *   - the "already has a commit" case asserts the SHA is UNCHANGED, so a stray amend/extra commit fails.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RecursiveRuntime } from '../src/runtime.ts'
import { createRecursiveInitTool } from '../src/recursive_init.tool.ts'
import { gitFacts, gitBaselineProblem } from '../src/git-context.ts'
import { GIT_REQUIRED_NOTICE, GIT_NO_COMMITS_NOTICE, GIT_DETACHED_HEAD_NOTICE } from '../src/phase-rules.ts'

const RUN = 'baseline-run'
const IDENTITY = { name: 'baseline fixture', email: 'fixture@example.invalid' }

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A git repo with NO commits. `identity` writes a LOCAL user config (deterministic, host-independent). */
function emptyRepo(tag: string, identity = true): string {
  const repo = mkdtempSync(join(tmpdir(), 'rm-baseline-' + tag + '-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  if (identity) {
    execFileSync('git', ['config', 'user.email', IDENTITY.email], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', IDENTITY.name], { cwd: repo, stdio: 'ignore' })
  }
  return repo
}

/** A git repo WITH one commit on `main`. */
function committedRepo(tag: string): string {
  const repo = emptyRepo(tag)
  writeFileSync(join(repo, 'seed.txt'), 'seed\n', 'utf8')
  execFileSync('git', ['add', '--', 'seed.txt'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo, stdio: 'ignore' })
  return repo
}

/** The runtime under test, constructed the way the existing specs construct it. */
function makeRuntime(repo: string): { ctx: Context; runtime: RecursiveRuntime } {
  const ctx = new Context()
  return { ctx, runtime: new RecursiveRuntime(ctx, { repoRoot: repo }) }
}

/** True when HEAD resolves (i.e. the repo has at least one commit). */
function hasHead(repo: string): boolean {
  try {
    git(repo, 'rev-parse', '--verify', 'HEAD^{commit}')
    return true
  } catch {
    return false
  }
}

describe('gitBaselineProblem — one verdict, three distinct causes, not-a-repo first', () => {
  it('names NO COMMITS in a zero-commit repository (where gitDir is NOT null)', () => {
    const repo = emptyRepo('nocommit')
    try {
      const facts = gitFacts(repo)
      // The measured hole: `git rev-parse --git-dir` SUCCEEDS here, so the old null-check missed it.
      expect(facts.gitDir).not.toBeNull()
      expect(facts.headSha).toBeNull()
      expect(gitBaselineProblem(facts)).toBe(GIT_NO_COMMITS_NOTICE)
      expect(gitBaselineProblem(facts)).toContain('NO COMMITS')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('names not-a-repository FIRST, never the misleading second cause', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-baseline-nonrepo-'))
    try {
      const facts = gitFacts(dir)
      expect(facts.gitDir).toBeNull()
      expect(facts.headSha).toBeNull()
      // A non-repo is trivially "no commits" too; the verdict must not report that instead.
      expect(gitBaselineProblem(facts)).toBe(GIT_REQUIRED_NOTICE)
      expect(gitBaselineProblem(facts)).not.toContain('NO COMMITS')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('names DETACHED HEAD when HEAD resolves but is not on a branch', () => {
    const repo = committedRepo('detached')
    try {
      git(repo, 'checkout', '--quiet', '--detach')
      const facts = gitFacts(repo)
      expect(facts.gitDir).not.toBeNull()
      expect(facts.headSha).not.toBeNull()
      expect(facts.detached).toBe(true)
      expect(gitBaselineProblem(facts)).toBe(GIT_DETACHED_HEAD_NOTICE)
      expect(gitBaselineProblem(facts)).toContain('DETACHED HEAD')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('is null when the baseline is usable (a branch with a commit)', () => {
    const repo = committedRepo('usable')
    try {
      expect(gitBaselineProblem(gitFacts(repo))).toBeNull()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})

describe('recursive_phase gitRequired — all three unusable-baseline states fire', () => {
  it('not a repository -> the not-a-repo notice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-baseline-phase-nonrepo-'))
    try {
      const { ctx, runtime } = makeRuntime(dir)
      await runtime.initRun(RUN)
      const rules = await runtime.phaseRules(RUN)
      expect(rules?.gitRequired).toBe(GIT_REQUIRED_NOTICE)
      expect(rules?.gitRequired).toContain('not a git repository')
      await ctx.fiber.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('no commits -> the no-commits notice (NOT the not-a-repo sentence)', async () => {
    const repo = emptyRepo('phase-nocommit')
    try {
      // The run dir is created WITHOUT initRun, because initRun now closes this state by committing.
      mkdirSync(join(repo, '.recursive', 'run', RUN), { recursive: true })
      writeFileSync(join(repo, '.recursive', 'run', RUN, '00-requirements.md'), 'Run: ' + RUN + '\n', 'utf8')
      expect(hasHead(repo)).toBe(false)
      const { ctx, runtime } = makeRuntime(repo)
      const rules = await runtime.phaseRules(RUN)
      expect(rules?.gitRequired).toBe(GIT_NO_COMMITS_NOTICE)
      expect(rules?.gitRequired).toContain('NO COMMITS')
      expect(rules?.gitRequired).not.toContain('not a git repository')
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('detached HEAD -> the detached notice', async () => {
    const repo = committedRepo('phase-detached')
    try {
      const { ctx, runtime } = makeRuntime(repo)
      await runtime.initRun(RUN)
      git(repo, 'checkout', '--quiet', '--detach')
      const rules = await runtime.phaseRules(RUN)
      expect(rules?.gitRequired).toBe(GIT_DETACHED_HEAD_NOTICE)
      expect(rules?.gitRequired).toContain('DETACHED HEAD')
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})

describe('initRun first commit — stages only its own paths, best-effort', () => {
  it('a zero-commit repo: exactly one commit, tree has init paths, unrelated file is NOT committed', async () => {
    const repo = emptyRepo('firstcommit')
    try {
      writeFileSync(join(repo, 'unrelated.txt'), 'DO NOT COMMIT ME\n', 'utf8')
      const { ctx, runtime } = makeRuntime(repo)
      const result = await runtime.initRun(RUN)

      expect(result.firstCommit).toBeDefined()
      expect(result.firstCommit!.committed).toBe(true)
      expect(result.firstCommit!.sha).toBeTruthy()
      expect(result.firstCommit!.error).toBeNull()
      // The local identity configured by the fixture is used; no placeholder is needed.
      expect(result.firstCommit!.usedPlaceholderIdentity).toBe(false)
      // Staged paths are exactly the FILES init created (12 phase artifacts), never the scaffold dirs.
      expect(result.firstCommit!.stagedPaths.length).toBe(12)
      expect(result.firstCommit!.stagedPaths.every((p) => p.endsWith('.md'))).toBe(true)
      expect(result.firstCommit!.stagedPaths).toContain('.recursive/run/' + RUN + '/00-requirements.md')

      // Exactly one commit, and it is init's.
      expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1')
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(result.firstCommit!.sha)

      // The tree contains init's own paths…
      const tree = git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean)
      expect(tree).toContain('.recursive/run/' + RUN + '/00-requirements.md')
      expect(tree).toContain('.recursive/run/' + RUN + '/08-memory-impact.md')
      // …and the CRITICAL one: the unrelated untracked file is NOT in that commit.
      expect(tree).not.toContain('unrelated.txt')
      // It is still there, untracked — the commit did not delete or stage it.
      expect(existsSync(join(repo, 'unrelated.txt'))).toBe(true)
      // ⚠ AND THE INDEX TOO: init stages EXPLICIT PATHSPECS, so nothing beyond the created paths was
      // ever added. This is the assertion that makes the `git add -A` mutation go red — the commit is
      // additionally restricted with `--only`, so a `-A` staging sweep would otherwise be invisible.
      const stagedAfter = git(repo, 'diff', '--cached', '--name-only').split(/\r?\n/).filter(Boolean)
      expect(stagedAfter).not.toContain('unrelated.txt')
      const untrackedAfter = git(repo, 'ls-files', '--others', '--exclude-standard').split(/\r?\n/).filter(Boolean)
      expect(untrackedAfter).toContain('unrelated.txt')

      // The run is actually LOCKABLE now: init re-prefilled 00-worktree.md with the new HEAD, so the
      // `<resolve-before-locking>` placeholder is gone and the diff basis resolves to init's commit.
      const worktreeDoc = readFileSync(join(repo, '.recursive', 'run', RUN, '00-worktree.md'), 'utf8')
      expect(worktreeDoc).not.toContain('<resolve-before-locking>')
      expect(worktreeDoc).toContain('- Base commit: `' + result.firstCommit!.sha + '`')

      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('a repo that already has a commit: no new commit, firstCommit absent, verdict null', async () => {
    const repo = committedRepo('already')
    try {
      const before = git(repo, 'rev-parse', 'HEAD')
      const { ctx, runtime } = makeRuntime(repo)
      const result = await runtime.initRun(RUN)
      expect(result.firstCommit).toBeUndefined()
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
      expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1')
      expect(gitBaselineProblem(gitFacts(repo))).toBeNull()
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('not a repository: no commit attempted, nothing throws, the notice fires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-baseline-nonrepo-init-'))
    try {
      const { ctx, runtime } = makeRuntime(dir)
      const result = await runtime.initRun(RUN)
      expect(result.firstCommit).toBeUndefined()
      expect(existsSync(join(dir, '.git'))).toBe(false)
      const rules = await runtime.phaseRules(RUN)
      expect(rules?.gitRequired).toBe(GIT_REQUIRED_NOTICE)
      await ctx.fiber.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('missing identity: the commit lands via the -c placeholder, and the result records it', async () => {
    // No LOCAL identity, and every ambient source suppressed for the git children initRun spawns.
    const repo = emptyRepo('identity', false)
    const saved: Record<string, string | undefined> = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
      EMAIL: process.env.EMAIL,
    }
    process.env.GIT_CONFIG_GLOBAL = 'NUL'
    process.env.GIT_CONFIG_SYSTEM = 'NUL'
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key]
    try {
      const { ctx, runtime } = makeRuntime(repo)
      const result = await runtime.initRun(RUN)
      expect(result.firstCommit).toBeDefined()
      expect(result.firstCommit!.committed).toBe(true)
      expect(result.firstCommit!.usedPlaceholderIdentity).toBe(true)
      expect(result.firstCommit!.sha).toBeTruthy()
      // The author in the log is the DISCLOSED placeholder, not a silently-wrong person.
      expect(git(repo, 'log', '-1', '--format=%an <%ae>')).toBe('recursive-init <recursive-init@invalid.local>')
      // And the repo/global configuration was NOT mutated: `git config user.name` still resolves to nothing.
      let configured = ''
      try { configured = git(repo, 'config', 'user.name') } catch { configured = '' }
      expect(configured).toBe('')
      await ctx.fiber.dispose()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('a failing pre-commit hook: init still succeeds and reports the failure', async () => {
    const repo = emptyRepo('hookfail')
    try {
      writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', 'utf8')
      const { ctx, runtime } = makeRuntime(repo)
      // init must NOT throw.
      const result = await runtime.initRun(RUN)
      // The run still scaffolded normally.
      expect(result.created.length).toBeGreaterThan(0)
      expect(existsSync(join(repo, '.recursive', 'run', RUN, '00-worktree.md'))).toBe(true)
      // The convenience commit failed and is reported, not swallowed.
      expect(result.firstCommit).toBeDefined()
      expect(result.firstCommit!.committed).toBe(false)
      expect(result.firstCommit!.error).toMatch(/git commit failed/)
      expect(hasHead(repo)).toBe(false)
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})

describe('recursive_init TOOL — the model SEES the commit outcome', () => {
  it('the tool result carries firstCommit and its render says what happened', async () => {
    const repo = emptyRepo('toolrender')
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
      const tool = createRecursiveInitTool(ctx.recursive)
      const dispose = ctx.tools.register(tool)
      const out = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('baseline-tool'),
        name: 'recursive_init',
        arguments: { runId: RUN },
        agent: { session: { header: { cwd: repo } } },
      } as never)
      const value = out.value as { firstCommit?: { committed: boolean; sha: string | null; stagedPaths: string[] }; error?: string }
      // 1. THE FIELD IS ON THE TOOL RESULT — this is the additive result field the caller reads.
      expect(value.error).toBeUndefined()
      expect(value.firstCommit).toBeDefined()
      expect(value.firstCommit!.committed).toBe(true)
      expect(value.firstCommit!.sha).toBeTruthy()
      // 2. AND THE RENDER NAMES IT IN PROSE, so it is not invisible work inside the JSON. `defineTool`
      //    passes the declared render through unchanged onto the returned definition, which is exactly the
      //    function the tool runtime turns into the text content a model reads.
      expect(tool.output?.render).toBeTypeOf('function')
      const parts = tool.output!.render({ runId: RUN }, value as never) as Array<{ type: string; text?: string }>
      const text = parts.map((p) => p.text ?? '').join('\n')
      expect(text).toContain('recursive_init made the first commit')
      expect(text).toContain(value.firstCommit!.sha!)
      expect(text).toContain('never unrelated work')
      dispose()
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
