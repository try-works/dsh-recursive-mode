import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHandoff, createChildBrief, replyPath, childScratchPath, buildDelegationPrompt } from '../src/handoff.ts'

function makeRun(root: string, runId: string) {
  const runDir = join(root, '.recursive', 'run', runId)
  mkdirSync(runDir, { recursive: true })
  return runDir
}

describe('handoff.ts — file-backed handoff docs (R2)', () => {
  it('writes handoff.md with the 10.6 context-in fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-handoff-'))
    makeRun(root, '10-deleg')
    const p = createHandoff({
      root,
      runId: '10-deleg',
      delegationId: 'review-1',
      role: 'code-reviewer',
      objective: 'Review the implementation',
      runDocRefs: ['.recursive/run/10-deleg/00-requirements.md'],
      codeRefs: ['src/workspace.ts#L10-L20'],
      auditQuestions: ['Is it scoped?'],
      requiredOutput: 'Verdict + findings',
      decisionBasis: 'native provider spawn is registered',
    })
    expect(existsSync(p)).toBe(true)
    const md = readFileSync(p, 'utf8')
    for (const token of ['## Run Document References', '## Code References', '## Audit Questions', '## Required Output Shape', '## Delegation Decision Basis']) {
      expect(md).toContain(token)
    }
    expect(md).toContain('native provider spawn is registered')
  })

  it('writes per-child brief.md and returns reply.md path', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-handoff-'))
    makeRun(root, '10-deleg')
    const brief = createChildBrief({
      root,
      runId: '10-deleg',
      delegationId: 'review-1',
      childId: 'child-a',
      slice: 'Review src/workspace.ts only',
    })
    expect(existsSync(brief)).toBe(true)
    expect(readFileSync(brief, 'utf8')).toContain('Review src/workspace.ts only')
    const reply = replyPath({ root, runId: '10-deleg', delegationId: 'review-1', childId: 'child-a' })
    expect(reply).toContain(join('review-1', 'child-child-a', 'reply.md'))
  })

  it('childScratchPath resolves under the run scratch dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-handoff-'))
    makeRun(root, '10-deleg')
    const p = childScratchPath({ root, runId: '10-deleg', childId: 'child-a' })
    expect(p).toContain(join('.recursive', 'run', '10-deleg', 'scratch', 'child-a.md'))
  })

  it('buildDelegationPrompt is reference-based (pointers, not a paste)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-handoff-'))
    makeRun(root, '10-deleg')
    const prompt = buildDelegationPrompt({
      root,
      runId: '10-deleg',
      delegationId: 'review-1',
      childId: 'child-a',
      handoffPath: join(root, '.recursive/run/10-deleg/subagents/review-1/handoff.md'),
      briefPath: join(root, '.recursive/run/10-deleg/subagents/review-1/child-child-a/brief.md'),
    })
    expect(prompt).toContain('handoff.md')
    expect(prompt).toContain('brief.md')
    expect(prompt).toContain('reply.md')
    expect(prompt).toContain('report tool')
  })
})
