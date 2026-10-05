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

/** The identifiers the workflow uses for its three human gates. */
export const ASK_GATE_IDS = ['tdd-mode', 'qa-signoff', 'gate-block'] as const
export type AskGateId = (typeof ASK_GATE_IDS)[number]

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
