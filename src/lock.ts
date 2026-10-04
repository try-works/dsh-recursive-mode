import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Lock-hash + lock-chain validation for recursive-mode runs.
 *
 * Ports recursive-lock.py / verify-locks.py / recursive_phase_rules.py
 * semantics (byte-for-byte where observable):
 * - lockHashFromContent: LF-normalize, strip LockHash lines, SHA-256 hex
 * - getLockStatus: MISSING / DRAFT / STALE_LOCK / LOCKED
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

export const OPTIONAL_PHASES = new Set([
  '01-as-is.md',
  '01.5-root-cause.md',
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '05-manual-qa.md',
])

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

export type LockStatus = 'MISSING' | 'DRAFT' | 'STALE_LOCK' | 'LOCKED'

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
  const idx = phaseIndex(artifactFile)
  if (idx <= 0) return []
  const prereqs: string[] = []
  for (const phase of PHASE_SEQUENCE.slice(0, idx)) {
    if (existsSync(join(runDir, phase))) prereqs.push(phase)
  }
  return prereqs
}

/**
 * Canonical lock-validity classifier:
 * MISSING (no file) / DRAFT (not LOCKED) / STALE_LOCK (missing or mismatched hash fields) / LOCKED.
 */
export function getLockStatus(artifactPath: string): LockStatus {
  if (!existsSync(artifactPath)) return 'MISSING'
  let content: string
  try { content = readFileSync(artifactPath, 'utf8') } catch { return 'MISSING' }
  const statusMatch = STATUS_RE.exec(content)
  if (!statusMatch || statusMatch[1] !== 'LOCKED') return 'DRAFT'
  const hashMatch = LOCK_HASH_RE.exec(content)
  const lockedAtMatch = LOCKED_AT_RE.exec(content)
  if (!hashMatch || !lockedAtMatch) return 'STALE_LOCK'
  const storedHash = hashMatch[1].toLowerCase()
  const actualHash = lockHashFromContent(content)
  if (storedHash !== actualHash) return 'STALE_LOCK'
  return 'LOCKED'
}

/** Every prerequisite whose status is not LOCKED, in PHASE_SEQUENCE order. */
export function getPrerequisiteBlockers(runDir: string, artifactFile: string): PrerequisiteBlocker[] {
  const blockers: PrerequisiteBlocker[] = []
  for (const prereq of getPrerequisites(runDir, artifactFile)) {
    const status = getLockStatus(join(runDir, prereq))
    if (status !== 'LOCKED') {
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
      if (prereqStatus !== 'LOCKED') {
        throw new Error(`Cannot write receipt for '${artifactFile}': prerequisite '${prereq}' is not LOCKED (status: ${prereqStatus})`)
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
  for (const phase of PHASE_SEQUENCE) {
    const phasePath = join(runDir, phase)
    const status = getLockStatus(phasePath)
    if (status === 'LOCKED') continue
    if (!existsSync(phasePath) && OPTIONAL_PHASES.has(phase)) continue
    if (getPrerequisiteBlockers(runDir, phase).length > 0) return null
    return phase
  }
  return null
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
 */
export function validateChain(runDir: string, runId: string): LockChainResult {
  const phases: ChainPhaseResult[] = []
  let breakPhase: string | null = null
  let complete = true
  for (const phase of PHASE_SEQUENCE) {
    const phasePath = join(runDir, phase)
    const status = getLockStatus(phasePath)
    const problems: string[] = []
    const lockValid = status === 'LOCKED'
    if (!lockValid && breakPhase === null) {
      breakPhase = phase
      complete = false
    }
    if (!lockValid && status !== 'MISSING') {
      if (status === 'DRAFT') problems.push(`Status is not LOCKED (${status})`)
      else if (status === 'STALE_LOCK') problems.push('LockHash mismatch or missing lock fields')
    }
    phases.push({ file: phase, status, lockValid, lockProblems: problems })
  }
  const nextLegalPhase = getNextLegalPhase(runDir)
  const staleReceipts = getAllStaleReceipts(runDir)
  return { runId, phases, breakPhase, nextLegalPhase, complete, staleReceipts }
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
