/**
 * T36 — the settlement observer: recognise the delivered event, never read history.
 *
 * The design constraint under test is the DSH prohibition on new production
 * synchronous session-history reads, so this module's whole contract is that it
 * works from the DELIVERED event plus the run's own file state. Nothing here
 * looks backwards through a session log, and the tests assert the observable
 * consequences of that: a settlement is recognised from one event, recorded once,
 * and read back from the run directory.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  settlementFromEvent,
  recordSettlement,
  readSettlements,
  readSettlement,
  settlementResult,
  settlementRoundObserver,
  settlementLogPath,
  captureSettlement,
  type SessionEventLike,
} from '../src/settlement.ts'

const CHILD = 'child-abc'

/** The harness's settlement notice, as it is delivered to a `session/event` listener. */
function settlementEvent(over: { childId?: string; summary?: string; closing?: string[]; id?: string } = {}): SessionEventLike {
  const closing = over.closing ?? ['{"verdict":"APPROVE"}']
  return {
    type: 'user/message',
    data: {
      id: over.id ?? 'm1',
      content: [
        { type: 'text', text: over.summary ?? 'Background subagent ' + CHILD + ' finished and will do no further work unless you send it more.' },
        { type: 'text', text: 'Its closing message:' },
        ...closing.map((text) => ({ type: 'text', text })),
      ],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: over.summary ?? 'Background subagent ' + CHILD + ' finished and will do no further work unless you send it more.',
        senderSessionId: over.childId ?? CHILD,
      },
    },
  }
}

function runRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-settle-'))
  mkdirSync(join(root, '.recursive', 'run', 'r1'), { recursive: true })
  return join(root, '.recursive', 'run', 'r1')
}

describe('T36 — recognising a settlement from the delivered event', () => {
  it('ignores every event that is not a settlement (it is wired to ALL events)', () => {
    expect(settlementFromEvent({ type: 'turn/start', data: { turn: 1 } })).toBeNull()
    expect(settlementFromEvent({ type: 'user/message', data: { content: [], source: { kind: 'human' } } })).toBeNull()
    expect(settlementFromEvent({ type: 'user/message', data: {} })).toBeNull()
    expect(settlementFromEvent({})).toBeNull()
  })

  it('names the child, the reason, and the child\'s own closing text', () => {
    const notice = settlementFromEvent(settlementEvent())!
    expect(notice.childId).toBe(CHILD)
    expect(notice.summary).toContain('finished')
    expect(notice.closingText).toBe('{"verdict":"APPROVE"}')
    expect(notice.messageId).toBe('m1')
  })

  it('keeps a multi-block closing message intact', () => {
    const notice = settlementFromEvent(settlementEvent({ closing: ['line one', 'line two'] }))!
    expect(notice.closingText).toBe('line one\n\nline two')
  })

  it('a child that left nothing yields no closing text rather than a fabricated one', () => {
    // The SOURCE summary is authoritative (the harness writes it); the content is
    // the rendered form. Both must agree, so the fixture sets both.
    const summary = 'Background subagent ' + CHILD + ' failed before it finished.'
    const event = settlementEvent({ summary })
    const data = event.data as { content: unknown[] }
    data.content = [
      { type: 'text', text: summary },
      { type: 'text', text: 'It left no closing message.' },
    ]
    const notice = settlementFromEvent(event)!
    expect(notice.closingText).toBe('')
    expect(notice.summary).toContain('failed')
  })
})

describe('T36 — the settlement is recorded in the run\'s own state', () => {
  it('records and reads back per child, latest wins', () => {
    const runDir = runRoot()
    try {
      recordSettlement(runDir, { childId: CHILD, summary: 'round 1', closingText: '' })
      recordSettlement(runDir, { childId: 'other', summary: 'unrelated', closingText: '' })
      recordSettlement(runDir, { childId: CHILD, summary: 'round 2', closingText: 'ok' })
      expect(readSettlement(runDir, CHILD)!.summary).toBe('round 2')
      expect(readSettlement(runDir, 'other')!.summary).toBe('unrelated')
      expect(readSettlement(runDir, 'never-seen')).toBeNull()
      expect(readSettlements(runDir)).toHaveLength(3)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('is APPEND-ONLY: recording does not rewrite earlier rounds', () => {
    const runDir = runRoot()
    try {
      recordSettlement(runDir, { childId: CHILD, summary: 'first', closingText: '' })
      const afterFirst = readSettlements(runDir)
      recordSettlement(runDir, { childId: CHILD, summary: 'second', closingText: '' })
      expect(readSettlements(runDir).slice(0, afterFirst.length)).toEqual(afterFirst)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('a malformed line does not make the run unobservable', () => {
    const runDir = runRoot()
    try {
      recordSettlement(runDir, { childId: CHILD, summary: 'good', closingText: '' })
      writeFileSync(settlementLogPath(runDir), 'not json\n{"childId":"x"}\n', 'utf8')
      expect(readSettlements(runDir)).toEqual([])
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('captureSettlement records ONLY settlements, and reports what it took', () => {
    const runDir = runRoot()
    try {
      expect(captureSettlement(runDir, { type: 'turn/start', data: {} })).toBeNull()
      expect(readSettlements(runDir)).toEqual([])
      const taken = captureSettlement(runDir, settlementEvent())
      expect(taken?.childId).toBe(CHILD)
      expect(readSettlements(runDir)).toHaveLength(1)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})

describe('T36 — the observer parks instead of blocking, and never fabricates approval', () => {
  it('returns null while no settlement has landed (the loop\'s "not yet" signal)', async () => {
    const runDir = runRoot()
    try {
      const observe = settlementRoundObserver(runDir)
      expect(await observe(CHILD, 'm1')).toBeNull()
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('reports the settlement once it lands, and the child stays addressable', async () => {
    const runDir = runRoot()
    try {
      captureSettlement(runDir, settlementEvent())
      const observe = settlementRoundObserver(runDir)
      const first = await observe(CHILD, 'm1')
      expect(first).not.toBeNull()
      // The child id is stable across rounds, so a LATER followup can reach it.
      const again = await observe(CHILD, 'm2')
      expect(again).not.toBeNull()
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('does NOT assert success from the summary — acceptance stays the verdict\'s job', () => {
    // A notice reports how the child's turn ENDED, not whether its work passes.
    // Defaulting `success` here would let a stopped child read as a passing review.
    const stopped = settlementResult({ childId: CHILD, summary: 'Background subagent X was stopped before it finished.', closingText: '' })
    expect((stopped as { success?: boolean }).success).not.toBe(true)
    const failed = settlementResult({ childId: CHILD, summary: 'Background subagent X failed before it finished.', closingText: '' })
    expect((failed as { success?: boolean }).success).not.toBe(true)
  })

  it('surfaces structured output when the child reported JSON', () => {
    const result = settlementResult({ childId: CHILD, summary: 'done', closingText: '{"verdict":"REVISE","findings":[]}' })
    expect((result as { structured?: { verdict?: string } }).structured?.verdict).toBe('REVISE')
  })

  it('leaves structured undefined for prose, so the verdict reader sees no fake verdict', () => {
    const result = settlementResult({ childId: CHILD, summary: 'done', closingText: 'I could not finish this.' })
    expect((result as { structured?: unknown }).structured).toBeUndefined()
  })
})
