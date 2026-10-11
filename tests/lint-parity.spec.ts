/**
 * R4 (run 09): golden-fixture lint parity (python-free).
 * The canonical lint-recursive-run.py output over the committed fixture
 * (tests/fixtures/lint-golden/) is captured once in expected-output.txt.
 * ts-lint.ts's in-process lintRun must reproduce the SAME [FAIL]/[WARN]
 * verdicts + Summary counts. No python runs at test time.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { lintRun, lintRequirementCompletionStatus, lintSourceRequirementInventory } from '../src/ts-lint.ts'
import { CURRENT_WORKFLOW_PROFILE } from '../src/phase-rules.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/lint-golden', import.meta.url))

/** Extract [FAIL]/[WARN] verdict lines (path-normalized to fixture-root-relative). */
function verdicts(out: string): { fails: string[]; warns: string[]; summary: string } {
  const lines = out.split(/\r?\n/)
  const fails: string[] = []
  const warns: string[] = []
  const failRe = /^\[FAIL\]\s+(.+)$/
  const warnRe = /^\[WARN\]\s+(.+)$/
  for (const line of lines) {
    const fm = line.match(failRe)
    if (fm) { fails.push(fm[1].trim()); continue }
    const wm = line.match(warnRe)
    if (wm) warns.push(wm[1].trim())
  }
  const summaryLine = lines.find(l => l.startsWith('Summary')) ?? ''
  return { fails, warns, summary: summaryLine }
}

