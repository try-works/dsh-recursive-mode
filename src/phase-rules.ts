/**
 * Phase rules (R5): canonical parity port of lint-recursive-run.py's
 * get_artifact_required_sections + workflow/audit constants. Single source of
 * truth for per-phase required section headings and audit extras; consumed by
 * initRun templates, renderRecursivePolicy, and the pre-step lint-rules
 * injection. Values are byte-identical to the canonical linter (recursive-
 * mode-audit-v2).
 */

export const CURRENT_WORKFLOW_PROFILE = 'recursive-mode-audit-v2'
export const STRICT_WORKFLOW_PROFILE = 'recursive-mode-audit-v1'
export const COMPAT_WORKFLOW_PROFILE = 'memory-phase8'
export const STRICT_WORKFLOW_PROFILES = new Set([CURRENT_WORKFLOW_PROFILE, STRICT_WORKFLOW_PROFILE])

export const LATE_PHASE_ARTIFACTS = ['06-decisions-update.md', '07-state-update.md', '08-memory-impact.md']

export const AUDITED_PHASE_FILES = new Set([
  '01-as-is.md',
  '01.5-root-cause.md',
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '06-decisions-update.md',
  '07-state-update.md',
  '08-memory-impact.md',
])

export const PRIOR_RECURSIVE_EVIDENCE_FILES = new Set([
  '01-as-is.md',
  '02-to-be-plan.md',
  '04-test-summary.md',
  '07-state-update.md',
  '08-memory-impact.md',
])

export const DIFF_AUDITED_FILES = new Set([
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '06-decisions-update.md',
  '07-state-update.md',
  '08-memory-impact.md',
])

export const TRACEABILITY_REQUIRED_FILES = new Set([
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
])

export const AUDIT_REQUIRED_HEADINGS = [
  'Audit Context',
  'Effective Inputs Re-read',
  'Earlier Phase Reconciliation',
  'Subagent Contribution Verification',
  'Worktree Diff Audit',
  'Gaps Found',
  'Repair Work Performed',
  'Requirement Completion Status',
  'Audit Verdict',
]

export const DIFF_BASIS_FIELDS = [
  'Baseline type',
  'Baseline reference',
  'Comparison reference',
  'Normalized baseline',
  'Normalized comparison',
  'Normalized diff command',
]

