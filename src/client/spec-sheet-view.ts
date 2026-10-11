/**
 * Pure display model for the RUN-START SPEC SHEET.
 *
 * WHY THIS MODULE EXISTS. `src/client/spec-sheet.tsx` renders the Phase 0 document beside the run-start
 * question so a person can read what they are approving. Everything that DECIDES what the sheet says is
 * here instead: reading the tool call's own arguments, classifying the document, and choosing the fetch
 * state. It is pure (no React, no fs, no session window), which is what lets the spec drive every branch —
 * a stub, a filled document, a missing file, a failed route, a call with no runId — without a browser.
 *
 * ⚠ THE VERDICT COMES FROM THE TEXT, NEVER FROM THE FETCH. `loading`, `absent`, `error` and `loaded` are
 * four different facts, and a single "not loaded" would collapse them — which is how a client comes to
 * render an empty box for a failure and a failure for a document nobody has written yet.
 *
 * ⚠ AND IT IS NODE-FREE. This file is reached by the BROWSER bundle. Reading the artifact belongs to the
 * server half (`run-start.ts`, `recursive_ask.tool.ts`); this half only ever DISPLAYS what the read-only
 * `/doc` route returned.
 */
import { classifyArtifact, type ArtifactMarkerHit, type ArtifactVerdict } from '../run-spec.ts'

/**
 * The wire name of the tool whose call row the sheet replaces.
 *
 * `tool.call.toolview` is a KEYED seat dispatched by this exact string, so a typo renders nothing at all
 * rather than rendering wrongly — the failure mode the harness documents for a keyed seat.
 */
export const RUN_START_TOOL_NAME = 'recursive_ask'

/**
 * The Phase 0 artifact the run-start decision is recorded in.
 *
 * ⚠ DUPLICATED DELIBERATELY, AND PINNED BY A TEST. `run-start.ts` holds the same string, but importing it
 * here would pull `node:fs` / `node:crypto` into the browser bundle through `status.ts` and take the page
 * down for a constant. `tests/spec-sheet.spec.ts` asserts this value EQUALS `RUN_START_ARTIFACT`, so the copy
 * cannot drift; the client only ever reads through it and never writes.
 */
export const RUN_START_SPEC_FILE = '00-requirements.md'

/** The gate id whose question this sheet accompanies. */
export const RUN_START_GATE_ID = 'run-start'

/** The tool call's own arguments, as far as the client reads them. */
export interface RecursiveAskArgs {
  /** The gate id the call asked for; null when the call did not name one. */
  gate: string | null
  /** The run whose spec the call is about; null when absent or blank. */
  runId: string | null
  /** The artifact the call named, if any (the run-start gate never lets a caller redirect it). */
  artifact: string | null
  /** The approval label the call carried, when it carried one. */
  answer: string | null
}

/** The all-null argument set: what a malformed, truncated, or absent payload yields. */
const NO_ARGS: RecursiveAskArgs = { gate: null, runId: null, artifact: null, answer: null }

/**
 * Read the arguments out of the raw JSON the model dispatched.
 *
 * A malformed or empty payload yields all-nulls rather than throwing: a truncated mid-stream argument string
 * is a normal sight on this seat (the harness exposes preparing calls with no arguments at all), and a view
 * that threw on one would take the transcript down with it.
 */
export function parseRecursiveAskArgs(argsRaw: string | null): RecursiveAskArgs {
  if (argsRaw === null || argsRaw.trim() === '') return { ...NO_ARGS }
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return { ...NO_ARGS }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...NO_ARGS }
  const record = parsed as Record<string, unknown>
  const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  return { gate: str(record.gate), runId: str(record.runId), artifact: str(record.artifact), answer: str(record.answer) }
}

