/**
 * RED spec for the per-phase run-doc viewer (0.2.4): the pure markdown line
 * parser (parseDoc — parsePlan base + fenced code + tables) and the inline
 * segment scanner (parseInline — bold / code spans / links), both exported from
 * src/client/doc-viewer.tsx.
 *
 * parsePlan + vim/search logic are ported from @guillaumemeyer/dsh-plan-approval
 * (MIT) — see the attribution header in doc-viewer.tsx.
 */
import { describe, it, expect } from 'vitest'
import { parseDoc, parseInline } from '../src/client/doc-viewer.tsx'

describe('parseDoc — markdown line tokens (parsePlan base + enhanced)', () => {
  it('produces blank/h1-h4/li/plain tokens (parsePlan base)', () => {
    const lines = parseDoc('# H1\n## H2\n### H3\n#### H4\n- bullet one\n- bullet two\nplain text\n\n')
    expect(lines).toEqual([
      { kind: 'h1', text: 'H1' },
      { kind: 'h2', text: 'H2' },
      { kind: 'h3', text: 'H3' },
      { kind: 'h4', text: 'H4' },
      { kind: 'li', text: 'bullet one' },
      { kind: 'li', text: 'bullet two' },
      { kind: 'plain', text: 'plain text' },
      { kind: 'blank', text: '' },
      { kind: 'blank', text: '' },
    ])
  })

  it('groups a fenced code block into one code line', () => {
    const lines = parseDoc('before\n```ts\nconst a = 1\nconst b = 2\n```\nafter')
    expect(lines.find((l) => l.kind === 'code')).toBeTruthy()
    const code = lines.find((l) => l.kind === 'code')!
    expect(code.text).toContain('const a = 1')
    expect(code.text).toContain('const b = 2')
    expect(lines[0].kind).toBe('plain')
    expect(lines[lines.length - 1].kind).toBe('plain')
  })

  it('parses a small table into header + rows (separator row dropped)', () => {
    const lines = parseDoc('| Phase | Status |\n| --- | --- |\n| 00 | LOCKED |\n| 01 | DRAFT |')
    const table = lines.find((l) => l.kind === 'table')
    expect(table).toBeTruthy()
    const cells = table!.cells!
    expect(cells.length).toBe(3)
    expect(cells[0]).toEqual(['Phase', 'Status'])
    expect(cells[1]).toEqual(['00', 'LOCKED'])
    expect(cells[2]).toEqual(['01', 'DRAFT'])
  })
})

describe('parseInline — bold / code / links', () => {
  it('splits bold, code span, and link out of plain text', () => {
    const segs = parseInline('Run **status** is `LOCKED` in [phase 3](https://example.com) today')
    expect(segs).toEqual([
      { type: 'text', text: 'Run ' },
      { type: 'bold', text: 'status' },
      { type: 'text', text: ' is ' },
      { type: 'code', text: 'LOCKED' },
      { type: 'text', text: ' in ' },
      { type: 'link', text: 'phase 3', href: 'https://example.com' },
      { type: 'text', text: ' today' },
    ])
  })

  it('treats unmatched markers as plain text', () => {
    const segs = parseInline('no **closing and no `code and [link](')
    expect(segs.every((s) => s.type === 'text')).toBe(true)
  })
})