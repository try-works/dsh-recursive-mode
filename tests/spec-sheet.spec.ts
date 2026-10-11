/**
 * THE SPEC SHEET (client half) — the document beside the run-start question.
 *
 * THE DEFECT THIS PINS. The run-start card appeared while the spec was still an unfilled template, and
 * nothing put the document in front of the person at all: *"i was never shown the spec before that so how
 * could i approve if i havent seen it"*. So this spec asserts, in order:
 *
 *   1. the call the sheet claims is the run-start call, read out of the call's OWN arguments — every other
 *      gate and every preparing call keeps the generic tool row;
 *   2. the component renders the ACTUAL DOCUMENT TEXT, verbatim — asserted by a marked line that appears in
 *      the tree and by the absence of any text the component might have composed about it;
 *   3. when the document is still the template, it SAYS SO plainly, quotes the placeholder lines, and does
 *      not nudge the reader toward approving it;
 *   4. the seat is registered on `tool.call.toolview` under the tool's wire name — the mounting claim;
 *   5. the invariants: read-only, an accessible name and role, a keyboard-reachable document body, Escape
 *      that casts no vote, and reduced-motion CSS that switches the one transition off.
 *
 * ⚠ WHAT WOULD MAKE (2) PASS VACUOUSLY. A component that rendered ANY document it was handed would satisfy
 * "the text is in the tree" for a fixture whose text is generic. The fixture is therefore a document with a
 * line that only the DOCUMENT can contain (`MARKER`), and the assertion is that the RENDERED tree carries
 * that exact line — plus the negative half: the tree must not carry the notice the component composes for a
 * document it did NOT read.
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { create as createRenderer, act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import {
  RunStartSpecSheet,
  RunStartSpecSheetBody,
  CALL_ANSWERED_LEAD,
  CALL_PENDING_LEAD,
  CALL_PENDING_TAIL,
  CALL_REFUSED_LEAD,
  CALL_REFUSED_NEXT,
  CALL_REFUSED_QUOTE_LEAD,
  CALL_REFUSED_UNQUOTED,
  CALL_UNKNOWN_LEAD,
  RUN_START_OPTION_MEANING,
  RUN_START_APPROVE_LABEL,
  RUN_START_HOLD_LABEL,
  RUN_START_QUESTION,
  RUN_START_SPEC_FILE,
  RUN_START_TOOL_NAME,
  decisionLine,
  parseRecursiveAskArgs,
  readCall,
  readCallOutcome,
  refusedNotice,
  resolveSpecRoot,
  specPath,
  specSheetModel,
  UNFILLED_NOTICE,
  unknownNotice,
  type SpecSheetBlock,
} from '../src/client/spec-sheet.tsx'
// ⚠ THE PARSER IS IMPORTED FROM ITS OWN HOME. The sheet renders through `doc-viewer.tsx`'s `parseDoc` /
// `PreviewLines` and does NOT re-export them: a spec that reached them through the sheet would let a second
// renderer appear inside the sheet without this file noticing.
import { parseDoc } from '../src/client/doc-viewer.tsx'
import { injectBoardStyles } from '../src/client/styles.ts'
import { requirementsContent } from '../src/init-templates.ts'
import { RUN_START_ARTIFACT, RUN_START_GATE } from '../src/run-start.ts'
import type { RecursiveRunCard } from '../src/types.ts'

/** A marked line that exists ONLY in the document, so its presence proves the document was shown. */
const MARKER = 'ACCEPTANCE-MARKER-7f3a: the widget must refuse a hollow spec'

/** A real Phase 0 document (as a filled one looks): no placeholders, no unchecked boxes, gates passing. */
function writtenDoc(): string {
  return [
    '# Phase 0 Requirements — r1',
    '',
    'Status: `DRAFT`',
    '',
    '## Requirements',
    '',
    '### `R1` The spec is readable before it is decidable',
    '',
    'Description: the person sees the document the decision is about.',
    'Acceptance criteria:',
    '- ' + MARKER,
    '',
    '## Out of Scope',
    '',
    '- `OOS1`: editing the document in the browser',
    '',
    '## Coverage Gate',
    '',
    '- [x] every requirement carries acceptance criteria',
    '',
    'Coverage: PASS',
    '',
    '## Approval Gate',
    '',
    '- [x] the document is ready for the decision',
    '',
    'Approval: PASS',
  ].join('\n')
}

/* ---------------- render-tree helpers (as tests/settings-panel.spec.ts) ---------------- */

interface JsonNode { type?: unknown; props?: Record<string, unknown>; children?: unknown }

/** A mounted renderer, named once so the helpers below read as prose. */
type Renderer = ReactTestRenderer

function textOf(json: unknown): string {
  if (typeof json === 'string') return json
  if (typeof json === 'number') return String(json)
  if (json === null || json === undefined || typeof json === 'boolean') return ''
  if (Array.isArray(json)) return json.map(textOf).join(' ')
  return textOf((json as JsonNode).children)
}

/**
 * The text under ONE ELEMENT.
 *
 * ⚠ `textOf(instance.props.children)` IS NOT THAT, and the difference is a silent trap worth naming: a child
 * returned by `createElement` carries no resolvable `children` of its own, so a JSON-tree walker renders it
 * as `''` — and an assertion about what an element SAYS would then be satisfied by nothing at all.
 *
 * ⚠ AND AN INSTANCE IS NOT ALWAYS A `ReactTestInstance`. `react-test-renderer` hands back the real host
 * fiber for a component's own root-host element, and a fiber exposes `type`/`props`/`$$typeof` as
 * OFF-INSTANCE properties — so a walker that classifies a node by `node.type` mis-reads the very element
 * under test as an empty leaf. The ONE accessor that works on both an instance and a fiber is `children`, so
 * that is what decides: an array of children is descended into, and everything else is a leaf.
 */
function textUnder(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(textUnder).join('')
  const n = node as { children?: unknown; props?: unknown }
  if (Array.isArray(n.children)) return textUnder(n.children)
  if (typeof n.children === 'string') return n.children
  // A raw React element (built by `createElement`, not yet rendered): its text is in `props.children`.
  return textUnder((n.props as { children?: unknown } | undefined)?.children)
}

/** The concatenated text of an element's rendered subtree. */
function textOfNode(node: ReactTestInstance): string {
  const kids = (node as unknown as { children?: unknown }).children
  return Array.isArray(kids) ? textUnder(kids) : textUnder(node.props?.children)
}

function hasClass(cls: string) {
  return (node: ReactTestInstance) => String((node.props as Record<string, unknown> | undefined)?.className ?? '').split(' ').includes(cls)
}

/**
 * Click the mode toggle by finding it the way a pointer user and the harness both do: by its class, then by
 * its behaviour. ⚠ `find(hasClass(...))` matches the OUTER node of a classed element first, and the toggle
 * carries exactly one class, so the button itself is `at(0)` — there is no nested same-class element here.
 */
function clickToggle(r: Renderer): void {
  const button = r.root.findAll(hasClass('rec-spec-view-toggle')).at(0)
  expect(button, 'the sheet must carry exactly one mode toggle').toBeDefined()
  act(() => { (button!.props as { onClick: () => void }).onClick() })
}

/** The mode toggle, the announced state line, and the document body — the three things a mode changes. */
function modeParts(r: Renderer): { toggle: ReactTestInstance; state: ReactTestInstance; body: ReactTestInstance } {
  return {
    toggle: r.root.findAll(hasClass('rec-spec-view-toggle')).at(0)!,
    state: r.root.findAll(hasClass('rec-spec-view-state')).at(0)!,
    body: r.root.findAll(hasClass('rec-spec-body-scroll')).at(0)!,
  }
}

/** The preview's parsed line blocks, in document order. */
function previewLines(r: Renderer): string[] {
  return r.root
    .findAll(hasClass('rec-doc-line-wrap'))
    .map((node) => textOfNode(node))
}

/**
 * The DOCUMENT BODY's own text, without the sheet's prose around it.
 *
 * ⚠ THE SHEET'S OWN SENTENCES MENTION THE SAME WORDS THE DOCUMENT DOES — the unfilled notice quotes
 * `Coverage: FAIL` verbatim as evidence. Asserting on the whole rendered sheet would therefore pass on the
 * NOTICE rather than on the document, which is exactly the confusion this seat exists to prevent. These
 * assertions read the body element alone.
 */
