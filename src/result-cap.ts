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

/** The payload shape the byte budget knows how to trim. */
export interface CappedPayload {
  errors: string[]
  warnings: string[]
  elided: ElisionMeta[]
}

/** Serialized size of a payload, measured the way the byte budget is enforced. */
export function payloadBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return 0
  }
}

/**
 * T28 — cap a payload by BYTES, which T24's count cap cannot do.
 *
 * `MAX_FINDINGS_FULL` bounds HOW MANY findings come back; it cannot see SIZE, so a
 * handful of enormous findings still passes. This trims the longer list repeatedly
 * until the payload fits, and reports every trim through the same `ElisionMeta` T24
 * established — a silent truncation is worse than no cap, because the reader cannot
 * tell a complete result from a clipped one.
 *
 * Terminates: each pass at least halves the longer list, and an empty pair of lists
 * ends the loop. A payload that still exceeds the budget once both lists are empty is
 * returned as-is — the alternative would be deleting fields the caller needs.
 */
export function capPayloadBytes<T extends CappedPayload>(payload: T, maxBytes: number): T {
  let current = payload
  let bytes = payloadBytes(current)
  if (bytes <= maxBytes) return current

  for (let attempt = 0; attempt < 16 && bytes > maxBytes; attempt += 1) {
    const { errors, warnings } = current
    if (errors.length === 0 && warnings.length === 0) break
    const trimErrors = errors.length >= warnings.length
    const from = trimErrors ? errors : warnings
    const keep = Math.floor(from.length / 2)
    current = {
      ...current,
      errors: trimErrors ? from.slice(0, keep) : errors,
      warnings: trimErrors ? warnings : from.slice(0, keep),
      elided: [...current.elided, {
        kind: trimErrors ? 'errors' : 'warnings',
        total: from.length,
        shown: keep,
        omitted: from.length - keep,
        hint: 'trimmed to fit the configured result byte budget (maxResultBytes); '
          + 'fix the findings shown and re-run to see the next batch',
      }],
    }
    bytes = payloadBytes(current)
  }
  return current
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
