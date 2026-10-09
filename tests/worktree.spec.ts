/**
 * Worktree + promotion operations (R?): createLinkedWorktree and promoteBranch
 * against real git repos + linked worktrees, including the dev/stage/main
 * fast-forward promotion path and the "target checked out in a worktree" case.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLinkedWorktree, promoteBranch, listWorktrees, findWorktreeForBranch } from '../src/worktree.ts'
import { createRecursiveWorktreeTool } from '../src/recursive_worktree.tool.ts'
import { createRecursiveInitTool } from '../src/recursive_init.tool.ts'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RecursiveRuntime } from '../src/runtime.ts'
import { TOOL_ERRORS } from '../src/errors.ts'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/**
 * EVERY ref under `prefix`, as an array, so "no branch was created" can be
 * asserted EXACTLY rather than by trying to look up one guessed name.
 *
 * `git branch --list recursive/..\escaped-run` cannot answer this question: the
 * id is a malformed ref, so the lookup fails for reasons that have nothing to do
 * with whether a branch exists, and a glob would be a second thing to get wrong.
 * `for-each-ref` with a prefix lists what IS in the namespace, which is the
 * question the test actually has.
 */
function refsUnder(repo: string, prefix: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname)', prefix).split(/\r?\n/).filter((line) => line !== '')
}

function freshGitRepo(tag: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'wt-op-' + tag + '-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, 'dummy.txt'), 'hello', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
  return repo
}