function bodyText(r: Renderer): string {
  return textOfNode(r.root.find(hasClass('rec-spec-body-scroll')))
}

/** Render the sheet body around one document text. */
function renderDoc(text: string): { model: ReturnType<typeof specSheetModel>; r: Renderer } {
  const model = specSheetModel({
    args: { gate: 'run-start', runId: 'r1', artifact: null, answer: null },
    root: '/ws',
    fetch: { state: 'loaded', text },
  })
  return { model, r: createRenderer(createElement(RunStartSpecSheetBody, { model })) }
}

/** A block whose call names the run whose spec we want. */
function startBlock(args: Record<string, unknown>): { phase: 'start'; argsRaw: string } {
  return { phase: 'start', argsRaw: JSON.stringify(args) }
}

/* ---------------- the SETTLED call: what a refusal and a decision actually look like on the wire ------------- */

/**
 * ⚠ THE PROVENANCE OF THESE TWO FIXTURES IS DIFFERENT, AND THEY ARE LABELLED SEPARATELY ON PURPOSE — a spec
 * that claimed both were verbatim would be making the same kind of false claim this defect is about.
 *
 * `LIVE_CHANNEL_REFUSAL` IS VERBATIM. It was read out of a real `tool/result` event in this machine's session
 * store (decompressed from `~/.dsh/sessions/--D-DEV-dsh-recursive-mode--/*.session.v4.jsonl.zstd`) and it is
 * what measured the two facts the fix rests on: the refusal is the call's PAYLOAD, and the recorded
 * `isError` for it is `false`.
 *
 * `SPEC_UNFILLED_REFUSAL` IS RECONSTRUCTED, not quoted, and this is the honest reason: NO live transcript on
 * this machine contains the run-start TEMPLATE refusal — the one the owner's screenshot shows — because a
 * refused call is exactly the call whose transcript nobody went looking for. It is rebuilt from the two pieces
 * that DO exist: `toolError`'s own sentence format (`<code> <class>: <problem> - <detail>. Next: <next>.`,
 * `src/errors.ts`) driven by the `RUN_START_SPEC_UNFILLED` registry entry, and the detail the guard composes
 * (`src/run-start.ts::runStartSpecGuard`) — whose wording the owner's screenshot corroborates character for
 * character: *"still carries the template scaffold"*, *"1 unfinished marker(s) of its own"*,
 * *"line 274: Approval: FAIL"*.
 */

/** VERBATIM from a live transcript: a channel refusal, recorded with `isError: false`. */
const LIVE_CHANNEL_REFUSAL =
  'RM5503 runtime: the user-questions channel mounted in this composition refused the run-start question, so '
  + 'no person was asked. Next: use recursive_ask without an answer to surface the question, and retry it with '
  + 'answer: "Start run" once the user has approved the run start.'

/** RECONSTRUCTED (see above) from `toolError('RUN_START_SPEC_UNFILLED', …)` and the guard's own detail. */
const SPEC_UNFILLED_REFUSAL =
  'RM4404 state: the Phase 0 requirements document is still the unfilled template, so there is no run spec for '
  + 'a person to approve - 00-requirements.md for run "r1" still carries the template scaffold (it also '
  + 'carries 1 unfinished marker(s) of its own, starting at line 274): line 23: <short title>, line 31: '
  + '[observable condition 1]. Next: fill the requirements document in (define the requirement ids and their '
  + 'acceptance criteria, and complete the TODO list) and then call recursive_ask with gate: run-start again.'

/** The tool's own output renderer: `JSON.stringify(value, null, 2)` into ONE text block. */
function payloadText(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2)
}

/** A DISPATCHED call with no result yet: the owner's `start` phase, i.e. the call in flight. */
function blockWithNoResult(args: Record<string, unknown> = { gate: 'run-start', runId: 'r1' }): SpecSheetBlock {
  return { phase: 'start', argsRaw: JSON.stringify(args) } as SpecSheetBlock
}

/**
 * A SETTLED call block, shaped as the toolview owner shapes it.
 *
 * ⚠ `isError` IS A PARAMETER WITH A `false` DEFAULT FOR A REASON: every refusal measured live came back with
 * `isError: false`, because this tool refuses in its PAYLOAD rather than by throwing. A fixture that set
 * `isError: true` for a refusal would let a client that branches on that flag pass these tests while failing
 * on the real transcript.
 */
function resultBlock(
  args: Record<string, unknown>,
  payload: string | null,
  options: { isError?: boolean; error?: string | null } = {},
): SpecSheetBlock {
  return {
    phase: 'result',
    call: { name: RUN_START_TOOL_NAME, argsRaw: JSON.stringify(args) },
    result: payload === null
      ? null
      : { text: [payload], isError: options.isError ?? false, error: options.error ?? null },
  } as SpecSheetBlock
}

/* ---------------- 1. the view model: what the call is, and what it asks for ---------------- */

describe('the spec sheet claims exactly the run-start call', () => {
  it('reads gate / runId / artifact out of the call arguments', () => {
    const args = parseRecursiveAskArgs(JSON.stringify({ gate: 'run-start', runId: 'r1', answer: 'Hold' }))
    expect(args).toEqual({ gate: 'run-start', runId: 'r1', artifact: null, answer: 'Hold' })
  })

  it('yields all-nulls for empty, malformed, or non-object arguments instead of throwing', () => {
    for (const raw of [null, '', '   ', '{not json', '42', '[]']) {
      expect(parseRecursiveAskArgs(raw)).toEqual({ gate: null, runId: null, artifact: null, answer: null })
    }
    expect(parseRecursiveAskArgs(JSON.stringify({ gate: '  run-start  ', runId: '', artifact: 7 })))
      .toEqual({ gate: 'run-start', runId: null, artifact: null, answer: null })
  })

  it('the artifact file it shows IS the one the gate is recorded in', () => {
    // The client cannot import run-start.ts (node:fs in the browser bundle), so the copy is pinned here.
    expect(RUN_START_SPEC_FILE).toBe(RUN_START_ARTIFACT)
    expect(RUN_START_TOOL_NAME).toBe('recursive_ask')
  })

  /**
   * ⚠ EVERY NAME THIS MODULE RE-EXPORTS MUST ACTUALLY ARRIVE, AND THIS IS NOT PARANOIA — IT IS A MEASURED
   * VACUITY. `toContain(undefined)` does not throw in vitest; it matches NOTHING and the assertion passes. So
   * when the re-export list was rewritten and `RUN_START_QUESTION` was left out, the two assertions that pin
   * the sheet's wording to the gate's own words kept passing while asserting nothing. A spec whose assertions
   * silently stop running is worse than no spec, so the names are resolved here as VALUES first.
   */
  it('re-exports the gate\'s own words as real strings (a missing name would make assertions vacuous)', async () => {
    const sheet = await import('../src/client/spec-sheet.tsx')
    for (const name of [
      'RUN_START_QUESTION',
      'RUN_START_OPTION_MEANING',
      'RUN_START_APPROVE_LABEL',
      'RUN_START_HOLD_LABEL',
      'CALL_PENDING_LEAD',
      'CALL_PENDING_TAIL',
      'CALL_REFUSED_LEAD',
      'CALL_REFUSED_NEXT',
      'CALL_REFUSED_QUOTE_LEAD',
      'CALL_REFUSED_UNQUOTED',
      'CALL_UNKNOWN_LEAD',
      'CALL_ANSWERED_LEAD',
      'UNFILLED_NOTICE',
      'UNFILLED_SHORT',
      'NO_CALL_NOTICE',
      'PREPARING_NOTICE',
      'TRUNCATED_NOTICE',
      'SPEC_DEFAULT_MODE',
    ] as const) {
      const value = (sheet as unknown as Record<string, unknown>)[name]
      expect(typeof value, name + ' must be re-exported as a value').toBe('string')
      expect(String(value).length, name + ' must not be empty').toBeGreaterThan(0)
    }
    // The three RECORD-shaped exports, checked as records: a mode whose label went missing would print
    // `undefined` on the control face rather than failing anywhere.
    for (const name of ['SPEC_MODE_LABEL', 'SPEC_MODE_NOTE', 'SPEC_TOGGLE_LABEL'] as const) {
      const value = (sheet as unknown as Record<string, unknown>)[name] as Record<string, unknown>
      expect(value, name + ' must be re-exported as a value').toBeTruthy()
      for (const mode of ['preview', 'raw']) {
        expect(typeof value[mode], name + '.' + mode).toBe('string')
        expect(String(value[mode]).length, name + '.' + mode + ' must not be empty').toBeGreaterThan(0)
      }
    }
    // The two constants the sheet QUOTES are non-empty and distinct, so the wording assertions above bite.
    expect(RUN_START_QUESTION.length).toBeGreaterThan(0)
    expect(RUN_START_OPTION_MEANING.length).toBeGreaterThan(0)
  })

  it('names the document it is about, and never invents a root it does not have', () => {
    expect(specPath('r1', '/ws', RUN_START_SPEC_FILE)).toBe('.recursive/run/r1/00-requirements.md  (in /ws)')
    expect(specPath(null, null, RUN_START_SPEC_FILE)).toBe('.recursive/run/<runId>/00-requirements.md')
    // The route re-validates the root it is handed, so the resolved root is preferred and a blank is not one.
    expect(resolveSpecRoot('/resolved', '/ws', '/cwd')).toBe('/resolved')
    expect(resolveSpecRoot(null, '/ws', '/cwd')).toBe('/ws')
    expect(resolveSpecRoot('   ', '', '/cwd')).toBe('/cwd')
    expect(resolveSpecRoot(null, '', '')).toBeNull()
  })

  it('says plainly that a Hold is not an approval', () => {
    expect(decisionLine(null)).toBeNull()
    expect(decisionLine('Start run')).toContain('approving label')
    expect(decisionLine('Hold')).toContain('not the approving label')
    expect(decisionLine('Hold')).not.toContain('arms the run goal')
  })
})

