import { defineTool } from '@deepseek-ai/dsh-tools'
import { codeRuntimeRefusal, toolError } from './errors.ts'
import { buildAskQuestion } from './recursive_ask.tool.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

export function createRecursiveLockTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_lock',
    description: 'Lock a DRAFT recursive-mode artifact: writes Status: LOCKED, LockedAt, LockHash and validates prerequisites (monotonic phase gating). Delegates to the RecursiveRuntime service.',
    parameters: {
      runId: { type: 'string', description: 'Run id. Required.' },
      artifact: { type: 'string', description: 'Artifact file name, e.g. 03-implementation-summary.md. Required.' },
      reopen: { type: 'boolean', description: 'If true, reopen a locked artifact back to DRAFT (invalidates downstream receipts).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string; artifact?: string; reopen?: boolean }, exec) {
      if (!args.runId || args.runId.trim() === '') {
        return { error: toolError('MISSING_RUN_ID') } as const
      }
      if (!args.artifact || args.artifact.trim() === '') {
        return { error: toolError('MISSING_ARTIFACT') } as const
      }
      try {
        const result = await recursive.lockArtifact(args.runId.trim(), args.artifact.trim(), args.reopen === true, exec.agent as { session?: { header?: { cwd?: string } } } | null)
        return result as unknown as JsonValue
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const refusal = codeRuntimeRefusal(message)
        // FU-7 — THE GATE-BLOCK CALL POINT, and this is the moment it belongs to: a lock was REFUSED, so
        // the run is blocked and a person has to choose how to unblock it. Returning only the sentence
        // makes the caller parse prose to find the decision; the options are what turn it into a choice.
        //
        // ⚠ IT IS ATTACHED TO THE ORDERING REFUSAL SPECIFICALLY (`Prerequisite blockers:`), because that
        // is the one a human resolves. A missing run id or an already-locked artifact is a caller mistake
        // with a mechanical fix, and offering "reopen / abandon the run" for those would be noise.
        if (message.startsWith('Prerequisite blockers:')) {
          return {
            error: refusal,
            ask: { gate: 'gate-block', ...buildAskQuestion('gate-block'), artifact: args.artifact ?? '', blocked: message },
          } as unknown as JsonValue
        }
        return { error: refusal } as const
      }
    },
  })
}
