/**
 * T33 — the lint section parsers cannot read a document's FINAL section.
 *
 * `getHeadingBody` (`ts-lint.ts:137`) and `getSubheadingBody` (`:145`) end their
 * lazy capture with the lookahead `(?=^[ \t]*##\s+|\Z)`. That `\Z` was carried
 * over from the canonical PYTHON implementation, where it means *absolute end of
 * string*. **In JavaScript `\Z` is an unrecognised escape and degrades to an
 * identity escape, so it matches a literal `Z` character** — verified below.
 *
 * Three consequences, all of which these tests pin:
 *   1. A body is TRUNCATED at its first literal `Z`. Any section carrying an ISO
 *      timestamp (`…T08:21:53Z`) loses everything after it. This is why the
 *      action-record writer had to place `Timestamp` last in `## Metadata`.
 *   2. A document's FINAL section reads as `''`, because the only lookahead that
 *      could terminate the capture can never match. A trailing newline does not
 *      help; only another heading after it does.
 *   3. The final SUB-heading of a section is likewise unreadable, because a
 *      section body produced by `getHeadingBody` has no following `##` inside it.
 *
 * Why it matters beyond tidiness: consequence 3 makes `### Reviewed` invisible to
 * `lintSubagentActionRecordFile`, so `claimedFileRefs.size === 0` and a record
 * whose only file impact is "Reviewed" — i.e. a READ-ONLY REVIEW delegation, this
 * plugin's primary delegation use case — can NEVER satisfy the repo's own linter,
 * however correct the writer is. That is pinned separately (and deliberately
 * `it.fails`) in `tests/docs-contract.spec.ts`; this file tests the parser itself.
 */
import { describe, it, expect } from 'vitest'
import { getHeadingBody, getSubheadingBody } from '../src/ts-lint.ts'

describe('T33 — the `\\Z` anchor is a literal Z in JavaScript', () => {
  it('does NOT match end-of-input, and DOES match a literal Z', () => {
    // Pinning the language behaviour the port got wrong. If a future engine made
    // `\Z` an end-of-input assertion, these two would flip and the fix below
    // (an explicit `(?![\s\S])`) would still be correct — so this test documents
    // the trap rather than depending on it.
    const re = new RegExp('(?=^[ \\t]*##\\s+|\\Z)', 'ms')
    expect(re.test('nothing here at all')).toBe(false)
    expect(re.test('a Z here')).toBe(true)
  })
})

describe('T33 — getHeadingBody', () => {
  it('reads a body followed by another heading', () => {
    const doc = ['## First', 'body one', '## Second', 'body two'].join('\n')
    expect(getHeadingBody(doc, 'First')).toBe('body one')
  })

  it('reads the FINAL heading of the document', () => {
    const doc = ['## First', 'body one', '## Last', 'body two'].join('\n')
    expect(getHeadingBody(doc, 'Last')).toBe('body two')
  })

  it('reads the final heading even with a trailing newline', () => {
    const doc = ['## First', 'body one', '## Last', 'body two', ''].join('\n')
    expect(getHeadingBody(doc, 'Last')).toBe('body two')
  })

  it('does NOT truncate a body at a literal Z — the ISO-timestamp case', () => {
    const doc = [
      '## Metadata',
      '- Timestamp: 2026-01-01T00:00:00Z',
      '- After: must survive',
      '## Next',
      'x',
    ].join('\n')
    expect(getHeadingBody(doc, 'Metadata')).toBe('- Timestamp: 2026-01-01T00:00:00Z\n- After: must survive')
  })

  it('does NOT truncate a FINAL body at a literal Z', () => {
    const doc = ['## First', 'x', '## Last', '- Timestamp: 2026-01-01T00:00:00Z', '- After: keep'].join('\n')
    expect(getHeadingBody(doc, 'Last')).toBe('- Timestamp: 2026-01-01T00:00:00Z\n- After: keep')
  })

  it('still returns empty for a genuinely absent heading', () => {
    expect(getHeadingBody('## First\nbody one\n', 'Nope')).toBe('')
  })

  it('reads only its own body, not the rest of the document', () => {
    const doc = ['## A', 'a-body', '## B', 'b-body', '## C', 'c-body'].join('\n')
    expect(getHeadingBody(doc, 'B')).toBe('b-body')
  })
})

describe('T33 — getSubheadingBody', () => {
  it('reads a sub-heading followed by another sub-heading', () => {
    const section = ['### Created', '- none', '### Modified', '- `a/b.md`'].join('\n')
    expect(getSubheadingBody(section, 'Created')).toBe('- none')
  })

  it('reads the FINAL sub-heading of a section', () => {
    const section = ['### Created', '- none', '### Modified', '- none', '### Reviewed', '- `a/b.md`'].join('\n')
    expect(getSubheadingBody(section, 'Reviewed')).toBe('- `a/b.md`')
  })

  it('reads a final sub-heading whose body holds a literal Z', () => {
    const section = ['### Read', '- none', '### Touched', '- `2026-01-01T00:00:00Z.md`'].join('\n')
    expect(getSubheadingBody(section, 'Touched')).toBe('- `2026-01-01T00:00:00Z.md`')
  })

  it('reads a `- none` body as `- none` rather than empty', () => {
    const section = ['### Created', '- none', '### Modified', '- none'].join('\n')
    expect(getSubheadingBody(section, 'Modified')).toBe('- none')
  })

  it('still returns empty for a genuinely absent sub-heading', () => {
    expect(getSubheadingBody('### Created\n- none\n', 'Reviewed')).toBe('')
  })

  it('honours the level argument', () => {
    const doc = ['#### Deep', 'deep body', '#### Deep2', 'x'].join('\n')
    expect(getSubheadingBody(doc, 'Deep', 4)).toBe('deep body')
  })
})
