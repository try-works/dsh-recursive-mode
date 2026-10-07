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
// The path is `.recursive/memory/.feedback.json`, joined onto the REPO ROOT, which is what the
// doc comment above has always said and what `filterRuntimeChangedFiles` expects: a counter the
// memory plane writes must live inside the `.recursive` control plane, not in the product tree.
// Measured before this fix: a completed fixture run ended with four residual FAILs naming
// `memory/.feedback.json` against phases 03 and 03.5, because the file landed outside
// `.recursive/run/<runId>/`, survived the runtime-diff filter, and entered the run's diff only
// after those phases were authored - retro-invalidating them. The counter is machine-owned and
// disposable per the same doc comment, so a counter left at the OLD path by an earlier version is
// READ once (see LEGACY_FEEDBACK_FILE) rather than silently dropped.
export const FEEDBACK_FILE = '.recursive/memory/.feedback.json'

/**
 * WHERE THE COUNTERS LIVED BEFORE the constant above carried its `.recursive/` prefix.
 *
 * ⚠ READ, BUT DELIBERATELY NEITHER MOVED NOR DELETED. Read, because evidence a previous run recorded is
 * not the plugin's to discard, and without the fallback the first settle after the move would start the
 * new file from an empty book — a counter lost silently, which is the one outcome ruled out. NOT moved,
 * because a delete is the single action that could re-create the very defect the prefix fixes: a legacy
 * file that is TRACKED and COMMITTED is absent from the run's diff while it is clean, so removing it
 * mid-run puts `D memory/.feedback.json` into the diff of every diff-audited phase authored before the
 * delete, which is the same retro-invalidation. Left alone, an untracked legacy file is in the diff from
 * the run's first phase (and is therefore accounted for), while a committed one stays invisible.
 * `readFeedback` prefers {@link FEEDBACK_FILE}, so the legacy counters are folded forward by the next
 * settle and this file then only sits there; it is machine-owned and disposable, so delete it by hand.
 */
export const LEGACY_FEEDBACK_FILE = 'memory/.feedback.json'

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

/**
 * Read the counters. A missing or unreadable file is an empty book, never an error.
 *
 * ⚠ THE LEGACY PATH IS A FALLBACK AND ONLY A FALLBACK: it is consulted when — and only when — there is
 * no usable file at {@link FEEDBACK_FILE} yet, which is exactly the first run after the path moved. The
 * two are never merged, because they are two SNAPSHOTS of one counter and adding them would count a run
 * twice. A file that exists at the current path but does not parse stays an empty book, which is what
 * this function has always promised: a corrupt sidecar is not an invitation to read a different file.
 */
export function readFeedback(root: string, readFile: (path: string) => string | null = defaultRead): FeedbackBook {
  const current = readFile(join(root, FEEDBACK_FILE))
  if (current !== null && current.trim() !== '') return parseBook(current)
  const legacy = readFile(join(root, LEGACY_FEEDBACK_FILE))
  return legacy === null ? {} : parseBook(legacy)
}

/** One counters file as a book: anything unreadable or unshaped is `{}`, never an error. */
function parseBook(text: string): FeedbackBook {
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

  const feedbackPath = join(root, FEEDBACK_FILE)
  // The counter now lives under the `.recursive` control plane, whose memory directory a fresh
  // checkout or a scratch fixture may not have yet. Creating it here rather than assuming it
  // exists is what a plugin owning its own control plane should do; before this, the write
  // threw ENOENT when nothing else had already made the directory.
  mkdirSync(dirname(feedbackPath), { recursive: true })
  write(feedbackPath, JSON.stringify(sortBook(book), null, 2) + '\n')
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
