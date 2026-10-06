/**
 * Explainable memory selection (FU-13 P1/P2) — the reference loader's good idea, with the reasons attached.
 *
 * ⚠ THE REFERENCE, measured: `recursive-training-loader.py` (21.1 KB) *"scores memory docs by relevance to the
 * current task, reads the most relevant docs, scores individual items, and returns formatted context for the
 * agent"* — progressive scoring, which is the right idea. Its weakness is that the ranking is OPAQUE: it
 * returns context, not reasons, so "why did the agent get this?" has no answer and a bad ranking cannot be
 * debugged or tuned.
 *
 * ⚠⚠ AND THE DEFECT THIS MODULE WAS REWRITTEN TO FIX. The first version asserted that one component — the
 * query score — came from production, and then ranked on THREE OTHER SIGNALS OF ITS OWN: it matched the last
 * path SEGMENT where production matches the whole path, capped the path weight where production does not,
 * tested its own retirement pattern instead of `RETIRED_MARKER`, and tie-broke differently. So it described a
 * ranking that does not ship, and the spec passed because it only checked the one shared component. The fix is
 * not "be careful": it is that this module now IMPORTS every constant it ranks with from `memory.ts`, and its
 * spec asserts the only property that cannot be faked — on the same on-disk plane with the same options, this
 * module's order EQUALS `selectMemory`'s shard order.
 */
import {
  type MemoryEntry,
  MEMORY_PATH_MATCH_WEIGHT,
  MEMORY_PHASE_MATCH_WEIGHT,
  entryAppliesTo,
  RETIRED_MARKER,
  scoreMemoryEntry,
} from './memory.ts'

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
  /** The same rendering shape the review path uses, for the included set. */
  rendered: string
}

export interface ExplainOptions {
  query: string
  /**
   * The run's changed paths. Already the signal FU-4 wired into `selectMemory`, and the one the reference
   * script cannot compute because it runs outside the run.
   */
  files?: readonly string[]
  /** The phase in play. Mirrors production's own option so both rank identically. */
  phase?: string
  /** How many entries may be injected. Mirrors `selectMemory`'s own cap, which is docs-and-items bounded. */
  maxItems?: number
  /** Mirrors `selectMemory`'s doc cap; the two caps compose there, so they must compose here. */
  maxDocs?: number
}

/** The same compose rule production applies at L246: `slice(0, Math.min(maxDocs, maxItems))`. */
const DEFAULT_MAX_DOCS = 3
const DEFAULT_MAX_ITEMS = 10

/**
 * Rank entries and explain every decision, using **production's own signals**.
 *
 * The score is `scoreMemoryEntry(entry, query) + <whole-path matches> * MEMORY_PATH_MATCH_WEIGHT`, the retired
 * marker is `RETIRED_MARKER`, and the tie-break is `title.localeCompare` — the four things the first version
 * got wrong by inventing them.
 */
export function explainMemorySelection(
  entries: readonly MemoryEntry[],
  options: ExplainOptions,
): MemoryExplanation {
  const files = options.files ?? []
  const cap = Math.min(options.maxDocs ?? DEFAULT_MAX_DOCS, options.maxItems ?? DEFAULT_MAX_ITEMS)
  const excluded: ExcludedEntry[] = []
  const scored: ExplainedEntry[] = []

  for (const entry of entries) {
    const haystack = entry.title + '\n' + entry.body
    if (haystack.trim() === '') {
      excluded.push({ title: entry.title, source: entry.source, reason: 'the entry is empty' })
      continue
    }
    if (RETIRED_MARKER.test(haystack)) {
      const status = RETIRED_MARKER.exec(haystack)?.[1] ?? 'retired'
      excluded.push({
        title: entry.title,
        source: entry.source,
        reason: 'status ' + status.toUpperCase() + ' is never injected',
      })
      continue
    }

    const components: ScoreComponent[] = []
    // ⚠ THE QUERY COMPONENT IS PRODUCTION'S OWN SCORER, not a second implementation of it.
    const queryScore = scoreMemoryEntry(entry, options.query)
    if (queryScore > 0) components.push({ name: 'query-match', weight: queryScore })

    // ⚠ WHOLE-PATH MATCH, UNCAPPED — production's rule (L227/L229), reproduced rather than improved on. The
    // temptation to match a path's last segment was exactly the drift this module was rewritten to remove.
    const matchedFiles = files.filter((file) => haystack.includes(file))
    if (matchedFiles.length > 0) {
      components.push({
        name: 'path-overlap',
        weight: matchedFiles.length * MEMORY_PATH_MATCH_WEIGHT,
        detail: matchedFiles.slice(0, 3).join(', '),
      })
    }

    // Production's phase rule, imported rather than re-derived.
    const declared = entryAppliesTo(entry)
    if (options.phase !== undefined && declared.some((p) => options.phase === p || options.phase?.startsWith(p + '-'))) {
      components.push({ name: 'phase-applicable', weight: MEMORY_PHASE_MATCH_WEIGHT, detail: 'declares ' + declared.join(', ') })
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

    scored.push({ kind: entry.kind, title: entry.title, source: entry.source, score: total, components, warnings: [] })
  }

  // Production's tie-break, exactly: score descending, then title by localeCompare.
  scored.sort((a, b) => (b.score - a.score) || a.title.localeCompare(b.title))

  const included = scored.slice(0, Math.max(0, cap))
  for (const dropped of scored.slice(Math.max(0, cap))) {
    excluded.push({
      title: dropped.title,
      source: dropped.source,
      reason: 'below the injection budget of ' + cap + ' shard(s)',
    })
  }

  return { entries: included, excluded, rendered: renderExplained(included) }
}

/** Render the included set, so a caller can print exactly what would be shown. */
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
