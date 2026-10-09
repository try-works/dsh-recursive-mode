import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolError } from './errors.ts'
import { RUN_ID_EXAMPLES, RUN_ID_RULE, runIdProblem } from './run-id.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

/**
 * `recursive_closeout` — scaffold a Phase 0-8 closeout receipt under the
 * SESSION's workspace only (R1 workspace-scoping invariant). The run is resolved
 * via the session agent's cwd -> workspace registry; a runId outside the current
 * workspace is rejected.
 *
 * A RUN ID IS A NAME, NOT A PATH HERE TOO, and "outside the current workspace is rejected" is NOT enough
 * on its own: `closeoutRun` joins the id onto the run layer and then writes a receipt under it, and its
 * scoping check is `runDir.startsWith(runRoot)` — a string prefix test, not containment. A `..\` segment
 * that lands on a SIBLING of the run layer passes that check whenever the sibling's name begins with
 * `run`, so a path-shaped id can still receive a write. MEASURED pre-fix: `..\run-away` and `../run-away`
 * were accepted and reached the report; the other shapes below were stopped only by the sibling not
 * existing, which is the operator's filesystem deciding, not the tool. The rule is `run-id.ts`; this
 * boundary is where the name enters, so this is where it is refused, with `recursive_init`'s refusal shape
 * — `BAD_RUN_ID` (RM1107), same detail sentence.
 */
export function createRecursiveCloseoutTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_closeout',
    description: 'REPORT what a closeout phase artifact is missing (Phase 4-8): it reads the artifact, lists the required sections and gates that are absent, and records a closeout receipt of its own. It NEVER writes the phase document. For a run in the CURRENT session workspace only. Workspace-scoped: refuses runIds outside the session\'s workspace. Delegates to the RecursiveRuntime service.',
    parameters: {
    phase: { type: 'string', description: 'Closeout phase to report on: 04, 05, 06, 07 or 08 (the same phase keys recursive_status prints). Phase 08 additionally fires the training trigger when it has been closed out before.' },
      runId: { type: 'string', description: 'Run id — the NAME of the run directory under .recursive/run/ (e.g. 03-something), never a path: ' + RUN_ID_RULE + '. Required. Must resolve inside the current workspace.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { phase?: string; runId?: string }, exec) {
      if (!args.phase || !args.runId || args.runId.trim() === '') {
        return { error: toolError('MISSING_PHASE_AND_RUN') } as const
      }
      const runId = args.runId.trim()
      // BEFORE `closeoutRun`, which joins the id onto the run layer and writes the closeout receipt under
      // whatever directory it resolved to.
      const problem = runIdProblem(runId)
      if (problem !== null) {
        return { error: toolError('BAD_RUN_ID', problem + ' - run ids allow ' + RUN_ID_RULE + ' - e.g. ' + RUN_ID_EXAMPLES) } as const
      }
      const root = await recursive.resolveWorkspaceRoot(exec.agent)
      if (!root) {
        return { error: toolError('NO_WORKSPACE') } as const
      }
      const result = await recursive.closeoutRun(root, runId, args.phase.trim(), exec.agent as { session?: { header?: { cwd?: string } } } | null)
      return result as unknown as JsonValue
    },
  })
}