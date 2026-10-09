/**
 * T23 — `recursive_ask`: the three human gates as STRUCTURED decisions, not prose.
 *
 * WHY. Three points in this workflow genuinely block on a person, and all three are prose today:
 * the `TDD Mode: strict|pragmatic` choice at phase-3 entry, QA sign-off at phase 5, and resolving a
 * gate block. Prose means the answer arrives as free text in a transcript — unvalidated, unciteable,
 * and impossible to write back into the artifact as a fact. Asking as a STRUCTURED question gives
 * the answer a shape the workflow can consume, and the harness renders that shape as a card.
 *
 * ⚠ WHAT IS MEASURED AND WHAT IS NOT. The ask flow is a CLIENT concern: the harness renders these
 * questions as cards (`ui-user-questions`, the ask-question card model), so the plugin's job is to
 * produce a well-formed question and to record the answer — not to draw anything. The LENGTH LIMITS
 * below are therefore the plugin's OWN documented bounds rather than a claimed mirror of a harness
 * constant I did not measure; what matters for the workflow is that an over-long field is refused
 * **with its field path**, which is what the item's RED asks for.
 *
 * ⚠ ONE ASK PER STEP. A step that asks twice produces two cards for one decision, and the second
 * answer silently overwrites the first — a decision the workflow never sees. The guard refuses the
 * second ask in the same step rather than letting the last writer win.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'
import { toolError } from './errors.ts'
import {
  RUN_START_APPROVE,
  RUN_START_ARTIFACT,
  RUN_START_GATE,
  RUN_START_GATE_ID,
} from './run-start.ts'


/** The identifiers the workflow uses for its three human gates. */
export const ASK_GATE_IDS = ['tdd-mode', 'qa-signoff', 'gate-block'] as const
export type AskGateId = (typeof ASK_GATE_IDS)[number]

/**
 * PHASE 0 — THE FOURTH GATE, AND WHY IT IS NOT IN `ASK_GATE_IDS`.
 *
 * The three above are the WORKFLOW's gates, and their membership is asserted as exactly those three.
 * Starting a run is a different kind of decision — it decides whether there is a run at all, and
 * approving it ARMS A GOAL the harness will keep driving — so its data lives in `run-start.ts` with its
 * own contract and its own options. Widening the workflow's gate list must not silently widen what may
 * start a run.
 */
export type AskAnyGateId = AskGateId | typeof RUN_START_GATE_ID

/** Is this gate id the run-start gate? */
export function isRunStartGate(gateId: string): boolean {
  return gateId === RUN_START_GATE_ID
}

/** Every gate id `recursive_ask` accepts, workflow gates first. */
export function askGateIds(): string[] {
  return [...ASK_GATE_IDS, RUN_START_GATE_ID]
}

/** The artifact a gate's answer belongs in — the run-start gate's is fixed to the Phase 0 requirements. */
export function askGateArtifact(gateId: AskAnyGateId): string {
  return isRunStartGate(gateId) ? RUN_START_ARTIFACT : GATE_DEFAULT_ARTIFACT[gateId as AskGateId]
}

/** The plugin's own documented bounds — see the module comment on why these are not a claimed mirror. */
export const MAX_HEADER_CHARS = 12
export const MAX_LABEL_CHARS = 30
export const MAX_DESCRIPTION_CHARS = 200

export interface AskOption {
  label: string
  description?: string
}

/** A structured question, in the shape the ask flow renders as a card. */
export interface AskQuestion {
  id: string
  header: string
  question: string
  options: AskOption[]
}

/** One of the three gates, as data: what to ask, what the options mean, and what the answer means. */
export interface AskGate {
  id: AskGateId
  header: string
  question: string
  options: AskOption[]
  /** The artifact marker name the answer is written under. */
  marker: string
}