/**
 * What the sheet reads out of a SETTLED call's result.
 *
 * ⚠ WITHOUT THIS, THE PANEL CANNOT TELL A REFUSED GATE FROM A PENDING ONE, and that is a live defect rather
 * than a hypothetical: the owner's own run rendered a sheet whose warning block said "there is no spec to
 * approve yet" while the panel beneath it announced a question and described Start run / Hold ("it showed the
 * requirement preview without any accept dialog"). The gate had REFUSED — nothing was asked, so no card could
 * appear, which is correct — but this seat renders for the CALL, and a refused call is a settled call like any
 * other.
 *
 * ⚠ THE PAYLOAD IS REACHED, AND THE FIX DEPENDS ON IT. `tool.call.toolview` hands the view the settled
 * `ToolResultNode`, whose `content` is the recorded result of the tool call (see
 * `ui-conversation/src/client/contract/records.ts`). `recursive_ask`'s output renderer serializes its return
 * value into that content as JSON text, so a refusal is READABLE here: the `error` key is the refusal the
 * caller received, verbatim. Only `name`/`argsRaw` are used for the arguments — the refusal is never inferred
 * from them.
 */
export interface SpecCallResult {
  /** The text blocks of the recorded result, in order. */
  readonly text: readonly string[]
  /**
   * `ToolResultNode.isError`, carried rather than trusted: MEASURED against a live transcript, the harness
   * leaves this `false` for a REFUSED `recursive_ask` call — the plugin refuses in its PAYLOAD, not by
   * throwing — so an `isError` test alone reports a refusal as a success. It is read so a host that DOES mark
   * one is still read as a failure; it is never the reason a refusal is believed.
   */
  readonly isError: boolean
  /** `ToolResultNode.error`: the host's own failure record, present only when the call itself failed. */
  readonly error?: string | null
}

/**
 * The parts of the owner's call block this sheet reads.
 *
 * Structurally typed rather than imported: the toolview owner passes one of three phase shapes
 * (`preparing` carries no arguments, `start` carries `argsRaw`, `result` carries the paired call — which is
 * NULL when window truncation left the call outside the loaded window — plus the result itself).
 */
export type SpecSheetBlock =
  | { readonly phase: 'preparing' }
  | { readonly phase: 'start'; readonly argsRaw: string }
  | {
    readonly phase: 'result'
    readonly call?: { readonly name: string; readonly argsRaw: string } | null
    readonly result?: SpecCallResult | null
  }
  | null

/** What the sheet could read from the call: its arguments, its result, or WHY it could read neither. */
export type CallRead =
  /** The call's arguments were dispatched and parsed. */
  | { readonly ok: true; readonly args: RecursiveAskArgs; readonly outcome: CallOutcome }
  /** No block was supplied at all. */
  | { readonly ok: false; readonly reason: 'missing' }
  /** The call is still PREPARING: the owner dispatches no arguments until the call starts. */
  | { readonly ok: false; readonly reason: 'preparing' }
  /** The call settled, but the loaded window left its call head outside, so no arguments are available. */
  | { readonly ok: false; readonly reason: 'truncated' }

/**
 * WHY THE PANEL CANNOT READ A SETTLED CALL, when it cannot.
 *
 * ⚠ THE THREE ARE KEPT APART for the same reason `readCall` keeps its three apart: "the tool refused", "this
 * client could not read the payload" and "the payload carries no decision" are three different facts, and a
 * panel that collapsed them would advise a person to re-run a call that actually succeeded, or would blame a
 * broken client for a clean refusal.
 */
export type CallUnknownReason =
  /** No result content reached this view at all (the owner supplied none). */
  | 'no-result'
  /** The result was read, but not one of its text blocks is a JSON payload (spilled or formatted output). */
  | 'unreadable'
  /** The payload parsed, and carries NEITHER a refusal nor a recorded decision. */
  | 'kind-absent'

