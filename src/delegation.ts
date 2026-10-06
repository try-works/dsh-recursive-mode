/**
 * Plugin-driven delegation + report/reference validation + durable action
 * records (Phase B R4/R6/R7, PROPOSAL 10.5/10.9). The ENFORCED path (distinct
 * from the agent-driven subagent tool): the plugin calls ctx.subagents.start()
 * with the full SubagentStartRequest (outputSchema/toolFilter/maxDepth) and
 * validates the child's references before writing an action record.
 *
 * Workspace-scoped (run 03 R1) + fail-loud + optionality-preserving.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { contentSha256 } from './review.ts'

/**
 * Opaque handle to the live direct-parent Agent. The live continuable service
 * authorizes by EXACT live object identity — `ctx.agents.get(parent.id) ===
 * parent` (authorizeLineage), `ancestry.has(parent)` (interrupt/drain), and a
 * `WeakSet` of live ancestry — so this must be the real live `Agent`, never a
 * structural `{ id }` copy. The seam only ever reads `id`/`session.header.cwd`
 * for attribution, and never serializes or inspects the live object.
 */
export interface SubagentParentHandle {
  readonly id?: string
  readonly session?: { readonly header?: { readonly cwd?: string } }
}

/** Durable identity of one continuable child session (string-branded in the host). */
export type ContinuableChildId = string

/** Durable identity of one accepted inbox message (string-branded in the host). */
export type ContinuableMessageId = string

/**
 * Attribution for a model coordinator's follow-up to one of its children (the
 * live `CoordinatorMessageSource` subset — see subagent/src/continuation.ts).
 */
export interface CoordinatorSourceLike {
  readonly kind: 'coordinator'
  readonly form: 'relay'
  readonly senderSessionId: string
}

/** Uniform outcome for the interrupt/drain kill-switch helpers. */
export interface ContinuableOpResult {
  ok: boolean
  reason?: string
}

/** Minimal host-realm contract for ctx.subagents (the seam we call). */
export interface SubagentsRuntimeLike {
  start(name: string, request: SubagentStartRequestLike): Promise<SubagentResultLike>
  getProvider?(name: string): unknown
  list?(): unknown
  /** T4: continuable child lifecycle (startContinuable / followup / interrupt / drain). */
  startContinuable?(spec: ContinuableStartSpecLike): Promise<ContinuableStartLike>
  /** The parent MUST be the exact live Agent (object-identity authority), never a `{ id }` copy. */
  followup?(parent: SubagentParentHandle, childId: ContinuableChildId, content: readonly { type: 'text'; text: string }[], options: SubagentFollowupOptionsLike): Promise<ContinuableMessageId>
  interrupt?(targetSessionId: ContinuableChildId, authority: SubagentInterruptAuthorityLike): void
  drainContinuableChildren?(parent: SubagentParentHandle, childIds: readonly ContinuableChildId[]): Promise<void>
  drainContinuableDescendants?(parents: readonly SubagentParentHandle[]): Promise<void>
}

export interface SubagentStartRequestLike {
  prompt: unknown[] // ContentBlock[]
  label?: string
  outputSchema?: Record<string, unknown>
  toolFilter?: unknown
  maxDepth?: number
  persona?: string
  parent?: unknown
  signal?: unknown
  /**
   * T9 — the child's provider/model overrides.
   *
   * ⚠ `SubagentStartRequest.agentOptions` is only valid for a provider that DECLARES
   * `capabilities.agentOptions`; the harness REJECTS a start that sends it otherwise. Passing
   * it unconditionally would therefore BREAK delegations on providers that do not support it,
   * which is why the caller gates on the capability rather than on the model being non-null.
   */
  agentOptions?: { model?: string; provider?: string }
}

export interface SubagentResultLike {
  output?: string
  structured?: unknown
  stopReason?: string
  success?: boolean
}

export interface DelegationError extends Error {
  code?: string
}

export function delegationError(message: string, code: string): DelegationError {
  const err = new Error(message) as DelegationError
  err.code = code
  return err
}

/** Object-rooted output schema for a delegated review. */
export function reviewOutputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['APPROVE', 'REJECT', 'REVISE'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['INFO', 'LOW', 'MEDIUM', 'HIGH'] },
            title: { type: 'string' },
            detail: { type: 'string' },
          },
          required: ['severity', 'title', 'detail'],
          additionalProperties: false,
        },
      },
      references: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            lineRange: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdict', 'findings', 'references'],
    additionalProperties: false,
  }
}

/** Default toolFilter for a delegated reviewer (run-relevant, workspace-scoped). */
export function defaultReviewToolFilter(): unknown {
  return { allow: ['fs_read', 'grep', 'glob'] }
}