export const ASK_GATES: Record<AskGateId, AskGate> = {
  'tdd-mode': {
    id: 'tdd-mode',
    header: 'TDD Mode',
    question: 'How should phase 3 handle test evidence?',
    options: [
      { label: 'strict', description: 'RED and GREEN evidence paths are required before the phase can lock.' },
      { label: 'pragmatic', description: 'A written rationale is accepted in place of evidence paths.' },
    ],
    marker: 'TDD Mode',
  },
  'qa-signoff': {
    id: 'qa-signoff',
    header: 'QA sign-off',
    question: 'Who signs off the manual QA phase?',
    options: [
      { label: 'human', description: 'A person runs and signs the QA checklist.' },
      { label: 'agent-operated', description: 'The agent runs it and records the results.' },
      { label: 'hybrid', description: 'The agent runs it; a person signs the result.' },
    ],
    marker: 'QA Execution Mode',
  },
  'gate-block': {
    id: 'gate-block',
    header: 'Gate block',
    question: 'A gate is blocking this transition. How should it be resolved?',
    options: [
      { label: 'fix', description: 'Return to the phase and satisfy the gate.' },
      { label: 'reopen', description: 'Reopen an earlier locked artifact and repair it there.' },
      { label: 'abandon', description: 'Stop the run; the block is not resolvable now.' },
    ],
    marker: 'Gate Resolution',
  },
}

/** Thrown for a request the ask flow would refuse; carries the FAILING FIELD PATH. */
export class AskValidationError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(field + ': ' + message)
    this.name = 'AskValidationError'
    this.field = field
  }
}

/**
 * Validate a question and return it unchanged.
 *
 * The FIELD PATH travels in the error because a caller fixing an over-long header needs to know
 * WHICH field — a bare "too long" for a request with four fields is a puzzle, not a diagnostic.
 */
export function validateAskQuestion(question: AskQuestion): AskQuestion {
  if (question.header.trim() === '') throw new AskValidationError('header', 'must not be empty')
  if (question.header.length > MAX_HEADER_CHARS) {
    throw new AskValidationError('header', 'is ' + question.header.length + ' characters, over the ' + MAX_HEADER_CHARS + '-character limit')
  }
  if (question.question.trim() === '') throw new AskValidationError('question', 'must not be empty')
  if (question.options.length === 0) throw new AskValidationError('options', 'at least one option is required')
  question.options.forEach((option, index) => {
    if (option.label.trim() === '') throw new AskValidationError('options[' + index + '].label', 'must not be empty')
    if (option.label.length > MAX_LABEL_CHARS) {
      throw new AskValidationError('options[' + index + '].label', 'is ' + option.label.length + ' characters, over the ' + MAX_LABEL_CHARS + '-character limit')
    }
    if (option.description !== undefined && option.description.length > MAX_DESCRIPTION_CHARS) {
      throw new AskValidationError('options[' + index + '].description', 'is ' + option.description.length + ' characters, over the ' + MAX_DESCRIPTION_CHARS + '-character limit')
    }
  })
  return question
}

/** Build the question for a gate, validated. */
export function buildAskQuestion(gateId: AskGateId): AskQuestion {
  const gate = ASK_GATES[gateId]
  return validateAskQuestion({
    id: gate.id,
    header: gate.header,
    question: gate.question,
    options: gate.options.map((option) => ({ ...option })),
  })
}

/**
 * PHASE 0 — build the question for ANY accepted gate, including the run-start gate.
 *
 * A separate entry point rather than a widened `buildAskQuestion` so the three workflow gates keep the
 * exact signature and behaviour their callers (and `runtime.phaseRules`) already rely on.
 */
export function buildAskQuestionFor(gateId: AskAnyGateId): AskQuestion {
  if (isRunStartGate(gateId)) {
    return validateAskQuestion({
      id: RUN_START_GATE.id,
      header: RUN_START_GATE.header,
      question: RUN_START_GATE.question,
      options: RUN_START_GATE.options.map((option) => ({ ...option })),
    })
  }
  return buildAskQuestion(gateId as AskGateId)
}