/* ------------- 1b. WHAT THE VIEW MODEL CAN TELL ABOUT THE CALL: the three states, and the code that decides ------- */

/**
 * ⚠ THIS IS THE DEFECT'S ROOT CAUSE, ASSERTED DIRECTLY.
 *
 * The sheet registers into `tool.call.toolview` keyed by the `recursive_ask` tool, so it renders for the CALL.
 * The owner's run showed the sheet rendering while its own warning block said "there is no spec to approve
 * yet" — and, in the same panel, announcing a question and describing Start run / Hold. The gate had REFUSED
 * (nothing was asked, no card could appear, which is correct); the panel simply had no way to know, because
 * the block it was handed was read for its ARGUMENTS ONLY.
 *
 * The four `readCallOutcome` branches below are the whole discrimination, and each is asserted on a payload
 * shaped the way the tool actually returns one (`JSON.stringify(value, null, 2)` in one text block).
 */
describe('the view model tells a REFUSED call from a PENDING one', () => {
  it('reads a refusal out of the call\'s own result — and NOT out of `isError`, which is false for it', () => {
    // The measured shape: a refusal in the payload, with the harness's error flag left false.
    const outcome = readCallOutcome({ text: [payloadText({ error: LIVE_CHANNEL_REFUSAL })], isError: false })
    expect(outcome.state).toBe('refused')
    // The refusal is carried VERBATIM: the panel prints the sentence the caller received, not a paraphrase of
    // it, which is what "name what refused it" has to mean when the panel did not make the decision.
    expect(outcome).toEqual({ state: 'refused', refusal: LIVE_CHANNEL_REFUSAL })
    // …and the same holds for the template refusal, whose `question` rides along WITH the error — the case
    // that makes "does the payload carry a question?" the wrong test for "is a question live?".
    const withQuestion = readCallOutcome({
      text: [payloadText({ error: SPEC_UNFILLED_REFUSAL, gate: 'run-start', runId: 'r1', question: { id: 'run-start' } })],
      isError: false,
    })
    expect(withQuestion).toEqual({ state: 'refused', refusal: SPEC_UNFILLED_REFUSAL })
  })

  it('the harness\'s OWN failure record is a refusal too, and its sentence is what gets printed', () => {
    // The other way a refusal can arrive: the host marks the call failed. It is still not a question, and the
    // panel prints the host's sentence rather than inventing one.
    expect(readCallOutcome({ text: [], isError: true, error: 'the tool call was aborted' }))
      .toEqual({ state: 'refused', refusal: 'the tool call was aborted' })
    // …and a host failure with no sentence at all is a refusal WITH THE GAP STATED, never a blank.
    expect(readCallOutcome({ text: [], isError: true })).toEqual({ state: 'refused', refusal: null })
  })

  it('reads a RECORDED DECISION as settled — including the payload whose label must come from the arguments', () => {
    expect(readCallOutcome({
      text: [payloadText({ gate: 'run-start', answer: 'Start run', artifact: '00-requirements.md', path: 'p', replaced: false, armed: true })],
      isError: false,
    })).toEqual({ state: 'answered', answer: 'Start run' })
    // ⚠ A `Hold` IS ANSWERED, NOT APPROVED: the state says the call settled, and WHICH label it recorded is
    // `decisionLine`'s job. A model that folded the two would report a hold as a start.
    expect(readCallOutcome({ text: [payloadText({ gate: 'run-start', answer: 'Hold', armed: false })], isError: false }))
      .toEqual({ state: 'answered', answer: 'Hold' })
    // ⚠ AND A SETTLED CALL WITH NO LABEL IS STILL SETTLED. `armed` alone is a returning record whose `answer`
    // this client did not see; reporting it as PENDING would announce a question that has already been answered.
    expect(readCallOutcome({ text: [payloadText({ gate: 'run-start', armed: true })], isError: false }))
      .toEqual({ state: 'answered', answer: null })
  })

  it('says it CANNOT TELL rather than guessing, and keeps the three reasons apart', () => {
    // No result was handed to the view at all.
    expect(readCallOutcome(null)).toEqual({ state: 'unknown', reason: 'no-result' })
    // A result that carries no JSON payload (a spill, a truncation, a format this client does not know).
    expect(readCallOutcome({ text: ['<persisted-output>see E:\\tmp\\spill.txt</persisted-output>'], isError: false }))
      .toEqual({ state: 'unknown', reason: 'unreadable' })
    expect(readCallOutcome({ text: [], isError: false })).toEqual({ state: 'unknown', reason: 'kind-absent' })
    // ⚠ THE SUBTLE ONE, and the reason it is not `refused`: a payload carrying ONLY the question text is the
    // shape a refusal ships TOO (measured above), so its presence proves nothing about a live question. The
    // panel says it cannot tell instead of borrowing the words of a question nobody may have been asked.
    expect(readCallOutcome({ text: [payloadText({ gate: 'run-start', question: { id: 'run-start' } })], isError: false }))
      .toEqual({ state: 'unknown', reason: 'kind-absent' })
  })

  it('a block with no settled result is PENDING, and a block with one carries what it said', () => {
    // The `start` phase: the call is in flight, which is the window in which the gate asks the channel — and
    // also the moment after a person answers, before the result lands. The state is `pending`; the panel's own
    // words (below) are what keep that from claiming a card is on screen at this instant.
    expect(readCall(blockWithNoResult())).toEqual({
      ok: true,
      args: { gate: 'run-start', runId: 'r1', artifact: null, answer: null },
      outcome: { state: 'pending' },
    })
    // A settled block carries its outcome, so the component cannot render a refusal as a question.
    const settled = readCall(resultBlock({ gate: 'run-start', runId: 'r1' }, payloadText({ error: LIVE_CHANNEL_REFUSAL })))
    expect(settled.ok && settled.outcome).toEqual({ state: 'refused', refusal: LIVE_CHANNEL_REFUSAL })
    // …and a settled block the owner sent WITHOUT a result is `unknown`, never `pending`: the difference is
    // the whole fix, because a settled call has no question left to ask.
    const bare = readCall(resultBlock({ gate: 'run-start', runId: 'r1' }, null))
    expect(bare.ok && bare.outcome).toEqual({ state: 'unknown', reason: 'no-result' })
  })

  it('builds the refusal notice from the refusal, and states the gap when there is none', () => {
    const notice = refusedNotice(SPEC_UNFILLED_REFUSAL)
    expect(notice).toContain(CALL_REFUSED_LEAD)
    expect(notice).toContain(CALL_REFUSED_QUOTE_LEAD)
    expect(notice).toContain(SPEC_UNFILLED_REFUSAL)
    expect(notice).toContain(CALL_REFUSED_NEXT)
    // A refusal that did not reach the panel says SO, rather than leaving "it was refused" standing alone.
    const bare = refusedNotice(null)
    expect(bare).toContain(CALL_REFUSED_UNQUOTED)
    expect(bare).not.toContain(CALL_REFUSED_QUOTE_LEAD)
    expect(refusedNotice('   ')).toContain(CALL_REFUSED_UNQUOTED)
    // Each unreadable reason names itself, and none of them claims a question exists.
    for (const reason of ['no-result', 'unreadable', 'kind-absent'] as const) {
      expect(unknownNotice(reason)).toContain(CALL_UNKNOWN_LEAD)
    }
    expect(unknownNotice('unreadable')).not.toBe(unknownNotice('kind-absent'))
  })
})

