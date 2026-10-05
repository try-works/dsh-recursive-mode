export interface PhaseDef {
  key: string
  label: string
  file: string
  optional: boolean
  phaseName: string
}

export interface ArtifactState {
  exists: boolean
  status: string
  lockValid: boolean
  lockProblems: string[]
  blockers: string[]
  lockedAt: string | null
  storedHash: string | null
  actualHash: string | null
  coverage: string
  approval: string
  audit: string
  todoHasSection: boolean
  todoUnchecked: number
}

/**
 * T21 — ONE named position per phase, derived from the fields every consumer
 * currently recombines for itself (`status`, `lockValid`, `lockProblems`,
 * `blockers`). Two consumers recombining those independently is exactly how two
 * consumers come to disagree about a phase's state; a single derived value gives
 * them nothing to disagree about.
 *
 * Closed vocabulary, total and disjoint (see `phasePosition`):
 *   `absent`       the artifact does not exist
 *   `skipped`      an optional (or legacy-profile late) phase that is not present
 *   `draft`        present and unlocked, with no blockers
 *   `blocked`      present and unlocked, with at least one blocker
 *   `invalid-lock` LOCKED but failing a condition other than its hash
 *   `locked`       LOCKED and lock-valid
 *   `tampered`     LOCKED with a hash mismatch — the more serious fact, so it wins
 *                  over any other lock problem
 */
export type PhasePosition = 'absent' | 'skipped' | 'draft' | 'blocked' | 'invalid-lock' | 'locked' | 'tampered'

export const PHASE_POSITIONS: readonly PhasePosition[] = ['absent', 'skipped', 'draft', 'blocked', 'locked', 'invalid-lock', 'tampered']

export interface PhaseState {
  key: string
  label: string
  file: string
  optional: boolean
  exists: boolean
  status: string
  lockValid: boolean
  lockProblems: string[]
  blockers: string[]
  /** T21: the single derived state of this phase. */
  position: PhasePosition
}

export interface RecursiveStatusResult {
  runId: string
  currentPhase: { key: string; label: string; phaseName: string; status: string } | null
  phases: PhaseState[]
  workflowProfile: string
}

/* ================= Phase D wire vocabulary (run 06 R3, PROPOSAL 11.4-11.7) === */

/** Run-level durable state (mirrors lifecycle.ts RUN_STATES; single pure-type home for the wire). */
export type RecursiveRunState = 'new' | 'active' | 'paused' | 'blocked' | 'complete'

/** One locked-phase fact carried by a recursive/phase-locked event. */
export interface RecursivePhaseLock {
  lockedAt: string
  lockHash: string
}

/** One gate failure fact carried by a recursive/gate-blocked event. */
export interface RecursiveGateBlock {
  failures: string[]
  kind: string
}

/** One tamper fact carried by a recursive/tamper event. */
export interface RecursiveTamper {
  path: string
  reason: string
}

/**
 * T18 — one piece of unresolved in-flight work, DERIVED from the run directory
 * (there is no ledger). `unanswered-delegation` is a `handoff.md` with no reply
 * yet; `empty-reply` is a reply file that exists but carries nothing, which is
 * not a submission.
 */
export interface PendingWorkItem {
  kind: 'unanswered-delegation' | 'empty-reply'
  /** The delegation directory name, so a refusal can name what is blocking. */
  delegationId: string
  /** Repo-relative path of the file that would settle it, or of the handoff. */
  path: string
  /** One sentence for a human, naming the delegation and what is missing. */
  detail: string
}

/** One subagent activity fact (start or end). */
export interface RecursiveSubagent {
  childId: string
  role: string
  provider: string
  status?: 'running' | 'done' | 'failed'
}

/** One phase row in a run card's folded phase chain. */
export interface RecursivePhaseRow {
  phase: string
  status: string
  lockedAt?: string
  lockHash?: string
  /**
   * T21: the same single derived position `foldRun` publishes, carried onto the
   * wire so the board and the tooling cannot disagree about a phase's state.
   * Optional so a row produced before this field existed stays readable.
   */
  position?: PhasePosition
}

/**
 * The per-run wire card the recursive projection folds: the board, inspector,
 * node, and strip all render from this whole value — never from the file tree.
 */
export interface RecursiveRunCard {
  runId: string
  worktreeRoot: string
  repo?: string
  template?: string
  /** Folded phase chain: last-wins per phase key. */
  phases: Record<string, RecursivePhaseRow>
  /** Folded run-level state: last recursive/run-state wins (default 'active'). */
  state: RecursiveRunState
  stateReason?: string
  /** Latest gate block (last-wins); absent when no block is in force. */
  gateBlocked?: RecursiveGateBlock
  /** Tamper facts (accumulated, latest wins per path). */
  tampers: Record<string, RecursiveTamper>
  /** Subagent activity (latest status wins per childId). */
  subagents: Record<string, RecursiveSubagent>
  /**
   * T18: unresolved in-flight work, DERIVED from the run directory on every fold
   * (never stored). Optional so an older producer's card stays readable; the
   * folder always sets it. A non-empty array explains why a lock will be refused.
   */
  pendingWork?: PendingWorkItem[]
  /** Set on recursive/run-merged; the run re-keys to this root. */
  mergedToRepoRoot?: string
}

/**
 * The recursive projection whole value: runs grouped by worktree root first,
 * then by runId. The board renders one lane per run; the client enumerates by
 * worktree root so it never crosses the workspace boundary.
 */
export type RecursiveProjection = Record<string, Record<string, RecursiveRunCard>>