/**
 * PHASE 0 — validate an answer to ANY accepted gate.
 *
 * The run-start gate accepts only the labels IT offered, exactly like the other three, and the check is
 * the same `ASK_GATES`-shaped test against its own options. An answer of `maybe` is refused rather than
 * recorded, because a recorded non-answer is the failure mode this whole change exists to prevent.
 */
export function validateAskAnswerFor(gateId: AskAnyGateId, answer: string): string {
  if (isRunStartGate(gateId)) {
    const offered = RUN_START_GATE.options.map((option) => option.label) as readonly string[]
    if (!offered.includes(answer)) {
      throw new AskValidationError('answer', 'must be one of ' + offered.join(' | ') + ' (got ' + JSON.stringify(answer) + ')')
    }
    return answer
  }
  return validateAskAnswer(gateId as AskGateId, answer)
}

/**
 * Validate an answer against its gate.
 *
 * An answer that is not one of the offered labels is REFUSED rather than recorded: a marker saying
 * `TDD Mode: maybe` would look like a decision and be a transcription error.
 */
export function validateAskAnswer(gateId: AskGateId, answer: string): string {
  const gate = ASK_GATES[gateId]
  if (!gate.options.some((option) => option.label === answer)) {
    throw new AskValidationError('answer', 'must be one of ' + gate.options.map((option) => option.label).join(' | ') + ' (got ' + JSON.stringify(answer) + ')')
  }
  return answer
}

/** The durable marker an accepted answer is written back as — a fact, not a chat aside. */
export function answerMarker(gateId: AskGateId, answer: string): string {
  const gate = ASK_GATES[gateId]
  return '- ' + gate.marker + ': ' + answer
}

/**
 * One-ask-per-step guard.
 *
 * A step that asks twice yields two cards for one decision and the second answer silently wins —
 * so the second ask is REFUSED, naming the gate already asked this step.
 */
export function createAskLedger(): { claim(gateId: AskGateId): void; asked(): AskGateId[] } {
  const asked: AskGateId[] = []
  return {
    claim(gateId: AskGateId): void {
      if (asked.includes(gateId)) {
        throw new AskValidationError('gate', 'the ' + gateId + ' gate was already asked in this step; one ask per step')
      }
      if (asked.length > 0) {
        throw new AskValidationError('gate', 'this step already asked ' + asked.join(', ') + '; answer it before asking again')
      }
      asked.push(gateId)
    },
    asked: () => [...asked],
  }
}

/** Which artifact each gate's answer belongs in, when the caller does not name one. */
export const GATE_DEFAULT_ARTIFACT: Record<AskGateId, string> = {
  'tdd-mode': '03-implementation-summary.md',
  'qa-signoff': '05-manual-qa.md',
  // A gate block can happen at any phase, so its marker belongs where the caller says.
  'gate-block': '',
}

/**
 * FU-7 — THE CALL POINTS: which gate, if any, a phase ENTRY still owes.
 *
 * ⚠ THE ARTIFACT IS THE RECORD, so no ledger is needed to ask once: if the document already carries the
 * gate's marker line, the question has been answered and is not asked again. That is the same
 * "once per run at entry" property T29 got from riding an existing gate — one mechanism, not two.
 *
 * ⚠ AND AN UNKNOWN PHASE OWES NOTHING. Returning a gate for a phase that has no such decision would ask a
 * person a question the workflow does not act on, which is worse than not asking at all.
 */
export function pendingGateFor(artifactFile: string, artifactText: string | null): AskGateId | null {
  const gate = (Object.keys(GATE_DEFAULT_ARTIFACT) as AskGateId[])
    .find((id) => GATE_DEFAULT_ARTIFACT[id] === artifactFile)
  if (gate === undefined) return null
  const marker = ASK_GATES[gate].marker
  // Already answered: the marker is in the document, so the decision is settled.
  if (artifactText !== null && new RegExp('^- ' + marker + ':', 'm').test(artifactText)) return null
  return gate
}