/**
 * What the call's own block can say about the STATE of the decision.
 *
 * ⚠ THE ONLY EVIDENCE EVER USED IS THE CALL'S OWN PAYLOAD. A refused call carries `{ error: <the refusal> }`;
 * a call that asked a question carries `{ question: … }`; a call that RECORDED a decision carries
 * `{ answer, armed, … }`; and a call that has not settled carries nothing, because the owner's `start`-phase
 * block is the call without a result. None of these is inferred from the arguments, from the verdict of the
 * document, or from the presence of the sheet itself — the sheet renders for the CALL, and a call is not a
 * question.
 */
export type CallOutcome =
  /** The gate REFUSED this call: it came back as a refusal, and no question was put to anybody. */
  | { readonly state: 'refused'; readonly refusal: string | null }
  /** The call has not settled, so a question it raised is the live one. */
  | { readonly state: 'pending' }
  /** The call SETTLED with a recorded decision: nothing is pending, and the call records the answer. */
  | { readonly state: 'answered'; readonly answer: string | null }
  /** The call settled and this panel cannot tell what it did — the reason is stated, never guessed. */
  | { readonly state: 'unknown'; readonly reason: CallUnknownReason }

/**
 * Read the call's arguments out of whichever phase the owner supplied.
 *
 * ⚠ THE THREE FAILURES ARE KEPT APART. "No block", "the arguments have not been dispatched yet" and "the
 * window truncated the call" are three different facts, and a client that collapsed them into one empty
 * argument set would tell a person the call named no run — a claim about the CALLER, made on evidence about
 * the CLIENT.
 */
export function readCall(block: SpecSheetBlock | undefined): CallRead {
  if (block === null || block === undefined) return { ok: false, reason: 'missing' }
  if (block.phase === 'preparing') return { ok: false, reason: 'preparing' }
  if (block.phase === 'start') {
    // ⚠ `pending` IS NOT "A QUESTION IS ON SCREEN". The owner dispatches this phase while the call is IN
    // FLIGHT — which is exactly the window in which the gate asks the channel — so a question it raised is
    // the live one. It is also the phase a call sits in for a moment AFTER a person answers the card and
    // before the result is recorded; the sheet therefore says what it knows (the call has not settled) and
    // never claims a card is on screen at this instant.
    return { ok: true, args: parseRecursiveAskArgs(block.argsRaw), outcome: { state: 'pending' } }
  }
  const carried = block.call ?? null
  if (carried === null) return { ok: false, reason: 'truncated' }
  return {
    ok: true,
    args: parseRecursiveAskArgs(carried.argsRaw),
    outcome: readCallOutcome(block.result ?? null),
  }
}

/**
 * Read the state of a SETTLED call out of its own result.
 *
 * ⚠ AN `isError` FLAG IS NOT THE TEST, AND THAT IS MEASURED. A live transcript of a refused run-start call
 * recorded `isError: false` with the refusal sitting in the content as `{"error":"RM5503 …"}` — so a panel
 * that looked for a failed call would have reported this refusal as a success and gone on to announce a
 * question nobody was asked. The refusal is therefore read from the payload's own `error` key: the sentence
 * the caller actually received, printed from there rather than paraphrased here.
 *
 * ⚠ AND A PAYLOAD THAT IS NOT A REFUSAL IS NOT ASSUMED TO BE A DECISION. The three outcomes are decided from
 * what the payload CARRIES (`error` / `answer`-or-`armed`), and anything else — no content, unreadable
 * content, or a payload with neither key — is `unknown` with the reason attached, because "I cannot tell" is
 * a fact this seat may state and a guess about a decision is not.
 */
