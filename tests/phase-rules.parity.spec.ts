import { describe, it, expect } from 'vitest'
import {
  REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS,
  REVIEW_BUNDLE_REQUIRED_SECTIONS,
  REVIEW_BUNDLE_SECTION_FORMAT_RULES,
  SECTION_FORMAT_RULES,
  getArtifactRequiredSections,
} from '../src/phase-rules.ts'

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

/**
 * ⚠ NO PINNED LIST MOVED FOR THE FORMAT GUIDANCE, and this is the assertion that keeps it that way.
 *
 * The twelve lists above are byte-parity with the canonical linter's `get_artifact_required_sections`, so the
 * only safe way to tell an agent HOW to write an entry row was to add guidance BESIDE those lists rather than
 * a section to them. `SECTION_FORMAT_RULES` is therefore keyed by artifact and may only name artifacts and
 * sections this spec already pins: a table entry for an artifact outside the canonical twelve, or a rule for
 * a section the artifact does not require, is guidance nobody can act on — and, in the second case, a hint
 * that would have had to move a parity list to be reachable.
 */
describe('phase-rules parity — the format guidance rides the canonical lists, never extends them', () => {
  it('names no artifact outside the canonical twelve', () => {
    for (const file of Object.keys(SECTION_FORMAT_RULES)) {
      expect(Object.keys(EXPECTED), 'SECTION_FORMAT_RULES key ' + file).toContain(file)
    }
  })

  it('describes only sections the pinned list for that artifact already requires', () => {
    for (const [file, rules] of Object.entries(SECTION_FORMAT_RULES)) {
      for (const rule of rules) {
        expect(EXPECTED[file], file + ' :: ' + rule.section).toContain(rule.section)
      }
      // And the FUNCTION and the PIN still agree for that artifact, so the table cannot be describing a
      // list other than the one this spec pins.
      expect(getArtifactRequiredSections(file, 'recursive-mode-audit-v2')).toEqual(EXPECTED[file])
    }
  })

  /**
   * ⚠ AND THE REVIEW BUNDLE'S RULES ARE NOT IN THAT TABLE, WHICH IS THE WHOLE REASON IT IS A SECOND TABLE.
   *
   * `SECTION_FORMAT_RULES` may only describe a section the phase artifact REQUIRES (asserted above, against the
   * pinned canonical lists). The review bundle is a different file whose headings — `## Diff Basis`,
   * `## Upstream Artifacts To Re-read`, `## Changed Files Reviewed` — are required in NO phase artifact, so a
   * bundle row could only have entered that table by MOVING A PIN. This spec is the assertion that no pin
   * moved: the bundle rows carry their own key (`REVIEW_BUNDLE_SECTION_FORMAT_RULES`), they name the linter's
   * own list, and the phase-artifact table's shape is byte-identical to what it was.
   */
  describe('phase-rules parity — the review bundle rides its own table, and no pin moved for it', () => {
    it('the bundle table adds NOTHING to the artifact-keyed table, and no pin moved for it', () => {
      // ⚠ THE ONE NAME THAT EXISTS IN BOTH TABLES IS `Diff Basis`, AND THE COLLISION IS WHY `appliesTo` EXISTS
      // RATHER THAN A KEY. `## Diff Basis` IS a canonical section of `08-memory-impact.md` — so a rule keyed by
      // section name alone could not distinguish the bundle's diff basis from that artifact's — and it is NOT
      // one of `03.5-code-review.md`. The assertion is therefore not "the names are disjoint" (they are not) but
      // the property that matters: the artifact-keyed table gained no key, and `03.5-code-review.md`'s own rows
      // are byte-for-byte what they were.
      const exemption = '05-manual-qa.md'
      expect(EXPECTED[exemption], exemption + ' has checked sections and deliberately NO format table').toBeDefined()
      expect(EXPECTED[exemption]).not.toContain('Diff Basis')
      expect(Object.keys(SECTION_FORMAT_RULES).sort()).toEqual(Object.keys(EXPECTED).filter((file) => file !== exemption).sort())
      expect(Object.keys(SECTION_FORMAT_RULES), exemption + ' must stay OUT of the format table').not.toContain(exemption)
      expect(SECTION_FORMAT_RULES['03.5-code-review.md']?.map((rule) => rule.section)).toEqual(['Requirement Completion Status'])
      // The collision is real and named, so a reader is not left to discover it:
      expect(EXPECTED['08-memory-impact.md']).toContain('Diff Basis')
      expect(EXPECTED['03.5-code-review.md']).not.toContain('Diff Basis')
      // ...and it is the ONLY name the two tables share, which is what keeps `appliesTo` sufficient.
      const artifactSections = new Set(Object.values(EXPECTED).flat())
      const bundleSections = REVIEW_BUNDLE_SECTION_FORMAT_RULES.map((rule) => rule.section)
      expect(bundleSections.filter((section) => artifactSections.has(section))).toEqual(['Diff Basis'])
    })

    it('every row of the artifact-keyed table still names a section its own pinned list requires', () => {
      for (const [file, rules] of Object.entries(SECTION_FORMAT_RULES)) {
        for (const rule of rules) {
          expect(EXPECTED[file], file + ' :: ' + rule.section).toContain(rule.section)
        }
      }
    })

    it('the bundle table covers every check the linter requires of the bundle, header fields included', () => {
      // ⚠ `## Required Output` IS THE ONE EXEMPTION and it is enumerated as a literal here rather than read from
      // the table, so removing its exemption from the guidance cannot silently remove it from this assertion.
      const exempt = ['Required Output']
      const described = REVIEW_BUNDLE_SECTION_FORMAT_RULES
        .filter((rule) => rule.appliesTo === 'review-bundle')
        .map((rule) => rule.section)
      for (const section of REVIEW_BUNDLE_REQUIRED_SECTIONS) {
        if (exempt.includes(section)) {
          expect(described, section + ' is exempt: the linter checks only that it EXISTS').not.toContain(section)
          continue
        }
        expect(described, 'the linter requires ## ' + section + ' of the review bundle').toContain(section)
      }
      for (const field of REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS) {
        expect(described, 'the linter requires the ' + field + ' header field').toContain(field)
      }
      // ...and NOTHING ELSE, so a rule for a heading no check reads is caught here rather than shipped as a
      // fifth surface describing a check that does not run.
      expect([...described].sort()).toEqual([
        ...REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS,
        ...[...REVIEW_BUNDLE_REQUIRED_SECTIONS].filter((section) => !exempt.includes(section)),
      ].sort())
    })
  })
})