/**
 * T23 — the tool.
 *
 * TWO BRANCHES, and the split is the point: called WITHOUT an answer it ASKS (returning the validated
 * question, which the host renders as a card), and called WITH one it RECORDS — validating the label,
 * writing the marker into the artifact, and reporting the line it wrote. A tool that did both in one
 * call would have to invent the answer.
 *
 * ⚠ THE WRITE-BACK IS A MARKER LINE, REPLACED IN PLACE when the artifact already carries one. A
 * second `TDD Mode:` line would leave two answers to one question and make "what was decided?"
 * depend on which a reader found first.
 *
 * ⚠ PHASE 0 — `run-start` IS RECORDED BY THE PLUGIN, NEVER BY A BARE MARKER WRITE. See
 * `recordRunStartAnswer`: it is the only path that can arm a run goal, it prefers the blocking human
 * channel, and it fails closed when no person can be reached.
 */
export function createRecursiveAskTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_ask',
    description: 'Ask a human gate as a structured decision (tdd-mode, qa-signoff, gate-block), or ASK TO START A RUN (run-start: nothing runs, and no goal exists, until this gate is approved). Call without `answer` to ask; call with it to write the answer into the artifact as a durable marker. For run-start the mounted human channel is asked first and its own selection wins; when that channel cannot deliver the question, the refusal names the cause and `relay=true` with an explicit `answer` records the person\'s relayed approval. One ask per step.',
    parameters: {
      gate: { type: 'string', description: 'tdd-mode | qa-signoff | gate-block | run-start. Required. `run-start` is phase 0: approving it records the approval and arms the run goal, which is what makes the harness drive rounds.' },
      runId: { type: 'string', description: 'Run id. Required; must resolve inside the current workspace.' },
      artifact: { type: 'string', description: 'Artifact file the answer belongs in. Optional; defaults per gate (gate-block has none, so it is required for that gate; run-start is always recorded in 00-requirements.md).' },
      answer: { type: 'string', description: 'One of the gate\'s option labels. Omit to ASK. For run-start, the labels are: ' + RUN_START_GATE.options.map((option) => option.label).join(' | ') + '.' },
      relay: { type: 'boolean', description: 'run-start only, and only after the person has approved in this conversation. Set relay=true when the mounted user-questions channel cannot deliver the run-start question: `answer` then stands in for the channel\'s selection and the result reports source: "relayed" instead of a direct selection. It is refused when the channel reports the question was cancelled, aborted, or timed out, and it is not needed when the person answers the card.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { gate?: string; runId?: string; artifact?: string; answer?: string; relay?: boolean }, exec) {
      const gateId = (args.gate ?? '').trim() as AskAnyGateId
      const runId = args.runId?.trim() ?? ''
      if (runId === '') return { error: toolError('MISSING_RUN_ID') } as const
      if (!askGateIds().includes(gateId)) {
        return { error: toolError('BAD_ASK_GATE', 'gate must be one of ' + askGateIds().join(' | ')) } as const
      }
      // ⚠ `relay` IS RUN-START ONLY, AND SAYING SO IS THE POINT. The other three gates never consult the
      // channel, so accepting the flag there would report a fallback that did not happen — the same class
      // of false claim this tool was fixed for.
      if (args.relay === true && !isRunStartGate(gateId)) {
        return { error: toolError('RELAY_ONLY_FOR_RUN_START', 'gate is ' + gateId) } as const
      }
      const root = await recursive.resolveWorkspaceRoot(exec.agent)
      if (!root) return { error: toolError('NO_WORKSPACE') } as const

      // The run-start gate's artifact is FIXED: the Phase 0 requirements document is the run's own
      // phase-0 record, and letting a caller aim the approval somewhere else is how an approval ends up
      // in a file no reader looks at. Every other gate keeps its per-gate default and its override.
      const artifact = (isRunStartGate(gateId) ? RUN_START_ARTIFACT : args.artifact ?? GATE_DEFAULT_ARTIFACT[gateId as AskGateId]).trim()
      let question: AskQuestion
      try {
        question = buildAskQuestionFor(gateId)
      } catch (err) {
        // The plugin's own gate data failing validation is a defect, so it is reported as one
        // rather than asked: a malformed card would be answered by a person who cannot fix it.
        return { error: toolError('BAD_ASK_GATE', err instanceof Error ? err.message : String(err)) } as const
      }

      // ASK.
      //
      // ⚠ PHASE 0 EXCEPTION, AND IT IS THE WHOLE POINT OF THE CHANNEL. For the three workflow gates a
      // question is answered by relaying a label, so "no answer means ask". Starting a run is the decision
      // that creates the armed goal, so when this composition mounts the blocking human channel the
      // question is PUT TO THE PERSON whether or not an answer argument arrived — a caller cannot skip the
      // person by supplying one. Only a composition with no channel falls back to the relayed answer, and
      // a channel that FAILED is a third case: it is reported with its cause, and the relayed answer is
      // taken only when the caller asks for the relay in so many words (see `recordRunStartAnswer`).
      const channelMounted = recursive.userQuestionsChannel !== null
      if (args.answer === undefined && !(isRunStartGate(gateId) && channelMounted)) {
        return { gate: gateId, marker: isRunStartGate(gateId) ? RUN_START_GATE.marker : ASK_GATES[gateId as AskGateId].marker, artifact, question } as unknown as JsonValue
      }

      // RECORD.
      let answer: string | undefined
      if (args.answer === undefined) {
        answer = undefined
      } else {
        try {
          answer = validateAskAnswerFor(gateId, args.answer)
        } catch (err) {
          return { error: toolError('BAD_ASK_ANSWER', err instanceof Error ? err.message : String(err)) } as const
        }
      }
      if (artifact === '') {
        return { error: toolError('MISSING_ASK_ARTIFACT', 'this gate needs an explicit artifact to record into') } as const
      }
      if (isRunStartGate(gateId)) {
        return recordRunStartAnswer(recursive, root, runId, answer, exec, args.relay === true) as unknown as JsonValue
      }
      const marker = answerMarker(gateId as AskGateId, answer as string)
      const written = recursive.recordAskAnswer(root, runId, artifact, marker)
      return { gate: gateId, answer, marker, artifact, path: written.path, replaced: written.replaced } as unknown as JsonValue
    },
  })
}

