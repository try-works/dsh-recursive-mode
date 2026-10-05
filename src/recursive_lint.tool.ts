/**
 * T24 — bounded, coded results and refusals for `recursive_lint`.
 *
 * Two contracts are enforced here:
 *
 *  1. THE RESULT IS BOUNDED. `errors`/`warnings` are clipped to a named cap and
 *     every clip is reported through `elided[]` (`src/result-cap.ts`), so a
 *     reader can always tell a complete result from a clipped one. `mode`
 *     chooses the budget: `full` (default, up to MAX_FINDINGS_FULL per list) or
 *     `summary` (a few findings plus the true totals, for a turn that only needs
 *     to know whether the artifact passes).
 *
 *  2. EVERY REFUSAL IS CODED AND ROUTED. Errors come from `src/errors.ts`, so a
 *     failure is one greppable sentence naming the call that resolves it. A
 *     runtime refusal is WRAPPED rather than passed through raw: a bare thrown
 *     message carries no stable code for a consumer to branch on, and the
 *     wrapper preserves the original sentence as its detail.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'
import { toolError } from './errors.ts'
import { MAX_FINDINGS_FULL, MAX_FINDINGS_SUMMARY, elideFindings, type ElisionMeta } from './result-cap.ts'

type LintMode = 'summary' | 'full'

/** The wire shape this tool returns (bounded by construction). */
interface CappedLintResult {
  artifact: string
  runId: string
  passed: boolean
  mode: LintMode
  /** Totals BEFORE clipping — a reader must be able to see the real size. */
  failCount: number
  warnCount: number
  errors: string[]
  warnings: string[]
  /** Empty when nothing was clipped; otherwise one marker per clipped list. */
  elided: ElisionMeta[]
}

export function createRecursiveLintTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_lint',
    description: 'Lint a recursive-mode run artifact for phase-specific issues (gates, TODO, traceability, diff audit). Delegates to the RecursiveRuntime service. The result is bounded: when findings are clipped, `elided` says how many and how to see the rest.',
    parameters: {
      runId: { type: 'string', description: 'Run id. Required.' },
      artifact: { type: 'string', description: 'Optional artifact file name; defaults to the current phase.' },
      mode: { type: 'string', description: "Result budget: 'full' (default, up to 200 findings per list) or 'summary' (a few findings plus the true totals)." },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string; artifact?: string; mode?: string }, exec) {
      if (!args.runId || args.runId.trim() === '') {
        return { error: toolError('MISSING_RUN_ID') } as const
      }
      const mode: LintMode = args.mode === 'summary' ? 'summary' : 'full'
      const cap = mode === 'summary' ? MAX_FINDINGS_SUMMARY : MAX_FINDINGS_FULL
      try {
        const result = await recursive.lintArtifact(args.runId.trim(), args.artifact?.trim(), exec.agent as { session?: { header?: { cwd?: string } } } | null)
        const raw = result as unknown as { artifact?: string; runId?: string; passed?: boolean; errors?: string[]; warnings?: string[] }
        const sourceErrors = raw.errors ?? []
        const sourceWarnings = raw.warnings ?? []
        const errors = elideFindings('errors', sourceErrors, cap)
        const warnings = elideFindings('warnings', sourceWarnings, cap)
        const elided: ElisionMeta[] = []
        if (errors.meta) elided.push(errors.meta)
        if (warnings.meta) elided.push(warnings.meta)
        const bounded: CappedLintResult = {
          artifact: String(raw.artifact ?? args.artifact ?? ''),
          runId: String(raw.runId ?? args.runId.trim()),
          passed: Boolean(raw.passed),
          mode,
          // Totals, never the clipped length: a reader must see the real size.
          failCount: sourceErrors.length,
          warnCount: sourceWarnings.length,
          errors: errors.kept,
          warnings: warnings.kept,
          elided,
        }
        return bounded as unknown as JsonValue
      } catch (err) {
        return { error: toolError('RUNTIME_REFUSED', err instanceof Error ? err.message : String(err)) } as const
      }
    },
  })
}