const SECTION_MAP: Record<string, string[]> = {
  '00-worktree.md': [
    'TODO',
    'Directory Selection',
    'Safety Verification',
    'Worktree Creation',
    'Main Branch Protection',
    'Project Setup',
    'Test Baseline Verification',
    'Worktree Context',
    'Diff Basis For Later Audits',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '00-requirements.md': [
    'TODO',
    'Requirements',
    'Out of Scope',
    'Constraints',
    'Coverage Gate',
    'Approval Gate',
  ],
  '01-as-is.md': [
    'TODO',
    'Reproduction Steps (Novice-Runnable)',
    'Current Behavior by Requirement',
    'Source Requirement Inventory',
    'Relevant Code Pointers',
    'Known Unknowns',
    'Evidence',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '01.5-root-cause.md': [
    'TODO',
    'Error Analysis',
    'Reproduction Verification',
    'Recent Changes Analysis',
    'Evidence Gathering (Multi-Layer if applicable)',
    'Data Flow Trace',
    'Pattern Analysis',
    'Hypothesis Testing',
    'Root Cause Summary',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '02-to-be-plan.md': [
    'TODO',
    'Planned Changes by File',
    'Requirement Mapping',
    'Implementation Steps',
    'Testing Strategy',
    'Playwright Plan (if applicable)',
    'Manual QA Scenarios',
    'Idempotence and Recovery',
    'Implementation Sub-phases',
    'Plan Drift Check',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '03-implementation-summary.md': [
    'TODO',
    'Changes Applied',
    'TDD Compliance Log',
    'Plan Deviations',
    'Implementation Evidence',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '03.5-code-review.md': [
    'TODO',
    'Review Scope',
    'Plan Alignment Assessment',
    'Code Quality Assessment',
    'Issues Found',
    'Verdict',
    'Review Metadata',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '04-test-summary.md': [
    'TODO',
    'Pre-Test Implementation Audit',
    'Environment',
    'Execution Mode',
    'Commands Executed (Exact)',
    'Results Summary',
    'Evidence and Artifacts',
    'Failures and Diagnostics (if any)',
    'Flake/Rerun Notes',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '05-manual-qa.md': [
    'TODO',
    'QA Execution Record',
    'QA Scenarios and Results',
    'Evidence and Artifacts',
    'User Sign-Off',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '06-decisions-update.md': [
    'TODO',
    'Decisions Changes Applied',
    'Rationale',
    'Resulting Decision Entry',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '07-state-update.md': [
    'TODO',
    'State Changes Applied',
    'Rationale',
    'Resulting State Summary',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '08-memory-impact.md': [
    'TODO',
    'Diff Basis',
    'Changed Paths Review',
    'Affected Memory Docs',
    'Run-Local Skill Usage Capture',
    'Skill Memory Promotion Review',
    'Uncovered Paths',
    'Router and Parent Refresh',
    'Final Status Summary',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
}

/**
 * get_artifact_required_sections(file_name, workflow_profile): canonical-parity
 * required section headings for a phase artifact. Defaults to TODO + Coverage
 * Gate + Approval Gate for unknown files. Audited phases in strict profiles get
 * the audit headings appended (plus Prior Recursive Evidence Reviewed for the
 * prior-evidence file set).
 */
export function getArtifactRequiredSections(fileName: string, workflowProfile: string = CURRENT_WORKFLOW_PROFILE): string[] {
  const headings = [...(SECTION_MAP[fileName] ?? ['TODO', 'Coverage Gate', 'Approval Gate'])]
  if (STRICT_WORKFLOW_PROFILES.has(workflowProfile) && AUDITED_PHASE_FILES.has(fileName)) {
    headings.push(...AUDIT_REQUIRED_HEADINGS)
    if (PRIOR_RECURSIVE_EVIDENCE_FILES.has(fileName)) {
      headings.push('Prior Recursive Evidence Reviewed')
    }
  }
  return headings
}

/**
 * LIVE BUG 6 (0.2.1): dedup gate for the agent/pre-step lint-rules reminder.
 * Keyed by (root, runId, phase) so each new run or phase transition gets its own
 * single injection, while re-arming steps in the SAME phase stay silent. Scoped
 * to the apply() effect/fiber lifetime (one instance per mount), matching the
 * repairedRoots dedup used by the scaffold repair above the injection point.
 */
export class ReminderOnceGate {
  private seen = new Set<string>()

  shouldInject(root: string, runId: string, phase: string): boolean {
    const key = root + '\u0000' + runId + '\u0000' + phase
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}

/**
 * Structured, single-source-of-truth rules for one phase (refined LIVE BUG 6
 * design): consumed by BOTH the recursive_phase tool and the once-per-phase
 * pre-step reminder. Derived from the canonical artifact-template sections.
 */
export interface PhaseRules {
  fileName: string
  label: string
  requiredSections: string[]
  audited: boolean
  tdd: boolean
  qa: boolean
}

export function phaseRulesFor(fileName: string, workflowProfile: string = CURRENT_WORKFLOW_PROFILE): PhaseRules {
  return {
    fileName,
    label: fileName.replace(/\.md$/, ''),
    requiredSections: getArtifactRequiredSections(fileName, workflowProfile),
    audited: AUDITED_PHASE_FILES.has(fileName),
    tdd: fileName === '03-implementation-summary.md',
    qa: fileName === '05-manual-qa.md',
  }
}

/**
 * Compact lint-rules message for the pre-step injection (R5): this phase's
 * required sections + phase-specific gate notes, built from phaseRulesFor
 * (single source of truth with the recursive_phase tool). Output is unchanged
 * from the prior inline build so r5-parity.spec.ts stays green.
 */
export function phaseLintRulesMessage(fileName: string, workflowProfile: string = CURRENT_WORKFLOW_PROFILE): string {
  const rules = phaseRulesFor(fileName, workflowProfile)
  const lines = [
    '<system-reminder>',
    'Recursive-mode phase lint rules for THIS phase (' + fileName + '):',
    'Required sections: ' + rules.requiredSections.join(' | '),
    'Gates: Coverage: FAIL until all checkboxes pass; Approval: FAIL until user sign-off; lock only via recursive_lock (monotonic).',
    'Audited phases: end with Audit: PASS before setting Coverage/Approval PASS; record Audit Context and Audit Verdict.',
    'TDD (phase 3): declare TDD Mode: strict|pragmatic; strict requires RED + GREEN evidence paths.',
    'QA (phase 5): declare QA Execution Mode: human|agent-operated|hybrid; human/hybrid need user sign-off.',
    '</system-reminder>',
  ]
  return lines.join('\n')
}
