/**
 * T36 — reading a verdict out of a child's `reply.md`, FAILING CLOSED.
 *
 * THE BUG THIS PREVENTS. `readVerdictFromStructured` returns `APPROVE` when a
 * result carries no structured verdict — a defensible default where the caller
 * re-evaluates the result, and the WRONG one for a review round. A settlement's
 * closing text is free-form: a child may answer in prose, answer a different
 * question, or write nothing parseable, and under the structured reader every one
 * of those would read as approval. Verification that fails open is not
 * verification, so this reader knows exactly three shapes and reports a problem
 * for everything else — which the caller turns into a REVISE with an instruction
 * that says what was missing.
 */
import { describe, it, expect } from 'vitest'
import { parseReplyVerdict, readVerdictFromReply, readRepairFromReply } from '../src/delegation.ts'

describe('T36 — the reply verdict reader accepts the three declared shapes', () => {
  it('reads review-schema JSON from a fenced block', () => {
    const reply = [
      '# Review',
      '',
      'I looked at the implementation.',
      '',
      '```json',
      '{"verdict":"REVISE","findings":[{"severity":"high","title":"the retry has no backoff"}]}',
      '```',
    ].join('\n')
    const parsed = parseReplyVerdict(reply)
    expect(parsed.verdict).toBe('REVISE')
    expect(parsed.findings).toEqual(['the retry has no backoff'])
    expect(parsed.problem).toBeNull()
  })

  it('reads a BARE JSON object, so an unfenced submission still counts', () => {
    expect(parseReplyVerdict('{"verdict":"APPROVE","findings":[]}').verdict).toBe('APPROVE')
  })

  it('reads an explicit Verdict: field, however a child decorates it', () => {
    expect(parseReplyVerdict('Verdict: APPROVE').verdict).toBe('APPROVE')
    expect(parseReplyVerdict('**Verdict:** `REVISE`').verdict).toBe('REVISE')
    expect(parseReplyVerdict('- verdict = REJECT').verdict).toBe('REJECT')
    expect(parseReplyVerdict('verdict: approve').verdict).toBe('APPROVE')
  })

  it('a fenced block wins over prose that merely mentions a word', () => {
    const reply = 'I will not approve this as-is.\n\n```json\n{"verdict":"REJECT","findings":[]}\n```\n'
    expect(parseReplyVerdict(reply).verdict).toBe('REJECT')
  })
})

describe('T36 — everything else is a PROBLEM, never an approval', () => {
  it('an empty reply names the problem', () => {
    const parsed = parseReplyVerdict('')
    expect(parsed.verdict).toBeNull()
    expect(parsed.problem).toContain('empty')
  })

  it('prose with no verdict names the problem', () => {
    const parsed = parseReplyVerdict('I looked at it and it seems fine to me.')
    expect(parsed.verdict).toBeNull()
    expect(parsed.problem).toContain('no verdict')
  })

  it('JSON WITHOUT a verdict field is a problem, not a pass', () => {
    const parsed = parseReplyVerdict('```json\n{"findings":[{"title":"x"}]}\n```')
    expect(parsed.verdict).toBeNull()
    expect(parsed.problem).toContain('no usable "verdict" field')
  })

  it('an OUT-OF-VOCABULARY verdict is a problem that quotes what it saw', () => {
    expect(parseReplyVerdict('Verdict: LGTM').problem).toContain('LGTM')
    expect(parseReplyVerdict('{"verdict":"LGTM"}').problem).toContain('no usable "verdict" field')
  })

  it('NEVER yields APPROVE for anything unreadable (the property that matters)', () => {
    const unreadable = [
      '', '   ', 'looks good', 'no opinion', '{"findings":[]}', '{"verdict":"LGTM"}',
      'Verdict: MAYBE', '```json\nnot json at all\n```', 'I approve of the approach in principle',
      'verdict', '{"verdict":null}',
    ]
    for (const text of unreadable) {
      expect(readVerdictFromReply(text), 'input: ' + JSON.stringify(text)).not.toBe('APPROVE')
      expect(readVerdictFromReply(text)).toBe('REVISE')
    }
  })

  it('reads an APPROVE only when one is actually stated', () => {
    expect(readVerdictFromReply('{"verdict":"APPROVE"}')).toBe('APPROVE')
    expect(readVerdictFromReply('Verdict: APPROVE')).toBe('APPROVE')
  })
})

describe('T36 — a repair instruction that can be acted on', () => {
  it('quotes the findings when the reply carried them', () => {
    const reply = '{"verdict":"REVISE","findings":[{"title":"no backoff"},{"title":"no timeout"}]}'
    expect(readRepairFromReply(reply)).toBe('Address the findings: no backoff; no timeout')
  })

  it('states the CONTRACT VIOLATION when there was nothing to quote', () => {
    // "please improve" cannot be acted on; naming the missing contract can.
    const repair = readRepairFromReply('it seems fine')
    expect(repair).toContain('reply.md')
    expect(repair).toContain('no verdict')
    expect(repair).toContain('APPROVE')
  })

  it('falls back to the generic revise line for a stated REVISE with no findings', () => {
    expect(readRepairFromReply('Verdict: REVISE')).toContain('address the review findings')
  })
})