/**
 * Call ctx.subagents.start() with the full request. Fail loud on capability
 * mismatch, missing provider, or unsupported schema (never silent).
 */
export async function delegate(input: {
  subagents: SubagentsRuntimeLike
  provider: string
  request: SubagentStartRequestLike
}): Promise<SubagentResultLike> {
  const { subagents, provider, request } = input
  if (!subagents || typeof subagents.start !== 'function') {
    throw delegationError('ctx.subagents.start is not available (no subagent seam)', 'NO_PROVIDER')
  }
  if (!provider) {
    throw delegationError('No provider named for delegation', 'NO_PROVIDER')
  }
  try {
    return await subagents.start(provider, request)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string })?.code
    if (code === 'UNSUPPORTED_CAPABILITY' || message.includes('UNSUPPORTED_CAPABILITY') || message.includes('does not support')) {
      throw delegationError(message, 'UNSUPPORTED_CAPABILITY')
    }
    throw delegationError(message, 'DELEGATION_FAILED')
  }
}

/**
 * T4: continuable-child delegation — ONE durable child receives the initial
 * prompt (startContinuable), each REVISE is delivered as a followup to the SAME
 * child (FIFO, working set retained), and the parent observes each round's
 * settlement through the injected `awaitRoundResult` seam (in live usage the
 * child's settlement lands in the parent's inbox — `reportFrom` is the
 * CHILD-side API, so the parent-side loop collects via settlement, not by
 * calling it). A hung reviewer is cancelled with `interruptContinuable`
 * (keepInbox: the child's pending inbox survives). Falls back to one-shot
 * `delegate` when the seam has no continuable methods.
 */

/** What the caller asks for when starting a continuable background child (structural subset). */
export interface ContinuableStartSpecLike {
  /** The `ctx.subagents` provider whose continuable-creation capability establishes the child. */
  readonly provider: string
  /** The initial delegation's short `description`, persisted as the child's creation label. */
  readonly label: string
  /** Optional caller-reserved child identity. */
  childId?: ContinuableChildId
  /** The delegation request (prompt + parent + toolFilter + maxDepth; no label/signal/outputSchema). */
  readonly request: Omit<SubagentStartRequestLike, 'label' | 'signal' | 'outputSchema'>
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal?: AbortSignalLike
}

/** Minimal cancellation shape (a live AbortSignal satisfies it). */
export interface AbortSignalLike {
  readonly throwIfAborted: () => void
}

/** Identities returned once a continuable child accepted its initial prompt. */
export interface ContinuableStartLike {
  /** The durable child session id, stable across activations. */
  readonly childId: ContinuableChildId
  /** The accepted initial prompt's inbox message id. */
  readonly messageId: ContinuableMessageId
}

/** Options for following up with one continuable child (structural subset). */
export interface SubagentFollowupOptionsLike {
  /** Durable attribution retained on the delivered message. */
  readonly source: CoordinatorSourceLike
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal?: AbortSignalLike
}

/** Authority under which one interrupt request is admitted. */
export type SubagentInterruptAuthorityLike =
  | { readonly kind: 'user'; readonly parentSessionId: string }
  | { readonly kind: 'ancestor'; readonly agent: SubagentParentHandle }

/** One round of a continuable child: the delivered text plus the observed outcome. */
export interface ContinuableRoundLike {
  /** The message text delivered as this round's user prompt. */
  text: string
  /** The child's observed outcome for this round. */
  result?: SubagentResultLike
  /** True when this round's verdict was REVISE (a repair followup followed). */
  revise?: boolean
  /** The repair instruction delivered in the followup (only when revise). */
  repair?: string
}

/** The full T4 delegation outcome. */
export interface ContinuableDelegationLike {
  ok: boolean
  reason?: string
  /** The durable child session id (stable across rounds). */
  childId?: ContinuableChildId
  /** Inbox message ids: [initial acceptance, ...followups]. */
  messageIds?: ContinuableMessageId[]
  rounds: ContinuableRoundLike[]
  /** Final outcome accepted (last verdict APPROVE + result accepted). */
  accepted: boolean
  /** True when the fallback one-shot `delegate()` was used (no continuable seam). */
  fellBackToOneShot?: boolean
  /**
   * True when the round ended because NO settlement has landed yet — the caller's
   * signal to resume on a later turn with the SAME `childId`, not a failure. The
   * harness offers no parent-side await-settlement promise, so this is the honest
   * report of "the child is still working".
   */
  parked?: boolean
}

/** Verdict vocabulary shared by T3/T4 (matches the delegated review schema). */
export type DelegationVerdict = 'APPROVE' | 'REVISE' | 'REJECT'

