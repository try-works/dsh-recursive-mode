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

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
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
