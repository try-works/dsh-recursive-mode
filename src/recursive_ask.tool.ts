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
import { QA_SIGN_OFF_FIELD, type PhaseAskNote } from './phase-rules.ts'
import { gateAskFor, GATE_CONFIG_KEY, type ResolvedGateAsks } from './gates.ts'
import {
  RUN_START_APPROVE,
  RUN_START_ARTIFACT,
  RUN_START_GATE,
  RUN_START_GATE_ID,
  runStartSpecGuard,
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
 * FU-7 — THE GATE-BLOCK REFUSAL PAYLOAD, BUILT IN ONE PLACE.
 *
 * A blocked lock is refused by TWO layers. The TOOL refuses when `lockArtifact` throws
 * `Prerequisite blockers:`; the GUARD refuses pre-dispatch when the lock-order rule fires
 * (`monotonic lock-order`), and under the strict default that is the layer the caller meets
 * first. Both must hand the caller the SAME choice, so both build it HERE.
 *
 * ⚠ WHY NOT TWO LITERALS. `fix | reopen | abandon` is the human's way out of a blocked lock,
 * and it existed in exactly one call site (`recursive_lock.tool.ts`). The guard's refusal moved
 * to the default path, and a second hand-written copy of the options there would be a second
 * answer to "what can a person do about this?": the day the options change, one of the two
 * refusals keeps offering the old set and nothing fails. One builder, called from both.
 *
 * `blocked` is the refusal's OWN sentence — the guard's rule text or the tool's exception
 * message — carried as data so the payload says what it is about without a reader having to
 * match it against the text beside it.
 */
export interface GateBlockAsk extends AskQuestion {
  gate: 'gate-block'
  artifact: string
  blocked: string
}

/** The payload, as the refusal carries it. Validated through `buildAskQuestion`. */
export function buildGateBlockAsk(artifact: string, blocked: string): GateBlockAsk {
  return { gate: 'gate-block', ...buildAskQuestion('gate-block'), artifact, blocked }
}

/**
 * FU-7 — THE OPTIONS AS TEXT, DERIVED FROM THE PAYLOAD rather than restated.
 *
 * WHY A RENDERER IS NEEDED AT ALL: the harness renders a `tools/pre-execute` denial as
 * `Error: <reason>` and drops every other field of the decision (measured in
 * `packages/core/tools`: `content: [{ type: 'text', text: 'Error: ' + denialReason }]`), so an
 * ask that rode along as a SIBLING field would reach the model as nothing at all — which is
 * exactly how a strict-by-default guard made the recovery path unreachable. The refusal
 * therefore renders the payload into the text it hands back, and it renders THIS object, so
 * the visible sentence and the structured payload cannot disagree.
 */
export function renderGateBlockAsk(ask: GateBlockAsk): string {
  const options = ask.options
    .map((option) => option.label + (option.description === undefined ? '' : ' (' + option.description + ')'))
    .join(' ')
  const target = ask.artifact === '' ? 'recursive_ask gate=gate-block' : 'recursive_ask gate=gate-block artifact=' + ask.artifact
  return ask.header + ': ' + ask.question + ' Options: ' + options + ' Answer with ' + target + '.'
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
    description: 'Ask a human gate as a structured decision (tdd-mode, qa-signoff, gate-block), or ASK TO START A RUN (run-start: nothing runs, and no goal exists, until this gate is approved). Call without `answer` to ask; call with it to write the answer into the artifact as a durable marker. When this composition mounts the user-questions channel, EVERY gate is put to the person as a blocking card and the person\'s own selection is what gets recorded (`source: "channel"`); a person who answers with something the gate did not offer, or a channel that reaches nobody, is REFUSED with the cause named (RM5505 / RM5506) and records NOTHING. With no channel mounted the question is returned so it can be relayed in the transcript and answered in a later call. For run-start the channel is asked first and its own selection wins; when that channel cannot deliver the question, the refusal names the cause and `relay=true` with an explicit `answer` records the person\'s relayed approval. The run-start gate is REFUSED while the Phase 0 requirements document is still the unfilled template — the refusal quotes the placeholder lines, and there is nothing to approve until they are written. One ask per step.',
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

      // ⚠ THE ORDERING GUARD, AND IT COMES BEFORE THE QUESTION IS PUT TO ANYBODY. A scaffolded run's Phase 0
      // document is a template: placeholder requirements, unchecked lists, FAIL gates. Raising "start this run
      // or hold?" over that asks a person to approve a document that is not a spec — and until this change
      // nothing even SHOWED it to them. So the gate refuses while the artifact is still the template, naming
      // the artifact and quoting the placeholder lines, and records nothing.
      //
      // It runs before BOTH branches below on purpose: asking the channel first and refusing afterwards would
      // put the card in front of the person anyway, which is the defect. A refusal here does not weaken any
      // part of the gate's contract — the person's own answer still wins everywhere below, a spec still
      // creates no goal, and the relay rules are untouched.
      if (isRunStartGate(gateId)) {
        const guard = runStartSpecGuard(root, runId)
        if (!guard.ok) {
          return {
            error: guard.reason,
            gate: RUN_START_GATE_ID,
            runId,
            artifact: RUN_START_ARTIFACT,
            // The question travels with the refusal so the caller can put the DECISION in the transcript while
            // it cannot yet raise the card — the same shape the channel refusals use.
            question: buildAskQuestionFor(RUN_START_GATE_ID),
          } as unknown as JsonValue
        }
      }

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
      // ⚠ EVERY GATE IS PUT TO THE PERSON WHEN THE COMPOSITION MOUNTS THE CHANNEL, and this is the fix for
      // the owner's report: *"the agent asks me for qa approval without sending a proper question ui
      // component for sign off, so i dont see any notification its just in the chat text and i miss it"*.
      // Before this change only `run-start` called `channel.ask`, so the three workflow gates handed the
      // question back as JSON for the model to retype in the transcript — a card the host never rendered,
      // which a live run demonstrated by asking `qa-signoff` three times with no person ever seeing it.
      //
      // The branches, in the order they run:
      //   1. `run-start` asks inside `recordRunStartAnswer`, whether or not an answer argument arrived — a
      //      caller cannot skip the person by supplying one, and the relay is refused unless the caller asks
      //      for it in so many words (see `recordRunStartAnswer`).
      //   2. The three workflow gates ask HERE, and only when no `answer` argument arrived. Their answer is
      //      recorded from the person's own selection, reported as `source: "channel"`.
      //   3. A composition with NO channel keeps the relayed behaviour exactly: the question is returned so
      //      the caller can put it in the transcript and answer it in a later call.
      // ⚠ PER-GATE ASK SWITCHES — evaluated BEFORE anything can raise a card. When a gate's ask is disabled
      // the person is NOT asked: the configured default is recorded at once, and the result SAYS so
      // (`source: 'config'` + `ask: 'disabled'`), so a reader never has to infer that nobody was involved.
      // Three refusals belong here, all of them naming what to change:
      //   • `run-start` cannot be silenced: it is the approval that ARMS the run, so a run started with that
      //     ask disabled would be a run nobody approved.
      //   • a gate with no configured default (`gate-block`) must not invent one — fix/reopen/abandon are the
      //     person's call, and picking one would have the plugin abandon a phase on their behalf.
      //   • a configured default that is not one of the gate's own labels is refused through the SAME
      //     validator a caller's answer goes through, rather than being written and read as a decision.
      const askPolicy = recursive.gateAsk(gateId)
      // `run-start` can never be silenced: it is the approval that ARMS the run, so this is refused whether or
      // not an answer was supplied — and the message must not offer a remedy that cannot work.
      if (!askPolicy.ask && isRunStartGate(gateId)) {
        return {
          error: toolError('GATE_ASK_DISABLED', 'the run-start ask cannot be disabled: it is the approval that arms the run (gates.runStart.ask)'),
          gate: gateId,
          runId,
          artifact,
        } as unknown as JsonValue
      }
      if (!askPolicy.ask) {
        // ⚠ AN EXPLICIT ANSWER IS READ *BEFORE* ANY REFUSAL. RM5507's remedy tells the caller to supply an
        // answer, so refusing before looking at one would prescribe the very call that had just failed — the
        // defect class this project keeps removing (a message asserting a state the code never established).
        // An answer also WINS over the configured default: the switch decides whether a person is ASKED, not
        // whether an explicit decision may be recorded, and overwriting a real decision with a default would
        // make the tool less truthful than the run.
        const explicit = args.answer
        if (explicit === undefined && askPolicy.default === undefined) {
          return {
            error: toolError('GATE_ASK_DISABLED', 'gate ' + gateId + ' has no configured default, so it cannot record a decision while its ask is disabled (gates.' + gateId + ')'),
            gate: gateId,
            runId,
            artifact,
          } as unknown as JsonValue
        }
        if (artifact === '') {
          return { error: toolError('MISSING_ASK_ARTIFACT', 'this gate needs an explicit artifact to record into') } as const
        }
        const requested = explicit ?? (askPolicy.default as string)
        let configured: string
        try {
          configured = validateAskAnswerFor(gateId as AskGateId, requested)
        } catch (err) {
          return {
            error: toolError('BAD_ASK_ANSWER', 'gate ' + gateId + ': ' + (err instanceof Error ? err.message : String(err))),
          } as const
        }
        const configuredMarker = answerMarker(gateId as AskGateId, configured)
        const configuredWritten = recursive.recordAskAnswer(root, runId, artifact, configuredMarker)
        return {
          gate: gateId,
          answer: configured,
          marker: configuredMarker,
          artifact,
          path: configuredWritten.path,
          replaced: configuredWritten.replaced,
          // WHERE THE RECORDED DECISION CAME FROM, stated: the caller's own answer, or the configuration.
          source: explicit === undefined ? 'config' : 'caller',
          ask: 'disabled',
        } as unknown as JsonValue
      }

      const channelMounted = recursive.userQuestionsChannel !== null
      if (args.answer === undefined && !(isRunStartGate(gateId) && channelMounted)) {
        const channel = recursive.userQuestionsChannel
        if (channel !== null && !isRunStartGate(gateId)) {
          // A gate with nowhere to record an answer must not raise a card first: putting a question to a
          // person and then discovering the answer cannot land is the same dead end as the run-start gate's
          // spec guard, so the artifact check runs BEFORE the ask.
          if (artifact === '') {
            return { error: toolError('MISSING_ASK_ARTIFACT', 'this gate needs an explicit artifact to record into') } as const
          }
          const outcome = await askGateDirectly(channel, {
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options,
          }, exec)
          if (outcome.kind === 'unusable') {
            // A person WAS reached and their answer is not one of this gate's labels. That decision is
            // final: neither the model nor a later call may replace it, and NOTHING is written.
            return {
              error: toolError('GATE_ANSWER_UNUSABLE', outcome.detail + ' (gate ' + gateId + ')'),
              gate: gateId,
              runId,
              artifact,
              question,
              channel: { outcome: 'unusable' },
            } as unknown as JsonValue
          }
          if (outcome.kind === 'unavailable') {
            // The question reached nobody, or the person cancelled it. There is no relay for a workflow
            // gate (see RM1150), so the refusal NAMES the cause and records nothing at all.
            return {
              error: toolError('GATE_QUESTION_UNANSWERED', outcome.detail + ' (gate ' + gateId + ')'),
              gate: gateId,
              runId,
              artifact,
              question,
              // The diagnosis as data: a model can quote the cause, and a test can assert on it rather
              // than on the prose above.
              channel: { outcome: 'unavailable', cause: outcome.cause, relayable: outcome.relayable },
            } as unknown as JsonValue
          }
          // Validate what is about to become durable. The ask already filtered the selection to this gate's
          // own labels; the check is kept because "the channel filtered it" must not be the only thing
          // standing between a stray label and a marker a later phase locks against.
          let decided: string
          try {
            decided = validateAskAnswerFor(gateId, outcome.answer)
          } catch (err) {
            return { error: toolError('BAD_ASK_ANSWER', err instanceof Error ? err.message : String(err)) } as const
          }
          return recordGateAnswer(recursive, root, runId, gateId as AskGateId, decided, artifact, 'channel') as unknown as JsonValue
        }
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
      return recordGateAnswer(recursive, root, runId, gateId as AskGateId, answer as string, artifact) as unknown as JsonValue
    },
  })
}

