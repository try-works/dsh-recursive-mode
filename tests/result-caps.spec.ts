/**
 * T24 — bounded results and coded refusals.
 *
 * `recursive_lint` used to return `errors[]`/`warnings[]` unbounded: one tool
 * result could carry every finding a 126 KB lint port produces. A silent
 * truncation would be worse than no cap — the reader could not tell a complete
 * result from a clipped one — so every clip is REPORTED through `elided[]`, which
 * states what was removed and how to see the rest.
 *
 * The tool is driven through a STUB runtime (`lintArtifact` only) so the cap can
 * be exercised with an arbitrarily large finding set without scaffolding a
 * repository big enough to produce one.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createRecursiveLintTool } from '../src/recursive_lint.tool.ts'
import { MAX_FINDINGS_FULL, MAX_FINDINGS_SUMMARY, elideFindings } from '../src/result-cap.ts'
import { TOOL_ERRORS } from '../src/errors.ts'

const signal = new AbortController().signal

/** A runtime stub exposing only what the lint tool calls. */
function stubRuntime(errors: string[], warnings: string[] = [], overrides: Record<string, unknown> = {}) {
  return {
    lintArtifact: async (runId: string, artifact?: string) => ({
      artifact: artifact ?? '03-implementation-summary.md',
      runId,
      passed: errors.length === 0,
      errors,
      warnings,
      ...overrides,
    }),
  } as never
}

async function lintWith(stub: unknown, args: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createRecursiveLintTool(stub as never))
  const out = await ctx.tools.execute({ signal, callId: ToolCallId('t24'), name: 'recursive_lint', arguments: args } as never)
  await ctx.fiber.dispose()
  return out
}

describe('T24 — elideFindings (pure)', () => {
  it('leaves a list at or under the cap untouched and unreported', () => {
    const exact = elideFindings('errors', ['a', 'b', 'c'], 3)
    expect(exact.kept).toEqual(['a', 'b', 'c'])
    expect(exact.meta).toBeNull()
    const under = elideFindings('warnings', ['a'], 3)
    expect(under.meta).toBeNull()
  })

  it('reports exactly what it removed, and states the route to the rest', () => {
    const { kept, meta } = elideFindings('errors', Array.from({ length: 512 }, (_, i) => 'e' + i), 200)
    expect(kept).toHaveLength(200)
    expect(kept[0]).toBe('e0')
    expect(meta).not.toBeNull()
    expect(meta!.kind).toBe('errors')
    expect(meta!.total).toBe(512)
    expect(meta!.shown).toBe(200)
    expect(meta!.omitted).toBe(312)
    // Self-describing: the count AND a route, because a bare count is not actionable.
    expect(meta!.hint).toContain('200 of 512')
    expect(meta!.hint).toContain('312 omitted')
    expect(meta!.hint).toMatch(/re-run|artifact/)
  })

  it('treats a non-finite cap as "no cap" rather than clipping everything', () => {
    const { kept, meta } = elideFindings('errors', ['a', 'b'], Number.NaN)
    expect(kept).toEqual(['a', 'b'])
    expect(meta).toBeNull()
  })

  it('a zero cap keeps nothing but still reports honestly', () => {
    const { kept, meta } = elideFindings('errors', ['a', 'b'], 0)
    expect(kept).toEqual([])
    expect(meta!.omitted).toBe(2)
  })
})

describe('T24 — recursive_lint is bounded', () => {
  it('clips an oversized result, keeps the TRUE totals, and explains the clip', async () => {
    const many = Array.from({ length: MAX_FINDINGS_FULL + 137 }, (_, i) => 'finding ' + i)
    const out = await lintWith(stubRuntime(many), { runId: 'r1', artifact: 'x.md' })
    expect(out.isError).toBe(false)
    const v = out.value as { errors: string[]; warnings: string[]; failCount: number; mode: string; elided: Array<{ kind: string; total: number; omitted: number; hint: string }> }
    // Bounded...
    expect(v.errors).toHaveLength(MAX_FINDINGS_FULL)
    // ...but the reader still sees how big the problem really is.
    expect(v.failCount).toBe(many.length)
    expect(v.mode).toBe('full')
    expect(v.elided).toHaveLength(1)
    expect(v.elided[0].kind).toBe('errors')
    expect(v.elided[0].total).toBe(many.length)
    expect(v.elided[0].omitted).toBe(137)
    expect(v.elided[0].hint).toContain('137 omitted')
  })

  it('leaves a small result completely untouched and reports no elision', async () => {
    const out = await lintWith(stubRuntime(['one issue'], ['a warning']), { runId: 'r1' })
    const v = out.value as { errors: string[]; warnings: string[]; elided: unknown[]; failCount: number; warnCount: number }
    expect(v.errors).toEqual(['one issue'])
    expect(v.warnings).toEqual(['a warning'])
    expect(v.elided).toEqual([])
    expect(v.failCount).toBe(1)
    expect(v.warnCount).toBe(1)
  })

  it('mode=summary buys a smaller budget but keeps the true totals', async () => {
    const many = Array.from({ length: 50 }, (_, i) => 'finding ' + i)
    const out = await lintWith(stubRuntime(many), { runId: 'r1', mode: 'summary' })
    const v = out.value as { errors: string[]; failCount: number; mode: string; elided: Array<{ omitted: number }> }
    expect(v.mode).toBe('summary')
    expect(v.errors).toHaveLength(MAX_FINDINGS_SUMMARY)
    expect(v.failCount).toBe(50)
    expect(v.elided[0].omitted).toBe(50 - MAX_FINDINGS_SUMMARY)
  })

  it('an unknown mode falls back to full rather than failing', async () => {
    const out = await lintWith(stubRuntime(['x']), { runId: 'r1', mode: 'shout' })
    expect(out.isError).toBe(false)
    expect((out.value as { mode: string }).mode).toBe('full')
  })

  it('defaults the output shape even when the runtime omits fields', async () => {
    const out = await lintWith({ lintArtifact: async () => ({}) } as never, { runId: 'r9' })
    expect(out.isError).toBe(false)
    const v = out.value as { errors: string[]; warnings: string[]; elided: unknown[]; runId: string; passed: boolean }
    expect(v.errors).toEqual([])
    expect(v.warnings).toEqual([])
    expect(v.elided).toEqual([])
    expect(v.runId).toBe('r9')
    expect(v.passed).toBe(false)
  })
})

describe('T24 — recursive_lint refusals are coded and routed', () => {
  it('a missing runId is refused with the registry code and a route out', async () => {
    const out = await lintWith(stubRuntime([]), {})
    expect(out.isError).toBe(false)
    const err = String((out.value as { error?: string }).error ?? '')
    expect(err.startsWith(TOOL_ERRORS.MISSING_RUN_ID.code + ' ' + TOOL_ERRORS.MISSING_RUN_ID.klass + ': ')).toBe(true)
    expect(err).toContain('Next: ')
    expect(err).toContain('recursive_status')
  })

  it('a runtime refusal is WRAPPED with a code and keeps the original sentence as detail', async () => {
    const stub = { lintArtifact: async () => { throw new Error('Artifact not found: 02-to-be-plan.md') } } as never
    const out = await lintWith(stub, { runId: 'r1' })
    expect(out.isError).toBe(false)
    const err = String((out.value as { error?: string }).error ?? '')
    expect(err.startsWith(TOOL_ERRORS.RUNTIME_REFUSED.code)).toBe(true)
    // The original sentence must survive: the code is a handle, not a replacement.
    expect(err).toContain('Artifact not found: 02-to-be-plan.md')
  })
})
