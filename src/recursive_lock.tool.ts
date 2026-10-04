import { defineTool } from '@deepseek-ai/dsh-tools'
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
        return { error: 'runId is required' } as const
      }
      if (!args.artifact || args.artifact.trim() === '') {
        return { error: 'artifact is required' } as const
      }
      try {
        const result = await recursive.lockArtifact(args.runId.trim(), args.artifact.trim(), args.reopen === true, exec.agent as { session?: { header?: { cwd?: string } } } | null)
        return result as unknown as JsonValue
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) } as const
      }
    },
  })
}
