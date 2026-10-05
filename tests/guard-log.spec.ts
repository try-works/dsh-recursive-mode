/**
 * T15 (D) — the rolling guard-decision log's own contract.
 *
 * `tests/guard-path.spec.ts` proves the LIVE path writes and reads decisions.
 * This file pins the three properties that spec does not reach, because they are
 * what make a file-backed evidence trace safe to run inside a guard:
 *   1. newest-first ordering (a caller reading `[0]` gets the last decision);
 *   2. BOUNDED growth (the file is rewritten to the newest GUARD_LOG_MAX_RECORDS);
 *   3. never throws — a missing/blocked/torn log degrades to "no evidence".
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUARD_LOG_MAX_RECORDS,
  appendGuardDecision,
  appendObservedTamper,
  guardDecisionLogPath,
  observedTamperLogPath,
  readGuardDecisions,
  readObservedTampers,
  type GuardDecisionRecord,
} from '../src/guard-log.ts'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'rm-guardlog-'))
}

function decision(tool: string, extra: Partial<GuardDecisionRecord> = {}): GuardDecisionRecord {
  return { at: '2026-01-01T00:00:00Z', runId: 'r1', tool, kind: 'allow', rule: 'none', ...extra }
}

describe('guard-log.ts — the T15 evidence trace', () => {
  it('lives under .recursive/config/ and creates the dir on first append', () => {
    const root = tmpRoot()
    try {
      expect(guardDecisionLogPath(root)).toBe(join(root, '.recursive', 'config', 'guard-decisions.jsonl'))
      expect(observedTamperLogPath(root)).toBe(join(root, '.recursive', 'config', 'observed-tampers.jsonl'))
      expect(readGuardDecisions(root, 5)).toEqual([])
      appendGuardDecision(root, decision('recursive_lock'))
      expect(readGuardDecisions(root, 5)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads newest first and round-trips rule/reason/transition', () => {
    const root = tmpRoot()
    try {
      appendGuardDecision(root, decision('first'))
      appendGuardDecision(root, decision('second', {
        kind: 'deny',
        rule: 'lock-order',
        reason: 'monotonic lock-order: 00-requirements.md (DRAFT)',
        transition: { passed: false, failures: ['no ## Effective Inputs Re-read'] },
      }))
      const records = readGuardDecisions(root, 5)
      expect(records.map(r => r.tool)).toEqual(['second', 'first'])
      expect(records[0].rule).toBe('lock-order')
      expect(records[0].reason).toContain('monotonic lock-order')
      expect(records[0].transition?.failures).toHaveLength(1)
      // `limit` keeps the NEWEST n, still newest first.
      expect(readGuardDecisions(root, 1).map(r => r.tool)).toEqual(['second'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is bounded: over the cap it keeps only the newest records', () => {
    const root = tmpRoot()
    try {
      for (let i = 0; i < GUARD_LOG_MAX_RECORDS + 5; i += 1) appendGuardDecision(root, decision('tool-' + i))
      const all = readGuardDecisions(root, GUARD_LOG_MAX_RECORDS + 100)
      expect(all).toHaveLength(GUARD_LOG_MAX_RECORDS)
      expect(all[0].tool).toBe('tool-' + (GUARD_LOG_MAX_RECORDS + 4))
      expect(all[all.length - 1].tool).toBe('tool-5')
      const lines = readFileSync(guardDecisionLogPath(root), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(GUARD_LOG_MAX_RECORDS)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never throws and never invents records: empty root, blocked root, torn line', () => {
    const root = tmpRoot()
    try {
      // An empty root must be a no-op, not a write into process.cwd().
      expect(() => appendGuardDecision('', decision('x'))).not.toThrow()
      expect(readGuardDecisions('', 5)).toEqual([])
      // A root that is a FILE cannot host the config dir: degrade, never throw.
      const blocked = join(root, 'blocked')
      writeFileSync(blocked, 'not a directory', 'utf8')
      expect(() => appendGuardDecision(blocked, decision('x'))).not.toThrow()
      expect(readGuardDecisions(blocked, 5)).toEqual([])
      // A torn/partial trailing line is skipped, the good records survive.
      appendGuardDecision(root, decision('good'))
      appendFileSync(guardDecisionLogPath(root), '{"at":"2026', 'utf8')
      expect(readGuardDecisions(root, 5).map(r => r.tool)).toEqual(['good'])
      // The tamper log is independent of the decision log.
      expect(readObservedTampers(root, 5)).toEqual([])
      appendObservedTamper(root, { at: '2026-01-01T00:00:00Z', runId: 'r1', path: '/w/x.md', reason: 'tampered' })
      expect(readObservedTampers(root, 5)).toHaveLength(1)
      expect(readGuardDecisions(root, 5)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
