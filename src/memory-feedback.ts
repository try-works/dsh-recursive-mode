/**
 * Memory feedback (FU-13 P3) — which entries were injected into which run, and how that run turned out.
 *
 * ⚠ WHAT THIS IS, HONESTLY LABELLED: a COUNTER, not learning. `TRAINING.md` puts model training (the
 * reference's 58 KB GRPO script) out of scope for a workflow plugin. What is in scope is the loop that makes
 * retrieval improve with evidence: record what was injected, settle it against the run's outcome, and let the
 * selector prefer what has held up.
 *
 * ⚠ AND WHY THE COUNTERS LIVE IN A SIDECAR, NOT IN THE SHARDS. The memory plane's documents are
 * human-authored: a person writes the lesson. Rewriting one to bump a number would be the silent-overwrite
 * defect this repo already produced once (the closeout writing over phase documents), applied to the memory
 * plane. So the counters live in `.recursive/memory/.feedback.json`, which is machine-owned and disposable —
 * delete it and you lose ranking evidence, not knowledge.
 *
 * ⚠ NO TIMESTAMPS ANYWHERE: two runs with the same inputs must produce identical files, which is the same
 * discipline the lock receipts, the closeout receipts and the selection output all follow.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Where the machine-owned counters live — inside the memory plane, but never a shard a person writes. */
export const FEEDBACK_FILE = 'memory/.feedback.json'

/** Where a run records what it was shown. */
export const INJECTIONS_FILE = 'memory-injections.json'

/** One entry the agent was shown, as the run recorded it. */
export interface InjectionRecord {
  /** The entry's source path, which is also its identity in the counters. */
  source: string
  title: string
  /** The phase it was injected for. */
  phase: string
  score: number
}

export interface FeedbackCounter {
  /** Times an entry was injected for a phase that then locked on that round. */
  applied: number
  /** Times an entry was injected for a phase that had to come round again before it locked. */
  contradicted: number
}

export type FeedbackBook = Record<string, FeedbackCounter>

/** Read the counters. A missing or unreadable file is an empty book, never an error. */
export function readFeedback(root: string, readFile: (path: string) => string | null = defaultRead): FeedbackBook {
  const text = readFile(join(root, FEEDBACK_FILE))
  if (text === null || text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const book: FeedbackBook = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<FeedbackCounter> | null
      if (record === null || typeof record !== 'object') continue
      book[key] = {
        applied: Number.isFinite(record.applied) ? Number(record.applied) : 0,
        contradicted: Number.isFinite(record.contradicted) ? Number(record.contradicted) : 0,
      }
    }
    return book
  } catch {
    return {}
  }
}

/** Read what a run recorded being shown. */
export function readInjections(runDir: string, readFile: (path: string) => string | null = defaultRead): InjectionRecord[] {
  const text = readFile(join(runDir, INJECTIONS_FILE))
  if (text === null || text.trim() === '') return []
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed as InjectionRecord[] : []
  } catch {
    return []
  }
}

/**
 * Record what the run was shown, MERGED by (source, title, phase).
 *
 * ⚠ MERGED RATHER THAN APPENDED, because a phase can be re-entered while it is still DRAFT and the same
 * entries are selected again. Appending would count one decision as four, and the counters exist to be
 * evidence. The highest score seen wins, since that is what the agent was most recently shown.
 */
export function recordInjection(
  runDir: string,
  entries: readonly { source: string; title: string; score: number }[],
  phase: string,
  write: (path: string, content: string) => void = defaultWrite,
  readFile: (path: string) => string | null = defaultRead,
): InjectionRecord[] {
  const existing = readInjections(runDir, readFile)
  const byKey = new Map<string, InjectionRecord>()
  for (const record of existing) byKey.set(keyOf(record), record)
  for (const entry of entries) {
    const candidate: InjectionRecord = { source: entry.source, title: entry.title, phase, score: entry.score }
    const key = keyOf(candidate)
    const prior = byKey.get(key)
    byKey.set(key, prior === undefined || candidate.score > prior.score ? candidate : prior)
  }
  // Deterministic order, so the file is comparable between runs.
  const merged = [...byKey.values()].sort((a, b) => a.phase.localeCompare(b.phase)
    || a.source.localeCompare(b.source) || a.title.localeCompare(b.title))
  write(join(runDir, INJECTIONS_FILE), JSON.stringify(merged, null, 2) + '\n')
  return merged
}

/**
 * Settle a finished run against its own outcome and return the updated book.
 *
 * ⚠ THE OUTCOME SIGNAL, and it is deliberately modest: an entry injected for a phase that **locked** was
 * APPLIED; an entry injected for a phase that had to come round again before it locked is CONTRADICTED — the
 * memory did not carry the phase the first time. That is a real signal available from the run's own files,
 * and it is not dressed up as more than that: no model was trained, and an entry is never deleted for losing.
 */
export function settleInjections(
  root: string,
  runDir: string,
  lockedPhases: readonly string[],
  write: (path: string, content: string) => void = defaultWrite,
  readFile: (path: string) => string | null = defaultRead,
): FeedbackBook {
  const injections = readInjections(runDir, readFile)
  const book = readFeedback(root, readFile)
  const locked = new Set(lockedPhases)

  // ⚠ ONLY `applied` IS SETTLED HERE, and the first version of this claimed more than it could show. It tried
  // to count a CONTRADICTION when "the phase needed more than one round", but `recordInjection` MERGES by
  // (source, title, phase) precisely so a re-entered DRAFT phase counts once — so the re-entry history that
  // rule needs is discarded before settle ever sees it, and the counts came out wrong in a way a reader would
  // have believed. `contradicted` stays in the type and in `feedbackBonus`, because the ranking already knows
  // what to do with it; what is missing is an honest SOURCE for it (a re-opened phase), and until there is
  // one, this function reports only what it can prove.
  for (const record of injections) {
    if (!locked.has(record.phase)) continue
    const counter = book[record.source] ?? { applied: 0, contradicted: 0 }
    counter.applied += 1
    book[record.source] = counter
  }

  write(join(root, FEEDBACK_FILE), JSON.stringify(sortBook(book), null, 2) + '\n')
  return book
}

/**
 * What the counters are worth in the ranking: `applied - contradicted`, clamped to one step.
 *
 * Clamped because a single long-lived entry should not be able to dominate the ranking forever, and because
 * the counter is evidence about retrieval, not a verdict about the lesson.
 */
export function feedbackBonus(book: FeedbackBook, source: string): number {
  const counter = book[source]
  if (counter === undefined) return 0
  const net = counter.applied - counter.contradicted
  return net === 0 ? 0 : net > 0 ? 1 : -1
}

function countPhase(injections: readonly InjectionRecord[], phase: string): number {
  return injections.filter((record) => record.phase === phase).length
}

function keyOf(record: { source: string; title: string; phase: string }): string {
  return record.phase + '\u0000' + record.source + '\u0000' + record.title
}

function sortBook(book: FeedbackBook): FeedbackBook {
  const sorted: FeedbackBook = {}
  for (const key of Object.keys(book).sort()) sorted[key] = book[key]
  return sorted
}

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function defaultWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}
