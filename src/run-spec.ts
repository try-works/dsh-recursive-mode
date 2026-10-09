/**
 * IS THIS RUN SPEC STILL A HOLLOW TEMPLATE? — one answer, two callers.
 *
 * WHY THIS MODULE EXISTS. `recursive_init` scaffolds Phase 0 as a TEMPLATE: the requirement block
 * still reads `### \`R1\` <short title>`, the acceptance criteria are still `[observable condition 1]`,
 * the checklists are still unchecked and both gates still read `FAIL`. The owner's defect report is that
 * `recursive_ask gate=run-start` raised the "start this run or hold?" gate while the document was in
 * exactly that state — *"i was never shown the spec before that so how could i approve if i havent seen
 * it"*. Approving an unfilled template is not a decision about a spec; there is no spec yet.
 *
 * So the QUESTION "is this document still the template?" must have ONE answer, and two consumers need it:
 *
 *   1. the SERVER gate (`recursive_ask`), which must REFUSE to raise the run-start question while the
 *      answer is yes, and
 *   2. the CLIENT sheet (`client/spec-sheet.tsx`), which must SAY SO plainly rather than dress a hollow
 *      document up as an approvable one — the honesty rule of `client/settings-view.ts`, applied to a
 *      document instead of a value.
 *
 * ⚠ THIS MODULE IS NODE-FREE ON PURPOSE. It is reached by both halves of the bundle, and the client bundle
 * is a BROWSER closure: a `node:fs` import anywhere in its graph breaks the page. So the file reading stays
 * in `run-start.ts` (which owns the artifact path) and this module takes TEXT and returns a VERDICT.
 *
 * ⚠ AND IT PINS THE TEMPLATE, NOT A COPY OF IT. The markers below are the literal lines
 * `init-templates.ts::requirementsContent` writes. A checker that instead carried its own copy of the whole
 * template would silently stop matching the moment the template changed; a checker that carried a CHECKSUM
 * would call every edited document filled and every untouched one unfilled on the strength of a byte count.
 * Naming the placeholder markers is the check that keeps meaning what it says.
 */

/** What the checker decided about one artifact's text. */
export type ArtifactVerdict = 'unfilled' | 'filled'

/** One piece of evidence found in the document, quoted with its line number. */
export interface ArtifactMarkerHit {
  /** Stable id of the marker that matched. */
  id: string
  /** 1-based line number in the document as it was read. */
  line: number
  /** The line verbatim, trimmed of surrounding whitespace. */
  text: string
}

/** The verdict plus the evidence for it. */
export interface ArtifactVerdictResult {
  verdict: ArtifactVerdict
  /** Marker hits, in line order. Empty exactly when the verdict is `filled`. */
  hits: ArtifactMarkerHit[]
}

/** The named evidence classes, so a reader can tell a placeholder from an unmet gate. */
export const ARTIFACT_MARKER_IDS = {
  placeholder: 'placeholder',
  uncheckedTodo: 'unchecked-todo',
  failedGate: 'failed-gate',
} as const

export type ArtifactMarkerId = (typeof ARTIFACT_MARKER_IDS)[keyof typeof ARTIFACT_MARKER_IDS]

/**
 * `...` on a line of its own, or a bracketed/angle placeholder.
 *
 * The bracketed form is deliberately `<[^<>\n]+>` rather than `<.+>`: a greedy pattern would swallow a
 * legitimate line that happens to contain two unrelated angle brackets, and the refusal it produced would
 * name a line the person could not see a placeholder in.
 */
const PLACEHOLDER_RE = /(^\s*\.\.\.\s*$)|(\[[^[\]\n<>]{2,120}\])|(<[^<>\n]{2,120}>)/

/** An unchecked task box: the template ships five of them and a filled spec has none in the TODO block. */
const UNCHECKED_TODO_RE = /^\s*[-*]\s*\[ \]/

/** The two FAIL gates the template ships (`Coverage: FAIL` / `Approval: FAIL`). */
const FAILED_GATE_RE = /^\s*(Coverage|Approval):\s*FAIL\b/i

/** Every marker, in the order they are reported for a single line. */
const MARKER_PATTERNS: readonly { id: ArtifactMarkerId; re: RegExp }[] = [
  { id: ARTIFACT_MARKER_IDS.placeholder, re: PLACEHOLDER_RE },
  { id: ARTIFACT_MARKER_IDS.uncheckedTodo, re: UNCHECKED_TODO_RE },
  { id: ARTIFACT_MARKER_IDS.failedGate, re: FAILED_GATE_RE },
]

/**
 * Which marker a single line carries, or null.
 *
 * Exported because the client prints the marker NAMES beside the quoted lines, and a second classifier that
 * re-derived them would be a second answer to the same question.
 */
export function markerIdsOnLine(line: string): ArtifactMarkerId[] {
  const ids: ArtifactMarkerId[] = []
  for (const pattern of MARKER_PATTERNS) {
    if (pattern.re.test(line)) ids.push(pattern.id)
  }
  return ids
}

/**
 * Does this line still carry a marker that PROVES the document is an unfilled template?
 *
 * ⚠ THE EVIDENCE IS NOT SYMMETRIC, and that asymmetry is the whole design. An angle-bracket placeholder or
 * `[observable condition 1]` cannot appear in a document somebody actually wrote, so it REFUTES the spec's
 * readiness. An unchecked box or a `FAIL` gate is weaker: a person may legitimately hold `Coverage: FAIL`
 * open as an objection while still having written real requirements. So the strong markers decide, the weak
 * ones are reported as context, and a real document is never refused on their account.
 */
function refutes(line: string): boolean {
  return markerIdsOnLine(line).includes(ARTIFACT_MARKER_IDS.placeholder)
}

/**
 * Classify one artifact's text.
 *
 * A verdict of `unfilled` means the document still carries the template's own placeholder text — the
 * evidence travels with it, line by line, so the refusal (and the client notice) can name what is missing
 * instead of asserting a state the reader cannot check.
 */
export function classifyArtifact(text: string): ArtifactVerdictResult {
  const lines = text.split(/\r?\n/)
  const hits: ArtifactMarkerHit[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    for (const id of markerIdsOnLine(line)) {
      hits.push({ id, line: i + 1, text: line.trim() })
    }
  }
  return { verdict: hits.some((hit) => hit.id === ARTIFACT_MARKER_IDS.placeholder) ? 'unfilled' : 'filled', hits }
}

/** The unfilled evidence only (what a refusal names). */
export function unfilledEvidence(result: ArtifactVerdictResult): ArtifactMarkerHit[] {
  return result.hits.filter((hit) => hit.id === ARTIFACT_MARKER_IDS.placeholder)
}

/** The weak, contextual markers (unchecked boxes, FAIL gates). */
export function contextEvidence(result: ArtifactVerdictResult): ArtifactMarkerHit[] {
  return result.hits.filter((hit) => hit.id !== ARTIFACT_MARKER_IDS.placeholder)
}

/**
 * One line naming what is missing, for a refusal sentence.
 *
 * The line number and the text are both quoted: "line 12: <short title>" is a thing a reader can go and
 * look at, while "the requirements are not filled in" is an assertion they would have to take on trust.
 */
export function describeEvidence(hits: readonly ArtifactMarkerHit[], limit = 3): string {
  const shown = hits.slice(0, limit).map((hit) => 'line ' + String(hit.line) + ': ' + hit.text)
  const rest = hits.length - shown.length
  const suffix = rest > 0 ? ' (and ' + String(rest) + ' more)' : ''
  return shown.join(' | ') + suffix
}