/* ---------------- 2-3. the rendered component: the real text, and the stub ---------------- */

describe('RunStartSpecSheetBody (renders the document it is given)', () => {

  it('renders the ACTUAL document as a PREVIEW, and composes no summary of its own', () => {
    const { r } = renderDoc(writtenDoc())
    const text = textOf(r.toJSON())
    // The document's own line, whole and unaltered — the `- ` of the bullet is the renderer's, drawn because
    // the parser reports list CONTENT (the base parser's shape) and this seat puts the marker back.
    // ⚠ THE SEPARATOR IS MATCHED AS WHITESPACE, NOT AS SPACES: the renderer draws a NON-BREAKING space
    // between a mark and its item (see the structural assertion further down), and an assertion written
    // around literal spaces would fail on a line that is perfectly correct.
    expect(textOf(r.toJSON())).toMatch(/-\s+ACCEPTANCE-MARKER-7f3a/)
    // ⚠ THE HEADING IS DRAWN AS A HEADING, NOT PRINTED AS MARKDOWN. This is the defect the owner reported:
    // "reading `##` headings and pipe-table syntax is not reviewing a spec". Each heading line keeps every
    // character of its own text while its MARKER is consumed by `parseDoc` and drawn as structure — so the
    // assertion moves from `### \`R1\` …` to the heading's text, and the `###` is asserted ABSENT. The
    // heading's inline code span is its own element, so the join between the two is whitespace, not a
    // character: the regex pins adjacency without pretending to know how many spaces a renderer inserts.
    expect(text).toMatch(/R1`?\s+The spec is readable before it is decidable/)
    expect(text).not.toContain('### `R1`')
    expect(text).not.toContain('## Requirements')
    // The document's own path and its verdict are still printed in the sheet, not paraphrased.
    expect(text).toContain('.recursive/run/r1/00-requirements.md')
    // ⚠ THE NEGATIVE HALF, which is what stops this passing on a component that renders anything: nothing
    // the component composes about an unread document is present.
    expect(text).not.toContain(UNFILLED_NOTICE)
    expect(text).not.toContain('No document text to show')
    // And the verdict of a written document is stated as such.
    expect(text).toContain('no template placeholder remains')
    // A filled document carries no unfilled marks: the drawn boxes are all ticked and both gates read PASS.
    expect(r.root.findAll(hasClass('rec-doc-todo-check-off')).length).toBe(0)
    expect(r.root.findAll(hasClass('rec-doc-gate-fail')).length).toBe(0)
    expect(r.root.findAll(hasClass('rec-doc-gate-pass')).length).toBe(2)
    r.unmount()
  })

  it('SAYS SO PLAINLY when the document is still the unfilled template, quoting the placeholders', () => {
    const { model, r } = renderDoc(requirementsContent('r1', 'feature'))
    expect(model.verdict).toBe('unfilled')
    const text = textOf(r.toJSON())
    expect(text).toContain(UNFILLED_NOTICE)
    expect(text).toContain('### `R1` <short title>')
    expect(text).toContain('line 23')
    // It does not dress the stub up as approvable, and it does not invite the reader to approve it.
    expect(text).not.toContain('no template placeholder remains')
    expect(text).toContain('Approving here would record a decision about a spec that does not exist yet.')
    r.unmount()
  })

  it('shows the template text TOO — a stated stub is still shown, not replaced by the notice', () => {
    const { r } = renderDoc(requirementsContent('r1', 'feature'))
    // The document's own first line survives into the tree, so the person can read the stub itself. The line
    // is split by the INLINE scanner (the path is a code span), so the two halves are asserted as halves.
    const text = textOf(r.toJSON())
    expect(text).toContain('Run:')
    expect(text).toContain('/.recursive/run/r1/')
    // The template's unfinished boxes reach the reader AS unfinished boxes, not as prose.
    expect(r.root.findAll(hasClass('rec-doc-todo-check-off')).length).toBe(7)
    expect(r.root.findAll(hasClass('rec-doc-todo-check-on')).length).toBe(0)
    // ...and both gates reach them reading FAIL.
    expect(r.root.findAll(hasClass('rec-doc-gate-fail')).length).toBe(2)
    r.unmount()
  })

  it('never claims a document it did not read: absent, error, and loading each say which they are', () => {
    const args = { gate: 'run-start', runId: 'r1', artifact: null, answer: null }
    const loading = createRenderer(createElement(RunStartSpecSheetBody, {
      model: specSheetModel({ args, root: '/ws', fetch: { state: 'loading' } }),
    }))
    expect(textOf(loading.toJSON())).toContain('Reading the document')
    loading.unmount()

    const absent = createRenderer(createElement(RunStartSpecSheetBody, {
      model: specSheetModel({ args, root: '/ws', fetch: { state: 'absent' } }),
    }))
    const absentText = textOf(absent.toJSON())
    expect(absentText).toContain('does not exist yet')
    // "not written" and "route broken" are different sentences, which is the whole reason 404 is its own state.
    expect(absentText).not.toContain('could not be read')
    absent.unmount()

    const failed = createRenderer(createElement(RunStartSpecSheetBody, {
      model: specSheetModel({ args, root: '/ws', fetch: { state: 'error', error: 'recursive phase doc: HTTP 500' } }),
    }))
    const failedText = textOf(failed.toJSON())
    expect(failedText).toContain('could not be read')
    expect(failedText).toContain('HTTP 500')
    failed.unmount()
  })

  it('names the decision and says the controls live elsewhere (it casts no vote)', () => {
    const { r } = renderDoc(writtenDoc())
    const text = textOf(r.toJSON())
    expect(text).toContain('Approve phase 0 and start this run?')
    expect(text).toContain('Start run')
    expect(text).toContain('Hold')
    expect(text).toContain('read-only')
    // ⚠ THE ONLY BUTTON IS THE VIEW TOGGLE — NOTHING HERE CASTS A VOTE. A second approve button would be a
    // second way to answer one question, and the read-only invariant (R9) forbids the client writing
    // anything at all. The view toggle changes HOW the document is shown, never WHETHER it is approved.
    // ⚠ ASSERTED BY COUNT, NOT BY DEEP EQUALITY AGAINST `[]`: a failing `toEqual` on React instances makes
    // the reporter walk the whole test-instance graph, which exhausts the heap and reports an OOM instead of
    // the mismatch. A count prints two numbers and the test stays diagnosable.
    const buttons = r.root.findAllByType('button')
    expect(buttons.length, 'exactly one control: the preview/source toggle').toBe(1)
    expect(textOfNode(buttons[0])).toBe('View source')
    expect(buttons[0].props.type).toBe('button')
    r.unmount()
  })
})

/* ---------------- 3b. the PREVIEW: the document is rendered, not printed ---------------- */

/**
 * The markdown rendered as STRUCTURE rather than as its own source.
 *
 * ⚠ THE VACUITY TRAP THIS AVOIDS. "The preview is rendered" cannot be asserted by looking for the document's
 * words, because the raw view contains every one of them too. So each assertion here is on a KIND — the
 * parsed token, or the element the renderer draws for it — and each is paired with a negative on the SYNTAX
 * that kind consumes.
 */
describe('the spec sheet renders a structured preview', () => {
  it('parses each markdown construct to its own token kind', () => {
    const kinds = parseDoc([
      '# Title',
      '## A section',
      '### `R1` A requirement',
      'plain line',
      '- a bullet',
      '- [ ] an open box',
      '- [x] a closed box',
      'Coverage: FAIL',
      'Approval: PASS',
      '```ts',
      'const a = 1',
      '```',
      '| Phase | Status |',
      '| --- | --- |',
      '| 00 | LOCKED |',
      '',
    ].join('\n'))
    expect(kinds.map((l) => l.kind)).toEqual([
      'h1', 'h2', 'h3', 'plain', 'li', 'li', 'li', 'plain', 'plain', 'code', 'table', 'blank',
    ])
    // ⚠ THE TWO MARKS THE TEMPLATE SHIPS are recorded as marks, not left as body text: an open box with its
    // tick, and a gate with its reading. These are the fields the preview draws the marks from.
    expect(kinds.find((l) => l.text === 'an open box')?.checked).toBe(false)
    expect(kinds.find((l) => l.text === 'a closed box')?.checked).toBe(true)
    expect(kinds.find((l) => l.text === 'Coverage: FAIL')?.gate).toBe('fail')
    expect(kinds.find((l) => l.text === 'Approval: PASS')?.gate).toBe('pass')
    // A plain bullet is NOT a task box: `checked` is absent, not false, so the renderer cannot draw a box
    // for an item that never had one.
    expect(kinds.find((l) => l.text === 'a bullet')?.checked).toBeUndefined()
  })

  it('draws a `##` line as a heading and a pipe table as a table, and consumes both syntaxes', () => {
    const { r } = renderDoc([
      '## Coverage Gate',
      '',
      '| Phase | Status |',
      '| --- | --- |',
      '| 00 | LOCKED |',
      '| 01 | DRAFT |',
    ].join('\n'))
    // The heading is an h2 ELEMENT carrying the heading text…
    const h2 = r.root.findAll(hasClass('rec-doc-h2'))
    expect(h2.length, 'the `##` line becomes exactly one h2').toBe(1)
    expect(textOfNode(h2[0])).toBe('Coverage Gate')
    // …and the line the preview draws is NOT the markdown that produced it.
    const preview = previewLines(r).join('\n')
    expect(preview).toContain('Coverage Gate')
    expect(preview).not.toContain('## Coverage Gate')
    expect(preview).not.toContain('##')

    // The pipe rows are ONE table, header included, and the separator row is not a row of data.
    const tables = r.root.findAllByType('table')
    expect(tables.length, 'the pipe rows become exactly one table').toBe(1)
    const headers = tables[0].findAllByType('th').map((n) => textOfNode(n))
    expect(headers).toEqual(['Phase', 'Status'])
    const cells = tables[0].findAllByType('td').map((n) => textOfNode(n))
    expect(cells).toEqual(['00', 'LOCKED', '01', 'DRAFT'])
    expect(preview).not.toContain('| --- |')
    r.unmount()
  })

  it('keeps the preview line the DOCUMENT\'s line: markers are drawn, the text is untouched', () => {
    const { r } = renderDoc([
      '- a plain bullet',
      '- [ ] an open box',
      '- [x] a closed box',
      'Run: `/.recursive/run/r1/`',
    ].join('\n'))
    const wraps = r.root.findAll(hasClass('rec-doc-line-wrap'))
    // ⚠ ASSERTED BY STRUCTURE, NOT BY THE JOINED STRING. Whether a mark is separated from its item by a
    // plain space, a non-breaking space or a flex `gap` is the renderer's business; what must not vary is
    // that the line is the DOCUMENT's line — a bullet with its marker, a box in place of the mark it
    // consumed, and the item's own text untouched behind it.
    const line = (n: number) => wraps[n].findAll(hasClass('rec-doc-line')).at(0)!
    expect(wraps.length, 'one rendered line per document line').toBe(4)
    // The bullet is drawn as a bare marker, and the SEPARATOR lives on the item's side of it: a text node
    // that ENDS in a space loses it (measured, and carried into the built bundle), so the glyph cannot hold
    // one. NBSP is written as an escape because a plain leading space is normalised away by the transform.
    expect(textOfNode(line(0).findAll(hasClass('rec-doc-bullet')).at(0)!)).toBe('-')
    expect(textOfNode(line(0).findAll(hasClass('rec-doc-li-text')).at(0)!)).toBe('\u00A0a plain bullet')
    // The box REPLACES the `[ ]` mark in the same position, and the tick is visible both ways.
    const box = line(1).findAll(hasClass('rec-doc-todo-check')).at(0)!
    expect(box.props.className).toContain('rec-doc-todo-check-off')
    expect(textOfNode(box)).toContain('[ ]')
    expect(textOfNode(box)).toContain('not done:')
    expect(textOfNode(line(1).findAll(hasClass('rec-doc-li-text')).at(0)!)).toBe('\u00A0an open box')
    // A ticked box says so, and says it differently.
    const done = line(2).findAll(hasClass('rec-doc-todo-check')).at(0)!
    expect(done.props.className).toContain('rec-doc-todo-check-on')
    expect(textOfNode(done)).toContain('[x]')
    expect(textOfNode(done)).toContain('done:')
    // ⚠ AND THE MARKS DO NOT RUN INTO THEIR ITEMS. A `-` with no separator renders the line as `-item`, and
    // an accessible mark with no separator is announced as `not done:item`; both were live defects here, so
    // the separator is asserted as the exact character it is rather than as a lookalike.
    expect(textOfNode(line(1))).toContain('not done:\u00A0')
    // Inline code is still inline code: the character survives, its backticks do not.
    expect(textOfNode(line(3))).toContain('Run:')
    expect(textOfNode(line(3))).toContain('/.recursive/run/r1/')
    expect(textOfNode(line(3))).not.toContain('`')
    r.unmount()
  })

  it('draws an unticked box as unticked and a FAIL gate as FAIL — the two marks it must not hide', () => {
    const { r } = renderDoc(['- [ ] still to do', '- [x] done', 'Coverage: FAIL', 'Approval: PASS'].join('\n'))
    // A box and a gate are STRUCTURED marks, not greyscale: a class the CSS colours, plus text that says it.
    expect(r.root.findAll(hasClass('rec-doc-todo-check-off')).length).toBe(1)
    expect(r.root.findAll(hasClass('rec-doc-todo-check-on')).length).toBe(1)
    expect(r.root.findAll(hasClass('rec-doc-gate-fail')).length).toBe(1)
    expect(r.root.findAll(hasClass('rec-doc-gate-pass')).length).toBe(1)
    expect(r.root.findAll(hasClass('rec-doc-todo-open')).length).toBe(1)
    // ⚠ THE MARK IS NOT COLOUR ALONE: the tick is carried as text for the ear as well, so "not ticked"
    // survives every way of reading it.
    const text = textOf(r.toJSON())
    expect(text).toContain('not done:')
    expect(text).toContain('done:')
    expect(text).toContain('Coverage: FAIL')
    r.unmount()
  })
})

