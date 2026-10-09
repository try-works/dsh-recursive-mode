/**
 * guard-log.ts — T15: the rolling enforcement evidence trace.
 *
 * WHY A FILE, and not one of the two obvious alternatives (plan §4.0):
 *   - NOT `ctx.session` events: the plugin is ZERO-EMISSION by contract
 *     (tests/no-emission.spec.ts). Appending session events to record that a
 *     guard fired would break the plugin's central invariant.
 *   - NOT `ctx.storageDomain`: this is evidence a human reads (why was this lock
 *     refused?) and it must survive a restart and an out-of-band `cat`. It is
 *     append-only, bounded, git-ignored, and derived-from-nothing — the
 *     control-plane config dir is exactly where the plan puts it.
 *
 * Every function here is BEST-EFFORT and never throws: the writers run inside a
 * `tools/pre-execute` guard and inside the synchronous, observe-only
 * `fs/observed` event, whose contract explicitly forbids throwing. A failed log
 * write must never change an enforcement verdict or break a session.
 *
 * The log is BOUNDED: once it exceeds GUARD_LOG_MAX_RECORDS it is rewritten with
 * only the newest records. A bounded log is the whole posture — evidence that
 * cannot grow without bound.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GuardRule } from './enforcement.ts'
import type { GateBlockAsk } from './recursive_ask.tool.ts'

/**
 * One logged guard decision (the JSONL record shape the board/tests read).
 * `rule` is always set (the guard's own machine-readable reason for the
 * verdict); `transition` is present whenever the transition gate was consulted.
 *
 * FU-7: a REFUSAL that a person has to resolve also carries `ask` — the gate-block decision, in the
 * same shape `recursive_lock` attaches to its own refusal. It is recorded because the log is where
 * "why was this lock refused?" is answered, and the options are the other half of that answer; a
 * caller (or a board) reading the trace can act on the refusal without parsing the sentence.
 */
export interface GuardDecisionRecord {
  at: string
  runId: string
  tool: string
  kind: 'allow' | 'deny' | 'ask'
  rule: GuardRule
  reason?: string
  transition?: { passed: boolean; failures: string[] }
  ask?: GateBlockAsk
}

/** One logged observed-write tamper (a LOCKED artifact whose hash no longer matches). */
export interface ObservedTamperRecord {
  at: string
  runId: string
  path: string
  reason: string
}

/** Newest-N retention cap for both logs (rewrite-on-exceed, never unbounded). */
export const GUARD_LOG_MAX_RECORDS = 500

/** The rolling decision log path under the control-plane root. */
export function guardDecisionLogPath(root: string): string {
  return join(root, '.recursive', 'config', 'guard-decisions.jsonl')
}

/** The rolling observed-tamper log path under the control-plane root. */
export function observedTamperLogPath(root: string): string {
  return join(root, '.recursive', 'config', 'observed-tampers.jsonl')
}

/** Parse a JSONL file, skipping torn/partial/failed lines. Never throws. */
function readRecords<T>(path: string): T[] {
  try {
    if (!existsSync(path)) return []
    const out: T[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as T)
      } catch {
        // A torn final line (concurrent writer / partial flush) is skipped, not fatal.
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * The newest `limit` records, NEWEST FIRST — `[0]` is the most recent record.
 * The file is appended oldest→newest, so a read takes the tail and reverses it.
 * This ordering is load-bearing for callers that read `[0]` as "the last thing
 * the guard decided".
 */
function readNewest<T>(path: string, limit: number): T[] {
  const all = readRecords<T>(path)
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : all.length
  return all.slice(-size).reverse()
}

/**
 * Append one record, creating the config dir as needed, then trim the file to
 * the newest GUARD_LOG_MAX_RECORDS when it has grown past the cap.
 */
function appendRecord(path: string, record: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
    const total = readRecords<unknown>(path).length
    if (total > GUARD_LOG_MAX_RECORDS) {
      const kept = readRecords<unknown>(path).slice(-GUARD_LOG_MAX_RECORDS)
      writeFileSync(path, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    }
  } catch {
    // Best-effort evidence only: never throw into a guard or an observe-only event.
  }
}

/** Log one guard decision (allows included — the trace shows what, and why). */
export function appendGuardDecision(root: string, record: GuardDecisionRecord): void {
  if (!root || root.trim() === '') return
  appendRecord(guardDecisionLogPath(root), record)
}

/** Log one observed-write tamper. */
export function appendObservedTamper(root: string, record: ObservedTamperRecord): void {
  if (!root || root.trim() === '') return
  appendRecord(observedTamperLogPath(root), record)
}

/** The newest `limit` guard decisions for `root`, newest first. Never throws. */
export function readGuardDecisions(root: string, limit = 20): GuardDecisionRecord[] {
  if (!root || root.trim() === '') return []
  return readNewest<GuardDecisionRecord>(guardDecisionLogPath(root), limit)
}

/** The newest `limit` observed tampers for `root`, newest first. Never throws. */
export function readObservedTampers(root: string, limit = 20): ObservedTamperRecord[] {
  if (!root || root.trim() === '') return []
  return readNewest<ObservedTamperRecord>(observedTamperLogPath(root), limit)
}
