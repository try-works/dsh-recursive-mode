import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolError } from './errors.ts'
import { RUN_ID_EXAMPLES, RUN_ID_RULE, runIdProblem } from './run-id.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

/**
 * `recursive_scratch` — read/write/append the run-scoped disposable scratchpad
 * (R5) under the CURRENT session workspace only (R1). Scratch is git-ignored
 * and never citable as an Input.
 *
 * A RUN ID IS A NAME, NOT A PATH HERE TOO. `scratchRun` joins it onto the run layer, and it then WRITES
 * (write/append) into the directory it landed on, so a path-shaped id does not merely fail to find a run:
 * with a `..\` segment it can find and write into a SIBLING of the run layer, because the runtime's
 * workspace-scoping check is `runDir.startsWith(runRoot)` — a string prefix test, not containment — and a
 * sibling directory whose name begins with `run` passes it. MEASURED pre-fix: `..\run-away` was accepted
 * and `scratchRun` wrote `scratch.md` into `<workspace>\.recursive\run-away\scratch\`. The rule is
 * `run-id.ts`; the gate sits here, at the boundary where the name enters, rather than in `scratchRun`, for
 * the same reason `recursive_init`'s does. Refusal shape is `recursive_init`'s, `BAD_RUN_ID` (RM1107),
 * composed identically: one rule, one message.
 */
export function createRecursiveScratchTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_scratch',
    description: 'Read, write, or append the run-scoped disposable scratchpad (scratch/scratch.md or scratch/scratch.ts) for a run in the CURRENT session workspace. Workspace-scoped; scratch is git-ignored and never citable as an Input.',
    parameters: {
      action: { type: 'string', description: 'read | write | append. Required.' },
      runId: { type: 'string', description: 'Run id — the NAME of the run directory under .recursive/run/ (e.g. 03-something), never a path: ' + RUN_ID_RULE + '. Required; must resolve inside the current workspace.' },
      target: { type: 'string', description: 'md | ts. Required.' },
      content: { type: 'string', description: 'Content for write/append. Optional for read.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { action?: string; runId?: string; target?: string; content?: string }, exec) {
      const action = args.action ?? ''
      const runId = args.runId?.trim() ?? ''
      const target = args.target ?? ''
      if (!action || !runId || !target) {
        return { error: toolError('MISSING_SCRATCH_ARGS') } as const
      }
      // BEFORE `scratchRun`, which joins the id onto the run layer and then writes through it.
      const problem = runIdProblem(runId)
      if (problem !== null) {
        return { error: toolError('BAD_RUN_ID', problem + ' - run ids allow ' + RUN_ID_RULE + ' - e.g. ' + RUN_ID_EXAMPLES) } as const
      }
      if (target !== 'md' && target !== 'ts') {
        return { error: toolError('BAD_TARGET') } as const
      }
      const root = await recursive.resolveWorkspaceRoot(exec.agent)
      if (!root) {
        return { error: toolError('NO_WORKSPACE') } as const
      }
      const result = recursive.scratchRun(root, runId, action, target as 'md' | 'ts', args.content)
      return result as unknown as JsonValue
    },
  })
}
