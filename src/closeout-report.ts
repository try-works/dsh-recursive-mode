/**
 * Closeout report (FU-12) — the closeout as a LINTER, not a writer.
 *
 * ⚠ THE DESIGN, in the user's words: *"closeout.ts is supposed to verify whether the phase artifact docs
 * contain the scaffold information or not, then tell the agent to add it if not. It is not supposed to just
 * insert section titles into the docs. It is like a linter checking if the agent missed anything. It is not
 * supposed to edit files by itself."*
 *
 * ⚠ WHAT THIS MODULE THEREFORE DOES NOT DO: it opens no file for writing. The previous implementation called
 * `mkdirSync` and `writeFileSync` to compose a stub receipt over the phase artifact — and a probe in a temp
 * run folder showed what that costs: against a DRAFT `05-manual-qa.md` it RETURNED SUCCESS while the agent's
 * real QA content was GONE. A closeout runs BEFORE a phase locks, so that was the ordinary case, not an edge.
 *
 * ⚠ AND WHERE THE STANDARD COMES FROM: `phase-rules.ts` and `ts-lint.ts` already own it — required sections
 * (`getArtifactRequiredSections`, profile-aware), gate lines (`getGateStatus`), the artifact sequence
 * (`RUN_ARTIFACT_SEQUENCE`), and the guidance text to hand the agent (`phaseLintRulesMessage`). This module
 * adds no vocabulary of its own: three separate defects in this repo came from inventing a private copy of
 * something that already had one home.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getLockStatus } from './lock.ts'
import { CURRENT_WORKFLOW_PROFILE, phaseLintRulesMessage } from './phase-rules.ts'
import { RUN_ARTIFACT_SEQUENCE, getGateStatus, hasHeading } from './ts-lint.ts'
import { getPrerequisiteBlockers } from './lock.ts'
import { getRunTreeAddenda } from './ts-lint.ts'

/** Gate lines every phase document carries, written as `Coverage: PASS` / `Approval: PASS`. */
const UNIVERSAL_GATES = ['Coverage', 'Approval'] as const

/** The phase → artifact map. A LOOKUP, not a template: nothing here is ever rendered into a file. */
export const CLOSEOUT_PHASE_FILES: Record<string, { file: string; label: string }> = {
  '04': { file: '04-test-summary.md', label: '04 Test Summary' },
  '05': { file: '05-manual-qa.md', label: '05 Manual QA' },
  '06': { file: '06-decisions-update.md', label: '06 Decisions Update' },
  '07': { file: '07-state-update.md', label: '07 State Update' },
  '08': { file: '08-memory-impact.md', label: '08 Memory Impact' },
}

/** One thing the agent must add or fix before the artifact can lock. */
export interface CloseoutFinding {
  kind: 'missing-artifact' | 'missing-section' | 'gate-not-passing'
  /** Directory-ready: what is wrong, in the words the agent should act on. */
  detail: string
}

export interface CloseoutReport {
  phase: string
  artifact: string
  label: string
  exists: boolean
  /** `LOCKED`, `DRAFT`, `STALE_LOCK`, `MISSING` — from the same reader the lock tool uses. */
  status: string
  /** Empty means the artifact fits the standard; the caller tells the agent only when it is not. */
  findings: CloseoutFinding[]
  /**
   * Advisory only: earlier artifacts that are not yet LOCKED. **Not a refusal** — the reference treats these
   * as warnings (*"hard enforcement happens at lock time"*), and a closeout that refuses here cannot do the
   * one thing it exists for.
   */
  prerequisites: Array<{ artifact: string; status: string }>
  /** The rules text to hand the agent, straight from the rules module. */
  guidance: string[]
  /** Addenda found anywhere in the run tree — cited as evidence, never written to. */
  addenda: string[]
}

export interface CloseoutReportOptions {
  workflowProfile?: string
  /** Include the advisory prerequisite list. Default true. */
  checkPrerequisites?: boolean
}

/**
 * Examine one phase artifact and report what it is missing. **Reads only.**
 *
 * An absent artifact is a finding rather than an error: the closeout's job is to say what should be there,
 * and "not written yet" is the most useful thing it can tell an agent at phase entry.
 */
export function closeoutReport(runDir: string, phase: string, options: CloseoutReportOptions = {}): CloseoutReport {
  const entry = CLOSEOUT_PHASE_FILES[phase]
  if (!entry) {
    throw new Error('Unsupported closeout phase: ' + phase + ' (expected one of '
      + Object.keys(CLOSEOUT_PHASE_FILES).join(', ') + ')')
  }
  const profile = options.workflowProfile ?? CURRENT_WORKFLOW_PROFILE
  const path = join(runDir, entry.file)
  const exists = existsSync(path)
  const findings: CloseoutFinding[] = []
  let status = 'MISSING'
  let content = ''

  if (!exists) {
    findings.push({
      kind: 'missing-artifact',
      detail: entry.file + ' does not exist yet; write it before this phase can lock',
    })
  } else {
    status = getLockStatus(path)
    try { content = readFileSync(path, 'utf8') } catch { content = '' }
    // The standard, asked of the module that owns it — never a private copy.
    const required = requiredSectionsFor(entry.file, profile)
    for (const heading of required) {
      if (!hasHeading(content, heading)) {
        findings.push({ kind: 'missing-section', detail: 'add the `## ' + heading + '` section and fill it in' })
      }
    }
    for (const gate of UNIVERSAL_GATES) {
      const gateStatus = getGateStatus(content, gate)
      if (gateStatus !== 'PASS') {
        findings.push({ kind: 'gate-not-passing', detail: gate + ' gate reads ' + gateStatus + '; it must read PASS' })
      }
    }
  }

  const prerequisites = (options.checkPrerequisites ?? true)
    ? getPrerequisiteBlockers(runDir, entry.file).map((b) => ({ artifact: b.artifact, status: b.status }))
    : []

  return {
    phase,
    artifact: entry.file,
    label: entry.label,
    exists,
    status,
    findings,
    prerequisites,
    guidance: guidanceFor(entry.file, profile),
    addenda: getRunTreeAddenda(runDir),
  }
}

/**
 * The required sections for an artifact, from the rules module.
 *
 * Kept behind a local indirection so the report has ONE place to change if the rules API moves, and so the
 * import stays named where a reader looks for the standard.
 */
function requiredSectionsFor(file: string, profile: string): string[] {
  return getArtifactRequiredSectionsImpl(file, profile)
}

/** The guidance text for an artifact, from the rules module. */
function guidanceFor(file: string, profile: string): string[] {
  const message = phaseLintRulesMessage(file, profile)
  if (Array.isArray(message)) return message.map((line) => String(line))
  return String(message).split('\n').filter((line) => line.trim() !== '')
}

// Imported this way so the rules dependency is visible as a single seam in the two helpers above.
import { getArtifactRequiredSections as getArtifactRequiredSectionsImpl } from './phase-rules.ts'

/** Anything in the run's artifact sequence that this report does not cover, for a whole-run sweep. */
export function uncoveredArtifacts(): string[] {
  const covered = new Set(Object.values(CLOSEOUT_PHASE_FILES).map((e) => e.file))
  return RUN_ARTIFACT_SEQUENCE.filter((name) => !covered.has(name))
}
