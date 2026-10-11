import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// T17: the graph model, for the queries that are graph operations (see getPrerequisites).
import { buildPhaseGraph, nextLegalPhase, prerequisitesOf } from './phase-graph.ts'

/**
 * Lock-hash + lock-chain validation for recursive-mode runs.
 *
 * Ports recursive-lock.py / verify-locks.py / recursive_phase_rules.py
 * semantics (byte-for-byte where observable):
 * - lockHashFromContent: LF-normalize, strip LockHash lines, SHA-256 hex
 * - getLockStatus: MISSING / DRAFT / STALE_LOCK / LOCKED / SKIPPED
 * - getPrerequisites / getPrerequisiteBlockers: sequence ordering
 * - validateChain: per-phase validity + break + next legal phase
 * - receipts: read/write/invalidate with Python-identical JSON
 *
 * R3 (run 02).
 */

export const PHASE_SEQUENCE = [
  '00-requirements.md',
  '00-worktree.md',
  '01-as-is.md',
  '01.5-root-cause.md',
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '05-manual-qa.md',
  '06-decisions-update.md',
  '07-state-update.md',
  '08-memory-impact.md',
] as const

/**
 * CHAIN-OPTIONAL — the phases whose ABSENCE does not stop the legal-phase selector.
 *
 * ⚠ WHAT THIS SET IS, AND THE ONE THING IT IS NOT. Its only consumer is
 * `nextLegalPhase(graph, { optional: MAY_BE_ABSENT_PHASES })`, where it means exactly:
 * *a member whose artifact was NEVER CREATED does not stop the selector*. It says nothing
 * about the phase's WORK, and it is NOT a licence to remove an artifact that exists.
 *
 * ⚠ THE NAME IS THE FIX FOR A LIVE DEFECT. This set used to be called `OPTIONAL_PHASES`, and
 * a live agent read that word as "this phase may be skipped", found phase 1.5 blocking a run
 * with nothing to investigate, and deleted the artifact with `git rm`. The fold then refused
 * the turn — correctly, because a run artifact is evidence — leaving the agent with a refusal
 * and no legitimate way to skip a phase. The word was doing the damage: **"optional" is not a
 * property this set has**, while "may be absent" is precisely what it means. The deliberate
 * skip is a DIFFERENT fact with its own word and its own record, in the artifact itself
 * (`Status: SKIPPED` + `SkippedAt` + `SkipReason`, see `src/skip.ts`) — never an absence and
 * never a deletion.
 *
 * The seven members are unchanged: this is a rename that removes a false promise, not a
 * change to which phases tolerate absence.
 */
export const MAY_BE_ABSENT_PHASES = new Set([
  '01-as-is.md',
  '01.5-root-cause.md',
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '05-manual-qa.md',
])

/**
 * The former name of {@link MAY_BE_ABSENT_PHASES}, kept so a published consumer does not
 * break on a rename.
 *
 * @deprecated THE NAME CAUSED A LIVE DEFECT — do not use it in new code, and do not read it as
 * "may be skipped": the set tolerates an artifact that was never created, and removal of an
 * existing artifact is refused by the fold whatever this set says. Use `MAY_BE_ABSENT_PHASES`
 * for the traversal fact, and `recursive_lock` with `skip` for the deliberate skip.
 */
export const OPTIONAL_PHASES = MAY_BE_ABSENT_PHASES

const LOCK_HASH_LINE_RE = /^[ \t]*LockHash:.*(?:\n|$)/gm
const STATUS_RE = new RegExp('^[ \\t]*Status:\\s*(?:`|")?(\\w+)(?:`|")?\\s*$', 'm')
const LOCK_HASH_RE = new RegExp('^[ \\t]*LockHash:\\s*(?:`|")?([a-fA-F0-9]{64})(?:`|")?\\s*$', 'm')
const LOCKED_AT_RE = new RegExp('^[ \\t]*LockedAt:\\s*(?:`|")?([^`"\\r\\n]+)(?:`|")?\\s*$', 'm')

export interface LockReceipt {
  artifact: string
  artifact_path: string
  artifact_hash: string
  locked_at: string
  prerequisite_hashes: Record<string, string>
  previous_receipt_hash: string | null
  receipt_hash: string
}

export type LockStatus = 'MISSING' | 'DRAFT' | 'STALE_LOCK' | 'LOCKED' | 'SKIPPED'

