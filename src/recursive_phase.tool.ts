import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

/**
 * recursive_phase (refined LIVE BUG 6): the canonical on-demand home of the
 * current phase's lint rules + instructions. Reads the same structured source
 * (runtime.phaseRules -> phaseRulesFor) as the once-per-phase pre-step
 * reminder, so the agent can re-ask for the rules without re-injecting them on
 * every step. Returns { error } when no active phase is found.
 */
export function createRecursivePhaseTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_phase',
    description: 'Return the lint rules + instructions for the current recursive-mode phase (required sections, gates, TDD/QA notes). Call once when entering a new phase; the same rules are also auto-injected once per phase transition.',
    parameters: {
      runId: { type: 'string', description: 'Optional run id (defaults to the latest run by mtime)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string }, exec) {
      const result = await recursive.phaseRules(args.runId, exec.agent as { session?: { header?: { cwd?: string } } } | null)
      if (!result) return { error: 'no recursive phase found' } as const
      return result as unknown as JsonValue
    },
  })
}
