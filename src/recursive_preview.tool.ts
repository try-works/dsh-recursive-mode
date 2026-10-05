/**
 * T26 — `recursive_preview`: see the enforcement contract BEFORE it fires.
 *
 * WHY. There is no way to see what the policy section will render, which rule a tool call will match,
 * or what the next legal transition requires — until it happens. That makes *enforce, don't just
 * describe* unverifiable by the person it is enforced on: a rule nobody can inspect in advance is
 * indistinguishable from a rule that does not exist.
 *
 * ⚠ IT MAKES NO MODEL CALL, and that is a property rather than a happy accident: every part of this
 * module is filesystem reads plus the SAME pure functions the enforcement path uses
 * (`renderStableContract` / `renderPhaseTail` / `contractDigest` from T22, `getNextLegalPhase` from
 * the lock chain, `phaseRulesFor` from the lint rules, `evaluateToolGuard` from the guard). A preview
 * that asked a model what would happen would be a DESCRIPTION of enforcement, which is exactly what
 * the item exists to replace.
 *
 * ⚠ AND IT REUSES THE ENFORCEMENT PATH RATHER THAN RESTATING IT. The probe calls `evaluateToolGuard`
 * — the same function the real `pre-execute` listener calls — so the rule it names is the rule that
 * WOULD fire, not a second opinion that can drift from it.
 */
import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { toolError } from './errors.ts'
import { evaluateToolGuard } from './enforcement.ts'
import { getNextLegalPhase } from './lock.ts'
import { phaseRulesFor } from './phase-rules.ts'
import { renderStableContract, renderPhaseTail, contractDigest } from './policy.ts'
import type { EnforcementConfig } from './enforcement.ts'
import type { RecursiveRuntime } from './runtime.ts'

/** A tool call the caller wants to preview the guard's decision for. */
export interface PreviewProbe {
  name: string
  arguments?: Record<string, unknown>
}

export interface PreviewResult {
  /** T22: the byte-identical prefix, the per-phase tail, and the local identifier. */
  policy: { stable: string; tail: string; digest: string }
  /** What the phase being worked on requires, from the same rules the linter enforces. */
  phase: { file: string; requiredSections: string[]; audited: boolean; tdd: boolean; qa: boolean } | null
  /** The next legal transition, or null when nothing is pending. */
  next: { phase: string; requiredSections: string[] } | null
  /** What the guard WOULD decide for a probe call — the rule that would fire, by name. */
  probe: { kind: string; rule: string; reason?: string } | null
}

/**
 * Build the preview. Pure apart from the run-directory reads it is given.
 *
 * `next` is `null` for a completed run rather than a fabricated phase: "nothing is pending" is a fact
 * a reader needs, and inventing the last phase as "next" would be the opposite of a preview.
 */
export function buildPreview(input: {
  root: string
  runId: string
  config: EnforcementConfig
  probe?: PreviewProbe
}): PreviewResult {
  const nextPhase = getNextLegalPhase(input.root + '/.recursive/run/' + input.runId) ?? null
  const rules = nextPhase === null ? null : phaseRulesFor(nextPhase)

  const probe = input.probe === undefined
    ? null
    : (() => {
        const decision = evaluateToolGuard(
          { name: input.probe.name, arguments: input.probe.arguments ?? {} } as never,
          input.root,
          input.runId,
          input.config.toolGuards,
        )
        const asRecord = decision as unknown as { kind: string; rule?: string; reason?: string }
        return {
          kind: asRecord.kind,
          // A decision with no rule is reported as `none` rather than omitted, so "no rule matched"
          // and "the preview forgot to look" cannot be confused.
          rule: asRecord.rule ?? 'none',
          ...(asRecord.reason === undefined ? {} : { reason: asRecord.reason }),
        }
      })()

  return {
    policy: {
      stable: renderStableContract(input.config),
      tail: renderPhaseTail(null),
      digest: contractDigest(input.config),
    },
    phase: rules === null
      ? null
      : {
          file: rules.fileName,
          requiredSections: [...rules.requiredSections],
          audited: rules.audited,
          tdd: rules.tdd,
          qa: rules.qa,
        },
    next: nextPhase === null || rules === null
      ? null
      : { phase: nextPhase, requiredSections: [...rules.requiredSections] },
    probe,
  }
}

/** `recursive_preview` — the read-only view, registered as a tool so it is one call away. */
export function createRecursivePreviewTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_preview',
    description: 'Show what the recursive-mode enforcement contract will do BEFORE it fires: the rendered policy prefix and its digest, the current phase\'s required sections and gates, the next legal transition, and the guard rule a probe tool call would match. Read-only: it reads the run directory and the same pure functions the enforcement path uses, and makes no model call.',
    parameters: {
      runId: { type: 'string', description: 'Run id. Required; must resolve inside the current workspace.' },
      probeTool: { type: 'string', description: 'Optional tool name to preview the guard decision for (e.g. recursive_lock).' },
      probeArguments: { type: 'string', description: 'Optional JSON object of arguments for the probe call.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string; probeTool?: string; probeArguments?: string }, exec) {
      const runId = args.runId?.trim() ?? ''
      if (runId === '') return { error: toolError('MISSING_RUN_ID') } as const
      const root = await recursive.resolveWorkspaceRoot(exec.agent)
      if (!root) return { error: toolError('NO_WORKSPACE') } as const
      if (!existsSync(root + '/.recursive/run/' + runId)) {
        return { error: toolError('MISSING_RUN_ID', 'no run directory for ' + runId) } as const
      }
      let probe: PreviewProbe | undefined
      if (args.probeTool !== undefined && args.probeTool.trim() !== '') {
        let parsed: Record<string, unknown> = {}
        if (args.probeArguments !== undefined && args.probeArguments.trim() !== '') {
          try {
            parsed = JSON.parse(args.probeArguments) as Record<string, unknown>
          } catch {
            return { error: toolError('BAD_PROBE_ARGUMENTS') } as const
          }
        }
        probe = { name: args.probeTool.trim(), arguments: parsed }
      }
      const preview = buildPreview({ root, runId, config: recursive.enforcementConfig, ...(probe === undefined ? {} : { probe }) })
      return preview as unknown as JsonValue
    },
  })
}