/**
 * THE TWO WORDS THIS MODULE USED TO CONFLATE, now named apart.
 *
 *   MAY BE ABSENT (chain) — an artifact that was NEVER CREATED does not stop
 *     `nextLegalPhase`. That is {@link MAY_BE_ABSENT_PHASES}, and it is a fact about a
 *     traversal, not about work.
 *   SETTLED (work) — a phase nobody has to work on any more, because it is LOCKED (the work
 *     is done and hashed) or deliberately SKIPPED (a record in the artifact saying the phase
 *     was considered and does not apply). {@link isSettledStatus}.
 *
 * A phase that is neither is OUTSTANDING, and it is the only thing that blocks a later phase
 * or holds a run open. The distinction is what makes "the chain should only grow" survivable:
 * a phase that does not apply is settled IN PLACE, never removed.
 */
export function isSettledStatus(status: string): boolean {
  return status === 'LOCKED' || status === 'SKIPPED'
}

/** Whether the artifact carries a DELIBERATE SKIP record (`Status: SKIPPED`) — a marker, not an absence. */
export function isSkippedStatus(status: string): boolean {
  return status === 'SKIPPED'
}

export interface PrerequisiteBlocker {
  artifact: string
  status: string
  path: string
}

export interface StaleDownstream {
  artifact: string
  reason: string
}

export interface ChainPhaseResult {
  file: string
  status: LockStatus
  lockValid: boolean
  lockProblems: string[]
}

export interface LockChainResult {
  runId: string
  phases: ChainPhaseResult[]
  breakPhase: string | null
  nextLegalPhase: string | null
  complete: boolean
  staleReceipts: StaleDownstream[]
}

/** LF-normalize, strip every LockHash: line, return the normalized content. */
export function normalizeForLockHash(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized.replace(LOCK_HASH_LINE_RE, '')
}

