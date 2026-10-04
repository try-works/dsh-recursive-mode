import { describe, it, expect } from 'vitest'
import { getArtifactRequiredSections } from '../src/phase-rules.ts'

const EXPECTED: Record<string, string[]> = {
  '00-requirements.md': ['TODO','Requirements','Out of Scope','Constraints','Coverage Gate','Approval Gate'],
  '00-worktree.md': ['TODO','Directory Selection','Safety Verification','Worktree Creation','Main Branch Protection','Project Setup','Test Baseline Verification','Worktree Context','Diff Basis For Later Audits','Traceability','Coverage Gate','Approval Gate'],
  '01-as-is.md': ['TODO','Reproduction Steps (Novice-Runnable)','Current Behavior by Requirement','Source Requirement Inventory','Relevant Code Pointers','Known Unknowns','Evidence','Traceability','Coverage Gate','Approval Gate','Audit Context','Effective Inputs Re-read','Earlier Phase Reconciliation','Subagent Contribution Verification','Worktree Diff Audit','Gaps Found','Repair Work Performed','Requirement Completion Status','Audit Verdict','Prior Recursive Evidence Reviewed'],
  '01.5-root-cause.md': ['TODO','Error Analysis','Reproduction Verification','Recent Changes Analysis','Evidence Gathering (Multi-Layer if applicable)','Data Flow Trace','Pattern Analysis','Hypothesis Testing','Root Cause Summary','Traceability','Coverage Gate','Approval Gate','Audit Context','Effective Inputs Re-read','Earlier Phase Reconciliation','Subagent Contribution Verification','Worktree Diff Audit','Gaps Found','Repair Work Performed','Requirement Completion Status','Audit Verdict'],
  '02-to-be-plan.md': ['TODO','Planned Changes by File','Requirement Mapping','Implementation Steps','Testing Strategy','Playwright Plan (if applicable)','Manual QA Scenarios','Idempotence and Recovery','Implementation Sub-phases','Plan Drift Check','Traceability','Coverage Gate','Approval Gate','Audit Context','Effective Inputs Re-read','Earlier Phase Reconciliation','Subagent Contribution Verification','Worktree Diff Audit','Gaps Found','Repair Work Performed','Requirement Completion Status','Audit Verdict','Prior Recursive Evidence Reviewed'],
  '03-implementation-summary.md': ['TODO','Changes Applied','TDD Compliance Log','Plan Deviations','Implementation Evidence','Traceability','Coverage Gate','Approval Gate','Audit Context','Effective Inputs Re-read','Earlier Phase Reconciliation','Subagent Contribution Verification','Worktree Diff Audit','Gaps Found','Repair Work Performed','Requirement Completion Status','Audit Verdict'],
  '03.5-code-review.md': ['TODO','Review Scope','Plan Alignment Assessment','Code Quality Assessment','Issues Found','Verdict','Review Metadata','Traceability','Coverage Gate','Approval Gate','Audit Context','Effective Inputs Re-read','Earlier Phase Reconciliation','Subagent Contribution Verification','Worktree Diff Audit','Gaps Found','Repair Work Performed','Requirement Completion Status','Audit Verdict'],
  '04-test-summary.md': ['TODO','Pre-Test Implementation Audit','Environment','Execution Mode','Commands Executed (Exact)','Results Summary','Evidence and Artifacts','Failures and Diagnostics (if any)','Flake/Rerun Notes','Traceability','Coverage Gate','Approval Gate','Audit Context','Effective Inputs Re-read','Earlier Phase Reconciliation','Subagent Contribution Verification','Worktree Diff Audit','Gaps Found','Repair Work Performed','Requirement Completion Status','Audit Verdict','Prior Recursive Evidence Reviewed'],
  '05-manual-qa.md': ['TODO','QA Execution Record','QA Scenarios and Results','Evidence and Artifacts','User Sign-Off','Traceability','Coverage Gate','Approval Gate'],
  '06-decisions-update.md': ['TODO','Decisions Changes Applied','Rationale','Resulting Decision Entry','Traceability','Coverage Gate','Approval Gate','Audit Context','Effective Inputs Re-read','Earlier Phase Reconciliation','Subagent Contribution Verification','Worktree Diff Audit','Gaps Found','Repair Work Performed','Requirement Completion Status','Audit Verdict'],
  '07-state-update.md': ['TODO','State Changes Applied','Rationale','Resulting State Summary','Traceability','Coverage Gate','Approval Gate','Audit Context','Effective Inputs Re-read','Earlier Phase Reconciliation','Subagent Contribution Verification','Worktree Diff Audit','Gaps Found','Repair Work Performed','Requirement Completion Status','Audit Verdict','Prior Recursive Evidence Reviewed'],
  '08-memory-impact.md': ['TODO','Diff Basis','Changed Paths Review','Affected Memory Docs','Run-Local Skill Usage Capture','Skill Memory Promotion Review','Uncovered Paths','Router and Parent Refresh','Final Status Summary','Traceability','Coverage Gate','Approval Gate','Audit Context','Effective Inputs Re-read','Earlier Phase Reconciliation','Subagent Contribution Verification','Worktree Diff Audit','Gaps Found','Repair Work Performed','Requirement Completion Status','Audit Verdict','Prior Recursive Evidence Reviewed'],
}

describe('phase-rules parity (canonical lint-recursive-run.py get_artifact_required_sections)', () => {
  for (const [file, sections] of Object.entries(EXPECTED)) {
    it(file + ' matches canonical sections', () => {
      expect(getArtifactRequiredSections(file, 'recursive-mode-audit-v2')).toEqual(sections)
    })
  }
  it('unknown file defaults to TODO + gates', () => {
    expect(getArtifactRequiredSections('unknown.md', 'recursive-mode-audit-v2')).toEqual(['TODO', 'Coverage Gate', 'Approval Gate'])
  })
  it('non-strict profile omits audit headings', () => {
    const got = getArtifactRequiredSections('01-as-is.md', 'memory-phase8')
    expect(got).not.toContain('Audit Verdict')
  })
})
