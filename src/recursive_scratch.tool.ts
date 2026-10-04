import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

/**
 * `recursive_scratch` — read/write/append the run-scoped disposable scratchpad
 * (R5) under the CURRENT session workspace only (R1). Scratch is git-ignored
 * and never citable as an Input.
 */
export function createRecursiveScratchTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_scratch',
    description: 'Read, write, or append the run-scoped disposable scratchpad (scratch/scratch.md or scratch/scratch.ts) for a run in the CURRENT session workspace. Workspace-scoped; scratch is git-ignored and never citable as an Input.',
    parameters: {
      action: { type: 'string', description: 'read | write | append. Required.' },
      runId: { type: 'string', description: 'Run id (e.g. 03-something). Required; must resolve inside the current workspace.' },
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
        return { error: 'action, runId, and target are required' } as const
      }
      if (target !== 'md' && target !== 'ts') {
        return { error: 'target must be md or ts' } as const
      }
      const root = await recursive.resolveWorkspaceRoot(exec.agent)
      if (!root) {
        return { error: 'session is not attached to a registered workspace (cannot resolve control-plane root)' } as const
      }
      const result = recursive.scratchRun(root, runId, action, target as 'md' | 'ts', args.content)
      return result as unknown as JsonValue
    },
  })
}
