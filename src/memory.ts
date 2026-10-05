/**
 * T14 — retrieve prior-run memory into the review bundle, so the recursion COMPOUNDS.
 *
 * WHY. A run that rediscovers what the last run learned is not a recursion, it is a repetition:
 * the workflow already writes memory to `.recursive/memory/` (domains, patterns, episodes, skills),
 * but nothing read it back into a REVIEWER's context, so every review started from nothing and the
 * only party who benefited from a lesson was whoever happened to grep the directory.
 *
 * ⚠ THERE IS NO NATIVE MEMORY SERVICE — measured, not assumed. The item's `memoryStore` names a
 * seam the harness does not provide (there is no memory package), so the store is this plugin's own
 * layer: markdown documents under `.recursive/memory/`. That is why this module PARSES and RANKS
 * rather than delegating; and it is why the ranking has to be explainable, since nothing else is
 * going to decide relevance for it.
 *
 * ⚠ AND RETRIEVAL IS DETERMINISTIC ON PURPOSE. Two runs over the same memory with the same query
 * MUST select the same entries: a reviewer whose context shuffles between runs cannot be compared
 * with itself, and "why did it miss that?" becomes unanswerable. The tie-break is document order,
 * so the result is reproducible from the inputs alone.
 */

/** The kinds this plugin's memory layer holds, in the order the scaffold creates them. */
export const MEMORY_KINDS = ['domains', 'patterns', 'episodes', 'skills'] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** One memory note: a titled section of a memory document. */
export interface MemoryEntry {
  kind: string
  title: string
  body: string
  /** Where it came from, so a citation in a review can be traced. */
  source: string
}

/** How many entries a bundle carries by default — enough to inform, not enough to drown a review. */
export const DEFAULT_MEMORY_LIMIT = 8

/**
 * Split a memory document into entries at its headings.
 *
 * A document with NO headings yields one entry rather than nothing: a memory file written as a
 * single paragraph is still memory, and dropping it because it lacks structure would silently lose
 * exactly the notes a hurried run leaves behind.
 */
export function parseMemoryEntries(kind: string, text: string, source: string): MemoryEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: MemoryEntry[] = []
  let title: string | null = null
  let body: string[] = []

  const flush = (): void => {
    const content = body.join('\n').trim()
    if (title === null && content === '') return
    entries.push({ kind, title: title ?? source, body: content, source })
  }

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flush()
      title = heading[2].trim()
      body = []
      continue
    }
    body.push(line)
  }
  flush()
  return entries.filter((entry) => entry.body !== '' || entry.title !== source)
}

/** The distinct lowercase words of a string, for overlap scoring. */
function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3))]
}

/**
 * Score one entry against a query: a term in the TITLE counts double.
 *
 * Titles are what a note is ABOUT; a term that appears only in the body may be incidental. The
 * weighting is crude and deliberate — an explainable ranking beats a clever one nobody can audit,
 * and the caller can always see every entry it did not get.
 */
export function scoreMemoryEntry(entry: MemoryEntry, query: string): number {
  const wanted = terms(query)
  if (wanted.length === 0) return 0
  const titleTerms = new Set(terms(entry.title))
  const bodyTerms = new Set(terms(entry.body))
  let score = 0
  for (const term of wanted) {
    if (titleTerms.has(term)) score += 2
    else if (bodyTerms.has(term)) score += 1
  }
  return score
}

/**
 * Rank entries against a query, keeping only those that MATCH.
 *
 * A zero score means no overlap, and an unmatched entry is not "less relevant" — it is unrelated,
 * and padding a reviewer's context with it would cost attention for nothing. Ties break by the
 * original order (a stable sort), so the same inputs always give the same answer.
 */
export function retrieveMemory(entries: readonly MemoryEntry[], query: string, limit: number = DEFAULT_MEMORY_LIMIT): MemoryEntry[] {
  const scored = entries.map((entry, index) => ({ entry, index, score: scoreMemoryEntry(entry, query) }))
  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, Math.max(0, limit))
    .map((row) => row.entry)
}

/**
 * Read the plugin's memory layer. Best-effort and never throws: an unreadable memory directory is
 * a missing advantage, not a failed review.
 *
 * `readFile` is injected so the caller decides how files are read (and a test can drive it without
 * a filesystem), which is also how the layout stays in ONE place — `.recursive/memory/<kind>/*.md`.
 */
export function readMemoryEntries(
  readFile: (path: string) => string | null,
  listFiles: (kind: string) => readonly string[],
  kinds: readonly string[] = MEMORY_KINDS,
): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  for (const kind of kinds) {
    for (const path of listFiles(kind)) {
      const text = readFile(path)
      if (text === null || text.trim() === '') continue
      entries.push(...parseMemoryEntries(kind, text, path))
    }
  }
  return entries
}

/** Render the retrieved memory for a review bundle: sections a reviewer can cite by title. */
export function renderMemorySection(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) {
    return 'No prior-run memory matched this review. Do not assume the absence is conclusive:'
      + ' memory is retrieved by relevance to the artifact and phase, not by recency.'
  }
  const lines: string[] = ['Prior-run memory relevant to this review (cite by title if you rely on it):']
  for (const entry of entries) {
    lines.push('')
    lines.push('### [' + entry.kind + '] ' + entry.title)
    if (entry.body !== '') lines.push(entry.body)
    lines.push('(source: ' + entry.source + ')')
  }
  return lines.join('\n')
}
