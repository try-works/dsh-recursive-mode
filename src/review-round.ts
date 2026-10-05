/**
 * T36 — the turn-shaped review driver: start → park → resume → repair.
 *
 * WHY A STATE MACHINE AND NOT A LOOP. The harness offers no parent-side
 * await-settlement promise: a continuable child's verdict arrives as a durable user
 * message on a LATER turn. So a review cannot be one function call that waits. It is
 * a sequence of turns, each of which either advances the round or honestly reports
 * that it is waiting — and the child id has to survive between those turns, which is
 * what the state file here is for. A tool call is the agent's only interface, so the
 * driver is designed to be driven once per turn, exactly like `recursive_audit_team`
 * advances the teams board one transition per call.
 *
 * THE FOUR OUTCOMES THAT MATTER:
 *   `reviewing`   the child has not settled yet — call again later
 *   `revised`     the round came back REVISE, so a repair instruction went to the
 *                 SAME child and the driver is waiting for the re-submission
 *   `approved`    a settled round read APPROVE and the work is accepted
 *   `rejected`    a settled round read REJECT — the reviewer says do not proceed
 * `unavailable` is the fifth, and it is not a failure of the work: it means the
 * delegation could not run continuably at all, so the repair path does not exist.
 * Naming that is the whole point of T35's `delegationMode`.
 *
 * THE VERDICT IS READ FROM `reply.md`, FAIL-CLOSED. A settlement carries free-form
 * text, and the loop's structured reader treats "no verdict" as APPROVE; a review
 * round must not. `readVerdictFromReply` is used instead, so prose, an empty reply
 * or an off-vocabulary answer becomes REVISE with a repair instruction rather than a
 * false approval.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readRepairFromReply, readVerdictFromReply, type ContinuableDelegationLike, type DelegationVerdict } from './delegation.ts'

/** The durable record of an in-flight review, so the next turn can resume it. */
export interface ReviewState {
  delegationId: string
  /** The durable child carrying this review, stable across turns. */
  childId: string
  phase: string
  role: string
  /** How many rounds the loop has observed so far. */
  rounds: number
  startedAt: string
  lastVerdict?: DelegationVerdict
}

export interface AdvanceReviewOutcome {
  status: 'reviewing' | 'revised' | 'approved' | 'rejected' | 'unavailable'
  childId?: string
  verdict?: DelegationVerdict
  rounds: number
  /** One sentence for the agent, saying what to do next. */
  message: string
}

/** Where one delegation's review state lives (beside its handoff and replies). */
export function reviewStatePath(runDir: string, delegationId: string): string {
  return join(runDir, 'subagents', delegationId, 'review-state.json')
}

/** Read an in-flight review, or null when there is none (or it is unreadable). */
export function readReviewState(runDir: string, delegationId: string): ReviewState | null {
  let raw: string
  try {
    raw = readFileSync(reviewStatePath(runDir, delegationId), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewState> | null
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.childId !== 'string' || parsed.childId === '') return null
    if (typeof parsed.delegationId !== 'string') return null
    const state: ReviewState = {
      delegationId: parsed.delegationId,
      childId: parsed.childId,
      phase: typeof parsed.phase === 'string' ? parsed.phase : '',
      role: typeof parsed.role === 'string' ? parsed.role : '',
      rounds: typeof parsed.rounds === 'number' && Number.isFinite(parsed.rounds) ? parsed.rounds : 0,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    }
    if (parsed.lastVerdict === 'APPROVE' || parsed.lastVerdict === 'REVISE' || parsed.lastVerdict === 'REJECT') {
      state.lastVerdict = parsed.lastVerdict
    }
    return state
  } catch {
    // A corrupt state file means "no known review", never a crash: the worst case is
    // that a fresh review starts, which the caller can see from the returned status.
    return null
  }
}

