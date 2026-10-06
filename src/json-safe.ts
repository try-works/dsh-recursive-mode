/**
 * Lossless-JSON projection for tool results (FU-9 defect fix).
 *
 * ⚠ THE DEFECT THIS EXISTS FOR, measured live: the host refused a review result with
 *
 *     Error: tool "recursive_review" returned invalid output: value is not lossless JSON
 *     ToolOutputError, code INVALID_TOOL_OUTPUT
 *
 * The tool returned its service result through a TYPE CAST — `return outcome as unknown as JsonValue` — and a
 * cast is a promise the compiler cannot keep. The outcome carries live objects: the delegation's per-round
 * `result` is whatever the host returned for a child run, which in a real session holds an Agent or a provider
 * seam, and neither survives `JSON.stringify`.
 *
 * ⚠ WHY A GENERAL PROJECTION RATHER THAN STRIPPING THE KNOWN FIELD: I could delete the `result` property and
 * pass this round's test, but the next field the engine adds would break the tool again — and the failure mode
 * is a REFUSED RESULT, which tells the caller nothing about the work that was done. A projection that handles
 * cycles, functions and class instances is correct for every future field rather than for this one.
 *
 * ⚠ AND IT IS HONEST ABOUT WHAT IT DROPS: a function becomes nothing, a cycle becomes a marker string, and a
 * class instance becomes its own enumerable properties. Nothing is invented, and nothing silently vanishes
 * without a trace in the output — a dropped key simply is not there, which is what "lossless JSON" means.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** What a reference to an already-visited object becomes, so a cycle is visible rather than dropped. */
export const CIRCULAR_MARKER = '[circular]'

/**
 * Project any value into something `JSON.stringify` accepts, without throwing.
 *
 * Returns `null` for values that have no JSON form at all (a lone function, a symbol, `undefined`), which the
 * caller decides how to present. Objects are walked by their OWN ENUMERABLE keys, so a class instance projects
 * to its data and its methods are left behind — which is exactly what an Agent or a seam needs to become.
 */
export function toLosslessJson(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue | null {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string') return value as string
  if (kind === 'boolean') return value as boolean
  if (kind === 'number') return Number.isFinite(value as number) ? (value as number) : String(value)
  if (kind === 'bigint') return (value as bigint).toString()
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return null

  const object = value as object
  if (seen.has(object)) return CIRCULAR_MARKER
  seen.add(object)

  if (Array.isArray(value)) {
    const items: JsonValue[] = []
    for (const item of value) {
      const projected = toLosslessJson(item, seen)
      // An array element with no JSON form is dropped rather than turned into null, because a null would claim
      // the element existed and was empty.
      if (projected !== null) items.push(projected)
    }
    return items
  }

  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return value.message

  const out: Record<string, JsonValue> = {}
  for (const key of Object.keys(object)) {
    let raw: unknown
    try {
      raw = (object as Record<string, unknown>)[key]
    } catch {
      // A getter that throws is not a value: skip it rather than failing the whole result.
      continue
    }
    const projected = toLosslessJson(raw, seen)
    if (projected !== null) out[key] = projected
  }
  return out
}
