/**
 * Closeout standards check (FU-12b) — does every artifact in a run fit the required standard?
 *
 * ⚠ WHAT THIS IS FOR, in the user's words: *"phase 6 7 8 writes the state decisions memory artifacts, and
 * closeout just makes sure that all the artifacts fit the required standards."* The closeout does not author
 * the ledgers. It holds the run to the standard and reports what is missing.
 *
 * ⚠ WHY IT READS `phase-rules` INSTEAD OF KEEPING ITS OWN LIST: the required sections already have exactly
 * one home. `phase-rules.ts` owns them and is PROFILE-AWARE — it appends `AUDIT_REQUIRED_HEADINGS` for
 * audited artifacts under a strict workflow profile, and `Prior Recursive Evidence Reviewed` for the files
 * that need it. A private copy cannot match that, and this session has already produced three separate
 * defects from exactly that duplication (the closeout's own `REQUIRED_SECTIONS`, the 00–03 stubs, and the
 * `meta` block). So this module invents nothing: it asks the rules and reports the difference.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getLockStatus } from './lock.ts'
import { CURRENT_WORKFLOW_PROFILE, getArtifactRequiredSections } from './phase-rules.ts'
import { RUN_ARTIFACT_SEQUENCE, getGateStatus, hasHeading } from './ts-lint.ts'

/** Gate lines every phase document carries, as `Coverage: PASS|FAIL` / `Approval: PASS|FAIL`. */
const UNIVERSAL_GATES = ['Coverage', 'Approval'] as const

export interface StandardViolation {
  /** Run-relative artifact name, or the sequence entry that was absent. */
  artifact: string
  kind: 'missing-artifact' | 'missing-section' | 'gate-not-passing' | 'not-locked'
  /** What is wrong, spelled so a caller can print it without re-deriving anything. */
  detail: string
}

export interface StandardsReport {
  /** How many artifacts from the sequence were present and examined. */
  checked: number
  /** Artifacts in the sequence that do not exist yet — informational, not necessarily a failure. */
  absent: string[]
  violations: StandardViolation[]
}

export interface StandardsOptions {
  /** Workflow profile whose rules apply; defaults to the current one, as every caller does. */
  workflowProfile?: string
  /**
   * Report artifacts that are present but not LOCKED. **OFF by default**: a closeout runs mid-run and a DRAFT
   * artifact is the normal state, so treating it as a violation would make the check useless exactly when it
   * is most wanted. Callers that need an all-locked assertion ask for it.
   */
  requireLocked?: boolean
}

/**
 * Examine every artifact in the run against the phase rules.
 *
 * Reports, per present artifact: required headings that are missing, gate lines that are missing or FAIL, and
 * (only when `requireLocked`) a status that is not LOCKED. Absent artifacts are listed separately — during a
 * closeout most of the sequence legitimately does not exist yet, and conflating "not written yet" with
 * "written wrong" would bury the findings that matter.
 */
export function verifyRunStandards(runDir: string, options: StandardsOptions = {}): StandardsReport {
  const profile = options.workflowProfile ?? CURRENT_WORKFLOW_PROFILE
  const violations: StandardViolation[] = []
  const absent: string[] = []
  let checked = 0

  for (const artifact of RUN_ARTIFACT_SEQUENCE) {
    const path = join(runDir, artifact)
    if (!existsSync(path)) { absent.push(artifact); continue }
    checked += 1
    let content = ''
    try { content = readFileSync(path, 'utf8') } catch { continue }

    for (const heading of getArtifactRequiredSections(artifact, profile)) {
      if (!hasHeading(content, heading)) {
        violations.push({ artifact, kind: 'missing-section', detail: 'missing required section: ## ' + heading })
      }
    }
    for (const gate of UNIVERSAL_GATES) {
      const status = getGateStatus(content, gate)
      if (status !== 'PASS') {
        violations.push({ artifact, kind: 'gate-not-passing', detail: gate + ': ' + status })
      }
    }
    if (options.requireLocked === true) {
      const status = getLockStatus(path)
      if (status !== 'LOCKED') {
        violations.push({ artifact, kind: 'not-locked', detail: 'status is ' + status })
      }
    }
  }

  return { checked, absent, violations }
}

/** One line per violation, for a tool result or a CLI print. Empty when the run fits the standard. */
export function formatStandardsReport(report: StandardsReport): string[] {
  const lines = report.violations.map((v) => v.artifact + ': ' + v.detail)
  if (lines.length === 0) {
    return ['All ' + report.checked + ' present artifact(s) fit the required standards'
      + (report.absent.length > 0 ? ' (' + report.absent.length + ' not written yet)' : '') + '.']
  }
  return lines
}
