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
 * The parts of the owner's call block this sheet reads.
 *
 * Structurally typed rather than imported: the toolview owner passes one of three phase shapes
 * (`preparing` carries no arguments, `start` carries `argsRaw`, `result` carries the paired call — which is
 * NULL when window truncation left the call outside the loaded window).
 */
export type SpecSheetBlock =
  | { readonly phase: 'preparing' }
  | { readonly phase: 'start'; readonly argsRaw: string }
  | { readonly phase: 'result'; readonly call?: { readonly name: string; readonly argsRaw: string } | null }
  | null

/** What the sheet could read from the call: its arguments, or WHY it could not. */
export type CallRead =
  /** The call's arguments were dispatched and parsed. */
  | { readonly ok: true; readonly args: RecursiveAskArgs }
  /** No block was supplied at all. */
  | { readonly ok: false; readonly reason: 'missing' }
  /** The call is still PREPARING: the owner dispatches no arguments until the call starts. */
  | { readonly ok: false; readonly reason: 'preparing' }
  /** The call settled, but the loaded window left its call head outside, so no arguments are available. */
  | { readonly ok: false; readonly reason: 'truncated' }

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
  if (block.phase === 'start') return { ok: true, args: parseRecursiveAskArgs(block.argsRaw) }
  const carried = block.call ?? null
  return carried === null ? { ok: false, reason: 'truncated' } : { ok: true, args: parseRecursiveAskArgs(carried.argsRaw) }
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
