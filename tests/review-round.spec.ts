/**
 * T36 — the turn-shaped review driver.
 *
 * A review cannot be one call that waits, because the harness has no parent-side
 * await-settlement promise: the verdict arrives on a later turn. So the driver is
 * exercised the way a real turn sequence exercises it — call, park, call again with
 * the SAME child, and only then settle — and the state file between those calls is
 * what makes it possible.
 *
 * The safety property under test throughout: a round that cannot be read as an
 * approval is NEVER reported as approved, and the child is KEPT so the repair can
 * still be sent to it. Losing the child is losing the repair path.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  advanceReview,
  readReviewState,
  writeReviewState,
  clearReviewState,
  reviewStatePath,
} from '../src/review-round.ts'
import type { ContinuableDelegationLike } from '../src/delegation.ts'

const DELEGATION = 'd1'

function runRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-review-'))
  const runDir = join(root, '.recursive', 'run', 'r1')
  mkdirSync(join(runDir, 'subagents', DELEGATION), { recursive: true })
  return runDir
}

/** A loop result, as `delegateContinuable` returns it. */
function loopResult(over: Partial<ContinuableDelegationLike> = {}): ContinuableDelegationLike {
  return { ok: true, childId: 'child-1', rounds: [{ text: 'review it' }], accepted: false, ...over }
}

/** The turn sequence a caller sees: park, then park after a repair, then approve. */
function drive(runDir: string, script: ContinuableDelegationLike[], reply: string) {
  const seen: Array<{ resumeChild?: string }> = []
  let i = 0
  return {
    seen,
    advance: () => advanceReview({
      runDir,
      delegationId: DELEGATION,
      phase: '3',
      role: 'code-reviewer',
      delegate: async (args) => {
        seen.push(args)
        const next = script[i] ?? loopResult({ parked: true })
        i += 1
        return next
      },
      readReply: () => reply,
    }),
  }
}

