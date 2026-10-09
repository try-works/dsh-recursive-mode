import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolError } from './errors.ts'
import { RUN_ID_EXAMPLES, RUN_ID_RULE, runIdProblem } from './run-id.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

/**
 * `recursive_worktree` — create a linked git worktree for a run and/or
 * promote a branch up the dev/stage/main chain. Workspace-scoped: the
 * operations run under the SESSION's control-plane root only.
 *
 * A RUN ID IS A NAME, NOT A PATH HERE TOO, and this is the worst place to be without the rule: a `create`
 * builds TWO things out of the id — the linked worktree directory `.worktrees/<runId>` AND the git branch
 * `recursive/<runId>` (git accepts '/' inside a ref) — so a path-shaped id used to leave a worktree and a
 * ref behind, not just a folder. MEASURED pre-fix, per id, against a fresh repo: `nested/child-run`
 * returned ok:true and created BOTH `.worktrees/nested/child-run` and
 * `refs/heads/recursive/nested/child-run`, while the shapes git itself refuses as ref syntax
 * (`recursive//tmp/x`, `recursive/C:…`, `.hidden-run`, a trailing space) failed the worktree add and
 * created neither. The rule is `run-id.ts` and is not restated here; the gate sits at this boundary, ahead
 * of `createRunWorktree`, so the refusal no longer depends on git happening to dislike the ref name.
 *
 * The refusal is `BAD_RUN_ID` (RM1107), composed exactly as `recursive_init` composes it — same code, same
 * detail, same sentence. One message for one rule is what keeps a caller from having to learn a second
 * vocabulary for the same defect, and the shared remedy it carries ("call recursive_init again") is right
 * for this tool as well: a `create` for a run that does not exist yet is exactly what `recursive_init`
 * with `createWorktree: true` does.
 */
export function createRecursiveWorktreeTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_worktree',
    description: 'Create a linked git worktree for a recursive-mode run and/or promote a branch up the dev/stage/main chain. Workspace-scoped under the current session workspace.',
    parameters: {
      runId: { type: 'string', description: 'Run id the worktree is created for — the NAME of the run (e.g. 03-something), never a path: ' + RUN_ID_RULE + '. A path-shaped id is refused for create. Required for create.' },
      action: { type: 'string', description: 'create | promote | status. Default: create.' },
      fromBranch: { type: 'string', description: 'Source branch for a promote action (the branch holding the new commits).' },
      toBranch: { type: 'string', description: 'Promotion target branch for a promote action (feature -> dev -> stage -> main).' },
      baseBranch: { type: 'string', description: 'Base branch the worktree branch is cut from (default: current HEAD branch).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { action?: string; runId?: string; fromBranch?: string; toBranch?: string; baseBranch?: string }, exec) {
      const action = args.action ?? 'create'
      // Resolve the control-plane root: agent cwd first, repoRoot fallback (B4),
      // so tests and headless callers work without a live session header.
      const root = await recursive.resolveRootFor(exec.agent as { session?: { header?: { cwd?: string } } } | null)
      if (!root) {
        return { error: toolError('NO_WORKSPACE') } as const
      }
      if (action === 'create') {
        if (!args.runId || args.runId.trim() === '') {
          return { error: toolError('MISSING_CREATE_RUN_ID') } as const
        }
        const runId = args.runId.trim()
        // BEFORE `createRunWorktree`: that call builds `.worktrees/<runId>` and cuts the branch
        // `recursive/<runId>`, so a path-shaped id that reaches it has already created both. The gate is
        // on the name; `run-id.ts` says why the join itself is not the thing to change.
        const problem = runIdProblem(runId)
        if (problem !== null) {
          return { error: toolError('BAD_RUN_ID', problem + ' - run ids allow ' + RUN_ID_RULE + ' - e.g. ' + RUN_ID_EXAMPLES) } as const
        }
        const result = recursive.createRunWorktree(root, runId, args.baseBranch?.trim() || undefined)
        return result as unknown as JsonValue
      }
      if (action === 'promote') {
        if (!args.fromBranch || !args.toBranch) {
          return { error: toolError('MISSING_PROMOTE_BRANCHES') } as const
        }
        const result = recursive.promoteRunBranch(root, args.fromBranch.trim(), args.toBranch.trim())
        return result as unknown as JsonValue
      }
      if (action === 'status') {
        const result = recursive.worktreeStatus(root)
        return result as unknown as JsonValue
      }
      return { error: toolError('BAD_ACTION') } as const
    },
  })
}
