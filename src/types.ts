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
  /** Set on recursive/run-merged; the run re-keys to this root. */
  mergedToRepoRoot?: string
}

/**
 * The recursive projection whole value: runs grouped by worktree root first,
 * then by runId. The board renders one lane per run; the client enumerates by
 * worktree root so it never crosses the workspace boundary.
 */
export type RecursiveProjection = Record<string, Record<string, RecursiveRunCard>>