describe('T36 — start, park, resume', () => {
  it('an unsettled round PARKS and records the child for the next turn', async () => {
    const runDir = runRoot()
    try {
      const d = drive(runDir, [loopResult({ parked: true })], '')
      const outcome = await d.advance()
      expect(outcome.status).toBe('reviewing')
      expect(outcome.childId).toBe('child-1')
      expect(outcome.message).toContain('still running')
      // The state file is what makes the next turn possible.
      expect(readReviewState(runDir, DELEGATION)!.childId).toBe('child-1')
      // The first call STARTS: it must not ask to resume anything.
      expect(d.seen[0].resumeChild).toBeUndefined()
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('the NEXT turn RESUMES the recorded child instead of starting a new one', async () => {
    const runDir = runRoot()
    try {
      const d = drive(runDir, [loopResult({ parked: true }), loopResult({ parked: true })], '')
      await d.advance()
      await d.advance()
      expect(d.seen[0].resumeChild).toBeUndefined()
      expect(d.seen[1].resumeChild).toBe('child-1')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('a parked round AFTER a repair is reported as REVISED, not as still-reviewing', async () => {
    const runDir = runRoot()
    try {
      // Round 0 settled REVISE (the loop sent the repair), round 1 has not settled.
      const script = [loopResult({
        parked: true,
        rounds: [{ text: 'review it', revise: true, repair: 'Address the findings: leak' }, { text: 'Address the findings: leak' }],
      })]
      const outcome = await drive(runDir, script, '').advance()
      expect(outcome.status).toBe('revised')
      expect(outcome.verdict).toBe('REVISE')
      expect(outcome.message).toContain('SAME child')
      expect(readReviewState(runDir, DELEGATION)!.lastVerdict).toBe('REVISE')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})

describe('T36 — a settled round, read from the child\'s reply', () => {
  it('APPROVE with an accepted result is approved, and the review is NOT resumable after', async () => {
    const runDir = runRoot()
    try {
      writeReviewState(runDir, {
        delegationId: DELEGATION, childId: 'child-1', phase: '3', role: 'code-reviewer', rounds: 1, startedAt: 'x',
      })
      const outcome = await drive(runDir, [loopResult({ accepted: true })], '{"verdict":"APPROVE"}').advance()
      expect(outcome.status).toBe('approved')
      expect(outcome.verdict).toBe('APPROVE')
      // A finished review must not be resumed by accident.
      expect(readReviewState(runDir, DELEGATION)).toBeNull()
      expect(existsSync(reviewStatePath(runDir, DELEGATION))).toBe(false)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('REJECT is rejected, and the review is not resumable after', async () => {
    const runDir = runRoot()
    try {
      const outcome = await drive(runDir, [loopResult({ accepted: false })], '{"verdict":"REJECT"}').advance()
      expect(outcome.status).toBe('rejected')
      expect(outcome.message).toContain('Do not proceed')
      expect(readReviewState(runDir, DELEGATION)).toBeNull()
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('an ACCEPTED result whose reply cannot be read is NOT approved (fail closed)', async () => {
    const runDir = runRoot()
    try {
      // The loop says accepted, but the child answered in prose: prose is not an
      // approval, so this must not pass on a technicality.
      const outcome = await drive(runDir, [loopResult({ accepted: true })], 'I looked at it and it seems fine.').advance()
      expect(outcome.status).toBe('revised')
      expect(outcome.message).toContain('technicality')
      // The child is KEPT so the repair can still reach it — losing it loses the repair path.
      expect(readReviewState(runDir, DELEGATION)!.childId).toBe('child-1')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('an empty reply is a repair, never a pass', async () => {
    const runDir = runRoot()
    try {
      const outcome = await drive(runDir, [loopResult({ accepted: true })], '').advance()
      expect(outcome.status).toBe('revised')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})

describe('T36 — the degraded and broken paths are NAMED', () => {
  it('a one-shot fallback is `unavailable` and says the repair path is missing', async () => {
    const runDir = runRoot()
    try {
      const outcome = await drive(runDir, [loopResult({ fellBackToOneShot: true })], '').advance()
      expect(outcome.status).toBe('unavailable')
      expect(outcome.message).toContain('WITHOUT the continuable repair path')
      // Nothing is recorded: there is no child to resume.
      expect(readReviewState(runDir, DELEGATION)).toBeNull()
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('a dispatch that THROWS is reported, not propagated', async () => {
    const runDir = runRoot()
    try {
      const outcome = await advanceReview({
        runDir, delegationId: DELEGATION, phase: '3', role: 'code-reviewer',
        delegate: async () => { throw new Error('subagent service exploded') },
        readReply: () => '',
      })
      expect(outcome.status).toBe('unavailable')
      expect(outcome.message).toContain('subagent service exploded')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('a CORRUPT state file means "no known review", never a crash', async () => {
    const runDir = runRoot()
    try {
      const path = reviewStatePath(runDir, DELEGATION)
      mkdirSync(join(runDir, 'subagents', DELEGATION), { recursive: true })
      writeFileSync(path, '{ this is not json', 'utf8')
      expect(readReviewState(runDir, DELEGATION)).toBeNull()
      const d = drive(runDir, [loopResult({ parked: true })], '')
      expect((await d.advance()).status).toBe('reviewing')
      expect(d.seen[0].resumeChild).toBeUndefined()
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('a state file without a child id is ignored (nothing to resume)', () => {
    const runDir = runRoot()
    try {
      writeFileSync(reviewStatePath(runDir, DELEGATION), JSON.stringify({ delegationId: DELEGATION }), 'utf8')
      expect(readReviewState(runDir, DELEGATION)).toBeNull()
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('clearReviewState is safe when there is nothing to clear', () => {
    const runDir = runRoot()
    try {
      expect(() => clearReviewState(runDir, 'never-existed')).not.toThrow()
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})

/**
 * T36 — the driver sends the repair itself when the LOOP stopped early.
 *
 * The loop's own verdict reader falls back to APPROVE for a result with no
 * structured verdict, so a child that answered in prose can make the loop believe it
 * was approved and END. Without this, the round would sit in `revised` forever with
 * nothing ever asking the child to fix anything — the exact opposite of the point.
 */
describe('T36 — a misread approval still produces a repair instruction', () => {
  function advanceWith(runDir: string, reply: string, sendRepair?: (childId: string, text: string) => Promise<void>) {
    return advanceReview({
      runDir,
      delegationId: DELEGATION,
      phase: '3',
      role: 'code-reviewer',
      // The loop stopped believing it was approved.
      delegate: async () => loopResult({ accepted: true }),
      readReply: () => reply,
      ...(sendRepair === undefined ? {} : { sendRepair }),
    })
  }

  it('SENDS the repair to the same child when the loop stopped on a misread', async () => {
    const runDir = runRoot()
    try {
      const sent: Array<{ childId: string; text: string }> = []
      const outcome = await advanceWith(runDir, 'it seems fine to me', async (childId, text) => {
        sent.push({ childId, text })
      })
      expect(outcome.status).toBe('revised')
      expect(sent).toHaveLength(1)
      expect(sent[0].childId).toBe('child-1')
      // The instruction names what was wrong, so it can actually be acted on.
      expect(sent[0].text).toContain('reply.md')
      expect(outcome.message).toContain('repair instruction was sent')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('a FAILED repair delivery is reported, and the child is still kept for a retry', async () => {
    const runDir = runRoot()
    try {
      const outcome = await advanceWith(runDir, 'no verdict here', async () => {
        throw new Error('followup seam unavailable')
      })
      expect(outcome.status).toBe('revised')
      expect(outcome.message).toContain('kept so the repair can be sent')
      expect(readReviewState(runDir, DELEGATION)!.childId).toBe('child-1')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('with no repair seam the child is kept and the message says so', async () => {
    const runDir = runRoot()
    try {
      const outcome = await advanceWith(runDir, 'it seems fine to me')
      expect(outcome.status).toBe('revised')
      expect(outcome.message).toContain('kept so the repair can be sent')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
