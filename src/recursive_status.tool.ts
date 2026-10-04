import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

export function createRecursiveStatusTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_status',
    description: 'Show the folded status of a recursive-mode run: phase table, current phase, lock validity. Reads through the RecursiveRuntime service (no duplicated parsing logic).',
    parameters: {
      runId: { type: 'string', description: 'Optional run id (defaults to the latest run by mtime)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string }, exec) {
      // B3: per-call workspace root via exec.agent.session.header.cwd (registry
      // first, cwd fallback) — never the host checkout process.cwd().
      const result = await recursive.status(args.runId, exec.agent as { session?: { header?: { cwd?: string } } } | null)
      if (!result) return { error: 'no recursive run found' } as const
      return result as unknown as JsonValue
    },
  })
}