/**
 * PHASE 0 — record the answer to the run-start gate, and start the run only if it says so.
 *
 * ⚠ THREE OUTCOMES, AND TELLING THEM APART IS THE FIX. The first version of this function collapsed all of
 * them into one `null`: "the channel threw", "the channel resolved with something unrecognisable", and
 * "nobody answered" produced the same refusal, whose text asserted a cause ("so no person was asked") the
 * plugin had already thrown away. A live session paid for that: the call failed after 22.9 s, the operator
 * could not be told why, and the refusal's own advice prescribed the call that had just failed. So:
 *
 *   1. A PERSON WAS REACHED (`unusable`): the channel resolved, so somebody answered, and their answer is
 *      not a label this gate offered — a skip, a custom value, several labels at once. That is a DECISION
 *      the gate cannot record, and it is final: neither the caller's `answer` nor `relay=true` may replace
 *      it. (RM5504)
 *   2. THE CHANNEL FAILED (`unavailable`): no decision came back at all, and the refusal NAMES THE CAUSE
 *      from the error the channel threw. Here the run can still be started, because a composition whose
 *      channel cannot deliver the question would otherwise be unable to start any run — but only by the
 *      caller asking for the relay in so many words (`relay=true`), which the result reports as
 *      `source: "relayed"` rather than as a person's own selection. (RM5503)
 *   3. NO CHANNEL IS MOUNTED: the relayed answer is the only possible source, exactly as before. (RM5502
 *      when there is no answer either)
 *
 * ⚠ AND A CANCELLED OR CLOSED QUESTION IS NEVER RELAYABLE. `ASK_CANCELLED`, `ASK_ABORTED` and
 * `ASK_TIMED_OUT` are the codes that mean the question was settled from outside this gate — the card was
 * dismissed, the turn was cancelled, or a foreground window ended. The relay is refused for those, so a
 * question the operator stopped cannot be turned into an approval by asking again in the same breath.
 * Every other failure is a composition or capability failure — the question reached nobody — which is the
 * class the relay exists for.
 *
 * ⚠ WHAT THE GATE STILL DOES *NOT* CLAIM: a relayed approval is a relayed approval. The plugin cannot
 * verify that a person gave the label, and it does not pretend otherwise — the result's `source` and
 * `channel` fields say where the decision came from, and a direct selection is preferred whenever the
 * channel can produce one.
 */
