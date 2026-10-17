import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { delegate, delegateContinuable, delegationError, reviewOutputSchema, defaultReviewToolFilter, validateReferences, writeActionRecord, evaluateDelegationResult } from '../src/delegation.ts'

function makeRun(root: string, runId: string) {
  const runDir = join(root, '.recursive', 'run', runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'src-file.ts'), 'line1\nline2\nline3\n', 'utf8')
  return runDir
}

describe('delegation.ts — plugin-driven delegation + validation (R4/R6/R7)', () => {
  it('reviewOutputSchema is object-rooted with required fields', () => {
    const s = reviewOutputSchema()
    expect(s.type).toBe('object')
    expect((s as { required?: string[] }).required).toContain('verdict')
  })

  it('delegate calls start with the full request and returns the result', async () => {
    let captured: unknown = null
    const subagents = {
      start: async (_name: string, req: unknown) => { captured = req; return { output: 'done', stopReason: 'completed', success: true } },
    }
    const result = await delegate({
      subagents: subagents as never,
      provider: 'spawn',
      request: { prompt: [{ type: 'text', text: 'hi' }], outputSchema: reviewOutputSchema(), toolFilter: defaultReviewToolFilter(), maxDepth: 2 },
    })
    expect(result.output).toBe('done')
    const req = captured as { outputSchema?: unknown; toolFilter?: unknown; maxDepth?: number }
    expect(req.outputSchema).toBeDefined()
    expect(req.toolFilter).toBeDefined()
    expect(req.maxDepth).toBe(2)
  })

  it('delegate fail-loud on missing seam', async () => {
    await expect(delegate({ subagents: undefined as never, provider: 'spawn', request: { prompt: [] } })).rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('delegate wraps UNSUPPORTED_CAPABILITY', async () => {
    const subagents = { start: async () => { throw new Error('subagent provider does not support the outputSchema capability') } }
    await expect(delegate({ subagents: subagents as never, provider: 'spawn', request: { prompt: [] } })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })

  it('validateReferences checks path + line range', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-deleg-'))
    makeRun(root, '10-deleg')
    const ok = validateReferences(root, [{ path: '.recursive/run/10-deleg/src-file.ts', lineRange: '1-3' }])
    expect(ok.ok).toBe(true)
    const bad = validateReferences(root, [
      { path: '.recursive/run/10-deleg/src-file.ts', lineRange: '5-9' },
      { path: '.recursive/run/10-deleg/missing.ts' },
    ])
    expect(bad.ok).toBe(false)
    expect(bad.failures.length).toBe(2)
  })

  it('writeActionRecord writes canonical sections + failed attempts marked failed', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-deleg-'))
    makeRun(root, '10-deleg')
    const p = writeActionRecord({
      root,
      runId: '10-deleg',
      subagentId: 'child-a',
      phase: '03.5',
      purpose: 'review',
      executionMode: 'native',
      success: false,
      stopReason: 'error',
    })
    expect(existsSync(p)).toBe(true)
    const md = readFileSync(p, 'utf8')
    for (const h of ['## Metadata', '## Inputs Provided', '## Claimed Actions Taken', '## Claimed File Impact', '## Claimed Artifact Impact', '## Claimed Findings', '## Verification Handoff']) {
      expect(md).toContain(h)
    }
    expect(md).toContain('Status: failed')
  })

  it('evaluateDelegationResult rejects success:false and non-completed stop reasons', () => {
    expect(evaluateDelegationResult({ success: false }).accepted).toBe(false)
    expect(evaluateDelegationResult({ success: true, stopReason: 'error' }).accepted).toBe(false)
    expect(evaluateDelegationResult({ success: true, stopReason: 'completed' }).accepted).toBe(true)
  })
})

/**
 * ⚠ FU-20 — WHAT THE CHILD ACTUALLY RUNS ON, REPORTED BY THE ONE PLACE THAT CAN KNOW.
 *
 * `delegateContinuable` is the only code in this plugin holding BOTH the live parent Agent and the model the
 * child was asked for. That pair is exactly what an independence claim needs, and without it the record can only
 * say "delegated" — which is what the live run said while the authoring agent reviewed its own work.
 *
 * ⚠ AND THE POINT IS WHAT IT REFUSES TO CLAIM. A child that inherits the session's model is a real, separate
 * agent — genuinely independent by CONTEXT — but it is NOT a second opinion from a different model. The owner
 * wants the session model as the default, so this case is normal, not a failure; what would be a failure is
 * describing it as independent-of-model, and that is what these assertions forbid.
 */
describe('FU-20 — a delegated child reports the route it actually took', () => {
  const sessionParent = (provider: string, model: string) => ({
    id: 'parent-1',
    session: { requestHeader: () => ({ config: { provider, model } }) },
  })

  /** A current-host (0.2.1-rc.2) continuable seam that never settles, so the outcome is a PARK. */
  async function run(input: {
    parent: unknown
    agentOptions?: { model?: string }
  }): Promise<ReturnType<typeof delegateContinuable> extends Promise<infer T> ? T : never> {
    const subagents = {
      startActivation: async (spec: { delivery?: string }) => {
        // The current host REQUIRES this field; the seam's continuable path always passes 'parent'.
        expect(spec.delivery).toBe('parent')
        return {
          childId: 'c1',
          messageId: 'm1',
          result: Promise.resolve({ output: [], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
      sendMessage: async () => 'm2',
    }
    return await delegateContinuable({
      subagents: subagents as never,
      provider: 'spawn',
      label: 'd1/c1',
      prompt: 'review this',
      parent: input.parent as never,
      awaitRoundResult: async () => null,
      ...(input.agentOptions === undefined ? {} : { agentOptions: input.agentOptions }),
    })
  }

  it('NO model configured: names the session’s model and says the independence is not of model', async () => {
    const out = await run({ parent: sessionParent('deepseek-official', 'deepseek-flash') })
    expect(out.childRoute).toContain('deepseek-official/deepseek-flash')
    expect(out.childRoute).toContain('NOT by model')
    expect(out.sessionModel?.available).toBe(true)
    expect(out.reason, 'the parked round carries the route too, so a reader of the park knows what it parked').toContain('deepseek-flash')
  })

  it('a model DIFFERENT from the session’s: says so, and on what basis', async () => {
    const out = await run({
      parent: sessionParent('deepseek-official', 'deepseek-flash'),
      agentOptions: { model: 'deepseek-pro' },
    })
    expect(out.childRoute).toContain('deepseek-pro')
    expect(out.childRoute).toContain('DIFFERENT model')
  })

  it('a model the SAME as the session’s: refuses to call it a second opinion', async () => {
    const out = await run({
      parent: sessionParent('deepseek-official', 'deepseek-flash'),
      agentOptions: { model: 'deepseek-flash' },
    })
    expect(out.childRoute).toContain('SAME MODEL')
    expect(out.childRoute).toContain('NOT by model')
  })

  it('⚠ an UNREADABLE session model is reported as unknown — neither answer is assumed', async () => {
    const out = await run({ parent: {}, agentOptions: { model: 'deepseek-pro' } })
    expect(out.sessionModel?.available).toBe(false)
    expect(out.childRoute).toContain('UNKNOWN')
    expect(out.childRoute, 'the difference is explicitly NOT claimed').toContain('is not claimed')
  })

  it('and the parked reason never claims a review the delegation did not buy', async () => {
    const out = await run({ parent: {} })
    expect(out.parked).toBe(true)
    expect(out.reason).toContain('PARKED, not failed')
    expect(out.childRoute).toContain('no model was configured')
  })
})