/**
 * T28 — how much delegation depth is left for a child of a parent at `parentDepth`.
 *
 * The configured maximum is a ceiling for the WHOLE recursion, not a fresh allowance
 * at every level. Passing the configured maximum down unchanged at each level is how
 * a "depth 3" budget silently permits 3^depth children, which bounds nothing.
 *
 * A caller may ask for LESS than what remains (`requested`) and never for more:
 * `min(remaining, requested)`. A parent already at or past the cap yields **0** —
 * "delegate no further" — never a negative that some downstream comparison could read
 * as permission.
 */
export function remainingDepthFor(
  budgets: { maxDelegationDepth: number },
  parentDepth: number,
  requested?: number,
): number {
  const depth = Number.isSafeInteger(parentDepth) && parentDepth > 0 ? parentDepth : 0
  const remaining = Math.max(0, budgets.maxDelegationDepth - depth)
  if (requested === undefined) return remaining
  const want = Number.isSafeInteger(requested) && requested > 0 ? requested : 0
  return Math.max(0, Math.min(remaining, want))
}

/** Read the verdict from a review-schema structured result (pure). */
export function readVerdictFromStructured(result: SubagentResultLike): DelegationVerdict {
  // SAFETY: reviewOutputSchema() defines verdict as a string enum; the cast reads
  // one leaf field only, never mutates, and falls back on a non-matching value.
  const verdict = (result.structured as { verdict?: unknown } | undefined)?.verdict
  if (verdict === 'APPROVE' || verdict === 'REVISE' || verdict === 'REJECT') return verdict
  // No structured verdict: a completed run with text output is a provisional APPROVE
  // candidate, but delegation acceptance stays strict (caller evaluates).
  return 'APPROVE'
}

/** Read the repair instruction from a review-schema structured result (pure). */
export function readRepairFromStructured(result: SubagentResultLike): string {
  // SAFETY: reviewOutputSchema() defines findings as an array of {severity,title,
  // detail}; the cast reads leaf fields only (no live data, no mutation). The
  // repair instruction is ALWAYS synthesized from the findings — a child cannot
  // inject arbitrary instruction text (prompt-injection hygiene).
  const findings = (result.structured as { findings?: Array<{ title?: string }> } | undefined)?.findings
  const titles = Array.isArray(findings) ? findings.map(f => f.title ?? '').filter(Boolean) : []
  if (titles.length > 0) return 'Address the findings: ' + titles.join('; ')
  return 'REVISE: address the review findings and re-submit.'
}

/** What a delegated child's `reply.md` said, as far as the plugin can tell. */
export interface ReplyVerdict {
  /** The verdict the reply STATES, or null when it states none. */
  verdict: DelegationVerdict | null
  /** Finding titles, when the reply carried review-schema JSON. */
  findings: string[]
  /** Why no verdict was read, for the repair instruction. Null when one was. */
  problem: string | null
}

/**
 * Read a verdict out of a child's `reply.md`, FAILING CLOSED.
 *
 * WHY THIS EXISTS RATHER THAN `readVerdictFromStructured`. The settlement's closing
 * text is free-form — a child may report prose, a fenced JSON block, or a bare
 * field line — and the structured reader's fallback for "no verdict" is
 * `APPROVE`. That default is defensible where the caller re-evaluates the result,
 * but it is the wrong default for a REVIEW ROUND: a child that answered with prose,
 * or answered the wrong question, or wrote nothing parseable, must never be read as
 * having approved the work. Verification that fails open is not verification.
 *
 * So this reader accepts exactly three things — review-schema JSON (fenced or
 * bare), or an explicit `Verdict:` field — and reports `verdict: null` plus a
 * `problem` for anything else. The caller turns that into a REVISE with a repair
 * instruction that says what was wrong, so an unreadable reply costs a round rather
 * than a false approval.
 */
export function parseReplyVerdict(replyText: string): ReplyVerdict {
  const text = replyText ?? ''
  if (text.trim() === '') {
    return { verdict: null, findings: [], problem: 'the reply is empty' }
  }

  const candidates: string[] = []
  // A fenced block first: a child that wraps its JSON is being explicit about it.
  for (const match of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) {
    if (match[1] !== undefined) candidates.push(match[1])
  }
  // Then a bare object, so an unfenced submission still reads.
  const bare = text.match(/\{[\s\S]*\}/)
  if (bare?.[0] !== undefined) candidates.push(bare[0])

  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
    const raw = record?.verdict
    const verdict = normaliseVerdict(raw)
    if (verdict !== null) {
      const findings = Array.isArray(record?.findings)
        ? record.findings
          .map((f) => (typeof f === 'object' && f !== null ? (f as { title?: unknown }).title : undefined))
          .filter((t): t is string => typeof t === 'string' && t !== '')
        : []
      return { verdict, findings, problem: null }
    }
    return { verdict: null, findings: [], problem: 'the reply carries JSON but no usable "verdict" field' }
  }

  // A plain field line, which is how a child that ignores the schema tends to answer.
  // The decoration class around the value allows the asterisks, backticks and
  // underscores a child may wrap it in — including a backtick INSIDE bold, as in
  // `**Verdict:** \`REVISE\``, which is the shape that first broke this reader.
  const field = text.match(/^[ \t>*_`-]*verdict[ \t]*[:=][ \t>*_`-]*([A-Za-z]+)/im)
  const fieldVerdict = normaliseVerdict(field?.[1])
  if (fieldVerdict !== null) return { verdict: fieldVerdict, findings: [], problem: null }

  return {
    verdict: null,
    findings: [],
    problem: field?.[1] !== undefined
      ? 'the reply states a verdict of "' + field[1] + '", which is not one of APPROVE, REVISE or REJECT'
      : 'the reply states no verdict',
  }
}

