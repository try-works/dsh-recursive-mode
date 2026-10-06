/**
 * Explainable memory selection (FU-13 P1) — the reference loader's good idea, with the reasons attached.
 *
 * ⚠ THE REFERENCE, measured: `recursive-training-loader.py` (21.1 KB) *"scores memory docs by relevance to the
 * current task, reads the most relevant docs, scores individual items, and returns formatted context for the
 * agent"* — progressive scoring, which is the right idea. Its weakness is that the ranking is OPAQUE: it
 * returns context, not reasons, so "why did the agent get this?" has no answer and a bad ranking cannot be
 * debugged or tuned.
 *
 * ⚠ WHY THIS DOES NOT REIMPLEMENT `memory.ts`: `retrieveMemory` and `scoreMemoryEntry` already exist and are
 * what the review path uses. This module is ADDITIVE — it explains their outcome rather than replacing it, and
 * it deliberately CALLS `scoreMemoryEntry` for the query component so the explanation cannot drift from the
 * behaviour it describes. Two implementations of one ranking is the duplication that has produced three
 * defects in this repo already.
 *
 * ⚠ AND WHY IT IS NOT THE WHOLE PROPOSAL: `TRAINING.md` plans phase/run signals, injection counters and a CLI
 * verb. This is P1: typed, scored, explainable, deterministic, with an explicit excluded list — the foundation
 * the later phases attach to.
 */
import { type MemoryEntry, scoreMemoryEntry } from './memory.ts'

/** One contribution to an entry's score, named so a reader can argue with it. */
export interface ScoreComponent {
  name: string
  weight: number
  detail?: string
}

export interface ExplainedEntry {
  kind: string
  title: string
  source: string
  score: number
  /** Sums to `score`. Asserted in the spec, because a breakdown that does not add up is worse than none. */
  components: ScoreComponent[]
  warnings: string[]
}

export interface ExcludedEntry {
  title: string
  source: string
  reason: string
}

export interface MemoryExplanation {
  /** Included entries, best first, each with its components. */
  entries: ExplainedEntry[]
  /** Everything the selector saw and did not inject — never silently dropped. */
  excluded: ExcludedEntry[]
  /** The same rendering the review path uses, for the included set. */
  rendered: string
}

export interface ExplainOptions {
  query: string
  /**
   * The run's changed paths. Already the signal FU-4 wired into `selectMemory`, and the one the reference
   * script cannot compute because it runs outside the run.
   */
  files?: readonly string[]
  /** How many entries may be injected. Defaults to the module's own limit, not a new one. */
  maxItems?: number
}

/** Status markers the plane uses for entries that must not be injected. Read from the body, by convention. */
const DEAD_STATUS = /\bStatus:\s*`?(DEPRECATED|STALE|SUPERSEDED)`?/i
const SUSPECT_STATUS = /\bStatus:\s*`?SUSPECT`?/i

/** A path counts as a hit when its final segment appears in the entry's text. Cheap, and honest about it. */
function pathHits(entry: MemoryEntry, files: readonly string[]): string[] {
  const haystack = (entry.title + '\n' + entry.body).toLowerCase()
  const hits: string[] = []
  for (const file of files) {
    const segment = file.replace(/\\/g, '/').split('/').filter(Boolean).pop()
    if (segment === undefined || segment === '') continue
    if (haystack.includes(segment.toLowerCase())) hits.push(file)
  }
  return hits
}

/**
 * Rank entries and explain every decision.
 *
 * Deterministic by construction: the sort is by score, then by source, then by title — never by input order
 * or a clock — so the same inputs always produce the same output, which is what makes two runs comparable.
 */
export function explainMemorySelection(
  entries: readonly MemoryEntry[],
  options: ExplainOptions,
): MemoryExplanation {
  const files = options.files ?? []
  const maxItems = options.maxItems ?? 10
  const excluded: ExcludedEntry[] = []
  const scored: ExplainedEntry[] = []

  for (const entry of entries) {
    const title = entry.title.trim()
    const text = title + '\n' + entry.body.trim()
    if (text.trim() === '') {
      excluded.push({ title: entry.title, source: entry.source, reason: 'the entry is empty' })
      continue
    }
    if (DEAD_STATUS.test(entry.body)) {
      const status = DEAD_STATUS.exec(entry.body)?.[1] ?? 'dead'
      excluded.push({
        title: entry.title,
        source: entry.source,
        reason: 'status ' + status.toUpperCase() + ' is never injected',
      })
      continue
    }

    const components: ScoreComponent[] = []
    // ⚠ THE QUERY COMPONENT IS THE PRODUCTION SCORER'S OWN NUMBER, so this explanation cannot disagree with
    // what `retrieveMemory` would have chosen.
    const queryScore = scoreMemoryEntry(entry, options.query)
    if (queryScore > 0) components.push({ name: 'query-match', weight: queryScore })

    const hits = pathHits(entry, files)
    if (hits.length > 0) {
      components.push({
        name: 'path-overlap',
        // Capped so one entry naming every changed file cannot dominate the ranking.
        weight: Math.min(hits.length, 3),
        detail: hits.slice(0, 3).join(', '),
      })
    }

    const total = components.reduce((sum, c) => sum + c.weight, 0)
    if (total === 0) {
      excluded.push({
        title: entry.title,
        source: entry.source,
        reason: 'no query match and no overlap with the run\'s changed paths',
      })
      continue
    }

    const warnings: string[] = []
    if (SUSPECT_STATUS.test(entry.body)) {
      warnings.push('status SUSPECT — injected, but treat the claim as unverified')
    }

    scored.push({ kind: entry.kind, title: entry.title, source: entry.source, score: total, components, warnings })
  }

  scored.sort((a, b) => (b.score - a.score)
    || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)
    || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))

  const included = scored.slice(0, Math.max(0, maxItems))
  for (const dropped of scored.slice(Math.max(0, maxItems))) {
    excluded.push({
      title: dropped.title,
      source: dropped.source,
      reason: 'below the injection budget of ' + maxItems + ' entries',
    })
  }

  return { entries: included, excluded, rendered: renderExplained(included) }
}

/** Render the included set the way the review section does, so a caller can print exactly what was shown. */
export function renderExplained(entries: readonly ExplainedEntry[]): string {
  if (entries.length === 0) {
    return 'No prior-run memory matched this phase. Do not assume the absence is conclusive:'
      + ' memory is retrieved by relevance, not by recency.'
  }
  const lines: string[] = ['Prior-run memory relevant to this phase (cite by title if you rely on it):']
  for (const entry of entries) {
    lines.push('')
    lines.push('### [' + entry.kind + '] ' + entry.title)
    lines.push('(source: ' + entry.source + ' | score ' + entry.score + ': '
      + entry.components.map((c) => c.name + ' +' + c.weight).join(', ') + ')')
    for (const warning of entry.warnings) lines.push('⚠ ' + warning)
  }
  return lines.join('\n')
}
