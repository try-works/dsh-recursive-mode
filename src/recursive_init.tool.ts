import { defineTool } from '@deepseek-ai/dsh-tools'
import { codeRuntimeRefusal, toolError } from './errors.ts'
import { RUN_ID_EXAMPLES, RUN_ID_RULE, runIdProblem } from './run-id.ts'
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
 *
 * AND A RUN ID IS A NAME, NOT A PATH. This is the boundary where the name enters, so it is the boundary
 * that refuses a path-shaped one — loudly, and before `initRun` can mkdir anything. The check lives here
 * (through the shared `run-id.ts` rule) rather than in `runtime.ts` because `initRun` is not the only
 * caller and because the runtime's `join(root, '.recursive', 'run', runId)` is CORRECT for a name; what
 * was missing was a gate on the name. Teaching the runtime to accept a path would silently relocate the
 * run layer instead of rejecting the call. See `run-id.ts` for the rule, the evidence behind it, and the
 * "do not fix this back" note.
 */
export function createRecursiveInitTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_init',
    description: 'Scaffold a new recursive-mode run directory (or ensure an existing one) with stub artifact headers. Delegates to the RecursiveRuntime service (no duplicated scaffolding logic). When createWorktree is true, a linked worktree is created first and the run is scaffolded inside it. THIS DOES NOT START THE RUN: no goal exists until the user approves phase 0 through recursive_ask gate=run-start, so the result carries runStartApproval — read it and ask. The runId is the NAME of the run directory under .recursive/run/ and is never a path (see the parameter description): a path-shaped runId is refused before anything is written.',
    parameters: {
      runId: { type: 'string', description: 'Run id — the NAME of the run directory under .recursive/run/ (e.g. 03-something, 01-calculator-lib), never a path: ' + RUN_ID_RULE + '. A run on another drive or inside a worktree is reached with recursive_worktree, not by passing a path here. Required.' },
      createWorktree: { type: 'boolean', description: 'If true, create a linked worktree at .worktrees/<runId>/ and scaffold the run inside it (default: false).' },
      baseBranch: { type: 'string', description: 'Base branch the worktree branch is cut from (default: current HEAD branch). Only used when createWorktree is true.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string; createWorktree?: boolean; baseBranch?: string }, exec) {
      const runId = args.runId?.trim() ?? ''
      if (runId === '') {
        return { error: toolError('MISSING_RUN_ID') } as const
      }
      // BEFORE `initRun`: that call starts with `mkdirSync(runDir, { recursive: true })`, so a
      // path-shaped id that reaches it has already made the operator-visible mess it was refused for.
      const problem = runIdProblem(runId)
      if (problem !== null) {
        return { error: toolError('BAD_RUN_ID', problem + ' - run ids allow ' + RUN_ID_RULE + ' - e.g. ' + RUN_ID_EXAMPLES) } as const
      }
      try {
        const result = await recursive.initRun(
          runId,
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
