import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

export function createRecursiveInitTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_init',
    description: 'Scaffold a new recursive-mode run directory (or ensure an existing one) with stub artifact headers. Delegates to the RecursiveRuntime service (no duplicated scaffolding logic). When createWorktree is true, a linked worktree is created first and the run is scaffolded inside it.',
    parameters: {
      runId: { type: 'string', description: 'Run id (e.g. 03-something). Required.' },
      createWorktree: { type: 'boolean', description: 'If true, create a linked worktree at .worktrees/<runId>/ and scaffold the run inside it (default: false).' },
      baseBranch: { type: 'string', description: 'Base branch the worktree branch is cut from (default: current HEAD branch). Only used when createWorktree is true.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string; createWorktree?: boolean; baseBranch?: string }, exec) {
      if (!args.runId || args.runId.trim() === '') {
        return { error: 'runId is required' } as const
      }
      try {
        const result = await recursive.initRun(
          args.runId.trim(),
          exec.agent as { session?: { header?: { cwd?: string } } } | null,
          { createWorktree: args.createWorktree === true, baseBranch: args.baseBranch?.trim() || undefined },
        )
        return result as unknown as JsonValue
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) } as const
      }
    },
  })
}