describe('worktree.ts — createLinkedWorktree', () => {
  it('creates a linked worktree on a recursive/<runId> branch', () => {
    const repo = freshGitRepo('create')
    try {
      const result = createLinkedWorktree({ repoRoot: repo, runId: '03-fix-bug' })
      expect(result.ok).toBe(true)
      expect(existsSync(result.worktreeDir)).toBe(true)
      expect(result.worktreeBranch).toBe('recursive/03-fix-bug')
      // worktree branch cut from main
      expect(git(repo, 'branch', '--show-current')).toBe('main')
      expect(git(result.worktreeDir, 'branch', '--show-current')).toBe('recursive/03-fix-bug')
      // listed as a linked worktree
      expect(listWorktrees(repo).some(w => w.branch === 'recursive/03-fix-bug')).toBe(true)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('refuses to create a worktree over an existing run directory', () => {
    const repo = freshGitRepo('existing')
    try {
      // an in-progress run dir exists at .recursive/run/<runId>
      const runDir = join(repo, '.recursive', 'run', '03-fix-bug')
      mkdirSync(runDir, { recursive: true })
      const result = createLinkedWorktree({ repoRoot: repo, runId: '03-fix-bug', worktreeBranch: 'recursive/03-fix-bug' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('already exists')
      expect(existsSync(join(repo, '.worktrees', '03-fix-bug'))).toBe(false)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})

describe('worktree.ts — promoteBranch (dev/stage/main fast-forward)', () => {
  it('creates the target branch on first promotion', () => {
    const repo = freshGitRepo('promote-first')
    try {
      // dev branch with a new commit
      git(repo, 'checkout', '-q', '-b', 'dev')
      writeFileSync(join(repo, 'dev.txt'), 'd', 'utf8')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'dev work')
      const result = promoteBranch({ repoRoot: repo, fromBranch: 'dev', toBranch: 'stage' })
      expect(result.ok).toBe(true)
      expect(result.action).toBe('created')
      // stage now points at dev
      expect(git(repo, 'rev-parse', 'stage')).toBe(git(repo, 'rev-parse', 'dev'))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('fast-forwards the target branch when it is behind the source', () => {
    const repo = freshGitRepo('promote-ff')
    try {
      git(repo, 'checkout', '-q', '-b', 'dev')
      // main has a commit; dev is at main initially; now dev advances
      writeFileSync(join(repo, 'dev.txt'), 'd', 'utf8')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'dev work')
      // promote main -> dev (main is ancestor of dev) => fast-forward dev to dev? no.
      // promote dev -> stage (stage created at dev)
      promoteBranch({ repoRoot: repo, fromBranch: 'dev', toBranch: 'stage' })
      // advance dev further, then promote stage (behind) -> dev (ahead) = ff
      writeFileSync(join(repo, 'dev2.txt'), 'd2', 'utf8')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'dev work 2')
      const result = promoteBranch({ repoRoot: repo, fromBranch: 'dev', toBranch: 'stage' })
      expect(result.ok).toBe(true)
      expect(result.action).toBe('fast-forward')
      expect(git(repo, 'rev-parse', 'stage')).toBe(git(repo, 'rev-parse', 'dev'))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('fails (not a fast-forward) when the target is not an ancestor of the source', () => {
    const repo = freshGitRepo('promote-nonff')
    try {
      git(repo, 'checkout', '-q', '-b', 'dev')
      writeFileSync(join(repo, 'dev.txt'), 'd', 'utf8')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'dev work')
      // stage created at dev
      promoteBranch({ repoRoot: repo, fromBranch: 'dev', toBranch: 'stage' })
      // now main advances independently (diverges from dev)
      git(repo, 'checkout', '-q', 'main')
      writeFileSync(join(repo, 'main.txt'), 'm', 'utf8')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'main work')
      // stage is based on dev, main advanced: main is NOT ancestor of dev
      const result = promoteBranch({ repoRoot: repo, fromBranch: 'dev', toBranch: 'main' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/not a fast-forward/)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('fast-forwards the target branch when it is checked out in a linked worktree', () => {
    const repo = freshGitRepo('promote-worktree')
    try {
      // create dev branch + a worktree checked out on dev
      git(repo, 'checkout', '-q', '-b', 'dev')
      writeFileSync(join(repo, 'dev.txt'), 'd', 'utf8')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'dev work')
      const wt = createLinkedWorktree({ repoRoot: repo, runId: 'dev-wt', baseBranch: 'dev', worktreeBranch: 'dev-wt-branch' })
      expect(wt.ok).toBe(true)
      // advance dev in the worktree
      writeFileSync(join(wt.worktreeDir, 'more.txt'), 'x', 'utf8')
      execFileSync('git', ['add', '-A'], { cwd: wt.worktreeDir, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'more'], { cwd: wt.worktreeDir, stdio: 'ignore' })
      // promote dev-wt-branch -> dev (dev is checked out in the worktree)
      const result = promoteBranch({ repoRoot: repo, fromBranch: 'dev-wt-branch', toBranch: 'dev' })
      expect(result.ok).toBe(true)
      expect(git(repo, 'rev-parse', 'dev')).toBe(git(repo, 'rev-parse', 'dev-wt-branch'))
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})

describe('recursive_worktree tool', () => {
  it('create action resolves the workspace root and creates a worktree', async () => {
    const repo = freshGitRepo('tool')
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
      const disposer = ctx.tools.register(createRecursiveWorktreeTool(ctx.recursive))
      const signal = new AbortController().signal
      const out = await ctx.tools.execute({
        signal, callId: ToolCallId('w1'),
        name: 'recursive_worktree',
        arguments: { action: 'create', runId: '03-tool-run', baseBranch: 'main' },
      })
      expect(out.isError).toBe(false)
      const value = out.value as { ok: boolean; worktreeDir: string }
      expect(value.ok).toBe(true)
      expect(existsSync(value.worktreeDir)).toBe(true)
      disposer()
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  /**
   * A RUN ID IS A NAME, NOT A PATH — AND HERE A PATH-SHAPED ONE HAS TWO SIDE
   * EFFECTS, NOT ONE. `createLinkedWorktree` builds the worktree directory
   * `.worktrees/<runId>` AND cuts the branch `recursive/<runId>`.
   *
   * MEASURED pre-fix on this host, per id, by calling `createLinkedWorktree`
   * directly against a fresh repo: `nested/child-run` returned `ok: true` and
   * created BOTH `.worktrees/nested/child-run` and the ref
   * `refs/heads/recursive/nested/child-run` — git accepts '/' inside a ref
   * component, so this id is a legal ref name even though it is a path. The
   * other shapes below were refused only by GIT itself, after the worktree add
   * was already attempted (`recursive//tmp/x`, `recursive/C:…`, `.hidden-run`
   * and the trailing space all fail as ref syntax), which is why one of them
   * left `.recursive\run` behind in the original report: the mess comes from the
   * attempt, not from the decision.
   *
   * So BOTH halves are asserted below — the directory and the ref — because a
   * filesystem-only check would have missed the branch for `nested/child-run`.
   * The ref half also names why the rule cannot be replaced by "let git decide":
   * a name like `nested` is a legal run id AND a legal ref, and it cannot be
   * created once `refs/heads/recursive/nested/child-run` exists (git: "cannot
   * lock ref … D/F conflict"), so a separator-shaped id takes a whole namespace
   * away from a run that never broke a rule.
   */
  describe('recursive_worktree refuses a run id that is a path, not a name', () => {
    const PATH_SHAPED: ReadonlyArray<readonly [string, string]> = [
      ['..\\escaped-run', 'path separator'], // the id measured to escape the run layer for recursive_init
      ['nested/child-run', 'path separator'], // MEASURED pre-fix: ok:true + dir + ref. The case a dir-only check misses.
      ['/tmp/x', 'path separator'],
      ['C:relative-drive-run', 'drive-qualified'],
      ['.hidden-run', 'hidden name'],
      ['03 trailing space', 'whitespace'],
    ]
    for (const [runId, expected] of PATH_SHAPED) {
      it('refuses ' + JSON.stringify(runId) + ' and creates neither the worktree nor the branch', async () => {
        const repo = freshGitRepo('wt-id')
        try {
          const ctx = new Context()
          await ctx.plugin(SystemPrompt)
          await ctx.plugin(ToolRuntime)
          await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
          const disposer = ctx.tools.register(createRecursiveWorktreeTool(ctx.recursive))
          const signal = new AbortController().signal
          const out = await ctx.tools.execute({
            signal, callId: ToolCallId('wt-id'),
            name: 'recursive_worktree',
            arguments: { action: 'create', runId, baseBranch: 'main' },
          })
          expect(out.isError).toBe(false)
          const value = out.value as { error?: string; ok?: boolean; worktreeDir?: string; worktreeBranch?: string }
          expect(value.error, 'a path-shaped runId was not refused').toBeTruthy()
          expect(value.error!.startsWith(TOOL_ERRORS.BAD_RUN_ID.code + ' ' + TOOL_ERRORS.BAD_RUN_ID.klass + ': ')).toBe(true)
          expect(value.error).toContain(expected)
          // Not a refusal-shaped success: no worktree result was returned at all.
          expect(value.ok).toBeUndefined()
          // (1) THE REF: nothing entered refs/heads/recursive/ — the half a filesystem check misses.
          expect(refsUnder(repo, 'refs/heads/recursive'), 'a refused runId still created a branch').toEqual([])
          // (2) THE DIRECTORY. `.worktrees` itself is the assertion rather than a guessed leaf path: pre-fix
          //     this ran `git worktree add`, which creates the parent, so a refused id used to leave a
          //     `.worktrees` tree behind even when git was the thing that said no.
          expect(existsSync(join(repo, '.worktrees')), '.worktrees was created by a refused runId').toBe(false)
          // (3) AND git agrees no worktree was added: the repo is still the only one.
          expect(listWorktrees(repo)).toHaveLength(1)
          expect(git(repo, 'branch', '--show-current')).toBe('main')
          disposer()
          await ctx.fiber.dispose()
        } finally { rmSync(repo, { recursive: true, force: true }) }
      })
    }

    it('still creates the worktree and the branch for every legitimate naming shape', async () => {
      // The other half of the contract: the rule must not cost a real run its worktree.
      const repo = freshGitRepo('wt-ok')
      try {
        const ctx = new Context()
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
        const disposer = ctx.tools.register(createRecursiveWorktreeTool(ctx.recursive))
        const signal = new AbortController().signal
        for (const [i, runId] of ['05-feature', 'fixture-run', '01-calculator-lib'].entries()) {
          const out = await ctx.tools.execute({
            signal, callId: ToolCallId('wt-ok-' + i),
            name: 'recursive_worktree',
            arguments: { action: 'create', runId, baseBranch: 'main' },
          })
          expect(out.isError).toBe(false)
          const value = out.value as { ok?: boolean; worktreeDir?: string; worktreeBranch?: string; error?: string }
          expect(value.error, runId + ' was refused').toBeUndefined()
          expect(value.ok).toBe(true)
          expect(value.worktreeBranch).toBe('recursive/' + runId)
          expect(existsSync(value.worktreeDir!)).toBe(true)
          expect(refsUnder(repo, 'refs/heads/recursive')).toContain('refs/heads/recursive/' + runId)
        }
        disposer()
        await ctx.fiber.dispose()
      } finally { rmSync(repo, { recursive: true, force: true }) }
    })
  })
})

describe('recursive_init + worktree — scaffold a run inside its own worktree', () => {
  it('createWorktree scaffolds the run in .worktrees/<runId>/ and records the worktree branch', async () => {
    const repo = freshGitRepo('init-wt')
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
      const disposer = ctx.tools.register(createRecursiveInitTool(ctx.recursive))
      const signal = new AbortController().signal
      const out = await ctx.tools.execute({
        signal, callId: ToolCallId('init-wt'),
        name: 'recursive_init',
        arguments: { runId: '05-feature', createWorktree: true, baseBranch: 'main' },
      })
      expect(out.isError).toBe(false)
      const value = out.value as { runDir: string; created: string[]; worktree?: { ok: boolean; worktreeDir: string; worktreeBranch: string } }
      expect(value.worktree?.ok).toBe(true)
      // run scaffolded inside the worktree
      expect(value.runDir).toContain(join(repo, '.worktrees', '05-feature'))
      expect(existsSync(join(repo, '.worktrees', '05-feature', '.recursive', 'run', '05-feature', '00-worktree.md'))).toBe(true)
      // 00-worktree.md records the worktree root + worktree branch
      const wtDoc = readFileSync(join(repo, '.worktrees', '05-feature', '.recursive', 'run', '05-feature', '00-worktree.md'), 'utf8')
      expect(wtDoc).toContain('.worktrees/05-feature')
      expect(wtDoc).toContain('recursive/05-feature')
      disposer()
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
