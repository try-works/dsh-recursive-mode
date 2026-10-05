/**
 * T24 — bounded tool results.
 *
 * A linter over a 126 KB port can emit hundreds of findings, and `recursive_lint`
 * returned `errors[]`/`warnings[]` unbounded, so a single tool result could grow
 * without limit. Every result this plugin returns must be BOUNDED, and when a
 * bound bites it must say so in a way the reader can act on:
 *
 *   - WHAT was removed (which list, how many),
 *   - what is SHOWN, and
 *   - HOW to see the rest.
 *
 * A silent truncation is worse than no cap at all: the reader cannot tell a
 * complete result from a clipped one. Hence {@link ElisionMeta} accompanies every
 * truncation, and the caller surfaces it next to the findings.
 *
 * The "how to see the rest" route is deliberately ITERATIVE rather than a
 * bypass argument: the cap is a hard bound, so telling the caller to pass
 * `mode: 'full'` when `mode: 'full'` is already the capped mode would be a lie.
 * Fixing the shown findings and re-running genuinely reveals the next batch,
 * which is also the order the workflow wants them fixed in.
 */

/** Findings kept by `mode: 'full'`. */
export const MAX_FINDINGS_FULL = 200

/** Findings kept by `mode: 'summary'` — enough to orient, not enough to drown a turn. */
export const MAX_FINDINGS_SUMMARY = 10

export interface ElisionMeta {
  /** Which list was clipped. */
  kind: 'errors' | 'warnings'
  /** Findings the source produced. */
  total: number
  /** Findings actually returned. */
  shown: number
  /** `total - shown`; stated so a consumer need not compute it. */
  omitted: number
  /** One self-sufficient sentence: what was removed and how to see it. */
  hint: string
}

export interface ElideResult {
  kept: string[]
  /** Present only when the list was clipped. */
  meta: ElisionMeta | null
}

/**
 * Keep at most `max` findings. Clipping is reported, never silent.
 * A `max` of 0 or less is treated as "keep nothing" but still reports honestly.
 */
export function elideFindings(kind: 'errors' | 'warnings', findings: readonly string[], max: number): ElideResult {
  const list = Array.isArray(findings) ? findings : []
  const bound = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : list.length
  if (list.length <= bound) return { kept: [...list], meta: null }
  const kept = list.slice(0, bound)
  const omitted = list.length - kept.length
  return {
    kept,
    meta: {
      kind,
      total: list.length,
      shown: kept.length,
      omitted,
      hint:
        'showing ' + kept.length + ' of ' + list.length + ' ' + kind + '; ' + omitted +
        ' omitted by the result cap - fix the shown findings and re-run to reveal the rest' +
        ', or narrow the result with the artifact argument',
    },
  }
}