export async function recordRunStartAnswer(
  recursive: RecursiveRuntime,
  root: string,
  runId: string,
  answer: string | undefined,
  exec: { agent?: unknown; signal?: unknown; callId?: unknown },
  relay = false,
): Promise<Record<string, unknown>> {
  // The question travels in every refusal: a composition whose channel cannot render a card can still put
  // the exact decision to the person in the transcript, which is what makes the failure recoverable.
  const question = buildAskQuestionFor(RUN_START_GATE_ID)
  const channel = recursive.userQuestionsChannel

  // 1. ASK THE PERSON DIRECTLY when this composition mounts the channel.
  const channelOutcome: RunStartChannelOutcome | null = channel ? await askRunStartDirectly(channel, exec) : null

  if (channelOutcome !== null && channelOutcome.kind === 'unusable') {
    // A person WAS asked. Their answer is not an approval this gate can record, and nothing the caller
    // supplies can stand in for it.
    return {
      error: toolError('RUN_START_ANSWER_UNUSABLE', channelOutcome.detail),
      gate: RUN_START_GATE_ID,
      runId,
      artifact: RUN_START_ARTIFACT,
      question,
    }
  }

  if (channelOutcome !== null && channelOutcome.kind === 'unavailable') {
    const blocked = !relay
      ? 'the caller did not ask for the relay'
      : 'the channel reports the question was cancelled, aborted, or timed out, so it is not relayable'
    if (!relay || !channelOutcome.relayable) {
      return {
        error: toolError('RUN_START_UNANSWERED', channelOutcome.detail + ' (' + blocked + ')'),
        gate: RUN_START_GATE_ID,
        runId,
        artifact: RUN_START_ARTIFACT,
        question,
        // The diagnosis, as data: a model can quote the cause, and a test can assert on it rather than on
        // the prose of the sentence above.
        channel: { outcome: 'unavailable', cause: channelOutcome.cause, relayable: channelOutcome.relayable },
      }
    }
    if (answer === undefined) {
      // ⚠ THE RELAY NEEDS SOMETHING TO RELAY, AND THIS IS NOT RM5502. A channel IS mounted here, so the
      // "this composition mounts no user-questions channel" sentence would be false — reachable by asking
      // for the relay without supplying the answer it relays.
      return {
        error: toolError('RUN_START_UNANSWERED', channelOutcome.detail + ' (the relay was authorised but no answer was supplied, so there is no decision to record)'),
        gate: RUN_START_GATE_ID,
        runId,
        artifact: RUN_START_ARTIFACT,
        question,
        channel: { outcome: 'unavailable', cause: channelOutcome.cause, relayable: channelOutcome.relayable },
      }
    }
  }

  const fromChannel = channelOutcome !== null && channelOutcome.kind === 'answered' ? channelOutcome.answer : null
  const final = fromChannel ?? answer
  if (final === undefined) {
    // No channel is mounted and no answer was supplied — the only state left here, because an `answered`
    // outcome sets `final`, an `unusable` one returned above, and an `unavailable` one either returned
    // above or carried an answer through the relay. RM5502 says exactly this, and nothing is recorded.
    return {
      error: toolError('RUN_START_NO_CHANNEL'),
      gate: RUN_START_GATE_ID,
      runId,
      artifact: RUN_START_ARTIFACT,
      question,
    }
  }

  // 2. Validate the decision that is about to become durable. A channel selection has already been
  //    filtered to the gate's own labels; a relayed answer has not, and a marker recording an unoffered
  //    label would read as a decision while being a transcription error.
  let decided: string
  try {
    decided = validateAskAnswerFor(RUN_START_GATE_ID, final)
  } catch (err) {
    return { error: toolError('BAD_ASK_ANSWER', err instanceof Error ? err.message : String(err)) }
  }

  // 3. Record it, and start the run only for the approving label. A `Hold` is recorded as the decision it
  //    is — declaring the run not started belongs in the run's own record — and starts nothing.
  const outcome = recursive.approveRunStart(root, runId, exec.agent as never, decided)
  return {
    gate: RUN_START_GATE_ID,
    answer: decided,
    artifact: RUN_START_ARTIFACT,
    // Where the decision came from matters to a reader of the transcript: a direct answer is the person's
    // own selection; a relayed one came back through the model. When the relay answered a FAILED channel,
    // the failure travels with the result, so a relayed approval never reads as a direct selection.
    source: fromChannel === null ? 'relayed' : 'user-questions',
    ...channelOutcome !== null && channelOutcome.kind === 'unavailable'
      ? { channel: { outcome: 'unavailable', cause: channelOutcome.cause, relayable: channelOutcome.relayable, relayed: true } }
      : {},
    path: outcome.path,
    replaced: outcome.replaced,
    // `armed` is the answer to "did the harness get a goal to drive?": the run is started only when the
    // marker took AND the projection armed the goal, so both are reported rather than one implying the
    // other.
    armed: outcome.ok && outcome.goal.ok,
    goal: outcome.goal,
  }
}

