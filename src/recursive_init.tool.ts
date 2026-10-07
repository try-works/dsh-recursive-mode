import { defineTool } from '@deepseek-ai/dsh-tools'
import { codeRuntimeRefusal, toolError } from './errors.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

/**
 * PHASE 0 — SCAFFOLDING IS NOT STARTING, AND THE TOOL SAYS SO AT THE MOMENT IT MATTERS.
 *
 * A spec may legitimately exist before a run does: this tool writes the run directory and every phase
 * document, and it still does. What it must NOT do is start the run, because starting is creating and
 * arming the goal the harness drives autonomous rounds from. That is the owner's rule — *"phase 0
 * requires explicit approval to start a run and goal"* — so the description below names the gate and the
 * result carries `runStartApproval`, which is the pointer a caller needs: the run is inert until
 * `recursive_ask` answers `run-start`.
 *
 * `runStartApproval` is read from the run's own Phase 0 artifact on every call, so it is the TRUE state
 * rather than "this call created something": re-initialising an APPROVED run reports `approved: true`
 * (and the run keeps its goal), which is what a caller re-scaffolding a run it already started needs to
 * see.
 */
export function createRecursiveInitTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_init',
    description: 'Scaffold a new recursive-mode run directory (or ensure an existing one) with stub artifact headers. Delegates to the RecursiveRuntime service (no duplicated scaffolding logic). When createWorktree is true, a linked worktree is created first and the run is scaffolded inside it. THIS DOES NOT START THE RUN: no goal exists until the user approves phase 0 through recursive_ask gate=run-start, so the result carries runStartApproval — read it and ask.',
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
        return { error: toolError('MISSING_RUN_ID') } as const
      }
      try {
        const result = await recursive.initRun(
          args.runId.trim(),
          exec.agent as { session?: { header?: { cwd?: string } } } | null,
          { createWorktree: args.createWorktree === true, baseBranch: args.baseBranch?.trim() || undefined },
        )
        return result as unknown as JsonValue
      } catch (err) {
        return { error: codeRuntimeRefusal(err instanceof Error ? err.message : String(err)) } as const
      }
    },
  })
}
