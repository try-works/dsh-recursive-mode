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
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
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

/**
 * T23 — THE REGISTERED TOOL, exercised through `ctx.tools.execute`.
 *
 * The acceptance has two halves — *"the three human gates render as cards, and their answers land in
 * the artifact"* — and both are asserted here on the REAL tool: the ask returns the validated
 * question the host renders, and the answered call writes the marker into the run's artifact.
 */
describe('T23 — the tool is registered and both branches work end to end', () => {
  async function mount() {
    const repo = mkdtempSync(join(tmpdir(), 'rm-ask-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin as never, { repoRoot: repo } as never)
    await ctx.recursive.initRun('r1')
    return {
      ctx,
      repo,
      call: (args: Record<string, unknown>) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('ask-1'),
        name: 'recursive_ask',
        arguments: args,
        agent: { session: { header: { cwd: repo } } },
      } as never),
      dispose: async () => {
        await ctx.fiber.dispose()
        rmSync(repo, { recursive: true, force: true })
      },
    }
  }

  it('is REGISTERED — the call below is only reachable if it is', async () => {
    // `ctx.tools.list()` is not on the runtime's surface, so registration is proven the way a caller
    // proves it: by CALLING the tool. An unknown name would fail rather than return a question.
    const m = await mount()
    try {
      const text = JSON.stringify(await m.call({ gate: 'qa-signoff', runId: 'r1' }))
      expect(text).toContain('QA sign-off')
    } finally {
      await m.dispose()
    }
  })

  it('ASKING returns the card-ready question, with the gate’s options and marker', async () => {
    const m = await mount()
    try {
      const text = JSON.stringify(await m.call({ gate: 'tdd-mode', runId: 'r1' }))
      expect(text).toContain('TDD Mode')
      expect(text).toContain('strict')
      expect(text).toContain('pragmatic')
      expect(text).toContain('03-implementation-summary.md')
    } finally {
      await m.dispose()
    }
  })

  it('ANSWERING lands the marker in the artifact, and a SECOND answer replaces it', async () => {
    const m = await mount()
    try {
      await m.call({ gate: 'tdd-mode', runId: 'r1', answer: 'strict' })
      const artifact = join(m.repo, '.recursive', 'run', 'r1', '03-implementation-summary.md')
      expect(readFileSync(artifact, 'utf8')).toContain('- TDD Mode: strict')

      // Changed mind: the second answer REPLACES — two markers would leave two answers to one
      // question and make "what was decided?" depend on which line a reader found first.
      const second = JSON.stringify(await m.call({ gate: 'tdd-mode', runId: 'r1', answer: 'pragmatic' }))
      expect(second).toContain('"replaced":true')
      const content = readFileSync(artifact, 'utf8')
      expect(content).toContain('- TDD Mode: pragmatic')
      expect(content).not.toContain('- TDD Mode: strict')
    } finally {
      await m.dispose()
    }
  })

  it('REFUSES an unoffered answer through the tool, with the offered labels', async () => {
    const m = await mount()
    try {
      const text = JSON.stringify(await m.call({ gate: 'tdd-mode', runId: 'r1', answer: 'maybe' }))
      expect(text).toContain('RM1142')
      expect(text).toContain('strict')
    } finally {
      await m.dispose()
    }
  })
})
