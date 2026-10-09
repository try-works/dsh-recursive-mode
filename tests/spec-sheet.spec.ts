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
  RUN_START_SPEC_FILE,
  RUN_START_TOOL_NAME,
  decisionLine,
  parseRecursiveAskArgs,
  resolveSpecRoot,
  specPath,
  specSheetModel,
  UNFILLED_NOTICE,
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
