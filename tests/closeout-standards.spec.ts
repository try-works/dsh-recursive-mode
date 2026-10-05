import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatStandardsReport, verifyRunStandards } from '../src/closeout-standards.ts'
import { CURRENT_WORKFLOW_PROFILE, getArtifactRequiredSections } from '../src/phase-rules.ts'

/**
 * FU-12b — CLOSEOUT HOLDS THE RUN TO THE STANDARD.
 *
 * ⚠ WHAT THESE ASSERTIONS ARE GUARDING: the check must read the phase rules rather than a private list of
 * headings. `getArtifactRequiredSections` is PROFILE-AWARE (it adds audit headings for audited artifacts
 * under a strict profile), so a private copy would silently disagree with the lint that enforces the same
 * standard — which is the duplication that has produced three defects in this repo already.
 *
 * The conforming fixture below is BUILT FROM THE RULES rather than written out by hand, so these tests
 * cannot pass by encoding the author's assumption of what the rules say.
 */
describe('FU-12b: the closeout standards check', () => {
  let runDir = ''

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'rm-standards-'))
  })
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
  })

  /** A document that satisfies the rules for `artifact`, generated from the rules themselves. */
  function conforming(artifact: string): string {
    const parts = ['Run: `/.recursive/run/standards-fixture/`', 'Status: `DRAFT`', '']
    for (const heading of getArtifactRequiredSections(artifact, CURRENT_WORKFLOW_PROFILE)) {
      parts.push('## ' + heading, '', '- filled in', '')
    }
    parts.push('Coverage: PASS', 'Approval: PASS', '')
    return parts.join('\n')
  }

  it('passes an artifact that satisfies the rules, built from the rules', () => {
    writeFileSync(join(runDir, '04-test-summary.md'), conforming('04-test-summary.md'), 'utf8')
    const report = verifyRunStandards(runDir)
    expect(report.checked).toBe(1)
    expect(report.violations).toEqual([])
    expect(formatStandardsReport(report)[0]).toContain('fit the required standards')
  })

  it('names the missing section and the gate that is not passing', () => {
    writeFileSync(join(runDir, '04-test-summary.md'), 'Run: `x`\nStatus: `DRAFT`\n\n## TODO\n\nCoverage: PASS\nApproval: FAIL\n', 'utf8')
    const report = verifyRunStandards(runDir)
    const details = report.violations.map((v) => v.detail)
    // The gate line is present but FAILING, which is a different finding from a missing section.
    expect(details).toContain('Approval: FAIL')
    expect(details.some((d) => d.startsWith('missing required section: ## '))).toBe(true)
    expect(report.violations.every((v) => v.artifact === '04-test-summary.md')).toBe(true)
  })

  it('separates "not written yet" from "written wrong" — absent artifacts are not violations', () => {
    const report = verifyRunStandards(runDir)
    expect(report.checked).toBe(0)
    expect(report.violations).toEqual([])
    expect(report.absent.length).toBeGreaterThan(0)
    // …and the empty-but-healthy case still says what it looked at.
    expect(formatStandardsReport(report)[0]).toContain('not written yet')
  })

  it('reports a DRAFT artifact only when the caller asks for locked artifacts', () => {
    writeFileSync(join(runDir, '07-state-update.md'), conforming('07-state-update.md'), 'utf8')
    // Default: a DRAFT mid-run is the NORMAL state, so it is not a violation.
    expect(verifyRunStandards(runDir).violations).toEqual([])
    const strict = verifyRunStandards(runDir, { requireLocked: true })
    expect(strict.violations.map((v) => v.kind)).toEqual(['not-locked'])
    expect(strict.violations[0].detail).toBe('status is DRAFT')
  })

  it('walks the whole sequence, not just one artifact', () => {
    mkdirSync(join(runDir), { recursive: true })
    writeFileSync(join(runDir, '06-decisions-update.md'), conforming('06-decisions-update.md'), 'utf8')
    writeFileSync(join(runDir, '08-memory-impact.md'), conforming('08-memory-impact.md'), 'utf8')
    const report = verifyRunStandards(runDir)
    expect(report.checked).toBe(2)
    expect(report.violations).toEqual([])
  })
})