/** Accept the verdict vocabulary case-insensitively; reject everything else. */
function normaliseVerdict(raw: unknown): DelegationVerdict | null {
  if (typeof raw !== 'string') return null
  const upper = raw.trim().toUpperCase()
  if (upper === 'APPROVE' || upper === 'REVISE' || upper === 'REJECT') return upper
  return null
}

/**
 * The verdict for one round, from the child's reply text, FAILING CLOSED: an
 * unreadable reply becomes `REVISE`, never `APPROVE`.
 */
export function readVerdictFromReply(replyText: string): DelegationVerdict {
  const parsed = parseReplyVerdict(replyText)
  if (parsed.verdict !== null) return parsed.verdict
  return 'REVISE'
}

/**
 * The repair instruction for a round whose reply did not approve.
 *
 * Findings drive it when the reply carried them (and are the ONLY source of
 * instruction text — a child cannot inject instructions, since only the titles
 * travel). When there is nothing to quote, the instruction states the contract
 * violation instead of asking vaguely for "improvement", because a repair request
 * that does not say what was wrong cannot be acted on.
 */
export function readRepairFromReply(replyText: string): string {
  const parsed = parseReplyVerdict(replyText)
  if (parsed.findings.length > 0) return 'Address the findings: ' + parsed.findings.join('; ')
  if (parsed.problem !== null) {
    return 'Your reply.md could not be read as a review: ' + parsed.problem + '. Re-submit with the required '
      + 'JSON contract (verdict APPROVE | REVISE | REJECT, plus findings) written to reply.md.'
  }
  return 'REVISE: address the review findings and re-submit.'
}

/**
 * Run a multi-round delegated task on ONE durable continuable child:
 * 1. `startContinuable` (initial prompt) — `start()` is never called.
 * 2. `awaitRoundResult` observes the child's settlement for that round.
 * 3. On REVISE: `followup` delivers the repair instruction to the SAME child.
 * 4. On APPROVE/REJECT: finish (accepted only when the verdict is APPROVE and
 *    the result evaluates as accepted).
 *
 * `awaitRoundResult(childId, messageId)` is the ONLY parent-side observation
 * seam: in live usage it waits for the child's settlement notice (the child's
 * `reportFrom` lands in the parent's inbox); in tests it is a fake queue.
 */