export function readCallOutcome(result: SpecCallResult | null): CallOutcome {
  if (result === null) return { state: 'unknown', reason: 'no-result' }
  if (result.isError) {
    // The host's own failure record: still a refusal — the call came back as a failure, so no question was put
    // to anybody — but the sentence printed is the HOST's, and it may not have carried one.
    return { state: 'refused', refusal: result.error ?? null }
  }
  const failure = readRefusal(result)
  if (failure !== null) return { state: 'refused', refusal: failure }
  const payload = readPayload(result)
  if (payload === undefined) return { state: 'unknown', reason: 'unreadable' }
  if (payload === null) return { state: 'unknown', reason: 'kind-absent' }
  const answer = typeof payload.answer === 'string' && payload.answer.trim() !== '' ? payload.answer : null
  // ⚠ `armed` IS READ FOR THE SAME REASON `answer` IS: the returning record of a decision carries
  // `{ gate, answer, path, replaced, armed, goal }`, and a recorded `armed` boolean is a settlement on its
  // own. It is reported as a settlement with no label this panel can print — never as a pending question.
  if (answer !== null || typeof payload.armed === 'boolean') return { state: 'answered', answer }
  // The remaining payloads carry `question` (what the gate WOULD ask) or nothing this client knows. Neither
  // is evidence that a question is live — a refused gate ships the question text with its refusal — so the
  // sheet says it cannot tell rather than borrowing the words of a question nobody was asked.
  return { state: 'unknown', reason: 'kind-absent' }
}

/** The refusal's own sentence, when this result is a refusal this seat can PRINT. */
function readRefusal(result: SpecCallResult): string | null {
  const payload = readPayload(result)
  if (payload === undefined || payload === null) return null
  const error = payload.error
  if (typeof error === 'string' && error.trim() !== '') return error
  return null
}

/**
 * The result's JSON payload, as far as this client can read it.
 *
 * `undefined` is the UNREADABLE case and `null` is "the content is there but carries no payload at all":
 * a spilled or truncated result must not be read as a call that recorded nothing, which is a claim about
 * the RUN made on evidence about the CLIENT.
 */
function readPayload(result: SpecCallResult): Record<string, unknown> | null | undefined {
  const blocks = result.text.filter((block) => block.trim() !== '')
  if (blocks.length === 0) return null
  for (const block of blocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  }
  return undefined
}

/** Is this the run-start gate? Everything else keeps the generic tool row. */
export function isRunStartCall(args: RecursiveAskArgs): boolean {
  return args.gate === RUN_START_GATE_ID
}

/** Whether this call is one the sheet claims at all: the run-start gate, with a run named. */
export function isSpecSheetCall(read: CallRead): boolean {
  return read.ok && isRunStartCall(read.args) && read.args.runId !== null
}

/** Where the fetch of the document stands. */
export type SpecFetchState = 'loading' | 'loaded' | 'absent' | 'error'

/** The fetch outcome, as the component holds it. */
export interface SpecFetch {
  state: SpecFetchState
  text?: string | null
  error?: string | null
}

/** Everything the sheet renders from — pure data, so the spec can assert it without a renderer. */
export interface SpecSheetModel {
  /** The run the call names, or null. */
  runId: string | null
  /** The workspace root the live route resolved, or null while it has not answered. */
  root: string | null
  /** The artifact this sheet shows. */
  file: string
  /** The fetch's state. */
  state: SpecFetchState
  /** Why an `error` state happened, in the route's own words. */
  error: string | null
  /** The document's text VERBATIM, or null when there is nothing to show. */
  text: string | null
  /** `run-spec.ts`'s verdict over that text, or null when there is no text. */
  verdict: ArtifactVerdict | null
  /** The marker hits, in line order (empty when filled, and when there is no text). */
  evidence: ArtifactMarkerHit[]
  /** The call's own arguments, so the sheet can show which decision is being asked. */
  args: RecursiveAskArgs
  /**
   * The STATE of the decision, read from the call's own result — the field that keeps a REFUSED gate from
   * rendering as a pending one.
   */
  call: CallOutcome
}

/**
 * Build the sheet's model from what the client actually has.
 *
 * ⚠ THE TEXT IS ONLY EVER TAKEN FROM A `loaded` FETCH. A stale body from a previous run is not shown against
 * a new run id, because "this is the document" is the one claim this seat exists to make truthfully.
 */
