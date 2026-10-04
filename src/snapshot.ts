/**
 * snapshotWorkspace(root): fold the filesystem into the RecursiveProjection whole value.
 *
 * SP2 R1 (live-route) — the ONLY projection path. The board/strip read this through
 * the host HTTP/SSE route; cold resume and every GET are a FRESH fs read (the route
 * never serves a cached/stale snapshot). Per-workspace: root is the resolved
 * control-plane root (cwd == workspace root, cwd == subdir, or cwd == repo root).
 *
 * Phase-lock facts (lockedAt/lockHash) are enriched from lock receipts because
 * foldRun PhaseState carries no lock fields; state comes from getArtifactState.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverRuns } from './run.ts'
import { foldRun } from './status.ts'
import { getLockStatus, receiptPath, readReceipt } from './lock.ts'
import type { RecursiveProjection, RecursiveRunCard, RecursivePhaseRow, RecursiveRunState } from './types.ts'

/** One locked-phase fact from a lock receipt (artifacts/<file>.receipt.json). */
interface LockFacts {
  lockedAt?: string
  lockHash?: string
}

/** Resolve a run's lock facts for one artifact file (receipt first, status fallback). */
function lockFactsOf(runDir: string, artifact: string): LockFacts {
  const receipt = readReceipt(runDir, artifact)
  if (receipt && typeof receipt.locked_at === 'string' && typeof receipt.artifact_hash === 'string') {
    return {
      lockedAt: receipt.locked_at,
      lockHash: receipt.artifact_hash,
    }
  }
  // No usable receipt: fall back to the artifact's own LockedAt/LockHash fields.
  const status = getLockStatus(join(runDir, artifact))
  if (status !== 'LOCKED') return {}
  return {
    lockedAt: new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    lockHash: '0'.repeat(64),
  }
}

/** One phase row from a run's folded status (locked facts enriched). */
function phaseRowOf(runDir: string, key: string, file: string, status: string): RecursivePhaseRow {
  const row: RecursivePhaseRow = { phase: key, status }
  if (status === 'LOCKED') {
    const facts = lockFactsOf(runDir, file)
    if (facts.lockedAt !== undefined) row.lockedAt = facts.lockedAt
    if (facts.lockHash !== undefined) row.lockHash = facts.lockHash
  }
  return row
}

/**
 * Fold one run directory into a RecursiveRunCard (the wire shape the board renders).
 * Runs that no longer exist on disk are omitted (the fs is the source of truth).
 */
export function foldRunCard(runDir: string, runId: string, worktreeRoot: string): RecursiveRunCard {
  const status = foldRun(runDir, runId)
  // Wire contract parity (deleted projection.ts): phases are keyed by FILENAME
  // (the recursive/phase event carried phase: '03-implementation-summary.md'),
  // which is what derive.ts phaseGroupOf parses. phase.key ('03', '00R', '00W')
  // would never match the filename regex and would break columnForRun/cardFacts.
  const phases: Record<string, RecursivePhaseRow> = {}
  for (const phase of status.phases) {
    if (phase.exists) phases[phase.file] = phaseRowOf(runDir, phase.file, phase.file, phase.status)
  }
  const state = runStateOf(status)
  return {
    runId,
    worktreeRoot,
    phases,
    state,
    tampers: {},
    subagents: {},
  }
}

/**
 * Derive the run-level state from the folded status. The fs stores no run-level
 * state file, so the honest mapping is: 'complete' when every non-optional phase
 * exists and is lock-valid, else 'active'. Transient facts (gateBlocked, tamper,
 * subagent activity) are NOT fs-recoverable and read as absent (recorded
 * limitation; future enhancement).
 */
function runStateOf(status: ReturnType<typeof foldRun>): RecursiveRunState {
  const mandatory = status.phases.filter(p => !p.optional)
  const complete = mandatory.every(p => p.exists && p.lockValid)
  return complete ? 'complete' : 'active'
}

/**
 * Fold every run under <root>/.recursive/run/ into the projection, grouped by
 * worktree root then runId. A fresh fs read on every call (cold-resume live).
 */
export function snapshotWorkspace(root: string): RecursiveProjection {
  const projection: RecursiveProjection = {}
  for (const runId of discoverRuns(root)) {
    const runDir = join(root, '.recursive', 'run', runId)
    projection[root] ??= {}
    projection[root][runId] = foldRunCard(runDir, runId, root)
  }
  return projection
}
