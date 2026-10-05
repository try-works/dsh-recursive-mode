/**
 * T23 — the three human gates as structured decisions.
 *
 * The RED's clauses are the cases below: an over-length header or label is refused WITH THE FIELD
 * PATH, a second ask in one step is refused, and an accepted answer becomes a durable marker string
 * that can be written into the artifact. Plus the direction that is easy to forget: an answer that
 * is NOT one of the offered options is refused rather than recorded, because a marker saying
 * `TDD Mode: maybe` would look like a decision and be a transcription error.
 */
import { describe, it, expect } from 'vitest'
import {
  ASK_GATES, ASK_GATE_IDS, buildAskQuestion, validateAskQuestion, validateAskAnswer, answerMarker,
  createAskLedger, AskValidationError, MAX_HEADER_CHARS, MAX_LABEL_CHARS,
} from '../src/recursive_ask.tool.ts'

describe('T23 — the three gates exist as data, not prose', () => {
  it('covers exactly the three points the item names', () => {
    expect([...ASK_GATE_IDS]).toEqual(['tdd-mode', 'qa-signoff', 'gate-block'])
    expect(ASK_GATES['tdd-mode'].marker).toBe('TDD Mode')
    expect(ASK_GATES['qa-signoff'].marker).toBe('QA Execution Mode')
  })

  it('offers the options the workflow actually accepts', () => {
    // strict|pragmatic is the exact vocabulary phase 3 locks against.
    expect(ASK_GATES['tdd-mode'].options.map((option) => option.label)).toEqual(['strict', 'pragmatic'])
    expect(ASK_GATES['qa-signoff'].options.map((option) => option.label)).toEqual(['human', 'agent-operated', 'hybrid'])
  })

  it('every built question passes its own validation', () => {
    for (const id of ASK_GATE_IDS) {
      const question = buildAskQuestion(id)
      expect(question.id).toBe(id)
      expect(question.options.length).toBeGreaterThan(0)
      expect(() => validateAskQuestion(question)).not.toThrow()
    }
  })
})

describe('T23 — a malformed request is refused WITH ITS FIELD PATH', () => {
  it('names the over-length HEADER', () => {
    const question = buildAskQuestion('tdd-mode')
    const tooLong = { ...question, header: 'x'.repeat(MAX_HEADER_CHARS + 1) }
    expect(() => validateAskQuestion(tooLong)).toThrow(AskValidationError)
    try {
      validateAskQuestion(tooLong)
    } catch (err) {
      // A bare "too long" for a request with four fields is a puzzle, not a diagnostic.
      expect((err as AskValidationError).field).toBe('header')
      expect((err as Error).message).toContain('header')
      expect((err as Error).message).toContain(String(MAX_HEADER_CHARS))
    }
  })

  it('names the over-length LABEL, with its INDEX', () => {
    const question = buildAskQuestion('qa-signoff')
    const bad = { ...question, options: [question.options[0], { label: 'y'.repeat(MAX_LABEL_CHARS + 1) }] }
    try {
      validateAskQuestion(bad)
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as AskValidationError).field).toBe('options[1].label')
    }
  })

  it('refuses an empty header, an empty question, and no options', () => {
    const question = buildAskQuestion('gate-block')
    expect((() => { try { validateAskQuestion({ ...question, header: '  ' }) } catch (e) { return (e as AskValidationError).field } })()).toBe('header')
    expect((() => { try { validateAskQuestion({ ...question, question: '' }) } catch (e) { return (e as AskValidationError).field } })()).toBe('question')
    expect((() => { try { validateAskQuestion({ ...question, options: [] }) } catch (e) { return (e as AskValidationError).field } })()).toBe('options')
  })

  it('refuses an ANSWER that is not one of the offered labels', () => {
    // A marker saying `TDD Mode: maybe` would look like a decision and be a transcription error.
    expect(validateAskAnswer('tdd-mode', 'strict')).toBe('strict')
    expect(() => validateAskAnswer('tdd-mode', 'maybe')).toThrow(/must be one of strict \| pragmatic/)
  })
})

describe('T23 — one ask per step', () => {
  it('accepts the first ask and REFUSES a second in the same step', () => {
    const ledger = createAskLedger()
    ledger.claim('tdd-mode')
    expect(ledger.asked()).toEqual(['tdd-mode'])
    // Two cards for one decision means the second answer silently wins.
    expect(() => ledger.claim('qa-signoff')).toThrow(/already asked tdd-mode/)
    expect(() => ledger.claim('tdd-mode')).toThrow(/already asked in this step/)
    // The refused claims did not mutate the ledger.
    expect(ledger.asked()).toEqual(['tdd-mode'])
  })
})

describe('T23 — an accepted answer becomes a durable marker', () => {
  it('renders the artifact line the workflow can read back', () => {
    expect(answerMarker('tdd-mode', 'strict')).toBe('- TDD Mode: strict')
    expect(answerMarker('qa-signoff', 'hybrid')).toBe('- QA Execution Mode: hybrid')
    expect(answerMarker('gate-block', 'reopen')).toBe('- Gate Resolution: reopen')
  })

  it('uses the SAME marker name the gate declares, so the write-back cannot drift', () => {
    for (const id of ASK_GATE_IDS) {
      const marker = answerMarker(id, ASK_GATES[id].options[0].label)
      expect(marker).toContain(ASK_GATES[id].marker)
    }
  })
})
