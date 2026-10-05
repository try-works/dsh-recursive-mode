/**
 * identity.ts — T19: deterministic operation identity.
 *
 * WHY THIS EXISTS. `reopen` is the one genuinely destructive operation in the
 * workflow, and a retry after a partial failure was indistinguishable from a fresh
 * request: the same reopen could run twice, and an interrupted delegated round could
 * be executed again. Identity makes a retry recognisable as the SAME operation.
 *
 * THE SHAPE IS NOT INVENTED HERE. Tardigrade's `InputDigest` canonicalises input
 * (sorted keys, lone surrogates and non-finite numbers rejected) then hashes it with
 * the byte length, inlining below a size limit and digesting above; Effect's
 * `makeExecutionIdFromPayload` hashes `tag.length:tag:payload`. This module is the
 * same rule, and the `tag.length:` prefix is not decoration: without the length, two
 * different `(act, input)` pairs could concatenate to one string.
 *
 * WHY A FILE FOR THE INDEX, and not `ctx.storageDomain` (plan §4.0). The same reason
 * `guard-log.ts` gives for its own store: the record must survive a restart and be
 * inspectable out-of-band, and a file keeps the plugin free of a service that may be
 * absent. The plan's actual requirement is that the index is PERSISTED rather than
 * derived — no artifact on disk says "this operation was already attempted", which is
 * exactly what makes the index worth keeping — and a bounded, git-ignored file meets
 * it. The degradation the plan asks for becomes the trivial "no index file yet".
 *
 * Every function is BEST-EFFORT on the read/write path and never throws for a
 * missing or corrupt index; only the canonicaliser throws, and only for input that
 * has no honest canonical form.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Canonical forms at or below this size are inlined into the key; larger ones are digested. */
export const INLINE_LIMIT_BYTES = 2048

/** How much of the digest becomes the id. 128 bits — ample for a local index. */
const ID_HEX_CHARS = 32

/**
 * Reject a string a hash could not faithfully represent.
 *
 * A lone surrogate has no valid UTF-8 encoding, so hashing it would hash a
 * replacement character: two genuinely different inputs would share one identity,
 * which is worse than refusing.
 */
function assertEncodable(value: string, where: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error('canonicalInput: lone surrogate at ' + where + ' (no valid UTF-8 encoding)')
      }
      i += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('canonicalInput: lone surrogate at ' + where + ' (no valid UTF-8 encoding)')
    }
  }
}

/** Serialize one value with object keys sorted at every depth; arrays keep their order. */
function serialize(value: unknown, where: string): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      // `JSON.stringify(NaN)` is `null`, which would alias NaN onto a real null.
      if (!Number.isFinite(value)) throw new Error('canonicalInput: non-finite number at ' + where)
      return JSON.stringify(value)
    case 'string':
      assertEncodable(value, where)
      return JSON.stringify(value)
    case 'undefined':
      throw new Error('canonicalInput: undefined at ' + where + ' has no canonical form')
    case 'bigint':
      throw new Error('canonicalInput: bigint at ' + where + ' has no canonical form')
    case 'function':
    case 'symbol':
      throw new Error('canonicalInput: ' + typeof value + ' at ' + where + ' has no canonical form')
    default:
      break
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item, index) => serialize(item, where + '[' + index + ']')).join(',') + ']'
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts = keys.map((key) => {
    assertEncodable(key, where)
    return JSON.stringify(key) + ':' + serialize(record[key], where + '.' + key)
  })
  return '{' + parts.join(',') + '}'
}

/**
 * Canonical JSON for an input: object keys sorted at every depth, arrays in order.
 * Throws for input with no honest canonical form (a lone surrogate, a non-finite
 * number, `undefined`) rather than silently substituting something hashable.
 */