/**
 * PART B — the field the distinct QA sign-off line carries.
 *
 * ⚠ WHY A SECOND LINE EXISTS AT ALL, AND WHAT IT HONESTLY PROVES. The owner asked for the QA phase to be
 * gated on a person, and config (`qa.humanReview`) is what makes an `agent-operated` downgrade REFUSE. This
 * line is the artifact-side evidence that the mode came through `recursive_ask` rather than being typed by
 * hand: `recursive_ask` writes it in the same call that writes the mode marker.
 *
 * The limit is stated rather than papered over: an agent that TYPES this line can still forge it — the
 * linter reads a document, and a document can say anything. What becomes impossible under `humanReview` is
 * the SILENT downgrade: the lint refusal comes from the CONFIG, so declaring `agent-operated` (typed or
 * recorded) fails the phase, and the only way past the gate is a person's label on the card.
 *
 * (The field NAME lives in `phase-rules.ts`, beside the section and field names the linter and the closeout
 * scaffold use, so the writer and the reader cannot spell it differently.)
 */

/** The exact shape `recursive_ask` writes for a QA gate answer, and the linter requires under human review. */
export function qaSignOffLine(answer: string, recordedAt: string): string {
  return '- ' + QA_SIGN_OFF_FIELD + ': ' + answer + ' (gate answer recorded ' + recordedAt + ')'
}

