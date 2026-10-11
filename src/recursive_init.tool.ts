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
    description: 'Scaffold a new recursive-mode run directory (or ensure an existing one) with stub artifact headers. Delegates to the RecursiveRuntime service (no duplicated scaffolding logic). If this is a git repository with NO COMMITS, init attempts to make the first commit itself, staging only paths this call created (never unrelated work); inspect the additive firstCommit result for the SHA, staged paths, placeholder identity use, or reported failure. A failed convenience commit does not fail init, but the run will remain unlockable until a real commit exists. When createWorktree is true, a linked worktree is created first and the run is scaffolded inside it. THIS DOES NOT START THE RUN: no goal exists until the user approves phase 0 through recursive_ask gate=run-start, so the result carries runStartApproval — read it and ask. The runId is the NAME of the run directory under .recursive/run/ and is never a path (see the parameter description): a path-shaped runId is refused before anything is written.',
    parameters: {
      runId: { type: 'string', description: 'Run id — the NAME of the run directory under .recursive/run/ (e.g. 03-something, 01-calculator-lib), never a path: ' + RUN_ID_RULE + '. A run on another drive or inside a worktree is reached with recursive_worktree, not by passing a path here. Required.' },
      createWorktree: { type: 'boolean', description: 'If true, create a linked worktree at .worktrees/<runId>/ and scaffold the run inside it (default: false).' },
      baseBranch: { type: 'string', description: 'Base branch the worktree branch is cut from (default: current HEAD branch). Only used when createWorktree is true.' },
    },
    output: {
      schema: { type: 'json' },
      // ⚠ THE FIRST COMMIT IS RENDERED AS A SENTENCE, not left to be found inside the JSON. A commit is
      // work this call did to the repository on the caller's behalf; the whole point of returning it is
      // that it is NOT invisible, so the one surface the model reads gets the outcome in prose — including
      // the placeholder-identity disclosure and the failure reason when there is one.
      render: (_args, value) => {
        const lines = [JSON.stringify(value, null, 2)]
        const commit = (value as { firstCommit?: { committed: boolean; sha: string | null; stagedPaths: string[]; error: string | null; usedPlaceholderIdentity: boolean } })?.firstCommit
        if (commit) {
          if (commit.committed) {
            lines.push('')
            lines.push('recursive_init made the first commit for this repository: ' + (commit.sha ?? '(sha unresolved)')
              + ' — it staged ONLY the ' + commit.stagedPaths.length + ' path(s) this call created, never unrelated work.')
            if (commit.usedPlaceholderIdentity) {
              lines.push('No user.name/user.email was configured, so this one commit used the placeholder identity'
                + ' `recursive-init <recursive-init@invalid.local>` via `-c` on the single command (no repo or global config was changed).'
                + ' The author in the log is a placeholder, not a person.')
            }
          } else {
            lines.push('')
            lines.push('recursive_init could NOT make the first commit, so this run is not lockable yet: ' + (commit.error ?? 'unknown git failure')
              + ' — fix the reported git condition and make a commit, then continue. Init itself succeeded.')
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
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