export function specSheetModel(input: {
  args: RecursiveAskArgs
  root: string | null
  fetch: SpecFetch
  file?: string
  /**
   * What the call's own block said about the state of the decision.
   *
   * ⚠ IT DEFAULTS TO `pending`, WHICH IS THE HONEST DEFAULT FOR A CALLER THAT DID NOT SAY — and it is the
   * one default this model may take, because a directly-constructed model (the specs do this, and so does any
   * caller holding only arguments) is a description of a question being shown, not of a settled call. The
   * COMPONENT never relies on it: it always passes what its own block carried, so a refusal reaches the
   * screen as a refusal.
   */
  call?: CallOutcome
}): SpecSheetModel {
  const file = input.file ?? RUN_START_SPEC_FILE
  const text = input.fetch.state === 'loaded' ? input.fetch.text ?? null : null
  const verdict = text === null ? null : classifyArtifact(text)
  return {
    runId: input.args.runId,
    root: input.root,
    file,
    state: input.fetch.state,
    error: input.fetch.error ?? null,
    text,
    verdict: verdict === null ? null : verdict.verdict,
    evidence: verdict === null ? [] : verdict.hits,
    args: input.args,
    call: input.call ?? { state: 'pending' },
  }
}

/** The document's path, as it should be PRINTED (never as it is fetched). */
export function specPath(runId: string | null, root: string | null, file: string): string {
  const at = '.recursive/run/' + (runId ?? '<runId>') + '/' + file
  return root === null || root.trim() === '' ? at : at + '  (in ' + root + ')'
}

/* ============================ preview / raw source ============================ */

/**
 * How the sheet is showing the document.
 *
 * ⚠ TWO MODES, AND THE SECOND ONE IS NOT A CONVENIENCE. The rendered preview is what makes the document
 * REVIEWABLE — reading `##` and `- [ ]` is not reading a spec — but a person is still being asked to approve
 * the document, and a preview is an interpretation. `raw` is the escape hatch that lets them check the
 * interpretation against the bytes, so "the preview is not paraphrasing or hiding anything" is a claim they
 * can verify rather than one they have to take on trust.
 */
export type SpecViewMode = 'preview' | 'raw'

/** The mode a freshly mounted sheet opens in: the rendered document. */
export const SPEC_DEFAULT_MODE: SpecViewMode = 'preview'

/** The toggle's own label, ALWAYS naming the mode that is on screen — never the one a click would reach. */
export const SPEC_MODE_LABEL: Record<SpecViewMode, string> = {
  preview: 'Showing: rendered preview',
  raw: 'Showing: raw source',
}

/** What the toggle does next, in the imperative, so the control reads as an action and its state reads apart. */
export const SPEC_TOGGLE_LABEL: Record<SpecViewMode, string> = {
  preview: 'View source',
  raw: 'Back to preview',
}

/** One line describing what is on screen, in both modes, for the announced status. */
export const SPEC_MODE_NOTE: Record<SpecViewMode, string> = {
  preview: 'The document is rendered here as a preview: headings, lists, code and tables are drawn as such.',
  raw: 'The document is shown here VERBATIM — the exact bytes, with nothing rendered and nothing removed.',
}

/** The other mode — what one press of the toggle reaches. */
export function otherMode(mode: SpecViewMode): SpecViewMode {
  return mode === 'preview' ? 'raw' : 'preview'
}

/** The toggle as a pure control description: its label, its pressed state and what it will do. */
export interface SpecViewToggle {
  /** The mode currently on screen. */
  mode: SpecViewMode
  /** The button's accessible name — the ACTION it performs. */
  action: string
  /** Whether the control is pressed, i.e. whether the verbatim source is the thing on screen. */
  pressed: boolean
  /** The line a status region announces, which names the mode CURRENTLY on screen. */
  announce: string
}

/**
 * Describe the toggle for a mode.
 *
 * ⚠ `pressed` IS DERIVED FROM THE MODE, NEVER STORED BESIDE IT. A second boolean that could disagree with the
 * mode is how a control comes to say "pressed" while the rendered document is on screen — and this is the one
 * control whose whole job is to tell the reader which of the two things they are looking at.
 */
