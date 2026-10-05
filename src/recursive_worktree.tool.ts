import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolError } from './errors.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

/**
 * `recursive_worktree` — create a linked git worktree for a run and/or
 * promote a branch up the dev/stage/main chain. Workspace-scoped: the
 * operations run under the SESSION's control-plane root only.
 */
export function createRecursiveWorktreeTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_worktree',
    description: 'Create a linked git worktree for a recursive-mode run and/or promote a branch up the dev/stage/main chain. Workspace-scoped under the current session workspace.',
    parameters: {
      runId: { type: 'string', description: 'Run id the worktree is created for (e.g. 03-something). Required for create.' },
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
        const result = recursive.createRunWorktree(root, args.runId.trim(), args.baseBranch?.trim() || undefined)
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
