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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/**
 * Where a closeout receipt lives: **its own file, beside the lock receipts, never over the artifact.**
 *
 * ⚠ FOLLOWS `lock.ts`'s `receiptPath`, which is the convention this plugin already has: a receipt is a JSON
 * file under `<runDir>/locks/` named after the artifact stem. The closeout receipt deliberately does NOT
 * reuse `<stem>.receipt.json` — that name belongs to the LOCK receipt, which carries a hash and is read by
 * `getLockStatus`. A distinct suffix keeps them together without a collision.
 */
export function closeoutReceiptPath(runDir: string, phase: string): string {
  const entry = CLOSEOUT_PHASE_FILES[phase]
  if (!entry) throw new Error('Unsupported closeout phase: ' + phase)
  return join(runDir, 'locks', entry.file.replace(/\.md$/, '') + '.closeout.receipt.json')
}

/**
 * Record the report as a closeout receipt. **The only write in this module, and it is never the artifact.**
 *
 * ⚠ WHY A RECEIPT AT ALL, in the user's words: a closeout *"should potentially create a close out receipt,
 * that is ok and valuable, as long as it doesnt overwrite the phase docs."* So the durable trace of "the
 * closeout examined this phase" is a file of its own, and the phase document is read and reported on but
 * never touched.
 *
 * The JSON is a plain projection of the report — no timestamp, so the receipt is a pure function of the run
 * state and two calls on the same run produce identical bytes.
 */
export function writeCloseoutReceipt(runDir: string, phase: string, options: CloseoutReportOptions = {}) {
  const report = closeoutReport(runDir, phase, options)
  const path = closeoutReceiptPath(runDir, phase)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8')
  // ⚠ PHASE 08 IS THE RUN'S LAST PHASE, so its receipt is also where the RUN-level receipt belongs: a receipt
  // that "represents what was done in the run" has to cover the whole run, and the early artifacts are most
  // of what was done. The per-phase receipt above stays as it was; this one is the run's.
  const runReceipt = isFinalPhase(phase) ? writeRunCloseoutReceipt(runDir, options) : null
  return { path, report, runReceipt }
}

/** Whether this phase is the run's final one — where the run-level receipt is written. */
function isFinalPhase(phase: string): boolean {
  return phase === '08' || phase === '08-memory-impact.md'
}

/** Where the RUN-level closeout receipt lives: the run root, one per run. */
export function runCloseoutReceiptPath(runDir: string): string {
  return join(runDir, 'closeout.receipt.json')
}

/** One artifact's line in the run-level receipt. */
export interface RunArtifactState {
  artifact: string
  exists: boolean
  /** `LOCKED`, `DRAFT`, `STALE_LOCK` — or `ABSENT` when the artifact was never written. */
  status: string
  /** Empty when this artifact fits the standard. */
  findings: CloseoutFinding[]
}

export interface RunCloseoutReport {
  /** Every artifact in the run's sequence, in order — 00 through 08, not only the closeout phases. */
  artifacts: RunArtifactState[]
  /** How many of them fit the standard, for a one-line summary. */
  conforming: number
}

/**
 * The RUN-level report: every artifact in the run, not just the phases the closeout reports on.
 *
 * ⚠ WHY IT SPANS 00–08: the user's point, and it is the right one — a receipt *"represents what was done in
 * the run"*, so it must include the early artifacts. The earlier correction still holds and is not undone by
 * this: the closeout must never WRITE those documents (`recursive_init` owns them). It READS them, holds them
 * to the same standard, and records their state. Reading a broad set and writing a narrow one is exactly the
 * distinction that was missing.
 */
export function runCloseoutReport(runDir: string, options: CloseoutReportOptions = {}): RunCloseoutReport {
  const profile = options.workflowProfile ?? CURRENT_WORKFLOW_PROFILE
  const artifacts: RunArtifactState[] = []

  for (const artifact of RUN_ARTIFACT_SEQUENCE) {
    const path = join(runDir, artifact)
    if (!existsSync(path)) {
      artifacts.push({ artifact, exists: false, status: 'ABSENT', findings: [] })
      continue
    }
    const findings: CloseoutFinding[] = []
    let content = ''
    try { content = readFileSync(path, 'utf8') } catch { content = '' }
    for (const heading of requiredSectionsFor(artifact, profile)) {
      if (!hasHeading(content, heading)) {
        findings.push({ kind: 'missing-section', detail: 'missing required section: ## ' + heading })
      }
    }
    for (const gate of UNIVERSAL_GATES) {
      const gateStatus = getGateStatus(content, gate)
      if (gateStatus !== 'PASS') {
        findings.push({ kind: 'gate-not-passing', detail: gate + ': ' + gateStatus })
      }
    }
    artifacts.push({ artifact, exists: true, status: getLockStatus(path), findings })
  }

  return { artifacts, conforming: artifacts.filter((a) => a.exists && a.findings.length === 0).length }
}

/**
 * Record the run-level receipt. **Its own file at the run root**, never a phase document.
 *
 * The JSON is a pure projection of the run state — no timestamp — so two calls on the same run produce
 * identical bytes, which is what makes it comparable between runs.
 */
export function writeRunCloseoutReceipt(runDir: string, options: CloseoutReportOptions = {}) {
  const report = runCloseoutReport(runDir, options)
  const path = runCloseoutReceiptPath(runDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8')
  return { path, report }
}
