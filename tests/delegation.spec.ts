import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { delegate, delegationError, reviewOutputSchema, defaultReviewToolFilter, validateReferences, writeActionRecord, evaluateDelegationResult } from '../src/delegation.ts'

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
