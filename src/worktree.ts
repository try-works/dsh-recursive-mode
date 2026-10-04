/**
 * worktree.ts — drive linked-worktree creation and branch promotion.
 *
 * Worktree + branch awareness, operational half (R?): after detection
 * (git-context.ts) and lint validation (ts-lint.ts), this module performs the
 * git operations that actually realize the dev/stage/main worktree workflow:
 *
 * - `createLinkedWorktree`: create a linked worktree at
 *   `<repoRoot>/.worktrees/<runId>/` on a worktree branch based on a base
 *   branch (default: the upstream/promotion source branch).
 * - `promoteBranch`: fast-forward one branch into a target promotion stage
 *   (feature -> dev -> stage -> main). The promotion is verified to be a
 *   fast-forward first (the target must be an ancestor of the source) and
 *   then applied where it is safe:
 *     - if the target branch is checked out in a worktree, `git merge
 *       --ff-only` runs THERE (safe: moves the branch and its working tree
 *       forward together, never a merge commit);
 *     - otherwise the branch ref is updated directly.
 *   It never rewrites history and never creates a merge commit.
 *
 * Both operations are explicit, workspace-scoped, and total: they return
 * { ok, ... } rather than corrupting git state. No operation ever touches a
 * branch other than the explicitly requested one.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface CreateWorktreeOptions {
  repoRoot: string
  runId: string
  /** Base branch the worktree branch is cut from (default: current HEAD branch). */
  baseBranch?: string
  /** Worktree branch name (default: `recursive/<runId>`). */
  worktreeBranch?: string
}

export interface CreateWorktreeResult {
  ok: boolean
  worktreeDir: string
  worktreeBranch: string
  baseBranch: string
  error?: string
}

export interface PromoteBranchOptions {
  repoRoot: string
  /** Branch being promoted (the source of the new commits). */
  fromBranch: string
  /** Promotion target branch (feature -> dev -> stage -> main). */
  toBranch: string
}

export interface PromoteBranchResult {
  ok: boolean
  fromBranch: string
  toBranch: string
  action: 'fast-forward' | 'created'
  error?: string
}

/** Run git; throw on failure (callers catch to turn into a result). */
function gitThrow(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Resolve the current branch of a repo dir (short name or null when detached). */
function currentBranch(repoRoot: string): string | null {
  try {
    return gitThrow(repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  } catch {
    return null
  }
}

/** Default worktree branch name for a run. */
export function defaultWorktreeBranch(runId: string): string {
  return 'recursive/' + runId
}

/** One row of `git worktree list --porcelain` (path + branch when attached). */
export interface WorktreeInfo {
  path: string
  branch: string | null
  detached: boolean
}

/** List linked worktrees (path + branch) for a repo root. */
export function listWorktrees(repoRoot: string): WorktreeInfo[] {
  let out: string
  try {
    out = gitThrow(repoRoot, 'worktree', 'list', '--porcelain')
  } catch {
    return []
  }
  const result: WorktreeInfo[] = []
  let current: WorktreeInfo | null = null
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) { if (current) { result.push(current); current = null } continue }
    if (trimmed.startsWith('worktree ')) {
      current = { path: trimmed.slice('worktree '.length), branch: null, detached: false }
    } else if (trimmed.startsWith('branch refs/heads/') && current) {
      current.branch = trimmed.slice('branch refs/heads/'.length)
    } else if (trimmed === 'detached' && current) {
      current.detached = true
    }
  }
  if (current) result.push(current)
  return result
}

/**
 * Find the worktree path where `branch` is currently checked out, or null.
 * Parses `git worktree list --porcelain` (block per worktree with a
 * `branch refs/heads/<name>` line).
 */
export function findWorktreeForBranch(repoRoot: string, branch: string): string | null {
  let out: string
  try {
    out = gitThrow(repoRoot, 'worktree', 'list', '--porcelain')
  } catch {
    return null
  }
  let currentPath: string | null = null
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) { currentPath = null; continue }
    if (trimmed.startsWith('worktree ')) {
      currentPath = trimmed.slice('worktree '.length)
    } else if (trimmed.startsWith('branch refs/heads/')) {
      const name = trimmed.slice('branch refs/heads/'.length)
      if (name === branch && currentPath) return currentPath
    }
  }
  return null
}

/**
 * Create a linked worktree at `.worktrees/<runId>/` for a run. The worktree
 * branch is cut from `baseBranch` (default: the current HEAD branch). Returns
 * the created worktree dir + branch. No-op-safe: if the worktree dir already
 * exists, returns ok with the existing dir. Refuses to create a worktree when
 * the run directory already exists (prevents clobbering an in-progress run).
 */