export async function delegateContinuable(input: {
  subagents: SubagentsRuntimeLike
  provider: string
  label: string
  prompt: string
  parent?: SubagentParentHandle
  toolFilter?: unknown
  maxDepth?: number
  childId?: ContinuableChildId
  /**
   * T36: RESUME an existing durable child instead of starting one. The turn-shaped
   * caller passes the childId from a previous `parked` round, which is what makes
   * the loop resumable across turns — `startContinuable` is not called, so a parked
   * round does not create a second child.
   */
  resumeChild?: ContinuableChildId
  maxRounds?: number
  readVerdict?: (result: SubagentResultLike) => DelegationVerdict
  readRepair?: (result: SubagentResultLike) => string | undefined
  awaitRoundResult?: (childId: ContinuableChildId, messageId: ContinuableMessageId) => Promise<SubagentResultLike | null>
  /** T9: the child's provider/model overrides, forwarded onto the start request verbatim. */
  agentOptions?: { model?: string; provider?: string }
}): Promise<ContinuableDelegationLike> {
  const { subagents, provider, label, prompt, parent, toolFilter, maxDepth } = input
  const maxRounds = input.maxRounds ?? 3
  const readVerdict = input.readVerdict ?? readVerdictFromStructured
  const readRepair = input.readRepair ?? readRepairFromStructured

  const startContinuable = subagents?.startContinuable
  const followup = subagents?.followup
  // A continuable loop MUST observe the child's real settlement AND hold the
  // exact live parent Agent (the live service authorizes followup by object
  // identity). When either is missing, fall back to one-shot (which returns the
  // actual result) rather than fabricating authority and silently APPROVE-ing.
  const hasContinuableSeam = startContinuable !== undefined && followup !== undefined && input.awaitRoundResult !== undefined
  if (!hasContinuableSeam || subagents === undefined || parent === undefined) {
    // ⚠ FU-9 — NAME WHICH CONDITION FAILED, because this branch covers THREE of them and the report did not.
    // A live run returned `status: unavailable` with "no continuable seam or no live parent" for three rounds,
    // making its cause UNDECIDABLE while this code knew it exactly. That is the defect class this session keeps
    // finding - a surface describing less than the code knows - and it cost more than the bug it was hiding.
    const fallbackReason = 'missing ' + [
      hasContinuableSeam ? null : 'the continuable seam (startContinuable, followup, awaitRoundResult)',
      subagents === undefined ? 'the subagents runtime' : null,
      parent === undefined ? 'the exact live parent Agent' : null,
    ].filter((part): part is string => part !== null).join(', ')
    // Fall back to one-shot delegation (self-audit-safe): never silently drop.
    try {
      const oneShot = await delegate({
        subagents,
        provider,
        request: {
          prompt: [{ type: 'text', text: prompt }],
          label,
          toolFilter,
          maxDepth,
          parent,
        },
      })
      const verdict = readVerdict(oneShot)
      return {
        ok: true,
        rounds: [{ text: prompt, result: oneShot }],
        accepted: verdict === 'APPROVE' && evaluateDelegationResult(oneShot).accepted,
        fellBackToOneShot: true,
        reason: fallbackReason,
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err), rounds: [], accepted: false, fellBackToOneShot: true }
    }
  }

  const messageIds: ContinuableMessageId[] = []
  const rounds: ContinuableRoundLike[] = []
  let childId: ContinuableChildId | undefined

  const request: ContinuableStartSpecLike['request'] = {
    prompt: [{ type: 'text', text: prompt }],
    parent,
  }
  if (toolFilter !== undefined) request.toolFilter = toolFilter
  if (maxDepth !== undefined) request.maxDepth = maxDepth
  // T9: the child's provider/model overrides, forwarded only when the caller supplied them —
  // and the caller supplies them only for a provider that DECLARES the capability, because the
  // harness rejects a start that carries them otherwise.
  if (input.agentOptions !== undefined) request.agentOptions = input.agentOptions

  const spec: ContinuableStartSpecLike = {
    provider,
    label,
    request,
  }
  if (input.childId !== undefined) spec.childId = input.childId
  try {
    if (input.resumeChild !== undefined) {
      // T36: RESUME. The initial prompt went out in an earlier turn, so this round
      // has no message id of its own — and the observer keys on the CHILD anyway,
      // because the settlement log is child-keyed. Starting a second child here
      // would orphan the one already doing the work.
      childId = input.resumeChild
      rounds.push({ text: prompt })
    } else {
      const started = await startContinuable(spec)
      childId = started.childId
      messageIds.push(started.messageId)
      rounds.push({ text: prompt })
    }

    for (let round = 0; round < maxRounds; round += 1) {
      const current = rounds[round]
      const lastMessageId = messageIds.length > 0
        ? messageIds[messageIds.length - 1]!
        : ('' as ContinuableMessageId)
      const observed = await input.awaitRoundResult!(childId, lastMessageId)
      if (observed === null) {
        // NOT a failure: nothing has settled yet. Reported as `parked` so a
        // turn-shaped caller resumes on a later turn instead of treating the round
        // as lost, and so `accepted` stays false — an unobserved round is never an
        // approval.
        return {
          ok: false,
          reason: 'no settlement has landed for round ' + (round + 1) + ' yet (the child is still working)',
          childId,
          messageIds,
          rounds,
          accepted: false,
          parked: true,
        }
      }
      current.result = observed
      const verdict = readVerdict(observed)
      if (verdict !== 'REVISE') {
        const accepted = verdict === 'APPROVE' && evaluateDelegationResult(observed).accepted
        return {
          ok: accepted,
          reason: accepted ? 'delegation completed' : 'delegation stopped with verdict ' + verdict,
          childId,
          messageIds,
          rounds,
          accepted,
        }
      }
      // REVISE: send the repair instruction to the SAME child (FIFO, context retained).
      const repair = readRepair(observed)
      if (!repair) {
        return { ok: false, reason: 'REVISE verdict without a repair instruction', childId, messageIds, rounds, accepted: false }
      }
      const followupId = await followup(
        parent,
        childId,
        [{ type: 'text', text: repair }],
        { source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id ?? '' } },
      )
      messageIds.push(followupId)
      current.revise = true
      current.repair = repair
      rounds.push({ text: repair })
    }
    return { ok: false, reason: 'max rounds reached without an APPROVE', childId, messageIds, rounds, accepted: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Failure preserves the child (a later followup may still resume it); the
    // kill switch is explicit (interruptContinuable), never implicit.
    return { ok: false, reason: message, childId, messageIds, rounds, accepted: false }
  }
}

