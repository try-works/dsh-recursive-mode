/**
 * git-context.ts — live git facts used for worktree + branch awareness (R?).
 *
 * Worktree/branch awareness goal: the plugin must know WHICH checkout and
 * WHICH branch a run is executing in, so Phase 0 records an honest base-vs-
 * worktree branch split and lint fails when the recorded context no longer
 * matches live git state.
 *
 * Detection primitives:
 * - `isLinkedWorktree` — a directory is a linked git worktree when its private
 *   git dir (`git rev-parse --git-dir`) differs from the common git dir
 *   (`git rev-parse --git-common-dir`). The main checkout has both equal.
 * - `upstreamBranch` — the current branch's upstream target with the remote
 *   prefix stripped (origin/main -> main). Used to infer the promotion source
 *   branch for dev/stage/main workflows.
 *
 * Every accessor is total: on missing git or non-git dirs it returns null /
 * false, never throws. Callers defer rather than fail hard.
 */
import { execFileSync } from 'node:child_process'

/** Normalized git facts about one checkout directory. */
export interface GitRepoFacts {
  /** SHA of HEAD^{commit}, or null when unresolvable (empty/non-git repo). */
  headSha: string | null
  /** Current branch short name via `git symbolic-ref --short HEAD`, null when detached. */
  branch: string | null
  /** True when HEAD is detached (no symbolic ref). */
  detached: boolean
  /** True when the cwd is a linked worktree (git-dir != git-common-dir). */
  isWorktree: boolean
  /** `git rev-parse --git-dir` output (may be relative). */
  gitDir: string | null
  /** `git rev-parse --git-common-dir` output (may be relative). */
  commonDir: string | null
  /** `git rev-parse --show-toplevel` output, or null. */
  toplevel: string | null
  /** Upstream branch with remote prefix stripped (origin/main -> main), null when none/detached. */
  upstreamBranch: string | null
}

/** Run git in a repo dir; return trimmed stdout or null on any failure. */
export function gitRun(repoRoot: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** True when a non-equal git-dir vs git-common-dir marks a linked worktree. */
export function isLinkedWorktree(gitDir: string | null, commonDir: string | null): boolean {
  if (!gitDir || !commonDir) return false
  return gitDir !== commonDir
}

/** Strip a remote ref prefix (origin/main -> main, remotes/origin/main -> main). */
export function stripRemotePrefix(ref: string | null): string | null {
  if (!ref) return null
  const trimmed = ref.trim()
  const short = trimmed.replace(/^refs\/remotes\//, '').replace(/^[^/]+\//, '')
  return short === '' ? null : short
}

/**
 * Gather normalized git facts about `repoRoot`. Total: any git failure
 * degrades to neutral values (false / null), never throws.
 */
export function gitFacts(repoRoot: string): GitRepoFacts {
  const gitDir = gitRun(repoRoot, 'rev-parse', '--git-dir')
  const commonDir = gitRun(repoRoot, 'rev-parse', '--git-common-dir')
  const headSha = gitRun(repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}')
  const branch = gitRun(repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  const toplevel = gitRun(repoRoot, 'rev-parse', '--show-toplevel')
  const upstreamRef = gitRun(repoRoot, 'rev-parse', '--abbrev-ref', '@{upstream}')
  return {
    headSha,
    branch: branch || null,
    detached: !branch,
    isWorktree: isLinkedWorktree(gitDir, commonDir),
    gitDir,
    commonDir,
    toplevel,
    upstreamBranch: branch ? stripRemotePrefix(upstreamRef) : null,
  }
}

/**
 * Resolve the effective base branch for a checkout. In a linked worktree this
 * is the branch the work is based on — best inferred from the upstream target
 * (dev/stage/main promotion source) when one is configured; otherwise fall
 * back to the current branch. Returns null only when no branch exists.
 */
export function resolveBaseBranch(facts: GitRepoFacts): string | null {
  if (facts.branch && facts.upstreamBranch && facts.upstreamBranch !== facts.branch) {
    return facts.upstreamBranch
  }
  return facts.branch
}

/**
 * Verify a worktree branch is (still) based on the recorded base branch.
 * Returns { ok, reason }. Fails when the base branch no longer exists, or the
 * worktree branch no longer contains it (merge-base --is-ancestor fails).
 * A missing/unresolvable branch degrades to ok:false with a reason; a
 * non-git dir degrades to ok:true (defer — nothing to verify).
 */
export function verifyBranchBase(repoRoot: string, baseBranch: string | null, worktreeBranch: string | null): { ok: boolean; reason: string | null } {
  if (!baseBranch || !worktreeBranch) return { ok: true, reason: null }
  const gitDir = gitRun(repoRoot, 'rev-parse', '--git-dir')
  if (!gitDir) return { ok: true, reason: null }
  const baseSha = gitRun(repoRoot, 'rev-parse', '--verify', `${baseBranch}^{commit}`)
  if (!baseSha) return { ok: false, reason: `recorded base branch '${baseBranch}' does not resolve in this checkout` }
  const wtSha = gitRun(repoRoot, 'rev-parse', '--verify', `${worktreeBranch}^{commit}`)
  if (!wtSha) return { ok: false, reason: `recorded worktree branch '${worktreeBranch}' does not resolve in this checkout` }
  // merge-base --is-ancestor <base> <worktree> -> exit 0 means base is an ancestor.
  try {
    execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', baseBranch, worktreeBranch], { stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, reason: null }
  } catch {
    return { ok: false, reason: `worktree branch '${worktreeBranch}' is not based on recorded base branch '${baseBranch}'` }
  }
}

/** Verify the recorded worktree branch matches the live HEAD branch. */
export function verifyWorktreeBranch(repoRoot: string, recordedBranch: string | null): { ok: boolean; reason: string | null } {
  if (!recordedBranch) return { ok: true, reason: null }
  const live = gitRun(repoRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  if (!live) return { ok: false, reason: 'HEAD is detached; expected branch ' + recordedBranch }
  if (live !== recordedBranch) return { ok: false, reason: `checkout is on branch '${live}' but 00-worktree.md records '${recordedBranch}'` }
  return { ok: true, reason: null }
}