export function specViewToggle(mode: SpecViewMode): SpecViewToggle {
  return {
    mode,
    action: SPEC_TOGGLE_LABEL[mode],
    pressed: mode === 'raw',
    announce: SPEC_MODE_LABEL[mode] + '. ' + SPEC_MODE_NOTE[mode],
  }
}

/**
 * What the body should be built from, so the two modes cannot be confused for one another.
 *
 * `preview` carries the TEXT to parse (parsing happens in the component, from the one parser this plugin
 * has); `raw` carries the TEXT to print. Both are the same bytes: neither mode reads a different source.
 */
export type SpecBodyContent =
  | { readonly mode: 'preview'; readonly text: string }
  | { readonly mode: 'raw'; readonly text: string }

/**
 * Decide the body content for a document text and a mode.
 *
 * ⚠ NULL TEXT IS NOT `''`. A `null` document is one that was never loaded, and it must not be printed as an
 * empty document — "there is nothing here" and "the document is empty" are different claims, and this seat
 * exists to make claims a reader can trust.
 */
export function specBodyContent(text: string | null, mode: SpecViewMode): SpecBodyContent | null {
  if (text === null) return null
  return mode === 'raw' ? { mode: 'raw', text } : { mode: 'preview', text }
}

/** The verdict in the plainest words available — no hedging, and nothing that reads as encouragement. */
export const UNFILLED_NOTICE = 'This document is still the UNFILLED TEMPLATE. There is no spec to approve yet.'

/** The same verdict as one phrase, for a status/data attribute. */
export const UNFILLED_SHORT = 'unfilled template'

/** What the sheet says when the block it was given carries no dispatched call. */
export const NO_CALL_NOTICE =
  'This panel could not read the tool call it belongs to, so it cannot say which run spec the question is about.'

/** What the sheet says while the call is still preparing (its arguments are not dispatched yet). */
export const PREPARING_NOTICE =
  'This tool call has not been dispatched yet, so its arguments — and the run it names — are not available.'

/** What the sheet says when the loaded window truncated the call head away. */
export const TRUNCATED_NOTICE =
  'The loaded window left this call\'s own arguments outside it, so the run spec it names cannot be resolved here.'

/** The labels the run-start gate offers, echoed so the sheet can state what is being decided. */
export const RUN_START_APPROVE_LABEL = 'Start run'
export const RUN_START_HOLD_LABEL = 'Hold'

/** The gate's own question, quoted verbatim rather than paraphrased. */
export const RUN_START_QUESTION =
  'Approve phase 0 and start this run? Approving creates an armed goal the harness will keep driving.'

/** What each offered label means, quoted from the gate's own option descriptions. */
export const RUN_START_OPTION_MEANING =
  '“' + RUN_START_APPROVE_LABEL + '” records the approval and arms the run goal; “' + RUN_START_HOLD_LABEL
  + '” leaves the spec inert: no run goal, no autonomous rounds.'

/**
 * The recorded decision, when this call carries one.
 *
 * ⚠ A `Hold` IS NOT AN APPROVAL and is not printed as one. The test is the same VALUE test the server makes
 * (`run-start.ts::isRunStartApproval` — the approving label, not the mere presence of a decision line), so
 * the sheet can never describe a hold as an approval.
 */
export function decisionLine(answer: string | null): string | null {
  if (answer === null) return null
  return answer.trim() === RUN_START_APPROVE_LABEL
    ? 'This call records: ' + answer + ' — the approving label, which arms the run goal.'
    : 'This call records: ' + answer + ' — not the approving label, so no run goal is armed.'
}

/* ============================ THE STATE OF THE DECISION ============================ */