/* ---------------- 3c. the RAW toggle: the escape hatch from the interpretation ---------------- */

/**
 * The preview is an INTERPRETATION and the sheet asks for an approval on the strength of it, so the verbatim
 * text must be one control away — and which of the two is on screen must be ANNOUNCED, not just drawn.
 */
describe('the sheet can swap the preview for the verbatim source, and back', () => {
  it('opens on the preview, swaps to VERBATIM text, and swaps back', () => {
    const doc = writtenDoc()
    const { r } = renderDoc(doc)
    const sheetText = () => textOf(r.toJSON())

    // 1. The default is the rendered preview: no markdown syntax survives it.
    expect(modeParts(r).toggle.props['aria-pressed']).toBe(false)
    expect(sheetText()).not.toContain('### `R1`')
    expect(sheetText()).not.toContain('## Coverage Gate')

    // 2. One press shows the document's own bytes, whole — the check that the preview hides nothing.
    clickToggle(r)
    expect(modeParts(r).toggle.props['aria-pressed']).toBe(true)
    expect(sheetText()).toContain(doc)
    expect(sheetText()).toContain('- ' + MARKER)
    expect(sheetText()).toContain('### `R1` The spec is readable before it is decidable')
    // In raw mode the body is the VERBATIM <pre>, not the parsed lines: the honesty is structural, not a
    // matter of the same renderer happening to reproduce the source.
    expect(r.root.findAll(hasClass('rec-spec-text')).length).toBe(1)
    expect(r.root.findAll(hasClass('rec-doc-line-wrap')).length).toBe(0)
    // ⚠ READ FROM THE BODY, NOT THE WHOLE SHEET: the sheet's own sentences quote the document's lines, so a
    // whole-sheet assertion could be satisfied by the notice while the body showed something else entirely.
    expect(bodyText(r)).toBe(doc)
    // Both marks are here — as the document's own characters, which is the point of this mode.
    expect(bodyText(r)).toContain('- [x]')
    expect(bodyText(r)).toContain('Coverage: PASS')

    // 3. Pressing it again returns the preview, so the control is a toggle and not a one-way door.
    clickToggle(r)
    expect(modeParts(r).toggle.props['aria-pressed']).toBe(false)
    expect(r.root.findAll(hasClass('rec-spec-text')).length).toBe(0)
    expect(r.root.findAll(hasClass('rec-doc-line-wrap')).length > 0).toBe(true)
    expect(r.root.findAll(hasClass('rec-doc-h2')).length > 0).toBe(true)
    expect(sheetText()).not.toContain('### `R1`')
    r.unmount()
  })

  it('is one real BUTTON, and names the mode on screen rather than the action it performs', () => {
    const { r } = renderDoc(writtenDoc())
    const { toggle, state } = modeParts(r)
    // A `button` element is keyboard reachable with no key handler of ours to get wrong; Tab reaches it and
    // Enter/Space press it.
    expect(toggle.type).toBe('button')
    expect(toggle.props.type).toBe('button')
    expect(typeof toggle.props.onClick).toBe('function')
    // The label is the ACTION ("View source"), so the state is carried by aria-pressed…
    expect(textOfNode(toggle)).toBe('View source')
    expect(toggle.props['aria-pressed']).toBe(false)
    // …and repeated as WORDS in a live region, naming the mode ON SCREEN. A reader who never sees the button
    // is told which of the two documents they are being shown.
    expect(state.props.role).toBe('status')
    expect(textOfNode(state)).toContain('Showing: rendered preview')

    clickToggle(r)
    const after = modeParts(r)
    expect(textOfNode(after.toggle)).toBe('Back to preview')
    expect(after.toggle.props['aria-pressed']).toBe(true)
    expect(textOfNode(after.state)).toContain('Showing: raw source')
    expect(textOfNode(after.state)).toContain('VERBATIM')
    r.unmount()
  })

  it('has no mode to offer before a document exists, and says so instead of lying about one', () => {
    const args = { gate: 'run-start', runId: 'r1', artifact: null, answer: null }
    for (const fetch of [{ state: 'loading' } as const, { state: 'absent' } as const, { state: 'error', error: 'HTTP 500' } as const]) {
      const r = createRenderer(createElement(RunStartSpecSheetBody, { model: specSheetModel({ args, root: '/ws', fetch }) }))
      const { toggle } = modeParts(r)
      // ⚠ `aria-disabled`, NOT `disabled`: a really-disabled control is skipped by the keyboard while the
      // status line beside it would still be announcing a mode. The click is refused instead.
      expect(toggle.props['aria-disabled']).toBe(true)
      expect(toggle.props.disabled).toBeUndefined()
      clickToggle(r)
      expect(modeParts(r).toggle.props['aria-pressed']).toBe(false)
      r.unmount()
    }
  })
})