/**
 * PHASE 0 — WHAT THE BLOCKING CHANNEL ACTUALLY DID.
 *
 * ⚠ THIS TYPE EXISTS BECAUSE ITS ABSENCE WAS THE DEFECT. The first version returned a bare `null` from a
 * `catch {}` for every failure and for every unrecognisable selection, so "the channel threw NO_PROVIDER",
 * "the caller is not the live root agent", "the person skipped the question" and "the person typed a
 * custom value" were ONE value. The refusal built from it then asserted the one cause it could not know.
 * An outcome carries the cause, the raw message, and whether the failure is the class a relay may answer.
 */
export type RunStartChannelOutcome =
  /** The person answered, and their selection is exactly one of the gate's own labels. */
  | { kind: 'answered'; answer: string }
  /** The channel RESOLVED, so a person was reached — but the answer is not a label this gate offered. */
  | { kind: 'unusable'; detail: string }
  /** The channel THREW: no decision came back, and the cause is named rather than discarded. */
  | { kind: 'unavailable'; cause: string; detail: string; relayable: boolean }

/**
 * ⚠ THE CODES THAT MEAN THE QUESTION WAS CANCELLED OR CLOSED rather than never delivered: the person
 * dismissed the card, their turn was cancelled, or a foreground window ended. A caller may not convert any
 * of those into an approval by asking for the relay in the same breath. Every other failure means the
 * question reached nobody — a composition or capability failure, which is the class the relay exists for.
 */
export const NON_RELAYABLE_CHANNEL_CODES = ['ASK_CANCELLED', 'ASK_ABORTED', 'ASK_TIMED_OUT'] as const

/**
 * Name the failure of one `ask()` call, without inventing anything about it.
 *
 * The cause is the error's own `code` when it has one (the harness's `UserQuestionError` carries
 * `NO_PROVIDER`, `CALLER_NOT_LIVE`, `DELEGATED_CALLER`, `ASK_ABORTED`, …), else its `name`, else its
 * JavaScript type. `detail` keeps the message verbatim so a reader sees the channel's own words rather
 * than this plugin's paraphrase — the paraphrase is exactly how the previous version came to assert a
 * cause nobody had.
 */
