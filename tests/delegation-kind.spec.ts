import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advanceReview } from '../src/review-round.ts'

/**
 * FU-17 step 1 — THE KIND IS A PARAMETER, NOT A FORK.
 *
 * The goal of this file is the claim that matters for landing work delegation safely: a round with no `kind` is
 * the review round it always was, and a `'work'` round is the same machinery with a different MEANING for its
 * settlement. The second test is the one that would fail if a work round ever parsed a verdict out of a
 * deliverable — manufacturing a judgement the child never made.
 */
describe('FU-17: one round driver, two kinds', () => {
  let runDir = ''
  beforeEach(() => { runDir = mkdtempSync(join(tmpdir(), 'rm-kind-')) })
  afterEach(() => { rmSync(runDir, { recursive: true, force: true }) })

  const settled = (childId: string) => async () => ({
    ok: true,
    childId,
    rounds: [{ text: 'do the thing', result: { output: 'APPROVE', stopReason: 'completed', success: true } }],
    accepted: true,
  })

  it('DEFAULT IS REVIEW: an APPROVE reply still approves, exactly as before', async () => {
    const outcome = await advanceReview({
      runDir,
      delegationId: 'phase-review',
      phase: '03.5',
      role: 'code-reviewer',
      delegate: settled('child-review'),
      readReply: () => 'Audit: PASS\nVerdict: APPROVE\n',
    })
    expect(outcome.status).toBe('approved')
    expect(outcome.verdict).toBe('APPROVE')
  })

  it('A WORK ROUND DOES NOT READ A VERDICT — the reply says APPROVE and it still only reports submitted', async () => {
    const outcome = await advanceReview({
      runDir,
      delegationId: 'phase-work',
      phase: '03',
      role: 'implementer',
      kind: 'work',
      delegate: settled('child-work'),
      readReply: () => 'Verdict: APPROVE\n',
    })
    expect(outcome.status, 'a deliverable is not an approval').toBe('submitted')
    expect(outcome.verdict, 'no verdict may be manufactured for work').toBeUndefined()
    expect(outcome.childId).toBe('child-work')
  })

  it('FEEDBACK GOES TO THE SAME CHILD, and the round reports that it is waiting for the repair', async () => {
    const sent: Array<{ childId: string; instruction: string }> = []
    const outcome = await advanceReview({
      runDir,
      delegationId: 'phase-work',
      phase: '03',
      role: 'implementer',
      kind: 'work',
      instruction: 'the migration is missing its rollback path; add it',
      delegate: settled('child-work'),
      readReply: () => 'done',
      sendRepair: async (childId, instruction) => { sent.push({ childId, instruction }) },
    })
    expect(outcome.status).toBe('revised')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.childId, 'the SAME child repairs, keeping its working set').toBe('child-work')
    expect(sent[0]!.instruction).toContain('rollback')
  })

  it('a feedback delivery that fails is named, and the child is kept for a retry', async () => {
    const outcome = await advanceReview({
      runDir,
      delegationId: 'phase-work',
      phase: '03',
      role: 'implementer',
      kind: 'work',
      instruction: 'fix it',
      delegate: settled('child-work'),
      readReply: () => 'done',
      sendRepair: async () => { throw new Error('inbox refused') },
    })
    expect(outcome.status).toBe('unavailable')
    expect(outcome.message).toContain('could not be delivered')
    expect(outcome.message).toContain('child-work')
  })
})
