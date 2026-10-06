/**
 * `recursive_review` — T36: the reachable caller that makes a failed review become a
 * repair.
 *
 * WHY A TOOL, AND WHY IT IS TURN-SHAPED. A tool call is the agent's only interface,
 * so the operator's requirement — "the main agent can message a child whose work
 * failed review and tell it to re-do or repair" — needs a tool or it is not real.
 * It is deliberately ONE TRANSITION PER CALL, like `recursive_audit_team`: the
 * harness has no parent-side await-settlement promise, so a review cannot be one
 * call that waits for a verdict that arrives on a later turn. Call it, get either an
 * outcome or "still running", and call it again after the child settles — the
 * durable review state carries the child id between those calls.
 *
 * DELEGATION IS CONTINUABLE BY DEFAULT (T35), which is what makes the repair
 * possible at all: a one-shot child is NOT resumable, so a one-shot review could
 * only ever be a complaint. When the continuable seam is unavailable the outcome says
 * so explicitly (`unavailable`) rather than reporting a success.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { toLosslessJson } from './json-safe.ts'
import type { RecursiveRuntime } from './runtime.ts'
import { codeRuntimeRefusal, toolError } from './errors.ts'
import { replyPath } from './handoff.ts'
import { advanceReview } from './review-round.ts'
import { settlementRoundObserver } from './settlement.ts'
import type { ContinuableDelegationLike, SubagentParentHandle, SubagentsRuntimeLike } from './delegation.ts'

/**
 * The reply contract, stated for the child AND relied on by the fail-closed reader:
 * `verdict` decides the round, and `findings[].title` is the ONLY text that can
 * become a repair instruction, so a child cannot inject instructions.
 */
const REPLY_CONTRACT =
  'Write reply.md with a single JSON object: {"verdict":"APPROVE"|"REVISE"|"REJECT",'
  + '"findings":[{"severity":"HIGH"|"MEDIUM"|"LOW","title":"...","detail":"..."}]}. '
  + 'State the verdict explicitly: a reply that does not state one is read as REVISE, never as approval.'