export function canonicalInput(value: unknown): string {
  return serialize(value, '$')
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The bounded key for one input: the canonical form inline when it is small, and a
 * digest plus byte length when it is not. The length is kept so a truncated input
 * cannot collide with a genuinely different one of the same digest.
 */
export function idempotencyKey(input: unknown): string {
  const canonical = canonicalInput(input)
  const bytes = Buffer.byteLength(canonical, 'utf8')
  if (bytes <= INLINE_LIMIT_BYTES) return 'inline:' + canonical
  return 'sha256:' + sha256(canonical) + ':' + bytes
}

/**
 * The deterministic id of an operation: same act and same input give the same id,
 * whatever the key order, and a materially different operation never does.
 */
export function operationId(input: { act: string; input: unknown }): string {
  const act = input.act
  assertEncodable(act, 'act')
  return sha256(act.length + ':' + act + ':' + idempotencyKey(input.input)).slice(0, ID_HEX_CHARS)
}

/** One recorded attempt. The index holds only what makes a retry recognisable. */
export interface OperationRecord {
  id: string
  act: string
  /** When the attempt was recorded (caller-supplied, so a test can be deterministic). */
  at: string
  /** What happened, when the caller knows: e.g. `applied`, `refused`, `interrupted`. */
  outcome?: string
  /**
   * T28: the phase this operation belongs to, when it has one.
   *
   * Recorded so a budget can be counted FROM the index rather than tracked
   * separately — the children-per-phase cap is `readOperations(...)` filtered by
   * phase, which needs no new state and cannot drift from the operations it counts.
   */
  phase?: string
}

/** The run-scoped, append-only operation index. Bounded by use, git-ignored with the run. */
export function operationsPath(runDir: string): string {
  return join(runDir, 'operations', 'operations.jsonl')
}

/** Every recorded attempt, oldest first. Never throws; a corrupt line is skipped. */
export function readOperations(runDir: string): OperationRecord[] {
  let raw: string
  try {
    raw = readFileSync(operationsPath(runDir), 'utf8')
  } catch {
    return []
  }
  const out: OperationRecord[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<OperationRecord> | null
      if (parsed === null || typeof parsed !== 'object') continue
      if (typeof parsed.id !== 'string' || typeof parsed.act !== 'string') continue
      const record: OperationRecord = {
        id: parsed.id,
        act: parsed.act,
        at: typeof parsed.at === 'string' ? parsed.at : '',
      }
      if (typeof parsed.outcome === 'string') record.outcome = parsed.outcome
      if (typeof parsed.phase === 'string') record.phase = parsed.phase
      out.push(record)
    } catch {
      // A partially written line must not make the run unreadable.
    }
  }
  return out
}

/** The LATEST record for an id, or null when the operation has never been attempted. */
export function findOperation(runDir: string, id: string): OperationRecord | null {
  const mine = readOperations(runDir).filter((record) => record.id === id)
  return mine.length === 0 ? null : mine[mine.length - 1]!
}

/** Append one attempt. Best-effort: a failed write must never change an operation's outcome. */
export function recordOperation(runDir: string, record: OperationRecord): boolean {
  const path = operationsPath(runDir)
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** True when this exact operation has already been attempted in this run. */
export function wasAttempted(runDir: string, id: string): boolean {
  return findOperation(runDir, id) !== null
}

/** True when the index exists at all — lets a caller distinguish "no retry" from "no index". */
export function hasIndex(runDir: string): boolean {
  return existsSync(operationsPath(runDir))
}

/**
 * T28: how many DISTINCT operations of one act have been recorded for one phase.
 *
 * Counted from the index rather than tracked in parallel, so a budget cannot drift
 * away from the operations it bounds. DISTINCT ids, not records, because a resumed
 * turn re-records the SAME operation: counting records would make a long review look
 * like many children and fire the cap on legitimate work, while a genuine new
 * operation (a repaired artifact changes the body, hence the id) still counts.
 */
export function countOperations(runDir: string, act: string, phase: string): number {
  const ids = new Set(
    readOperations(runDir)
      .filter((record) => record.act === act && record.phase === phase)
      .map((record) => record.id),
  )
  return ids.size
}