export function createLinkedWorktree(opts: CreateWorktreeOptions): CreateWorktreeResult {
  const { repoRoot, runId } = opts
  const baseBranch = opts.baseBranch ?? currentBranch(repoRoot) ?? 'main'
  const worktreeBranch = opts.worktreeBranch ?? defaultWorktreeBranch(runId)
  const worktreeDir = join(repoRoot, '.worktrees', runId)

  if (existsSync(worktreeDir)) {
    return { ok: true, worktreeDir, worktreeBranch, baseBranch, error: undefined }
  }
  // Guard: never create a worktree over an in-progress run directory.
  const runDir = join(repoRoot, '.recursive', 'run', runId)
  if (existsSync(runDir)) {
    return { ok: false, worktreeDir, worktreeBranch, baseBranch, error: 'run directory already exists: ' + runDir + ' (refusing to create a worktree for an existing run)' }
  }
  // Base branch must resolve.
  try {
    gitThrow(repoRoot, 'rev-parse', '--verify', baseBranch + '^{commit}')
  } catch {
    return { ok: false, worktreeDir, worktreeBranch, baseBranch, error: 'base branch does not resolve: ' + baseBranch }
  }
  try {
    gitThrow(repoRoot, 'worktree', 'add', '-b', worktreeBranch, worktreeDir, baseBranch)
  } catch (err) {
    return { ok: false, worktreeDir, worktreeBranch, baseBranch, error: 'git worktree add failed: ' + (err as Error).message }
  }
  return { ok: true, worktreeDir, worktreeBranch, baseBranch }
}

/**
 * Fast-forward `toBranch` to `fromBranch` (promotion up the dev/stage/main
 * chain). Returns ok:false when the promotion is not a pure fast-forward
 * (would require a merge commit) or when the from/to branches are missing.
 */
export function promoteBranch(opts: PromoteBranchOptions): PromoteBranchResult {
  const { repoRoot, fromBranch, toBranch } = opts
  if (fromBranch === toBranch) {
    return { ok: false, fromBranch, toBranch, action: 'fast-forward', error: 'from and to branches are identical: ' + fromBranch }
  }
  // Resolve the source commit; the target may or may not exist yet.
  let fromSha: string | null = null
  try { fromSha = gitThrow(repoRoot, 'rev-parse', '--verify', fromBranch + '^{commit}') } catch { /* missing */ }
  if (!fromSha) {
    return { ok: false, fromBranch, toBranch, action: 'fast-forward', error: 'from branch does not resolve: ' + fromBranch }
  }
  let toSha: string | null = null
  try { toSha = gitThrow(repoRoot, 'rev-parse', '--verify', toBranch + '^{commit}') } catch { /* missing */ }

  if (!toSha) {
    // Target doesn't exist yet — create it at the source commit (first promotion).
    try {
      gitThrow(repoRoot, 'branch', toBranch, fromSha)
      return { ok: true, fromBranch, toBranch, action: 'created' }
    } catch (err) {
      return { ok: false, fromBranch, toBranch, action: 'created', error: 'git branch failed: ' + (err as Error).message }
    }
  }

  // Verify the target is an ancestor of the source (a pure fast-forward).
  try {
    execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', toBranch, fromBranch], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return { ok: false, fromBranch, toBranch, action: 'fast-forward', error: 'promotion is not a fast-forward: ' + toBranch + ' is not an ancestor of ' + fromBranch }
  }

  // Apply the fast-forward where it is safe:
  //  - if the target branch is checked out in a worktree, merge --ff-only there
  //    (moves the branch AND its working tree forward together, never a merge);
  //  - otherwise update the branch ref directly.
  const checkedOutIn = findWorktreeForBranch(repoRoot, toBranch)
  if (checkedOutIn) {
    try {
      gitThrow(checkedOutIn, 'merge', '--ff-only', fromBranch)
      return { ok: true, fromBranch, toBranch, action: 'fast-forward' }
    } catch (err) {
      return { ok: false, fromBranch, toBranch, action: 'fast-forward', error: 'fast-forward merge in ' + checkedOutIn + ' failed: ' + (err as Error).message }
    }
  }
  try {
    gitThrow(repoRoot, 'update-ref', 'refs/heads/' + toBranch, fromSha)
    return { ok: true, fromBranch, toBranch, action: 'fast-forward' }
  } catch (err) {
    return { ok: false, fromBranch, toBranch, action: 'fast-forward', error: 'git update-ref failed: ' + (err as Error).message }
  }
}