/* ---------------- 3d. THE DEFECT: a REFUSED call must not render as a PENDING one ---------------- */

/**
 * ⚠ THE TWO ASSERTIONS THE OWNER'S RUN NEEDED, AND WHY THEY ARE PAIRED.
 *
 * The owner's screenshot showed one panel doing both things at once: warning that the document is still the
 * unfilled template — "there is no spec to approve yet" — and announcing "The question about this document is:
 * 'Approve phase 0 and start this run?'" with a description of Start run / Hold. The gate had REFUSED, so
 * nothing was asked and no dialog could appear, which is correct; the PANEL was wrong.
 *
 * A positive assertion alone ("the refusal explanation is rendered") would not have caught it, because the
 * defect was an EXTRA claim, not a missing one. So the refusal case asserts BOTH halves: the refusal
 * explanation is present, and the question text and the option meanings are ABSENT. The pending case asserts
 * the opposite half, so neither assertion can be satisfied by weakening the other.
 */
describe('a REFUSED run-start call renders the refusal, and NOT a question', () => {
  /** The sheet body for one settled block, exactly as the seat builds it. */
  function renderSettled(block: SpecSheetBlock) {
    const read = readCall(block)
    if (!read.ok) throw new Error('the fixture block must be readable')
    const model = specSheetModel({
      args: read.args,
      root: '/ws',
      fetch: { state: 'loaded', text: requirementsContent('r1', 'feature') },
      call: read.outcome,
    })
    return createRenderer(createElement(RunStartSpecSheetBody, { model }))
  }

  it('GATE REFUSED: prints the refusal and DOES NOT print the question or the options', () => {
    const r = renderSettled(resultBlock(
      { gate: 'run-start', runId: 'r1' },
      payloadText({ error: SPEC_UNFILLED_REFUSAL, gate: 'run-start', runId: 'r1', artifact: '00-requirements.md' }),
    ))
    const text = textOf(r.toJSON())

    // 1. IT SAYS PLAINLY THAT NOTHING IS BEING ASKED, and names what refused it — using the refusal the call
    //    actually came back with, which is the only part of this the panel did not decide itself.
    expect(text).toContain(CALL_REFUSED_LEAD)
    expect(text).toContain(SPEC_UNFILLED_REFUSAL)
    expect(text).toContain('still carries the template scaffold')

    // 2. ⚠ AND IT DOES NOT ANNOUNCE A QUESTION. These are the exact sentences the live defect printed.
    expect(text).not.toContain('The question about this document is')
    expect(text).not.toContain(RUN_START_QUESTION)
    expect(text).not.toContain(RUN_START_OPTION_MEANING)
    // The option labels are not offered as a choice either. (`Start run` still appears — inside the quoted
    // refusal, whose own `Next:` clause names it — so the assertion is on the MEANING sentence, which is what
    // described the decision as available, and on the question itself.)
    expect(text).not.toContain(CALL_PENDING_LEAD)

    // 3. THE DOCUMENT IS STILL SHOWN, and its verdict is unchanged: the refusal usually names the document as
    //    its reason, so the reader gets the refusal and the document it is about from the same panel.
    expect(text).toContain(UNFILLED_NOTICE)
    expect(text).toContain('### `R1` <short title>')
    expect(text).toContain(CALL_REFUSED_NEXT)

    // 4. NOTHING HERE CASTS A VOTE. The only control is still the preview/source toggle.
    const buttons = r.root.findAllByType('button')
    expect(buttons.length, 'a refused call adds no control at all').toBe(1)
    expect(textOfNode(buttons[0])).toBe('View source')
    r.unmount()
  })

  it('GATE REFUSED, refusal not readable: states the gap instead of leaving "it was refused" bare', () => {
    const r = renderSettled(resultBlock({ gate: 'run-start', runId: 'r1' }, null))
    const text = textOf(r.toJSON())
    expect(text).toContain(CALL_UNKNOWN_LEAD)
    // It does not claim a question, and it does not claim a refusal either — it does not know which.
    expect(text).not.toContain('The question about this document is')
    expect(text).not.toContain(RUN_START_QUESTION)
    r.unmount()
  })

  it('GATE PENDING still renders the question and the options — the other half of the pair', () => {
    const read = readCall(blockWithNoResult())
    if (!read.ok) throw new Error('the fixture block must be readable')
    const model = specSheetModel({
      args: read.args,
      root: '/ws',
      fetch: { state: 'loaded', text: requirementsContent('r1', 'feature') },
      call: read.outcome,
    })
    const r = createRenderer(createElement(RunStartSpecSheetBody, { model }))
    const text = textOf(r.toJSON())
    // The question is quoted, and the panel says the decision belongs to the card that asked it.
    expect(text).toContain(CALL_PENDING_LEAD + RUN_START_QUESTION + CALL_PENDING_TAIL)
    expect(text).toContain(RUN_START_OPTION_MEANING)
    expect(text).toContain('The decision controls are the question card\'s')
    // ⚠ IT ALSO SAYS NOTHING WAS REFUSED. The pending block is the one state that may describe Start run /
    // Hold as available, and a stricter reading of "distinguishable" is that this state does NOT carry the
    // refusal sentence either.
    expect(text).not.toContain(CALL_REFUSED_LEAD)
    expect(text).not.toContain(CALL_ANSWERED_LEAD)
    r.unmount()
  })

  it('ALREADY ANSWERED says the call SETTLED, and quotes the label it recorded', () => {
    const r = renderSettled(resultBlock(
      { gate: 'run-start', runId: 'r1' },
      payloadText({ gate: 'run-start', answer: 'Hold', artifact: '00-requirements.md', armed: false }),
    ))
    const text = textOf(r.toJSON())
    expect(text).toContain(CALL_ANSWERED_LEAD)
    // The recorded label is printed, and a Hold is still not an approval. NO question is announced: the call
    // is over, so there is nothing pending to answer.
    expect(text).toContain('This call records: Hold')
    expect(text).toContain('not the approving label')
    expect(text).not.toContain('The question about this document is')
    expect(text).not.toContain(RUN_START_OPTION_MEANING)
    r.unmount()
  })
})

