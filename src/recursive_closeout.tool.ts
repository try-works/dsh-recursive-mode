import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolError } from './errors.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

/**
 * `recursive_closeout` — scaffold a Phase 0-8 closeout receipt under the
 * SESSION's workspace only (R1 workspace-scoping invariant). The run is resolved
 * via the session agent's cwd -> workspace registry; a runId outside the current
 * workspace is rejected.
 */
export function createRecursiveCloseoutTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_closeout',
    description: 'REPORT what a closeout phase artifact is missing (Phase 4-8): it reads the artifact, lists the required sections and gates that are absent, and records a closeout receipt of its own. It NEVER writes the phase document. For a run in the CURRENT session workspace only. Workspace-scoped: refuses runIds outside the session\'s workspace. Delegates to the RecursiveRuntime service.',
    parameters: {
    phase: { type: 'string', description: 'Closeout phase to report on: 04, 05, 06, 07 or 08 (the same phase keys recursive_status prints). Phase 08 additionally fires the training trigger when it has been closed out before.' },
      runId: { type: 'string', description: 'Run id (e.g. 03-something). Required. Must resolve inside the current workspace.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { phase?: string; runId?: string }, exec) {
      if (!args.phase || !args.runId || args.runId.trim() === '') {
        return { error: toolError('MISSING_PHASE_AND_RUN') } as const
      }
      const root = await recursive.resolveWorkspaceRoot(exec.agent)
      if (!root) {
        return { error: toolError('NO_WORKSPACE') } as const
      }
      const result = await recursive.closeoutRun(root, args.runId.trim(), args.phase.trim(), exec.agent as { session?: { header?: { cwd?: string } } } | null)
      return result as unknown as JsonValue
    },
  })
}