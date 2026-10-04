/**
 * Transition gate validation + goal coupling (Phase C R1/R2/R6, PROPOSAL 8.4).
 *
 * Live BUG dsh-v0.1.1-rc.2 compatibility (0.2.2): the legacy session-event fold
 * surface (foldRecursivePhase / detectTransitionIntent / hasOpenTurn /
 * LifecycleDriver / the recursive/* event payload interfaces) was REMOVED.
 * The plugin is zero-emission: no recursive/* session event is ever appended
 * or emitted, so nothing folds them. What remains is the pure transition gate
 * check (validateTransition — reads the file tree + lock chain, writes nothing)
 * plus the shared intent/result types and the goal-coupling no-op helper.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPrerequisiteBlockers, getLockStatus } from './lock.ts'
import { getMdFieldValue, getGateStatus } from './status.ts'

/** Run-level durable states (PROPOSAL 8.8). */
export const RUN_STATES = ['new', 'active', 'paused', 'blocked', 'complete'] as const
export type RunState = (typeof RUN_STATES)[number]

/** A proposed phase transition the gates validate before any file write. */
export interface PhaseTransitionIntent {
  runId: string
  worktreeRoot: string
  targetArtifact: string
  kind: 'lock' | 'reopen' | 'advance'
  evidence?: {
    tddMode?: string
    redEvidencePath?: string
    greenEvidencePath?: string
    qaMode?: string
    qaSignOff?: boolean
  }
}

/** Folded phase state (run key + current phase + current run-level state). */
export interface RecursivePhaseState {
  runId: string
  phase: string
  status: string
  runState: RunState
}

/** Gate check result - the transition set's single output. */
export interface GateCheckResult {
  passed: boolean
  failures: string[]
}

/** The audited phase files whose lock requires Audit: PASS (parity with status.ts). */
const AUDITED_PHASE_FILES = new Set([
  '01-as-is.md', '01.5-root-cause.md', '02-to-be-plan.md', '03-implementation-summary.md',
  '03.5-code-review.md', '04-test-summary.md', '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md',
])

/**
 * Validate a proposed transition against the target phase's gates (PROPOSAL 8.4).
 * Pure: reads the current file tree + lock.ts chain; writes nothing.
 */
export function validateTransition(intent: PhaseTransitionIntent): GateCheckResult {
  const failures: string[] = []
  const runDir = join(intent.worktreeRoot, '.recursive', 'run', intent.runId)
  const artifactPath = join(runDir, intent.targetArtifact)

  if (intent.kind === 'reopen') {
    const status = getLockStatus(artifactPath)
    if (status !== 'LOCKED') failures.push('reopen requires a LOCKED artifact (current: ' + status + ')')
    return { passed: failures.length === 0, failures }
  }

  // 1. Phase doc exists.
  if (!existsSync(artifactPath)) {
    failures.push('phase doc does not exist: ' + intent.targetArtifact)
    return { passed: false, failures }
  }

  const content = readFileSync(artifactPath, 'utf8')

  // 2. Monotonic gating (parity with recursive-lock.py).
  const blockers = getPrerequisiteBlockers(runDir, intent.targetArtifact)
  for (const b of blockers) failures.push('unlocked prerequisite: ' + b.artifact + ' (' + b.status + ')')

  // 3. TDD evidence (Phase 3).
  if (intent.targetArtifact === '03-implementation-summary.md') {
    const tddMode = getMdFieldValue(content, 'TDD Mode') ?? intent.evidence?.tddMode ?? ''
    if (tddMode === 'strict') {
      const red = intent.evidence?.redEvidencePath ?? ''
      const green = intent.evidence?.greenEvidencePath ?? ''
      if (!red || !existsSync(join(runDir, red))) failures.push('TDD Mode: strict requires a RED evidence path')
      if (!green || !existsSync(join(runDir, green))) failures.push('TDD Mode: strict requires a GREEN evidence path')
    } else if (tddMode === 'pragmatic') {
      if (!/rationale/i.test(content)) failures.push('TDD Mode: pragmatic requires an exception rationale')
    } else {
      failures.push('TDD Mode must be declared strict|pragmatic')
    }
  }

  // 4. Audit closed (audited phases).
  if (AUDITED_PHASE_FILES.has(intent.targetArtifact)) {
    if (getGateStatus(content, 'Audit') !== 'PASS') failures.push('audited phase must end with Audit: PASS')
    if (!/Requirement Completion Status/.test(content)) failures.push('audited phase requires a Requirement Completion Status section')
    if (!/Delegation Decision Basis|Delegation Override Reason|Subagent Capability Probe/.test(content)) {
      failures.push('audited phase requires Delegation Decision Basis / Subagent Capability Probe')
    }
  }

  // 5. QA sign-off (Phase 5).
  if (intent.targetArtifact === '05-manual-qa.md') {
    const qaMode = getMdFieldValue(content, 'QA Execution Mode') ?? intent.evidence?.qaMode ?? ''
    if (!qaMode) failures.push('QA Execution Mode must be declared human|agent-operated|hybrid')
    else if ((qaMode === 'human' || qaMode === 'hybrid') && intent.evidence?.qaSignOff !== true) {
      failures.push('QA Execution Mode ' + qaMode + ' requires user sign-off')
    }
  }

  // 6. Effective inputs re-read.
  if (!/Effective Inputs Re-read/.test(content)) failures.push('phase doc must re-read effective inputs (## Effective Inputs Re-read)')

  return { passed: failures.length === 0, failures }
}

/**
 * Couple a gate-block to the goal service (PROPOSAL 8.4 goal integration).
 * Graceful no-op when the goal service or agent is unavailable.
 */
export function coupleGateBlockToGoal(
  goalService: { block?: (agent: unknown, ref: unknown, reason: unknown) => unknown } | null | undefined,
  agent: unknown,
  ref: unknown,
  reason: { code: string; message: string },
): boolean {
  if (!goalService || typeof goalService.block !== 'function' || !agent) return false
  goalService.block(agent, ref, reason)
  return true
}