/**
 * Write one workflow gate's answer into its artifact and report what landed.
 *
 * ⚠ ONE WRITER FOR BOTH SOURCES. A label that came back from the mounted channel and one supplied as
 * `answer` take exactly the same path from here, so the marker a later phase locks against cannot differ
 * by where the decision came from — only the reported `source` says that.
 *
 * ⚠ THE QA GATE ALSO WRITES A DISTINCT SIGN-OFF LINE (see `qaSignOffLine`). It is a SECOND marker under its
 * own field rather than a longer first one because `recordAskAnswer` replaces by field name: one line with
 * two facts would be found by neither field's rule, and a hand-typed `QA Execution Mode` would then be the
 * only thing standing between an agent and the phase gate.
 */
function recordGateAnswer(
  recursive: RecursiveRuntime,
  root: string,
  runId: string,
  gateId: AskGateId,
  answer: string,
  artifact: string,
  source?: 'channel',
): Record<string, unknown> {
  const marker = answerMarker(gateId, answer)
  const written = recursive.recordAskAnswer(root, runId, artifact, marker)
  const signOff = gateId === 'qa-signoff' ? qaSignOffLine(answer, new Date().toISOString()) : null
  const signOffWritten = signOff === null ? null : recursive.recordAskAnswer(root, runId, artifact, signOff)
  return {
    gate: gateId,
    answer,
    marker,
    artifact,
    path: written.path,
    replaced: written.replaced,
    // `source` is present ONLY for a channel selection: the relayed-answer path has reported no source
    // since T23, and adding one there would change a result existing callers (and tests) already read.
    ...(source === undefined ? {} : { source }),
    ...(signOff === null || signOffWritten === null ? {} : { signOff, signOffReplaced: signOffWritten.replaced }),
  }
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
 * WHAT THE BLOCKING CHANNEL ACTUALLY DID — for ANY gate (run-start and the three workflow gates alike).
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
function describeUnusableAnswer(item: { selected: string[]; custom?: string } | undefined, gate: AskGateQuestion): string {
  const offered: readonly string[] = gate.options.map((option) => option.label)
  const list = (values: readonly string[]): string => JSON.stringify(values.join(' | '))
  if (item === undefined) {
    return 'the channel resolved with no answer for question ' + JSON.stringify(gate.id) + ' at all'
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
 * THE QUESTION A GATE PUTS TO THE CHANNEL — the minimum both gate families can supply.
 *
 * `ASK_GATES`' values and `RUN_START_GATE` both satisfy it structurally, so the ask helper below can be the
 * ONE place that talks to the channel without widening either gate's own contract.
 */
export interface AskGateQuestion {
  id: string
  header: string
  question: string
  options: readonly AskOption[]
}

/**
 * Ask ANY gate's question through the blocking channel and report WHAT HAPPENED.
 *
 * ⚠ THE CATCH IS THE POINT. It used to be `catch { return null }` — a blocking human question whose failure
 * cause was erased at the exact moment the cause was the only thing worth knowing. Every path out of this
 * function now says which path it was.
 *
 * The selection is filtered to the GATE'S OWN labels: a question a UI answered with a free-text custom value,
 * or with a label from another gate, must not become a decision just because it arrived on the right channel.
 */
export async function askGateDirectly(
  channel: NonNullable<RecursiveRuntime['userQuestionsChannel']>,
  gate: AskGateQuestion,
  exec: { agent?: unknown; signal?: unknown; callId?: unknown },
): Promise<RunStartChannelOutcome> {
  const known = gate.options.map((option) => option.label) as readonly string[]
  try {
    // The agent is passed as the LIVE handle the host gave this tool call. The real service validates it
    // against its own registry and rejects when it is not the live root, so a fabricated handle can never
    // produce an answer here.
    const settled = await channel.ask({
      questions: [{
        id: gate.id,
        header: gate.header,
        question: gate.question,
        options: gate.options.map((option) => ({ ...option })),
      }],
      agent: exec.agent,
      signal: exec.signal,
      // Links the card to this tool call, the way plan-mode's exit does.
      wait: { callId: exec.callId },
    } as never)
    const item = settled.answers.find((entry) => entry.id === gate.id)
    const selected = item?.selected?.filter((label) => known.includes(label)) ?? []
    if (selected.length !== 1) return { kind: 'unusable', detail: describeUnusableAnswer(item, gate) }
    return { kind: 'answered', answer: selected[0] as string }
  } catch (err) {
    return { kind: 'unavailable', ...classifyChannelFailure(err) }
  }
}

/**
 * Ask the run-start question through the blocking channel.
 *
 * ⚠ A THIN WRAPPER SINCE THE WORKFLOW GATES LEARNED TO ASK. The body is `askGateDirectly`'s — same ask, same
 * filtering, same outcome vocabulary — and this name survives because the exported contract (and the tests
 * that call it directly) is about the run-start gate specifically.
 */
export async function askRunStartDirectly(
  channel: NonNullable<RecursiveRuntime['userQuestionsChannel']>,
  exec: { agent?: unknown; signal?: unknown; callId?: unknown },
): Promise<RunStartChannelOutcome> {
  return askGateDirectly(channel, RUN_START_GATE, exec)
}

/**
 * PER-GATE ASK SWITCHES — THE GUIDANCE NOTE FOR A PHASE WHOSE GATE WILL NOT ASK.
 *
 * ⚠ WHY THIS LIVES HERE. The artifact→gate mapping is `GATE_DEFAULT_ARTIFACT`, and the gate vocabulary is
 * `ASK_GATES`/`ASK_GATE_IDS` — both owned by this module. A guidance builder that re-derived "phase 03 owes
 * `tdd-mode`" from the file name with its own table would be a second mapping, and the day a gate's artifact
 * moves, the reminder would keep telling an agent to call a gate the phase does not owe.
 *
 * ⚠ AND IT RETURNS `null` WHENEVER THE PERSON WILL BE ASKED. The note exists to stop an agent waiting for a
 * card that is not coming; saying anything at all when the gate DOES ask would be noise in a message that is
 * already dense, and it would make the line's presence meaningless.
 *
 * The result is passed to `phaseLintRulesMessage`, which is the ONE text that reaches both the automatic
 * pre-step reminder and the closeout report's `guidance` (see `closeout-report.ts`).
 */
export function phaseAskNote(artifactFile: string, gates: ResolvedGateAsks): PhaseAskNote | null {
  const gate = (Object.keys(GATE_DEFAULT_ARTIFACT) as AskGateId[])
    .find((id) => GATE_DEFAULT_ARTIFACT[id] === artifactFile)
  if (gate === undefined) return null
  const setting = gateAskFor(gates, gate)
  // A gate with no configured default cannot record anything while its ask is off; the ask path REFUSES that
  // combination by name (GATE_ASK_DISABLED), so there is nothing helpful to say here beyond silence.
  if (setting.ask || setting.default === undefined) return null
  const key = GATE_CONFIG_KEY[gate]
  if (key === undefined) return null
  return { gate, key, default: setting.default }
}
