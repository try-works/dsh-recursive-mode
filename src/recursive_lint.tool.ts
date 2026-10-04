import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

export function createRecursiveLintTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_lint',
    description: 'Lint a recursive-mode run artifact for phase-specific issues (gates, TODO, traceability, diff audit). Delegates to the RecursiveRuntime service.',
    parameters: {
      runId: { type: 'string', description: 'Run id. Required.' },
      artifact: { type: 'string', description: 'Optional artifact file name; defaults to the current phase.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string; artifact?: string }, exec) {
      if (!args.runId || args.runId.trim() === '') {
        return { error: 'runId is required' } as const
      }
      try {
        const result = await recursive.lintArtifact(args.runId.trim(), args.artifact?.trim(), exec.agent as { session?: { header?: { cwd?: string } } } | null)
        return result as unknown as JsonValue
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) } as const
      }
    },
  })
}
