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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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
export function renderMemorySection(entries: readonly MemoryEntry[]): string {  if (entries.length === 0) {
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

/**
 * T29 — INJECT MEMORY AT RUN START: the loader.
 *
 * WHY. The plugin built and linted the memory plane and **never read it**, so every run started from
 * zero and the whole temporal axis was dead. This is the read half of that axis; {@link selectMemory}
 * is the progressive-disclosure rule that keeps it from becoming a firehose.
 *
 * ⚠ RETIRED ENTRIES ARE NEVER INJECTED. `MemoryEntry` has no status FIELD, so the marker is read from
 * the entry's own text (`Status: STALE` / `Status: DEPRECATED`) — and an entry that says it is retired
 * is the one thing a later run must not be taught. Superseding writes a new entry; this is what makes
 * the old one stop being read.
 */
// ⚠ EXPORTED SO THERE IS ONE COPY: an explainer that tested its own retirement pattern would describe a
// ranking that does not ship - which is exactly the defect memory-select.ts had before this change.
export const RETIRED_MARKER = /\bStatus:\s*`?(STALE|DEPRECATED)`?/i

/**
 * What one matched changed path is worth. Exported for the same reason as the marker above: the explainer
 * must add the number production adds, not a number that looks reasonable.
 */
export const MEMORY_PATH_MATCH_WEIGHT = 3

/** The registry the loader starts from: the router, not the plane. */
export const MEMORY_INDEX_FILE = 'memory/MEMORY.md'

/** Progressive disclosure defaults, matching the parent (`--max-docs` 3, `--max-items` 10). */
export const MAX_MEMORY_DOCS = 3
export const MAX_MEMORY_ITEMS = 10

/** Read the whole plane, minus nothing: filtering is the SELECTOR's job, not the reader's. */
export function loadMemoryIndex(
  root: string,
  readFile: (path: string) => string | null = defaultMemoryRead,
  listFiles: (kind: string) => readonly string[] = (kind) => defaultMemoryList(root, kind),
): MemoryEntry[] {
  return readMemoryEntries(readFile, listFiles)
}

/** A shard, as the loader returns it: the entry plus why it was selected. */
export interface MemoryShard {
  entry: MemoryEntry
  score: number
  /** The query terms or paths that matched. Empty for an entry kept only because it is pinned. */
  matched: string[]
}

export interface MemorySelection {
  /** The shards to inject, best first. EMPTY when nothing was relevant. */
  shards: MemoryShard[]
  /** False when nothing is injected — the caller must then continue WITHOUT fabricating memory. */
  injected: boolean
  reason: string
}

/**
 * Select what to inject.
 *
 * ⚠ PATHS ARE THE STRONGER SIGNAL, per the parent: a shard whose text mentions a path the run has
 * actually changed outranks one that merely shares wording with the query. Both matter, and the path
 * evidence is weighted — not substituted, because a run's requirements text is what says what the run
 * is FOR.
 *
 * ⚠ NOTHING RELEVANT MEANS NOTHING INJECTED, verbatim from the parent: *"If the loader finds nothing
 * relevant, continue normally rather than fabricating memory."* A zero-score entry is NOT a weak
 * match, it is no match, and `injected: false` says so.
 */
export function selectMemory(
  root: string,
  options: { query: string; files?: readonly string[]; maxDocs?: number; maxItems?: number },
): MemorySelection {
  const maxDocs = options.maxDocs ?? MAX_MEMORY_DOCS
  const maxItems = options.maxItems ?? MAX_MEMORY_ITEMS
  const entries = loadMemoryIndex(root)
  if (entries.length === 0) {
    return { shards: [], injected: false, reason: 'the memory plane is empty, so nothing is injected' }
  }

  const files = options.files ?? []
  const candidates: MemoryShard[] = []
  for (const entry of entries) {
    const haystack = entry.title + '\n' + entry.body
    if (RETIRED_MARKER.test(haystack)) continue
    const matchedFiles = files.filter((file) => haystack.includes(file))
    const base = scoreMemoryEntry(entry, options.query)
    const score = base + matchedFiles.length * MEMORY_PATH_MATCH_WEIGHT
    if (score === 0) continue
    const matched = matchedFiles.length > 0
      ? matchedFiles
      : options.query.split(/\s+/).filter((term) => term.length > 2 && haystack.toLowerCase().includes(term.toLowerCase()))
    candidates.push({ entry, score, matched: [...new Set(matched)].slice(0, 5) })
  }

  if (candidates.length === 0) {
    return {
      shards: [],
      injected: false,
      reason: 'no memory entry matches this run and none is retired-but-relevant, so nothing is injected rather than fabricating memory',
    }
  }

  candidates.sort((a, b) => (b.score - a.score) || a.entry.title.localeCompare(b.entry.title))
  const shards = candidates.slice(0, Math.min(maxDocs, maxItems))
  return {
    shards,
    injected: true,
    reason: 'injected ' + shards.length + ' of ' + candidates.length + ' matching shard(s), capped at maxDocs ' + maxDocs,
  }
}

function defaultMemoryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function defaultMemoryList(root: string, kind: string): readonly string[] {
  const dir = join(root, 'memory', kind)
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}
