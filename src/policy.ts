/**
 * recursive:policy prompt-section renderer (Phase C R5, PROPOSAL 8.4 Layer 3).
 * Renders the CURRENT phase's contract from folded state + enforcement config:
 * what must exist before advancing, which tools are denied/asked this phase,
 * the strict/pragmatic TDD mode, the QA mode, the lock chain, and (R5) the
 * current phase's required sections + gate checklist — the same rules the
 * machine gates enforce (no prompt/gate contradiction).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PHASE_SEQUENCE, getLockStatus } from './lock.ts'
import { foldRun } from './status.ts'
import type { RecursivePhaseState } from './lifecycle.ts'
import type { EnforcementConfig } from './enforcement.ts'
import { DEFAULT_ENFORCEMENT } from './enforcement.ts'
import { getArtifactRequiredSections, AUDITED_PHASE_FILES, CURRENT_WORKFLOW_PROFILE } from './phase-rules.ts'

export interface PolicyContext {
  worktreeRoot: string
  runId: string
  folded?: RecursivePhaseState | null
  config?: EnforcementConfig
}

/**
 * Render the current-phase contract. Empty string when no run is active.
 */
export function renderRecursivePolicy(context: PolicyContext | null): string {
  if (!context || !context.runId) return ''
  const runDir = join(context.worktreeRoot, '.recursive', 'run', context.runId)
  const folded = context.folded ?? null
  const config = context.config ?? DEFAULT_ENFORCEMENT

  // Derive the current phase from files (never trust an unchecked fold).
  let currentPhase = folded?.phase ?? ''
  let nextRequired = ''
  let currentFile = ''
  const status = existsSync(runDir) ? foldRun(runDir, context.runId) : null
  if (status?.currentPhase) {
    currentPhase = status.currentPhase.label + ' (' + status.currentPhase.status + ')'
    nextRequired = status.currentPhase.phaseName + ' (' + status.currentPhase.key + ')'
    currentFile = status.currentPhase.phaseName
  }

  const strictness = (gate: EnforcementConfig[keyof EnforcementConfig]) => gate
  const lines = [
    'You are in a recursive-mode session (enforcement active).',
    '- Current phase: ' + (currentPhase || 'unknown'),
    '- Next required artifact: ' + (nextRequired || 'none - run complete'),
    '- Lock chain: phases lock monotonically (' + PHASE_SEQUENCE.join(' -> ') + ').',
    '- Gates in force: pre-step ' + strictness(config.preStep) + ', tool guards ' + strictness(config.toolGuards) + ', tamper ' + strictness(config.tamper) + '.',
    '- A transition that fails its gates is BLOCKED (strict) or warns (advisory); no rejected transition advances state.',
    '- Writes to a Status: LOCKED phase doc are denied/asked; reopen explicitly to edit.',
    '- Phase 3 lock requires TDD evidence (strict) or rationale (pragmatic); Phase 5 requires QA sign-off for human/hybrid modes.',
    '- The control-plane root is resolved STRICTLY from this session workspace (never scan other workspaces).',
    '- Scratch is disposable, git-ignored, and never citable as an Input.',
    '- The workflow spec lives at /.recursive/RECURSIVE.md; bootstrap it when missing.',
    '- Call recursive_phase when entering a new phase; the same rules are auto-injected once per phase transition.',
  ];

  // R5: surface the current phase's required sections + gate checklist.
  if (currentFile) {
    const sections = getArtifactRequiredSections(currentFile, CURRENT_WORKFLOW_PROFILE)
    lines.push('');
    lines.push('## This phase (' + currentFile + ') required sections (canonical lint):');
    lines.push('- ' + sections.join(' | '));
    lines.push('## This phase gate checklist:');
    lines.push('- Coverage: FAIL until every checklist item is done; Approval: FAIL until sign-off; lock only via recursive_lock (monotonic).');
    if (AUDITED_PHASE_FILES.has(currentFile)) {
      lines.push('- Audited phase: end with Audit: PASS before setting Coverage/Approval PASS; record Audit Context + Audit Verdict.');
    }
    if (currentFile === '03-implementation-summary.md') {
      lines.push('- TDD Mode: strict|pragmatic; strict requires RED + GREEN evidence paths.');
    }
    if (currentFile === '05-manual-qa.md') {
      lines.push('- QA Execution Mode: human|agent-operated|hybrid; human/hybrid require user sign-off.');
    }
  }

  return lines.join('\n')
}