export function createRecursiveReviewTool(recursive: RecursiveRuntime, subagents?: SubagentsRuntimeLike) {
  return defineTool({
    name: 'recursive_review',
    description:
      'Run or resume an INDEPENDENT review of the current phase artifact with a durable continuable subagent. '
      + 'Call it once per turn: it either reports an outcome (approved | rejected | unavailable) or that the '
      + 'review is still running. When a round comes back REVISE the SAME child is sent the repair instruction, '
      + 'so call this again after the re-submission settles. Never locks anything itself.',
    parameters: {
      runId: { type: 'string', description: 'Optional run id (defaults to the latest run by mtime).' },
      phase: { type: 'string', description: 'Optional phase key to review (e.g. 03). Defaults to the run\'s current phase.' },
      role: { type: 'string', description: 'Reviewer role to route (default: code-reviewer). Must be enabled in the router policy.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string; phase?: string; role?: string }, exec) {
      try {
        const root = await recursive.resolveWorkspaceRoot(exec.agent)
        if (!root) return { error: toolError('NO_WORKSPACE') } as const

        const status = await recursive.status(args.runId, exec.agent)
        if (!status) return { error: toolError('NO_RUN') } as const
        const runId = status.runId

        // The phase defaults to the run's current phase: the one a review is actually
        // about, because that is the artifact whose lock the review gates.
        const phase = args.phase?.trim() || status.currentPhase?.key || ''
        if (phase === '') return { error: toolError('NO_PHASE') } as const
        const row = status.phases.find((p) => p.key === phase)
        if (row === undefined || !row.exists) {
          return { error: toolError('NO_PHASE', 'phase ' + phase + ' has no artifact to review yet') } as const
        }

        const role = args.role?.trim() || 'code-reviewer'
        const delegationId = phase + '-review'
        const runDir = join(root, '.recursive', 'run', runId)
        const artifactPath = join(runDir, row.file)
        const parent = exec.agent as unknown as SubagentParentHandle

        const outcome = await advanceReview({
          runDir,
          delegationId,
          phase,
          role,
          delegate: async ({ resumeChild }) => {
            // A resumed round keeps the child it was given; a fresh round reserves an
            // id up front so the brief/prompt paths and the session agree from the
            // first call (`ctx.agents.create` accepts a reserved id).
            const childId = resumeChild ?? randomUUID()
            const review = await recursive.delegateReview({
              root,
              runId,
              phase,
              role,
              delegationId,
              childId,
              artifactPath,
              upstreamArtifacts: [],
              auditQuestions: [
                'Does the artifact satisfy every required section for phase ' + phase + '?',
                'Are the gate fields (Coverage/Approval/Audit/TDD Compliance) truthful and supported by evidence?',
                'Do the artifact and the upstream artifacts it cites agree with each other?',
              ],
              requiredOutput: REPLY_CONTRACT,
              subagents,
              parent,
              mode: 'continuable',
              awaitRoundResult: settlementRoundObserver(runDir),
            })
            return toContinuable(review)
          },
          readReply: (childId) => readReplyText(root, runId, delegationId, childId),
          // The loop can stop believing a prose reply was approved; the driver
          // disagrees, so it must be able to deliver the repair itself.
          sendRepair: async (childId, instruction) => {
            const followup = subagents?.followup
            if (followup === undefined) throw new Error('no continuable followup seam')
            await followup(parent, childId, [{ type: 'text', text: instruction }], {
              source: { kind: 'coordinator', form: 'relay', senderSessionId: parent?.id ?? '' },
            })
          },
        })
        // ⚠ FU-9 — A CAST IS NOT A CONTRACT, and this line proved it live. It used to be
        // `return outcome as unknown as JsonValue`, and a real session answered with
        //   Error: tool "recursive_review" returned invalid output: value is not lossless JSON
        //   ToolOutputError, code INVALID_TOOL_OUTPUT
        // because the outcome carries per-round `result` objects from the host — live Agents and seams, none of
        // which survive JSON.stringify. The projection keeps every datum a caller reads (status, rounds, the
        // round text, the message) and turns what has no JSON form into something that does, so the host can
        // always read the result rather than refusing it and reporting nothing about the work.
        const projected = toLosslessJson(outcome)
        return (projected ?? { error: codeRuntimeRefusal('the review produced no JSON-representable result') }) as JsonValue
      } catch (err) {
        return { error: codeRuntimeRefusal(err instanceof Error ? err.message : String(err)) } as const
      }
    },
  })
}

/** The child's reply file, or '' when it has not written one (an empty reply is not an approval). */
function readReplyText(root: string, runId: string, delegationId: string, childId: string): string {
  try {
    return readFileSync(replyPath({ root, runId, delegationId, childId }), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Project `delegateReview`'s result onto the loop shape the driver reads.
 *
 * The mapping is where the honest failure modes live: no continuable result at all
 * (self-audit, or the delegation never ran) becomes `fellBackToOneShot`, which the
 * driver reports as `unavailable` — the review happened without the repair path, and
 * saying so beats reporting a success that cannot be acted on.
 */
function toContinuable(review: {
  continuable: { rounds: unknown[]; childId?: string; fellBackToOneShot?: boolean; parked?: boolean; ok?: boolean; reason?: string } | null
  evaluation?: { accepted?: boolean }
  error?: string | null
  parked?: boolean
}): ContinuableDelegationLike {
  if (review.continuable === null) {
    return {
      ok: false,
      reason: review.error ?? 'no continuable delegation ran',
      rounds: [],
      accepted: false,
      fellBackToOneShot: true,
    }
  }
  return {
    // ⚠ FU-9 — THE DELEGATION'S OWN `ok` AND `reason`, NOT A HARDCODED `true`. This adapter forwarded `rounds`,
    // `childId`, `accepted` and `parked` while dropping `ok` and `reason`, so a delegation that returned
    // `{ ok: false, reason: '...' }` arrived at the review driver as `{ ok: true, rounds: [] }` — and the driver
    // then printed "the round ended without an approval", naming none of the three branches that can produce
    // it. Two rounds of live runs went into recovering a sentence this object already carried.
    ok: review.continuable.ok ?? true,
    ...(review.continuable.reason === undefined ? {} : { reason: review.continuable.reason }),
    rounds: review.continuable.rounds as ContinuableDelegationLike['rounds'],
    ...(review.continuable.childId === undefined ? {} : { childId: review.continuable.childId }),
    accepted: review.evaluation?.accepted === true,
    ...(review.continuable.parked === true ? { parked: true } : {}),
    // ⚠ AND THE FALLBACK FLAG, which decides whether the driver reports "no continuable repair path" at all.
    ...(review.continuable.fellBackToOneShot === true ? { fellBackToOneShot: true } : {}),
  }
}