/* ---------------- 4. accessibility + reduced motion ---------------- */

describe('the spec sheet is reachable, named, and moves only if it may', () => {
  it('names the region, exposes the body to the keyboard, and swallows Escape', () => {
    const model = specSheetModel({
      args: { gate: 'run-start', runId: 'r1', artifact: null, answer: null },
      root: '/ws',
      fetch: { state: 'loaded', text: writtenDoc() },
    })
    const r = createRenderer(createElement(RunStartSpecSheetBody, { model }))
    const section = r.root.find((n) => String((n.props as Record<string, unknown>).className ?? '') === 'rec-spec')
    // An accessible name and a role: a screen reader announces what this region is.
    expect(section.props.role).toBe('region')
    expect(String(section.props['aria-labelledby'])).toBeTruthy()
    const heading = r.root.find(hasClass('rec-spec-title'))
    expect(heading.props.id).toBe(section.props['aria-labelledby'])
    expect(textOfNode(heading)).toContain('Run spec — r1')
    // Read-only is STATED, not left to be discovered.
    expect(section.props['aria-readonly']).toBe('true')

    // The document body is keyboard reachable and separately named.
    const body = r.root.find(hasClass('rec-spec-body-scroll'))
    expect(body.props.tabIndex).toBe(0)
    expect(body.props.role).toBe('group')
    // The label names the document AND the mode the box is showing, because the box is the element whose
    // contents the toggle replaces. `read-only` stays on it in both modes.
    const label = String(body.props['aria-label'])
    expect(label).toContain('read-only')
    expect(label).toContain('rendered preview')
    // The same element serves both modes — that is what keeps focus alive across a toggle.
    clickToggle(r)
    const after = r.root.find(hasClass('rec-spec-body-scroll'))
    expect(after.props.tabIndex).toBe(0)
    expect(String(after.props['aria-label'])).toContain('raw source')
    expect(textOfNode(body)).toContain(MARKER)

    // ESCAPE CASTS NO VOTE: the key is consumed, and no handler here can approve anything.
    let prevented = 0
    let stopped = 0
    act(() => {
      section.props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented += 1 }, stopPropagation: () => { stopped += 1 } })
    })
    expect(prevented).toBe(1)
    expect(stopped).toBe(1)
    // Any other key is left alone — the sheet is not a keyboard trap.
    act(() => {
      section.props.onKeyDown({ key: 'a', preventDefault: () => { prevented += 1 }, stopPropagation: () => { stopped += 1 } })
    })
    expect(prevented).toBe(1)
    expect(stopped).toBe(1)
    r.unmount()
  })

  it('carries a reduced-motion rule for its one transition, and a scroll cap so the controls stay reachable', () => {
    const original = (globalThis as { document?: unknown }).document
    const styles: Array<{ textContent: string; attrs: Record<string, string>; setAttribute(k: string, v: string): void; remove(): void }> = []
    ;(globalThis as { document?: unknown }).document = {
      querySelector: () => null,
      createElement: () => {
        const el = {
          attrs: {} as Record<string, string>, textContent: '',
          setAttribute(k: string, v: string) { el.attrs[k] = v },
          remove() {},
        }
        styles.push(el)
        return el
      },
      head: { appendChild: () => {} },
    }
    try {
      injectBoardStyles()
      const css = styles[0]?.textContent ?? ''
      // The sheet's rules exist at all (a vacuity guard: the assertions below must not pass on empty CSS).
      expect(css).toContain('.rec-spec {')
      expect(css).toContain('.rec-spec-text {')
      // reduced motion: the ONE transition the sheet has is switched off.
      const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
      expect(reduced).toContain('.rec-spec { transition: none; }')
      // A long document scrolls INSIDE the sheet; the decision controls below it cannot be pushed away.
      const body = css.slice(css.indexOf('.rec-spec-body-scroll {'))
      expect(body).toContain('max-height:')
      expect(body).toContain('overflow-y: auto')
    } finally {
      (globalThis as { document?: unknown }).document = original
    }
  })
})

/* ---------------- 5. the component: which calls it claims, and which it leaves alone ---------------- */

const SESSIONS = { ids: ['s1'], byId: { s1: { id: 's1', cwd: '/ws' } }, current: 's1' }
const sessionsHook = ((sel: (s: unknown) => unknown) => sel(SESSIONS)) as never

/**
 * A live-events stub, because the SEAT subscribes without being asked to.
 *
 * ⚠ THIS IS NOT TEST DECORATION. `RunStartSpecSheet` calls `useLiveProjection` UNCONDITIONALLY (the run 13
 * lesson: a conditional hook changed the hook count across renders), so mounting the real seat opens an
 * `EventSource` in jsdom, where there is none. The three tests that mount it with a `preparing` / truncated /
 * other-gate block return before the subscription matters, so only the two full-path tests below need this —
 * and what they assert (the refusal reaching the screen) is upstream of the route entirely.
 */
