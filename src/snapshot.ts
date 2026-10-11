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
import { foldRun, pendingWork } from './status.ts'
import { getLockStatus, receiptPath, readReceipt } from './lock.ts'
import type { PhasePosition, RecursiveProjection, RecursiveRunCard, RecursivePhaseRow, RecursiveRunState, RecursiveTamper } from './types.ts'

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
function phaseRowOf(runDir: string, key: string, file: string, status: string, position?: PhasePosition): RecursivePhaseRow {
  const row: RecursivePhaseRow = { phase: key, status }
  // T21: carry the server's single derived position onto the wire so the board
  // reads ONE value instead of recombining status/gates/lock fields itself.
  if (position !== undefined) row.position = position
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
    if (phase.exists) phases[phase.file] = phaseRowOf(runDir, phase.file, phase.file, phase.status, phase.position)
  }
  const state = runStateOf(status)
  return {
    runId,
    worktreeRoot,
    phases,
    state,
    tampers: tampersOf(status),
    subagents: {},
    // T18: the card carries the same DERIVED pending set the lock gate enforces,
    // so the board explains a refusal instead of only recording it. Derived on
    // every fold, so a cold resume shows it and no store is involved (§4.0).
    pendingWork: pendingWork(runDir),
  }
}

/**
 * T15 (F) — tamper facts by DERIVATION, never by persistence.
 *
 * `foldRun` already decides, per phase, whether a LOCKED artifact's stored hash
 * still matches its content: a mismatch lands in `lockProblems` as the literal
 * 'LockHash mismatch' and clears `lockValid`. That IS the tamper fact, so the
 * card reads it off the fold instead of replaying the observed-tamper log —
 * which means it survives a cold resume, honours plan §4.0 ("derived beats
 * stored"), and stays correct even if the log was rotated or never written.
 *
 * Keyed by artifact FILE NAME (e.g. '00-requirements.md'), matching the phase
 * keys above. `foldRun` itself is untouched: its output shape is
 * parity-asserted by tests/status.parity.spec.ts.
 */
function tampersOf(status: ReturnType<typeof foldRun>): Record<string, RecursiveTamper> {
  const tampers: Record<string, RecursiveTamper> = {}
  for (const phase of status.phases) {
    if (phase.status !== 'LOCKED' || phase.lockValid) continue
    if (!phase.lockProblems.includes('LockHash mismatch')) continue
    tampers[phase.file] = { path: phase.file, reason: phase.lockProblems.join('; ') }
  }
  return tampers
}

/**
 * Derive the run-level state from the folded status. The fs stores no run-level
 * state file, so the honest mapping is: 'complete' when every phase the run's WORK
 * requires is SETTLED, else 'active'.
 *
 * ⚠ TWO DELIBERATE CHANGES, both from the skip mechanism (`src/skip.ts`), and both stated because a
 * reader of a completeness calculation deserves to know what moved:
 *
 *   1. THE FIELD IS NAMED `requiredForCompletion`, NOT `optional`. It used to read the same word as
 *      `lock.ts`'s `OPTIONAL_PHASES` while holding a DIFFERENT set (2 members vs 7) and meaning a
 *      different thing (a work claim vs a chain-traversal tolerance), so a reader could not tell which
 *      declaration was speaking — and the page that rendered both as a badge said as much. The two
 *      claims now have two names: MAY BE ABSENT (chain) and REQUIRED FOR COMPLETION (work).
 *
 *   2. SETTLED IS NOT "LOCKED" ANY MORE. A phase that was deliberately SKIPPED is a decision the run
 *      recorded, so it counts as settled — otherwise a legitimate skip would make a run permanently
 *      incomplete, which is the same dead end that made deleting the artifact look like the only way
 *      forward. The shape is unambiguous: a skip is only ever honoured on an artifact that EXISTS and
 *      says so in itself, while the fold's other SKIPPED statuses are synthesized for ABSENT phases
 *      only — so `exists && status === 'SKIPPED'` cannot be reached by a missing file, and a required
 *      phase that is merely absent still holds the run open (preserved, and asserted).
 *
 * Tamper facts ARE fs-recoverable and are derived by tampersOf above; gateBlocked and subagent
 * activity are not (recorded limitation; future enhancement).
 */
function runStateOf(status: ReturnType<typeof foldRun>): RecursiveRunState {
  const settled = (p: ReturnType<typeof foldRun>['phases'][number]) => p.lockValid || (p.exists && p.status === 'SKIPPED')
  const required = status.phases.filter(p => p.requiredForCompletion)
  const complete = required.every(settled)
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
