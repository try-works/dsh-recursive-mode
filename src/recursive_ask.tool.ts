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
    description: 'Ask a human gate as a structured decision (tdd-mode, qa-signoff, gate-block), or ASK TO START A RUN (run-start: nothing runs, and no goal exists, until this gate is approved). Call without `answer` to ask; call with it to write the answer into the artifact as a durable marker. One ask per step.',
    parameters: {
      gate: { type: 'string', description: 'tdd-mode | qa-signoff | gate-block | run-start. Required. `run-start` is phase 0: approving it records the approval and arms the run goal, which is what makes the harness drive rounds.' },
      runId: { type: 'string', description: 'Run id. Required; must resolve inside the current workspace.' },
      artifact: { type: 'string', description: 'Artifact file the answer belongs in. Optional; defaults per gate (gate-block has none, so it is required for that gate; run-start is always recorded in 00-requirements.md).' },
      answer: { type: 'string', description: 'One of the gate\'s option labels. Omit to ASK. For run-start, the labels are: ' + RUN_START_GATE.options.map((option) => option.label).join(' | ') + '.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { gate?: string; runId?: string; artifact?: string; answer?: string }, exec) {
      const gateId = (args.gate ?? '').trim() as AskAnyGateId
      const runId = args.runId?.trim() ?? ''
      if (runId === '') return { error: toolError('MISSING_RUN_ID') } as const
      if (!askGateIds().includes(gateId)) {
        return { error: toolError('BAD_ASK_GATE', 'gate must be one of ' + askGateIds().join(' | ')) } as const
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
      // person by supplying one. Only a composition with no channel falls back to the relayed answer.
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
        return recordRunStartAnswer(recursive, root, runId, answer, exec) as unknown as JsonValue
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
 * ⚠ THIS GATE NEVER ACCEPTS A RELAYED ANSWER WHILE A HUMAN CHANNEL IS MOUNTED. That is the rule that makes
 * an approval a human act rather than an inference: when `ctx.userQuestions` is present, the question is
 * PUT TO THE PERSON and nothing else can settle it — not the caller's own `answer` argument, and not a
 * fabrication, because `ask()` resolves only with a real selection. A person's decline is likewise final
 * for that call and cannot be overridden by a model that asked for `Start run` in the same breath.
 *
 * ⚠ AND WHEN NO CHANNEL IS MOUNTED, THE RELAYED ANSWER IS THE ONLY POSSIBLE SOURCE, so it is used — that
 * is the same contract the other three gates have always had, and refusing it would leave a composition
 * without the channel unable to start any run at all. The question is surfaced first by the ASK branch
 * (the card data the host renders), and the model's `answer` is that person's selection coming back.
 *
 * ⚠ WHAT THE GATE THEREFORE DOES *NOT* CLAIM, stated rather than implied: in a composition with no
 * `userQuestions` channel, a plugin cannot verify that a person was really asked, so a model could in
 * principle relay a label nobody gave. That is a property of the relay, not of this gate — and it is the
 * reason the channel is consulted in preference whenever it exists. See the header of `run-start.ts`.
 */
export async function recordRunStartAnswer(
  recursive: RecursiveRuntime,
  root: string,
  runId: string,
  answer: string | undefined,
  exec: { agent?: unknown; signal?: unknown; callId?: unknown },
): Promise<Record<string, unknown>> {
  // 1. ASK THE PERSON DIRECTLY when this composition mounts the channel. An abort or a dismissal is not
  //    consent, so it settles nothing — and, because the channel was available, it does not hand the
  //    decision back to the caller either (that is the refusal below).
  const channel = recursive.userQuestionsChannel
  const fromChannel = channel ? await askRunStartDirectly(channel, exec) : null
  if (channel !== null && fromChannel === null) {
    // The channel exists, so a person COULD have been asked and was not: no answerer, no live root agent,
    // a dismissal, an abort, or a selection that is not one of this gate's labels. An approval nobody
    // gave is not recorded, and neither is the caller's argument.
    return { error: toolError('RUN_START_UNANSWERED') }
  }
  const final = fromChannel ?? answer
  if (final === undefined) {
    // No channel and no answer: there is nothing a person said, so nothing is recorded.
    return { error: toolError('RUN_START_NO_CHANNEL') }
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
    // own selection; a relayed one came back through the model.
    source: fromChannel === null ? 'relayed' : 'user-questions',
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
 * Ask the run-start question through the blocking channel and return the selection, or null when the
 * person was not reachable (no answerer, no live root agent, a dismissal, an abort).
 *
 * The selection is filtered to the gate's OWN labels before it is returned: a question a UI answered with
 * a free-text custom value must not become an approval just because it arrived on the right channel.
 */
async function askRunStartDirectly(
  channel: NonNullable<RecursiveRuntime['userQuestionsChannel']>,
  exec: { agent?: unknown; signal?: unknown; callId?: unknown },
): Promise<string | null> {
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
    if (selected.length !== 1) return null
    return selected[0]
  } catch {
    // Quiet by design: the caller reports the situation, and this function's job is only to say whether a
    // person answered.
    return null
  }
}