/**
 * T4 kill switch: interrupt one live continuable child's current turn. Admission
 * is synchronous, the effect asynchronous, and the child's pending inbox is
 * preserved (keepInbox semantics) — a followup later resumes the parked queue.
 */
export function interruptContinuable(
  subagents: SubagentsRuntimeLike,
  childId: ContinuableChildId,
  parentSessionId: string,
): ContinuableOpResult {
  const interrupt = subagents?.interrupt
  if (interrupt === undefined) {
    return { ok: false, reason: 'no continuable interrupt seam' }
  }
  try {
    interrupt(childId, { kind: 'user', parentSessionId })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * T4 closeout: release one continuable child (host drains its Activation and
 * disposes its handle). No-op when the seam lacks the method (one-shot hosts).
 */
export async function drainContinuableChildren(
  subagents: SubagentsRuntimeLike,
  parent: SubagentParentHandle,
  childIds: readonly ContinuableChildId[],
): Promise<ContinuableOpResult> {
  if (subagents?.drainContinuableChildren === undefined || childIds.length === 0) return { ok: true }
  try {
    await subagents.drainContinuableChildren(parent, childIds)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * T4 closeout (host teardown path): release every continuable descendant below
 * the given live parents (mirrors the live `drainContinuableDescendants`).
 * No-op when the seam lacks the method; the host owns this at session teardown.
 */
export async function drainContinuableDescendants(
  subagents: SubagentsRuntimeLike | null,
  parents: readonly SubagentParentHandle[],
): Promise<ContinuableOpResult> {
  const drain = subagents?.drainContinuableDescendants
  if (drain === undefined || parents.length === 0) return { ok: true }
  try {
    await drain(parents)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export interface Reference {
  path: string
  lineRange?: string
}
export interface ReferenceCheck {
  ok: boolean
  failures: string[]
  checked: { path: string; ok: boolean; reason?: string }[]
}

function norm(repoRelative: string): string {
  return repoRelative.replace(/\\/g, '/').replace(/^\/+/, '')
}

function resolveUnderRoot(root: string, repoRelative: string): string {
  const normalized = norm(repoRelative)
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, normalized)
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  if (abs !== rootAbs && !abs.startsWith(rootPrefix)) {
    throw new Error('Path escapes the workspace root: ' + repoRelative)
  }
  return abs
}

/**
 * Validate every claimed reference: the path exists under root, and a line
 * range (e.g. '10-20' or '10') is within the file's line count.
 */
export function validateReferences(root: string, references: Reference[]): ReferenceCheck {
  const checked: ReferenceCheck['checked'] = []
  const failures: string[] = []
  for (const ref of references) {
    const rel = norm(ref.path)
    if (!rel) {
      checked.push({ path: ref.path, ok: false, reason: 'empty path' })
      failures.push('empty reference path')
      continue
    }
    let abs: string
    try {
      abs = resolveUnderRoot(root, rel)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      checked.push({ path: ref.path, ok: false, reason })
      failures.push(rel + ': ' + reason)
      continue
    }
    if (!existsSync(abs)) {
      checked.push({ path: ref.path, ok: false, reason: 'path does not exist' })
      failures.push(rel + ': path does not exist')
      continue
    }
    if (ref.lineRange) {
      const total = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n').length
      const range = ref.lineRange.trim()
      const single = /^\d+$/.test(range)
      const pair = /^(\d+)-(\d+)$/.exec(range)
      let start = 0
      let end = 0
      if (single) {
        start = Number(range)
        end = Number(range)
      } else if (pair) {
        start = Number(pair[1])
        end = Number(pair[2])
      } else {
        checked.push({ path: ref.path, ok: false, reason: 'invalid lineRange ' + range })
        failures.push(rel + ': invalid lineRange ' + range)
        continue
      }
      if (start < 1 || end < start || end > total) {
        const reason = 'lineRange ' + range + ' out of bounds (file has ' + total + ' lines)'
        checked.push({ path: ref.path, ok: false, reason })
        failures.push(rel + ': ' + reason)
        continue
      }
    }
    checked.push({ path: ref.path, ok: true })
  }
  return { ok: failures.length === 0, failures, checked }
}

export interface ActionRecordInput {
  root: string
  runId: string
  subagentId: string
  phase: string
  purpose: string
  executionMode: string
  artifactPath?: string
  upstreamArtifacts?: string[]
  reviewBundle?: string
  diffBasis?: string
  codeRefs?: string[]
  auditQuestions?: string[]
  actionsTaken?: string[]
  createdFiles?: string[]
  modifiedFiles?: string[]
  reviewedFiles?: string[]
  findings?: string[]
  success: boolean
  stopReason?: string
  /**
   * ⚠ FU-9 — WHY IT FAILED, when it did. `success` is a boolean, so a record could say `Status: failed` and
   * nothing else: a delegation that FAILED and a delegation that NEVER HAPPENED read identically, which is what
   * let me conclude for three rounds that the host was not scheduling children. The caller ALREADY passed
   * `stopReason`, and the live record said `n/a` — because there was no result to take a stop reason from.
   */
  failure?: string
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'action'
}

/**
 * Write a durable action record under subagents/ in the shape this repo's own
 * linter accepts (ts-lint.ts lintSubagentActionRecordFile — every top-level .md
 * under a run's subagents/ is linted as one):
 *   - the literal title `# Subagent Action Record`;
 *   - `Run ID` and `Timestamp` in ## Metadata (Run ID must equal the run dir name);
 *   - `Current Artifact`, `Artifact Content Hash` (the artifact's LF-normalized
 *     sha256, derived from the artifact itself — no extra caller input), `Diff
 *     Basis`, `Review Bundle`, and the NAMED fields `Upstream Artifacts` /
 *     `Code Refs` strictly inside ## Inputs Provided. The linter resolves each of
 *     those through the heading body, so a field under another heading is not
 *     found at all.
 * A success:false attempt is written with a failed status and is NOT accepted.
 */
export function writeActionRecord(input: ActionRecordInput): string {
  const { root, runId } = input
  const dir = resolveUnderRoot(root, '.recursive/run/' + runId + '/subagents')
  mkdirSync(dir, { recursive: true })
  const fileName = Date.now() + '-' + slugify(input.subagentId) + '-action.md'
  const path = join(dir, fileName)

  const tick = String.fromCharCode(96)
  const code = (value: string) => tick + norm(value) + tick

  const list = (title: string, values: string[]) => {
    const out: string[] = [title]
    if (!values?.length) {
      out.push('- none')
      return out
    }
    for (const v of values) out.push('- ' + code(v))
    return out
  }

  /** A NAMED field whose value is a block of backticked paths (`Field: none` when empty). */
  const namedList = (fieldName: string, values: string[]): string[] =>
    values.length
      ? ['- ' + fieldName + ':', ...values.map((v) => '  - ' + code(v))]
      : ['- ' + fieldName + ': none']

  const artifactRel = input.artifactPath ? norm(input.artifactPath) : ''
  let artifactHash = ''
  if (artifactRel) {
    try {
      const artifactAbs = resolveUnderRoot(root, artifactRel)
      if (existsSync(artifactAbs)) artifactHash = contentSha256(readFileSync(artifactAbs, 'utf8'))
    } catch {
      artifactHash = ''
    }
  }

  const lines: string[] = [
    // The canonical template (references/artifact-template.md) H1 and the string the
    // linter looks for — the subagent identity belongs in Metadata, not the title.
    '# Subagent Action Record',
    '',
    '## Metadata',
    '- Subagent ID: ' + input.subagentId,
    '- Run ID: ' + runId,
    '- Phase: ' + input.phase,
    '- Purpose: ' + input.purpose,
    '- Execution Mode: ' + input.executionMode,
    '- Status: ' + (input.success ? 'accepted' : 'failed'),
    // ⚠ EMITTED ONLY WHEN A REASON IS GIVEN, so a caller that says nothing produces the record it always did.
    // Not politeness: this record's shape is asserted by specs, and a first attempt that always emitted the line
    // failed 13 tests across 5 files. A change to a shared surface should be additive where it can be.
    ...(input.success === false && input.failure !== undefined ? ['- Failure: ' + input.failure] : []),
    '- Stop Reason: ' + (input.stopReason ?? 'n/a'),
    // Timestamp LAST in Metadata. This USED to be load-bearing: `getHeadingBody` ended
    // its capture with a `\Z` that JavaScript reads as a literal `Z`, so a body was
    // truncated at its first `Z` and an ISO timestamp could cut the section short. T33
    // replaced that anchor with `(?![\s\S])`, so the hazard is gone and this ordering is
    // now only conventional — kept because Timestamp is naturally the last metadata field.
    '- Timestamp: ' + new Date().toISOString(),
    '',
    '## Inputs Provided',
    ...(artifactRel ? ['- Current Artifact: ' + code(artifactRel)] : []),
    ...(artifactHash ? ['- Artifact Content Hash: ' + code(artifactHash)] : []),
    '- Diff Basis: ' + (input.diffBasis ?? 'n/a'),
    ...namedList('Upstream Artifacts', input.upstreamArtifacts ?? []),
    ...(input.reviewBundle ? ['- Review Bundle: ' + code(norm(input.reviewBundle))] : []),
    ...namedList('Code Refs', input.codeRefs ?? []),
    '- Audit / Task Questions: ' + (input.auditQuestions?.length ? input.auditQuestions.join(' ') : 'n/a'),
    '',
    '## Claimed Actions Taken',
    ...list('', input.actionsTaken ?? []).slice(1),
    '',
    '## Claimed File Impact',
    ...(input.createdFiles?.length ? ['### Created', ...list('', input.createdFiles).slice(1)] : ['### Created', '- none']),
    ...(input.modifiedFiles?.length ? ['### Modified', ...list('', input.modifiedFiles).slice(1)] : ['### Modified', '- none']),
    ...(input.reviewedFiles?.length ? ['### Reviewed', ...list('', input.reviewedFiles).slice(1)] : ['### Reviewed', '- none']),
    '',
    '## Claimed Artifact Impact',
    ...list('### Read', input.upstreamArtifacts ?? []).slice(1),
    '',
    '## Claimed Findings',
    ...(input.findings?.length ? input.findings.map((f) => '- ' + f) : ['- none']),
    '',
    '## Verification Handoff',
    '- Inspect first: ' + (artifactRel ? code(artifactRel) : 'n/a'),
    '- Notes: main agent must verify every claimed reference against actual files, actual recursive artifacts, and the actual diff before acceptance.',
    '',
    // Provenance tail. This USED to be load-bearing: with the old `\Z` anchor a
    // document's FINAL section always read as empty, so `## Verification Handoff` would
    // have been reported as "Missing or empty section" unless something followed it. T33
    // gave the section parsers a real end-of-input assertion, so the trailing heading is
    // no longer needed to satisfy the linter — it is kept because the record genuinely
    // wants to state who wrote it and how its hashes are computed.
    '## Record Provenance',
    '- Writer: dsh-recursive-mode ' + code('writeActionRecord') + ' (plugin-generated action record; hashes are LF-normalized sha256).',
    '- Contract: canonical Subagent Action Record sections, as read by recursive_lint.',
    '',
  ]

  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

/**
 * Accept/reject a delegation result: a success:false or non-completed
 * stopReason is a failed attempt (diagnostics preserved, NOT accepted).
 */
export function evaluateDelegationResult(result: SubagentResultLike): { accepted: boolean; reason: string } {
  if (result.success === false) {
    return { accepted: false, reason: 'delegation reported success:false' }
  }
  if (result.stopReason && result.stopReason !== 'completed') {
    return { accepted: false, reason: 'delegation stopped with reason ' + result.stopReason }
  }
  return { accepted: true, reason: 'delegation completed' }
}

/**
 * T8 — the child's CLAIMED references, read from wherever the delegation put them.
 *
 * The review output schema requires `references`, so a reviewer states which files back its
 * verdict — and NOTHING read that field: `evaluateDelegationResult` looks only at
 * `success`/`stopReason`, so a review citing files that do not exist was indistinguishable
 * from one citing real evidence. This reads the claims so they can be checked.
 *
 * Both carriers are tried, because a delegation may return structured output or the raw
 * JSON text: `structured` first (the native path), then `output` parsed as JSON. A result
 * that carries neither yields `[]` — "no claims" — which the caller treats as NOTHING TO
 * CHECK rather than as a pass, so an unparseable result can never be mistaken for a
 * verified one. Malformed entries are dropped rather than thrown on: this reads a model's
 * output, which is untrusted.
 */
export function referencesFromResult(result: SubagentResultLike): Reference[] {
  const candidates: unknown[] = []
  if (result.structured !== undefined && result.structured !== null && typeof result.structured === 'object') {
    candidates.push((result.structured as { references?: unknown }).references)
  }
  if (typeof result.output === 'string' && result.output.trim() !== '') {
    try {
      const parsed = JSON.parse(result.output) as { references?: unknown } | null
      if (parsed !== null && typeof parsed === 'object') candidates.push(parsed.references)
    } catch {
      // Not JSON: no structured claims to read. Never a failure of the delegation itself.
    }
  }
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const refs: Reference[] = []
    for (const entry of candidate) {
      if (entry === null || typeof entry !== 'object') continue
      const path = (entry as { path?: unknown }).path
      if (typeof path !== 'string' || path.trim() === '') continue
      const reference: Reference = { path }
      const lineRange = (entry as { lineRange?: unknown }).lineRange
      if (typeof lineRange === 'string') reference.lineRange = lineRange
      refs.push(reference)
    }
    if (refs.length > 0) return refs
  }
  return []
}