describe('R4 — golden-fixture lint parity (ts-lint.ts == canonical, python-free)', () => {
  it('lintRun reproduces the canonical FAIL verdicts on the golden fixture', () => {
    const result = lintRun(FIXTURE, 'g-run')
    const golden = readFileSync(join(FIXTURE, 'expected-output.txt'), 'utf8')
    const g = verdicts(golden)
    // canonical FAIL lines carry absolute paths; normalize to basename+msg.
    // result.errors already have the '[FAIL] ' prefix baked in; strip both
    // the prefix and the path for a fair comparison. Drop the CLI exit banner
    // ('[FAIL] Lint failed') — it is the process exit line, not a lint issue.
    const norm = (lines: string[]) => lines.map(l => l.replace(/^\[(FAIL|WARN)\]\s+/, '').replace(/^.*[\\/]/, ''))
    const fails = g.fails.filter(l => l.trim() !== 'Lint failed')
    expect(norm(result.errors)).toEqual(norm(fails))
    expect(result.failCount).toBe(fails.length)
  })

  it('lintRun reproduces the canonical WARN verdicts on the golden fixture', () => {
    const result = lintRun(FIXTURE, 'g-run')
    const golden = readFileSync(join(FIXTURE, 'expected-output.txt'), 'utf8')
    const g = verdicts(golden)
    const norm = (lines: string[]) => lines.map(l => l.replace(/^\[(FAIL|WARN)\]\s+/, '').replace(/^.*[\\/]/, ''))
    expect(norm(result.warnings)).toEqual(norm(g.warns))
    expect(result.warnCount).toBe(g.warns.length)
  })

  it('lintRun verdict matches the canonical exit (FAIL because fixture is DRAFT/incomplete)', () => {
    const result = lintRun(FIXTURE, 'g-run')
    expect(result.passed).toBe(false)
    expect(result.failCount).toBeGreaterThan(0)
  })

  it('carries no ADDITIVE prose on the golden fixture: every canonical line above is byte-identical', () => {
    // ⚠ THE GUARD ON "ADDITIVE". The three tests above compare the FULL verdict lists against the canonical
    // linter's captured output, so appending anything to a message the golden contains would already fail
    // them — this test says WHY in one place. The golden's drafts do not reach the missing-id messages this
    // change extends (they are "Missing or empty section: ## Requirement Completion Status" cases), so the
    // canonical parity surface is untouched, and that is a property to keep rather than assume.
    const result = lintRun(FIXTURE, 'g-run')
    for (const line of [...result.errors, ...result.warnings]) {
      expect(line, 'golden parity must stay byte-identical').not.toContain('expected row:')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* THE FAILURE MESSAGE TEACHES ITS OWN REMEDY                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ WHY THESE ASSERTIONS EXIST, MEASURED FROM A LIVE RUN'S OWN TRANSCRIPT. An agent spent a very large number
 * of turns reverse-engineering the entry-row format from these very messages — *"the lint logic is a black
 * box"*, *"unless the parser regex is GREEDY"* — testing its entries one by one for the substring `with`, and
 * ending with a workaround it called a hack (*"ensure EVERY inventory entry contains at least one backtick
 * pair IN THE QUOTE"*). "is missing explicit requirement IDs: R1..R24" says what is ABSENT; it does not say
 * what a correct line looks like, so the only way forward is more failures. The detail appended to it now
 * shows the row, and the assertions below are LITERALS on purpose: a test that recomputed the expected text
 * from the same table the message reads would pass no matter what that table said.
 */
const tempRoots: string[] = []
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A run directory whose 00-requirements.md DEFINES R1 and R2 — the ids the entry rows are checked against. */
function runWithRequirements(): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-msg-'))
  tempRoots.push(root)
  const runDir = join(root, '.recursive', 'run', 'r1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, '00-requirements.md'), [
    'Workflow version: `' + CURRENT_WORKFLOW_PROFILE + '`',
    '',
    '## Requirements',
    '',
    '### `R1` the lock refuses an out-of-order artifact',
    'Acceptance criteria: a prerequisite that is DRAFT blocks the lock.',
    '',
    '### `R2` the refusal carries a decision',
    'Acceptance criteria: the refusal names the blocking prerequisite.',
    '',
    '## Coverage Gate',
    'Coverage: FAIL',
  ].join('\n'), 'utf8')
  return runDir
}

describe('R4 — a missing entry id fails WITH the expected row in the message', () => {
  it('the inventory message keeps the canonical sentence and adds a passing row', () => {
    const runDir = runWithRequirements()
    const content = [
      'Workflow version: `' + CURRENT_WORKFLOW_PROFILE + '`',
      '',
      '## Source Requirement Inventory',
      '',
      '- R1 | Disposition: in-scope | Source Quote: a prerequisite that is DRAFT blocks the lock | Summary: the guard is described',
      '',
      '## Coverage Gate',
      'Coverage: FAIL',
    ].join('\n')
    const message = lintSourceRequirementInventory(join(runDir, '01-as-is.md'), content, CURRENT_WORKFLOW_PROFILE, runDir).join('\n')
    // The canonical sentence, unchanged and still the FIRST thing in the message.
    expect(message.startsWith('Source Requirement Inventory is missing explicit requirement IDs from 00-requirements.md: R2')).toBe(true)
    // ...and the shape, which is the part that was missing.
    expect(message).toContain('expected row: - R1 | Disposition: in-scope | Source Quote:')
    expect(message).toContain('the id ALONE as the first | field')
    expect(message).toContain('a row that is backtick-wrapped is skipped silently')
  })

  it('the message a TRAPPED writer sees carries the row too: every entry row was dropped', () => {
    // ⚠ THE CASE THAT MATTERS MOST, and it is NOT the missing-id message. When no row parses at all, the
    // linter returns early with "must contain at least one ... entry" — which reads as "your section is
    // empty" to a writer looking at a section full of rows it wrote. Both rows below are unparseable on
    // purpose: a bold id, and a backtick-wrapped row whose quoted field contains a backtick.
    const runDir = runWithRequirements()
    const content = [
      'Workflow version: `' + CURRENT_WORKFLOW_PROFILE + '`',
      '',
      '## Source Requirement Inventory',
      '',
      '- **R1** | Disposition: in-scope | Source Quote: a prerequisite that is DRAFT blocks the lock | Summary: bold id',
      '- `R2 | Disposition: in-scope | Source Quote: the refusal names the blocking `prerequisite` | Summary: wrapped`',
      '',
      '## Coverage Gate',
      'Coverage: FAIL',
    ].join('\n')
    const message = lintSourceRequirementInventory(join(runDir, '01-as-is.md'), content, CURRENT_WORKFLOW_PROFILE, runDir).join('\n')
    expect(message).toContain('Source Requirement Inventory must contain at least one requirement inventory entry')
    expect(message).toContain('expected row: - R1 | Disposition: in-scope')
  })

  it('the Requirement Completion Status message shows the row for THIS phase\'s status vocabulary', () => {
    const runDir = runWithRequirements()
    const plan = '## Requirement Completion Status\n\n'
      + '- R1 | Status: planned | Implementation Surface: src/x.ts | Verification Surface: tests/x.spec.ts | QA Surface: by hand\n\n## Coverage Gate\nCoverage: FAIL\n'
    const planned = lintRequirementCompletionStatus(join(runDir, '02-to-be-plan.md'), plan, ['R1', 'R2'], runDir, CURRENT_WORKFLOW_PROFILE, null).join('\n')
    expect(planned.startsWith('Requirement Completion Status is missing in-scope requirements: R2')).toBe(true)
    expect(planned).toContain('expected row: - R1 | Status: planned | Implementation Surface:')

    const impl = '## Requirement Completion Status\n\n'
      + '- R1 | Status: implemented | Changed Files: src/x.ts | Implementation Evidence: src/x.ts\n\n## Coverage Gate\nCoverage: FAIL\n'
    const closeout = lintRequirementCompletionStatus(join(runDir, '03-implementation-summary.md'), impl, ['R1', 'R2'], runDir, CURRENT_WORKFLOW_PROFILE, null).join('\n')
    expect(closeout.startsWith('Requirement Completion Status is missing in-scope requirements: R2')).toBe(true)
    expect(closeout).toContain('expected row: - R1 | Status: verified | Changed Files:')
  })

  it('appends NOTHING outside the profile whose shape it describes — no behaviour change where it is off', () => {
    // v1 is a STRICT profile, so it runs the Requirement Completion Status lint; but its phase 2 uses the
    // CLOSEOUT statuses, and telling that writer a v2 PLANNING row would teach a vocabulary v1 rejects. The
    // detail is therefore scoped to the profile whose shape is actually being enforced.
    const runDir = runWithRequirements()
    const v1Plan = lintRequirementCompletionStatus(
      join(runDir, '02-to-be-plan.md'), '## Requirement Completion Status\n\n- R1 | Status: planned\n', ['R1', 'R2'], runDir, 'recursive-mode-audit-v1', null,
    ).join('\n')
    expect(v1Plan).toContain('Requirement Completion Status is missing in-scope requirements: R2')
    expect(v1Plan).not.toContain('expected row:')
  })
})