function withEventSourceStub<T>(body: () => Promise<T>): Promise<T> {
  const g = globalThis as { EventSource?: unknown; document?: unknown }
  const originalEventSource = g.EventSource
  const hadDocument = 'document' in g && g.document !== undefined
  const originalDocument = g.document
  class StubEventSource {
    onmessage: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    constructor(public readonly url: string) {}
    addEventListener(_type: string, _listener: (event: unknown) => void): void { /* no stream in a test */ }
    removeEventListener(_type: string, _listener: (event: unknown) => void): void { /* no stream in a test */ }
    close(): void { /* no stream in a test */ }
  }
  g.EventSource = StubEventSource
  // `visibilityState` is deliberately NOT 'visible': the visible branch re-opens the stream, which would make
  // the sheet re-subscribe in a loop and turn this fixture into a test of the retry path.
  g.document = {
    visibilityState: 'hidden',
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  return body().finally(() => {
    g.EventSource = originalEventSource
    if (hadDocument) g.document = originalDocument
    else delete g.document
  })
}

/**
 * Unmount a seat mounted under `withEventSourceStub` WITHOUT a detached-tree React warning.
 *
 * ⚠ THIS IS NOT PADDING. The seat subscribes to the live route in a PASSIVE effect, and React flushes passive
 * effects asynchronously — so unmounting and then restoring `globalThis` in the same tick leaves that
 * subscription's teardown to run against a `document` that no longer exists. React reports it as an internal
 * commit-phase error in a detached tree, which reads like a broken test when nothing is broken. Flushing the
 * effect queue inside the stub (and letting the next macrotask drain) keeps the reporter honest.
 */
async function unmountSeat(r: { unmount: () => void }): Promise<void> {
  await act(async () => { await Promise.resolve() })
  act(() => { r.unmount() })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('RunStartSpecSheet claims the run-start call and nothing else', () => {
  it('renders NOTHING for another gate — the generic tool row keeps its call', async () => {
    let r: ReturnType<typeof createRenderer> | undefined
    await act(async () => {
      r = createRenderer(createElement(RunStartSpecSheet, {
        block: startBlock({ gate: 'tdd-mode', runId: 'r1' }),
        useSessions: sessionsHook,
      }))
    })
    expect(r!.toJSON()).toBeNull()
    r!.unmount()
  })

  it('renders NOTHING when the owner supplies no block at all', async () => {
    let r: ReturnType<typeof createRenderer> | undefined
    await act(async () => { r = createRenderer(createElement(RunStartSpecSheet, { useSessions: sessionsHook })) })
    expect(r!.toJSON()).toBeNull()
    r!.unmount()
  })

  it('says the call cannot be read rather than rendering an empty document', async () => {
    let r: ReturnType<typeof createRenderer> | undefined
    await act(async () => {
      r = createRenderer(createElement(RunStartSpecSheet, { block: { phase: 'preparing' }, useSessions: sessionsHook }))
    })
    const text = textOf(r!.toJSON())
    expect(text).toContain('has not been dispatched yet')
    // ⚠ NOT an empty document: an empty frame would read as "the spec is empty", a claim about the run made
    // on evidence about the client. The document body is absent entirely.
    expect(text).not.toContain('No document text to show')
    r!.unmount()
  })

  it('says the window truncated the call rather than blaming the caller', async () => {
    let r: ReturnType<typeof createRenderer> | undefined
    await act(async () => {
      r = createRenderer(createElement(RunStartSpecSheet, { block: { phase: 'result', call: null }, useSessions: sessionsHook }))
    })
    expect(textOf(r!.toJSON())).toContain('left this call\'s own arguments outside it')
    r!.unmount()
  })

  /**
   * ⚠ THE WHOLE CHAIN, FROM THE SEAT THE HARNESS MOUNTS TO THE SENTENCES ON SCREEN.
   *
   * The two tests above drive `RunStartSpecSheetBody` with a model a spec built by hand; this one drives the
   * REGISTERED component with a BLOCK shaped as the toolview owner shapes it, because that is where the defect
   * lived: the seat rendered for the call, the view model read the call's ARGUMENTS, and the state the call
   * came back in never reached the body at all. A model-only spec cannot see that link — this can.
   */
  it('a REFUSED call renders the refusal through the REGISTERED seat, and announces no question', async () => {
    let r: ReturnType<typeof createRenderer> | undefined
    let text = ''
    let readOnly: unknown
    // ⚠ THE UNMOUNT HAPPENS INSIDE THE STUB, not after it: the seat's live subscription is torn down on
    // unmount, and restoring `globalThis.document` first would make that teardown throw a `document is not
    // defined` into the reporter — noise that looks like a failure and is not one. (The region's attributes are
    // read BEFORE the unmount for the same reason `react-test-renderer` gives: a tree that is gone has no root.)
    await withEventSourceStub(async () => {
      await act(async () => {
        r = createRenderer(createElement(RunStartSpecSheet, {
          block: resultBlock(
            { gate: 'run-start', runId: 'r1' },
            payloadText({ error: LIVE_CHANNEL_REFUSAL, gate: 'run-start', runId: 'r1' }),
          ),
          useSessions: sessionsHook,
        }))
      })
      text = textOf(r!.toJSON())
      const section = r!.root.find((n) => String((n.props as Record<string, unknown>).className ?? '') === 'rec-spec')
      readOnly = section.props['aria-readonly']
      await unmountSeat(r!)
    })
    // The refusal reaches the screen, verbatim, from the call's own result…
    expect(text).toContain(CALL_REFUSED_LEAD)
    expect(text).toContain(LIVE_CHANNEL_REFUSAL)
    // …and the question block the defect printed is GONE.
    expect(text).not.toContain('The question about this document is')
    expect(text).not.toContain(RUN_START_QUESTION)
    expect(text).not.toContain(RUN_START_OPTION_MEANING)
    // The region is still the read-only region, and the escape invariant is untouched.
    expect(readOnly).toBe('true')
    // ⚠ AND THE REFUSAL IS INDEPENDENT OF THE DOCUMENT'S FETCH. The route is not mounted in this fixture, so
    // the document never loads — and the refusal still renders, because it comes from the CALL rather than
    // from the file. That independence is the point: the gate refuses on the document's CONTENT, which this
    // panel cannot see until the route answers, so a sheet that waited for the fetch before saying "refused"
    // would leave the reader with an empty box and no explanation.
    expect(text).toContain('Reading the document')
    expect(text).toContain('No document text to show')
  })

  it('a DISPATCHED call with no result yet still renders the question through the registered seat', async () => {
    let r: ReturnType<typeof createRenderer> | undefined
    let text = ''
    await withEventSourceStub(async () => {
      await act(async () => {
        r = createRenderer(createElement(RunStartSpecSheet, { block: blockWithNoResult(), useSessions: sessionsHook }))
      })
      text = textOf(r!.toJSON())
      await unmountSeat(r!)
    })
    expect(text).toContain(RUN_START_QUESTION)
    expect(text).toContain(RUN_START_OPTION_MEANING)
    expect(text).not.toContain(CALL_REFUSED_LEAD)
  })
})

/* ---------------- 6. the seat is registered where the call renders ---------------- */

describe('the seat registers on the keyed tool-call seat', () => {
  it('slots.ts registers tool.call.toolview keyed by `recursive_ask`', async () => {
    const { registerSlots } = await import('../src/client/slots.ts')
    const entries: Array<{ name: string; key?: string; component: unknown }> = []
    const ctx = {
      slots: {
        inject: (_seat: string, factory: (c: unknown) => () => void) => { factory({}); return () => {} },
        register: (options: { name: string; key?: string }, component: unknown) => {
          entries.push({ name: options.name, key: options.key, component })
          return () => {}
        },
      },
      get: () => undefined,
      effect: () => () => {},
    }
    registerSlots(ctx as never)
    const seat = entries.filter((e) => e.name === 'tool.call.toolview')
    // Exactly one entry, and it is keyed by the tool's wire name: a typo here renders NOTHING at all.
    expect(seat.length).toBe(1)
    expect(seat[0].key).toBe(RUN_START_TOOL_NAME)
    // The component IS the sheet (not a wrapper that could quietly render something else).
    expect(seat[0].component).toBe(RunStartSpecSheet)
  })
})

/* ---------------- 7. the sheet does not depend on the board's projection ---------------- */

describe('the sheet reads the document, not the board', () => {
  it('the projection type it never consumes still has nothing to do with the rendered text', () => {
    // A guard against a future "optimisation" that renders facts about the run instead of the document: the
    // sheet's input is the TEXT, and a card with a rich projection cannot put a single character on screen.
    const card: RecursiveRunCard = {
      runId: 'r1',
      worktreeRoot: '/ws',
      phases: { '00-requirements.md': { phase: '00-requirements.md', status: 'LOCKED', position: 'locked' } },
      state: 'active',
      tampers: {},
      subagents: {},
    }
    const model = specSheetModel({
      args: { gate: 'run-start', runId: card.runId, artifact: null, answer: null },
      root: '/ws',
      fetch: { state: 'loading' },
    })
    const r = createRenderer(createElement(RunStartSpecSheetBody, { model }))
    expect(textOf(r.toJSON())).not.toContain('LOCKED')
    expect(textOf(r.toJSON())).not.toContain('active')
    r.unmount()
  })

  it('the gate the sheet quotes is the gate the server defines', () => {
    // The sheet paraphrases the question and the option meanings for the reader; both must stay the gate's.
    const model = specSheetModel({
      args: { gate: 'run-start', runId: 'r1', artifact: null, answer: null },
      root: '/ws',
      fetch: { state: 'loaded', text: writtenDoc() },
    })
    const r = createRenderer(createElement(RunStartSpecSheetBody, { model }))
    const text = textOf(r.toJSON())
    expect(text).toContain(RUN_START_GATE.question)
    for (const option of RUN_START_GATE.options) expect(text).toContain(option.label)
    r.unmount()
  })
})