export function writeReviewState(runDir: string, state: ReviewState): string {
  const path = reviewStatePath(runDir, state.delegationId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8')
  return path
}

/** Forget a finished review. A finished review must not be resumable by accident. */
export function clearReviewState(runDir: string, delegationId: string): void {
  const path = reviewStatePath(runDir, delegationId)
  if (existsSync(path)) rmSync(path, { force: true })
}

/**
 * Advance one review by exactly one turn.
 *
 * `delegate` is injected rather than called directly so this driver can be tested
 * against a scripted loop, and so the caller owns how the review is dispatched
 * (which provider, which bundle, which parent). It receives `resumeChild` when a
 * child is already carrying the review — a resumed round must NEVER re-establish
 * the child, which would orphan the one already doing the work.
 */
export async function advanceReview(input: {
  runDir: string
  delegationId: string
  phase: string
  role: string
  /** Dispatch one turn of the continuable loop, resuming `resumeChild` when given. */
  delegate: (args: { resumeChild?: string }) => Promise<ContinuableDelegationLike>
  /** The child's reply text for the settled round, or '' when it has not written one. */
  readReply: (childId: string) => string
  /**
   * Deliver a repair instruction to the child.
   *
   * NEEDED BECAUSE THE LOOP CAN STOP EARLY ON A MISREAD. The loop's own verdict
   * reader falls back to APPROVE when a result carries no structured verdict, so a
   * child that answered in prose can make the loop believe it was approved and
   * END — leaving no repair sent and the child idle. This driver re-reads the reply
   * fail-closed and disagrees, so it must be able to send the repair itself;
   * otherwise the round would sit in `revised` forever with nothing ever asking the
   * child to fix anything.
   */
  sendRepair?: (childId: string, instruction: string) => Promise<void>
  now?: () => string
}): Promise<AdvanceReviewOutcome> {
  const { runDir, delegationId } = input
  const state = readReviewState(runDir, delegationId)
  const resumeChild = state?.childId

  let result: ContinuableDelegationLike
  try {
    result = await input.delegate(resumeChild === undefined ? {} : { resumeChild })
  } catch (err) {
    return {
      status: 'unavailable',
      childId: resumeChild,
      rounds: state?.rounds ?? 0,
      message: 'the review could not be dispatched: ' + (err instanceof Error ? err.message : String(err)),
    }
  }

  // The delegation ran, but not continuably: the review happened without the repair
  // path. Named, never hidden behind a success — this is T35's whole reason.
  if (result.fellBackToOneShot === true) {
    return {
      status: 'unavailable',
      rounds: result.rounds.length,
      message: 'the review ran WITHOUT the continuable repair path (no continuable seam or no live parent), '
        + 'so a failed review cannot be sent back to the child that did the work',
    }
  }

  const childId = result.childId ?? resumeChild
  const rounds = result.rounds.length
  const repaired = result.rounds.some((round) => (round as { revise?: boolean }).revise === true)

  if (result.parked === true) {
    // Still working, or a repair was just sent and we are waiting for the re-submission.
    if (childId !== undefined) {
      writeReviewState(runDir, {
        delegationId,
        childId,
        phase: input.phase,
        role: input.role,
        rounds,
        startedAt: state?.startedAt ?? (input.now ?? defaultNow)(),
        ...(repaired ? { lastVerdict: 'REVISE' as const } : {}),
      })
    }
    return repaired
      ? {
        status: 'revised',
        childId,
        verdict: 'REVISE',
        rounds,
        message: 'the review came back REVISE; a repair instruction was delivered to the SAME child '
          + '(childId ' + String(childId) + '). Call recursive_review again after it settles.',
      }
      : {
        status: 'reviewing',
        childId,
        rounds,
        message: 'the review is still running (childId ' + String(childId) + '). No settlement has landed yet; '
          + 'call recursive_review again after it settles.',
      }
  }

  // A settled round: read the verdict from the child's own reply, FAIL-CLOSED.
  const replyText = childId === undefined ? '' : input.readReply(childId)
  const verdict = readVerdictFromReply(replyText)

  if (result.accepted && verdict === 'APPROVE') {
    clearReviewState(runDir, delegationId)
    return { status: 'approved', childId, verdict, rounds, message: 'the review passed: verdict APPROVE.' }
  }
  if (verdict === 'REJECT') {
    clearReviewState(runDir, delegationId)
    return {
      status: 'rejected',
      childId,
      verdict,
      rounds,
      message: 'the reviewer rejected the work: verdict REJECT. Do not proceed; resolve it before locking.',
    }
  }

  // Anything else — an unreadable reply, a stopped child, a REVISE the loop ended on —
  // is a REPAIR, not a pass: keep the state so the child can be told to fix it, and
  // TELL IT, since the loop may have stopped believing it was approved.
  if (childId !== undefined) {
    writeReviewState(runDir, {
      delegationId,
      childId,
      phase: input.phase,
      role: input.role,
      rounds,
      startedAt: state?.startedAt ?? (input.now ?? defaultNow)(),
      lastVerdict: 'REVISE',
    })
  }
  let repairSent = false
  if (childId !== undefined && input.sendRepair !== undefined) {
    try {
      await input.sendRepair(childId, readRepairFromReply(replyText))
      repairSent = true
    } catch {
      // The repair could not be delivered; the child is still kept, so a later turn
      // can retry. Reported below rather than swallowed.
    }
  }
  // BOTH facts are always stated: WHY the round is a repair, and what happened to
  // the child — because a caller that does not know the child was kept cannot know
  // whether a later turn can still repair it.
  const why = result.accepted
    ? 'the reviewer approved, but the reply could not be read as an APPROVE; treated as REVISE so it is not '
      + 'accepted on a technicality.'
    : 'the round ended without an approval.'
  const what = repairSent
    ? ' A repair instruction was sent to the SAME child.'
    : ' The child is kept so the repair can be sent to it.'
  return {
    status: 'revised',
    childId,
    verdict: 'REVISE',
    rounds,
    message: why + what,
  }
}

function defaultNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}