/**
 * THE REFUSED STATE, SAID PLAINLY.
 *
 * ⚠ THIS IS THE SENTENCE THE LIVE DEFECT NEEDED. The sheet's warning block and its question block used to
 * CONTRADICT each other in one panel: "there is no spec to approve yet … approving here would record a
 * decision about a spec that does not exist" immediately above "The question about this document is …" and a
 * description of Start run / Hold. The gate had refused, nothing was asked, and no card could appear — the
 * correct behaviour — but a reader could not tell that from a question waiting on them. So this notice names
 * the refusal, says outright that no question exists, and quotes what the caller actually received.
 */
export const CALL_REFUSED_LEAD =
  'This call was REFUSED. There is NO question about this document: nothing was asked, no decision was '
  + 'recorded, and no question card can appear for it.'

/**
 * What the refusal means for the document, in the terms the reader can act on.
 *
 * ⚠ IT DOES NOT NAME A CAUSE. The refusal's own sentence is printed VERBATIM beside this line, and it is the
 * only thing here that knows WHY — the panel reads a payload, it did not make the decision.
 */
export const CALL_REFUSED_NEXT =
  'The document below is unchanged by the refusal: it stays inert, and filling it in and asking again is what '
  + 'moves the run forward.'

/** The refusal, quoted as the caller received it rather than paraphrased by this panel. */
export const CALL_REFUSED_QUOTE_LEAD = 'The refusal it came back with:'

/**
 * What the panel says when a call settled as a refusal and the refusal's own words did not reach it.
 *
 * ⚠ THE GAP IS STATED, NOT FILLED. A panel that dropped this line would leave "This call was REFUSED" standing
 * on its own, and a reader would have to guess what refused it; a panel that invented a cause would be
 * guessing. This says which half is missing.
 */
export const CALL_REFUSED_UNQUOTED =
  'The refusal itself did not reach this panel, so the cause it named is not shown here. Nothing about this '
  + 'document was decided.'

/** The pending state: a question exists, and the answer belongs to the card that asked it. */
export const CALL_PENDING_LEAD = 'The question about this document is: “'

/** The sentence that closes the quoted question. */
export const CALL_PENDING_TAIL = '”'

/** What the panel says when the call settled and it cannot tell whether anything was asked. */
export const CALL_UNKNOWN_LEAD =
  'This panel cannot tell what this call did: it settled, and what it returned is not readable here.'

/** The three ways that happens, named separately so the reader is not told a cause the client does not know. */
export const CALL_UNKNOWN_REASON: Record<CallUnknownReason, string> = {
  'no-result':
    'No result was supplied with this call block, so whether a question was asked is unknown.',
  'unreadable':
    'The call\'s result was supplied but carries no readable payload — a spill, a truncation or a format this '
    + 'client does not know — so whether a question was asked is unknown.',
  'kind-absent':
    'The call\'s result carries no refusal and no recorded decision — including the case where it carries only '
    + 'the question TEXT, which a refusal ships too — so whether a question is live is unknown.',
}

/**
 * What the panel says when the call settled with a recorded decision.
 *
 * ⚠ IT DOES NOT CLAIM THE DECISION WAS AN APPROVAL. Which label was recorded is `decisionLine`'s job below,
 * from the label itself; this line only reports that the call is finished and that no question is left over.
 */
export const CALL_ANSWERED_LEAD =
  'This call has SETTLED: the decision was recorded, so there is no question pending for it now.'

/** The refusal notice, built from the refusal the caller actually received. */
export function refusedNotice(refusal: string | null): string {
  const quoted = refusal === null || refusal.trim() === ''
    ? CALL_REFUSED_UNQUOTED
    : CALL_REFUSED_QUOTE_LEAD + ' ' + refusal.trim()
  return CALL_REFUSED_LEAD + ' ' + quoted + ' ' + CALL_REFUSED_NEXT
}

/** The unreadable-state notice, naming which half is missing. */
export function unknownNotice(reason: CallUnknownReason): string {
  return CALL_UNKNOWN_LEAD + ' ' + CALL_UNKNOWN_REASON[reason]
}