export function classifyChannelFailure(err: unknown): { cause: string; detail: string; relayable: boolean } {
  const code = (err as { code?: unknown } | null | undefined)?.code
  const name = err instanceof Error ? err.name : typeof err
  const message = err instanceof Error ? err.message : String(err)
  const hasCode = typeof code === 'string' && code.trim() !== ''
  const cause = hasCode ? (code as string) : name
  const relayable = !(hasCode && (NON_RELAYABLE_CHANNEL_CODES as readonly string[]).includes(code as string))
  return { cause, detail: 'channel threw ' + name + '[' + cause + ']: ' + message, relayable }
}

/** Describe an answer that arrived but is not a decision this gate can record. */
function describeUnusableAnswer(item: { selected: string[]; custom?: string } | undefined): string {
  const offered: readonly string[] = RUN_START_GATE.options.map((option) => option.label)
  const list = (values: readonly string[]): string => JSON.stringify(values.join(' | '))
  if (item === undefined) {
    return 'the channel resolved with no answer for question ' + JSON.stringify(RUN_START_GATE.id) + ' at all'
  }
  const raw = item.selected ?? []
  const custom = item.custom?.trim() ?? ''
  if (raw.length === 0 && custom === '') {
    return 'the person skipped the question, and a skip is not an approval'
  }
  if (raw.length === 0) {
    return 'the person answered ' + JSON.stringify(custom) + ' as free text rather than one of ' + list(offered)
  }
  // ⚠ THE SUBSET MATTERS. A UI can return a label the gate never offered, so "not exactly one of mine" is
  // not the same statement as "the person chose something I do not know" — and the refusal says which.
  const recognised = raw.filter((label) => offered.includes(label))
  if (recognised.length === 0) {
    return 'the person selected ' + list(raw) + ', and none of those name a label this gate offered (' + offered.join(' | ') + ')'
  }
  if (recognised.length === raw.length) {
    return 'the person selected ' + list(raw) + ', and an approval is exactly one of ' + list(offered)
  }
  return 'the person selected ' + list(raw) + ', of which only ' + list(recognised) + ' name this gate\'s labels ' + list(offered)
}

/**
 * Ask the run-start question through the blocking channel and report WHAT HAPPENED.
 *
 * ⚠ THE CATCH IS THE POINT. It used to be `catch { return null }` — a blocking human question whose
 * failure cause was erased at the exact moment the cause was the only thing worth knowing. Every path out
 * of this function now says which path it was.
 *
 * The selection is filtered to the gate's OWN labels: a question a UI answered with a free-text custom
 * value must not become an approval just because it arrived on the right channel.
 */
export async function askRunStartDirectly(
  channel: NonNullable<RecursiveRuntime['userQuestionsChannel']>,
  exec: { agent?: unknown; signal?: unknown; callId?: unknown },
): Promise<RunStartChannelOutcome> {
  const known = RUN_START_GATE.options.map((option) => option.label) as readonly string[]
  try {
    // The agent is passed as the LIVE handle the host gave this tool call. The real service validates it
    // against its own registry and rejects when it is not the live root, so a fabricated handle can never
    // produce an answer here.
    const settled = await channel.ask({
      questions: [{
        id: RUN_START_GATE.id,
        header: RUN_START_GATE.header,
        question: RUN_START_GATE.question,
        options: RUN_START_GATE.options.map((option) => ({ ...option })),
      }],
      agent: exec.agent,
      signal: exec.signal,
      // Links the card to this tool call, the way plan-mode's exit does.
      wait: { callId: exec.callId },
    } as never)
    const item = settled.answers.find((entry) => entry.id === RUN_START_GATE.id)
    const selected = item?.selected?.filter((label) => known.includes(label)) ?? []
    if (selected.length !== 1) return { kind: 'unusable', detail: describeUnusableAnswer(item) }
    return { kind: 'answered', answer: selected[0] as string }
  } catch (err) {
    return { kind: 'unavailable', ...classifyChannelFailure(err) }
  }
}