/** SHA-256 hex over the UTF-8 bytes of the normalized content. */
export function lockHashFromContent(content: string): string {
  const normalized = normalizeForLockHash(content)
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

export function phaseIndex(artifactFile: string): number {
  return PHASE_SEQUENCE.indexOf(artifactFile as (typeof PHASE_SEQUENCE)[number])
}

export function isCoreArtifact(artifactFile: string): boolean {
  return phaseIndex(artifactFile) >= 0
}

/**
 * Every earlier phase in PHASE_SEQUENCE that exists on disk.
 * Mirrors: [phase for phase in PHASE_SEQUENCE[:idx] if (run_dir / phase).exists()]
 */
export function getPrerequisites(runDir: string, artifactFile: string): string[] {
  // T17: delegated to the graph — the same query expressed as IN-EDGES. The first attempt FAILED the
  // parity golden because the graph only had nodes for artifacts already on disk, while this function
  // is asked about files that do not exist yet (checking prerequisites BEFORE creating one is the
  // normal case). The graph now takes the queried artifact as an edge TARGET that emits no outgoing
  // edge, which is exactly this function's semantics — and `lock.parity.spec.ts` is the proof.
  const present = PHASE_SEQUENCE.filter((phase) => existsSync(join(runDir, phase)))
  const graph = buildPhaseGraph({ sequence: PHASE_SEQUENCE, present, queried: [artifactFile] })
  return prerequisitesOf(graph, artifactFile)
}

/**
 * Canonical lock-validity classifier:
 * MISSING (no file) / DRAFT (not LOCKED) / STALE_LOCK (missing or mismatched hash fields) /
 * LOCKED / SKIPPED (a deliberate skip recorded in the artifact — see `src/skip.ts`).
 *
 * ⚠ `SKIPPED` IS READ FROM THE ARTIFACT'S OWN `Status:` FIELD, and therefore only a file that
 * EXISTS can be SKIPPED. `foldRun` synthesizes the same status for an absent phase whose work the
 * run does not require, but that synthesis happens in the fold and never reaches this function —
 * so "an absent file" and "a phase recorded as skipped" cannot be confused by a caller here.
 */
export function getLockStatus(artifactPath: string): LockStatus {
  if (!existsSync(artifactPath)) return 'MISSING'
  let content: string
  try { content = readFileSync(artifactPath, 'utf8') } catch { return 'MISSING' }
  const statusMatch = STATUS_RE.exec(content)
  if (!statusMatch) return 'DRAFT'
  // A DELIBERATE SKIP. Checked before the LOCKED branch and REQUIRED to be spelled in the file
  // (not inferred from a missing lock field): a skip is a recorded decision, and a record that
  // cannot be read is not a record. No LockHash is expected — nothing was locked.
  if (isSkippedStatus(statusMatch[1])) return 'SKIPPED'
  if (statusMatch[1] !== 'LOCKED') return 'DRAFT'
  const hashMatch = LOCK_HASH_RE.exec(content)
  const lockedAtMatch = LOCKED_AT_RE.exec(content)
  if (!hashMatch || !lockedAtMatch) return 'STALE_LOCK'
  const storedHash = hashMatch[1].toLowerCase()
  const actualHash = lockHashFromContent(content)
  if (storedHash !== actualHash) return 'STALE_LOCK'
  return 'LOCKED'
}

/**
 * Every prerequisite that is not SETTLED, in PHASE_SEQUENCE order.
 *
 * ⚠ SETTLED, NOT MERELY LOCKED, and the difference is the whole skip mechanism: a deliberately
 * SKIPPED prerequisite was considered and recorded as not applicable, so it cannot block the
 * phase after it — otherwise a legitimate skip would wedge the run exactly where the removal
 * used to (the phase after it could never lock, and the agent would be back to deleting files).
 * An OUTSTANDING prerequisite (MISSING / DRAFT / STALE_LOCK) still blocks, with the status named.
 */
export function getPrerequisiteBlockers(runDir: string, artifactFile: string): PrerequisiteBlocker[] {
  const blockers: PrerequisiteBlocker[] = []
  for (const prereq of getPrerequisites(runDir, artifactFile)) {
    const status = getLockStatus(join(runDir, prereq))
    if (!isSettledStatus(status)) {
      blockers.push({ artifact: prereq, status, path: join(runDir, prereq) })
    }
  }
  return blockers
}

export function receiptPath(runDir: string, artifactFile: string): string {
  const stem = artifactFile.replace(/\.md$/, '')
  return join(runDir, 'locks', stem + '.receipt.json')
}

export function readReceipt(runDir: string, artifactFile: string): LockReceipt | null {
  const rpath = receiptPath(runDir, artifactFile)
  if (!existsSync(rpath)) return null
  try {
    return JSON.parse(readFileSync(rpath, 'utf8')) as LockReceipt
  } catch {
    return null
  }
}

/**
 * Write a lock receipt with Python-identical JSON semantics.
 */
export function writeReceipt(runDir: string, artifactFile: string, artifactPath: string): LockReceipt {
  const content = readFileSync(artifactPath, 'utf8')
  const artifactHash = lockHashFromContent(content)

  const prereqHashes: Record<string, string> = {}
  for (const prereq of getPrerequisites(runDir, artifactFile)) {
    const prereqPath = join(runDir, prereq)
    if (existsSync(prereqPath)) {
      const prereqStatus = getLockStatus(prereqPath)
      // SETTLED, not merely LOCKED: a SKIPPED prerequisite is cited by its CONTENT HASH rather
      // than by a lock hash, which is what pins the skip record into the chain — an edit to a
      // skip record after the fact therefore shows up as a stale downstream receipt, exactly
      // like an edit to a locked artifact. A receipt for the skipped artifact itself is written
      // by the skip (see `src/skip.ts`), so `validateReceiptChain`'s gap check stays satisfied.
      if (!isSettledStatus(prereqStatus)) {
        throw new Error(`Cannot write receipt for '${artifactFile}': prerequisite '${prereq}' is not settled (status: ${prereqStatus})`)
      }
      prereqHashes[prereq] = lockHashFromContent(readFileSync(prereqPath, 'utf8'))
    }
  }

  const existing = readReceipt(runDir, artifactFile)
  const prevReceiptHash: string | null = existing ? existing.receipt_hash : null

  const now = new Date()
  const lockedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z')

  const base: Omit<LockReceipt, 'receipt_hash'> = {
    artifact: artifactFile,
    artifact_path: artifactPath,
    artifact_hash: artifactHash,
    locked_at: lockedAt,
    prerequisite_hashes: prereqHashes,
    previous_receipt_hash: prevReceiptHash,
  }

  // Python json.dumps(sort_keys=True) compact serialization:
  // keys sorted lexicographically, separators (', ', ': '), ensure_ascii.
  const receiptHash = createHash('sha256').update(pythonJsonDumps(base), 'utf8').digest('hex')

  const receipt: LockReceipt = { ...base, receipt_hash: receiptHash }

  const locksDir = join(runDir, 'locks')
  mkdirSync(locksDir, { recursive: true })
  const rpath = receiptPath(runDir, artifactFile)
  writeFileSync(rpath, pythonJsonDumpsIndent(receipt), 'utf8')
  return receipt
}

export function invalidateReceipt(runDir: string, artifactFile: string): boolean {
  const rpath = receiptPath(runDir, artifactFile)
  if (existsSync(rpath)) {
    rmSync(rpath, { force: true })
    return true
  }
  return false
}

/**
 * Downstream phases (strictly after artifactFile in PHASE_SEQUENCE) whose
 * receipt's prerequisite_hashes[artifactFile] differs from the current hash
 * (or the artifact no longer exists).
 */
export function getStaleDownstreamPhases(runDir: string, artifactFile: string): StaleDownstream[] {
  const idx = phaseIndex(artifactFile)
  if (idx < 0) return []
  let currentHash: string | null = null
  const artifactPath = join(runDir, artifactFile)
  if (existsSync(artifactPath)) {
    currentHash = lockHashFromContent(readFileSync(artifactPath, 'utf8'))
  }
  const stale: StaleDownstream[] = []
  for (const downstream of PHASE_SEQUENCE.slice(idx + 1)) {
    const receipt = readReceipt(runDir, downstream)
    if (!receipt) continue
    const prereqHashes = receipt.prerequisite_hashes ?? {}
    if (!(artifactFile in prereqHashes)) continue
    const storedHash = prereqHashes[artifactFile]
    if (currentHash === null || storedHash !== currentHash) {
      stale.push({ artifact: downstream, reason: `prerequisite '${artifactFile}' hash changed` })
    }
  }
  return stale
}

export function getNextLegalPhase(runDir: string): string | null {
  // T17: delegated to the graph, which now models all four shipped rules (skip LOCKED; skip a
  // deliberately SKIPPED phase; skip an ABSENT MAY-BE-ABSENT phase; report BLOCKED rather than
  // moving past a blocked node). `queried` carries the WHOLE sequence because an absent, required
  // phase is a legitimate answer here, and the parity specs are the proof — the same goldens that
  // caught the previous attempt.
  //
  // ⚠ THE SKIPPED SET IS PASSED SEPARATELY FROM `locked`, deliberately: a skip is not a lock, and a
  // caller that receives one for the other would report a phase as approved work. The graph's walk
  // treats both as SETTLED, which is the only sense in which they are the same thing.
  const present = PHASE_SEQUENCE.filter((phase) => existsSync(join(runDir, phase)))
  const statuses = new Map(present.map((phase) => [phase, getLockStatus(join(runDir, phase))]))
  const locked = present.filter((phase) => statuses.get(phase) === 'LOCKED')
  const skipped = present.filter((phase) => isSkippedStatus(statuses.get(phase) ?? 'MISSING'))
  const graph = buildPhaseGraph({ sequence: PHASE_SEQUENCE, present, locked, skipped, queried: PHASE_SEQUENCE })
  return nextLegalPhase(graph, { optional: MAY_BE_ABSENT_PHASES })
}

/** All receipts whose prerequisite_hashes reference a missing or changed artifact. */
export function getAllStaleReceipts(runDir: string): StaleDownstream[] {
  const stale: StaleDownstream[] = []
  for (const phase of PHASE_SEQUENCE) {
    const receipt = readReceipt(runDir, phase)
    if (!receipt) continue
    const prereqHashes = receipt.prerequisite_hashes ?? {}
    for (const [prereq, storedHash] of Object.entries(prereqHashes)) {
      const prereqPath = join(runDir, prereq)
      if (!existsSync(prereqPath)) {
        stale.push({ artifact: phase, reason: `prerequisite '${prereq}' no longer exists` })
        continue
      }
      const currentHash = lockHashFromContent(readFileSync(prereqPath, 'utf8'))
      if (storedHash !== currentHash) {
        stale.push({ artifact: phase, reason: `prerequisite '${prereq}' content changed since lock at ${receipt.locked_at}` })
      }
    }
  }
  return stale
}

/**
 * Validate the full lock chain of a run: per-phase lock status, break phase,
 * next legal phase, completion, and stale receipts.
 *
 * ⚠ `complete` MEANS "NOTHING IS OUTSTANDING", and that is a DELIBERATE widening (it used to mean
 * "every phase is LOCKED"). A deliberately SKIPPED phase is a decision the run recorded, so it does
 * not break the chain and does not hold the run open — while `lockValid` stays FALSE for it, so a
 * caller that asks "is this phase locked?" still gets the honest answer and can tell the two apart.
 * Without this, a legitimate skip would leave the run permanently incomplete, which is the same
 * dead end that made deleting the artifact look like the only way forward.
 */
export function validateChain(runDir: string, runId: string): LockChainResult {
  const phases: ChainPhaseResult[] = []
  let breakPhase: string | null = null
  let complete = true
  for (const phase of PHASE_SEQUENCE) {
    const phasePath = join(runDir, phase)
    const status = getLockStatus(phasePath)
    const problems: string[] = []
    const settled = isSettledStatus(status)
    const lockValid = status === 'LOCKED'
    if (!settled && breakPhase === null) {
      breakPhase = phase
      complete = false
    }
    if (!settled && status !== 'MISSING') {
      if (status === 'DRAFT') problems.push(`Status is not LOCKED (${status})`)
      else if (status === 'STALE_LOCK') problems.push('LockHash mismatch or missing lock fields')
    }
    phases.push({ file: phase, status, lockValid, lockProblems: problems })
  }
  const nextLegalPhase = getNextLegalPhase(runDir)
  const staleReceipts = getAllStaleReceipts(runDir)
  return { runId, phases, breakPhase, nextLegalPhase, complete, staleReceipts }
}

/** Why a receipt chain failed verification. */
export type ReceiptChainBreakKind =
  | 'receipt-hash-mismatch'
  | 'prerequisite-hash-mismatch'
  | 'missing-prerequisite-receipt'
  | 'malformed-previous-hash'

/** One broken link, naming the phase at fault and both values involved. */
export interface ReceiptChainBreak {
  /** The artifact whose receipt is at fault. */
  phase: string
  kind: ReceiptChainBreakKind
  /** A sentence naming both values, so the break is diagnosable without a debugger. */
  detail: string
}

export interface ReceiptChainResult {
  runId: string
  ok: boolean
  /** How many receipts were examined (absent phases are skipped, not counted). */
  checked: number
  breaks: ReceiptChainBreak[]
}

const RECEIPT_HASH_RE = /^[a-fA-F0-9]{64}$/

/**
 * T32 — verify a run's receipts against each other and against the artifacts they
 * cite. Closes review finding E: the receipt hash was COMPUTED on every lock and
 * never re-derived, so `previous_receipt_hash` was written and read by nothing.
 *
 * READ-ONLY, deliberately. The chain is evidence, and a verification that rewrites
 * what it verifies is worthless — so this never repairs, re-hashes or touches a
 * receipt, and a caller can run it as often as it likes.
 *
 * WHAT IT CHECKS, and what it refuses to claim. `previous_receipt_hash` chains to the
 * SAME artifact's previous receipt, and there is exactly one receipt file per
 * artifact, so the receipt it names has been overwritten and its LINKAGE cannot be
 * verified from disk. Rather than assert a linkage it cannot prove, this checks:
 *   1. receipt integrity — the stored `receipt_hash` must equal the hash recomputed
 *      from the receipt's own fields (catches an edit after the fact);
 *   2. prerequisite agreement — each recorded `prerequisite_hashes[p]` must equal
 *      p's CURRENT artifact hash (catches an upstream changed after locking);
 *   3. gaps — a receipt citing a prerequisite that has no receipt at all;
 *   4. a well-formedness check on `previous_receipt_hash`, which the writer could
 *      only ever produce as a sha256 hex digest or null.
 *
 * Never throws: an unreadable receipt is skipped, and a missing run directory is an
 * empty result rather than an error.
 */
export function validateReceiptChain(runDir: string, runId: string): ReceiptChainResult {
  const breaks: ReceiptChainBreak[] = []
  let checked = 0

  for (const phase of PHASE_SEQUENCE) {
    const receipt = readReceipt(runDir, phase)
    if (receipt === null) continue
    checked += 1

    // 1. INTEGRITY. Recompute the hash from every field the writer covered.
    const { receipt_hash: storedHash, ...base } = receipt
    const expectedHash = createHash('sha256').update(pythonJsonDumps(base), 'utf8').digest('hex')
    if (storedHash !== expectedHash) {
      // Two hashes alone say "something changed" but not WHAT, so the detail also
      // compares the receipt's recorded artifact hash against the artifact on disk.
      // That single comparison separates the two causes a reader cares about: the
      // ARTIFACT was edited after locking, or the RECEIPT was edited after writing.
      let onDisk: string | null = null
      try {
        onDisk = lockHashFromContent(readFileSync(join(runDir, phase), 'utf8'))
      } catch {
        onDisk = null
      }
      const recorded = String(receipt.artifact_hash)
      const which = onDisk === null
        ? 'the artifact cannot be read now'
        : onDisk === recorded
          ? 'the artifact still matches its recorded hash ' + recorded + ', so the RECEIPT was edited'
          : 'the artifact now hashes ' + onDisk + ' but the receipt records ' + recorded + ', so the ARTIFACT changed after locking'
      breaks.push({
        phase,
        kind: 'receipt-hash-mismatch',
        detail: 'receipt_hash ' + String(storedHash) + ' does not match the recomputed ' + expectedHash + '; ' + which,
      })
    }

    // 4. WELL-FORMEDNESS first among the cheap checks, and NOT skipped when the
    // integrity check already failed: a tampered field is exactly when a malformed
    // one is worth naming too.
    const previous = receipt.previous_receipt_hash
    if (previous !== null && previous !== undefined && !RECEIPT_HASH_RE.test(String(previous))) {
      breaks.push({
        phase,
        kind: 'malformed-previous-hash',
        detail: 'previous_receipt_hash ' + JSON.stringify(previous) + ' is not a sha256 hex digest or null',
      })
    }

    // 2 + 3. The cited prerequisites must still agree with what is on disk.
    const cited = receipt.prerequisite_hashes ?? {}
    for (const prereq of Object.keys(cited)) {
      const recorded = cited[prereq]
      if (readReceipt(runDir, prereq) === null) {
        breaks.push({
          phase,
          kind: 'missing-prerequisite-receipt',
          detail: 'cites ' + prereq + ' as a locked prerequisite, but no receipt exists for it',
        })
        continue
      }
      let currentHash: string | null = null
      try {
        currentHash = lockHashFromContent(readFileSync(join(runDir, prereq), 'utf8'))
      } catch {
        currentHash = null
      }
      if (currentHash === null) {
        breaks.push({
          phase,
          kind: 'prerequisite-hash-mismatch',
          detail: 'cites ' + prereq + ' at ' + String(recorded) + ', but its artifact cannot be read now',
        })
      } else if (currentHash !== recorded) {
        breaks.push({
          phase,
          kind: 'prerequisite-hash-mismatch',
          detail: 'recorded ' + String(recorded) + ' for ' + prereq + ', which now hashes ' + currentHash,
        })
      }
    }
  }

  return { runId, ok: breaks.length === 0, checked, breaks }
}

/**
 * Python json.dumps(obj, sort_keys=True, separators=(', ', ': '), ensure_ascii=True)
 * compact serialization. Exported for parity testing against the Python oracle.
 */
export function serializeForReceiptHash(obj: object): string {
  return pythonJsonDumps(obj)
}

/** Python json.dumps(obj, sort_keys=True) compact serialization (receipt_hash input). */
function pythonJsonDumps(obj: object): string {
  const rec = obj as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  const parts = keys.map(key => {
    const value = rec[key]
    return `${jsonString(key)}: ${jsonValue(value)}`
  })
  return '{' + parts.join(', ') + '}'
}

/** Python json.dumps(obj, indent=2, sort_keys=True) disk serialization. */
function pythonJsonDumpsIndent(obj: object): string {
  const rec = obj as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  const inner = keys.map(key => {
    const value = rec[key]
    return '  ' + jsonString(key) + ': ' + jsonValueIndent(value, 2)
  })
  return '{\n' + inner.join(',\n') + '\n}'
}

function jsonString(s: string): string {
  return JSON.stringify(s)
}

function jsonValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return jsonString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return '[' + value.map(jsonValue).join(', ') + ']'
  if (typeof value === 'object') return pythonJsonDumps(value as Record<string, unknown>)
  return 'null'
}

function jsonValueIndent(value: unknown, depth: number): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return jsonString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return '[' + value.map(v => jsonValueIndent(v, depth)).join(', ') + ']'
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const pad = '  '.repeat(depth)
    const inner = keys.map(key => pad + '  ' + jsonString(key) + ': ' + jsonValueIndent(obj[key], depth + 1))
    return '{\n' + inner.join(',\n') + '\n' + pad + '}'
  }
  return 'null'
}
