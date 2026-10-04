/**
 * R4 (run 09): golden-fixture lint parity (python-free).
 * The canonical lint-recursive-run.py output over the committed fixture
 * (tests/fixtures/lint-golden/) is captured once in expected-output.txt.
 * ts-lint.ts's in-process lintRun must reproduce the SAME [FAIL]/[WARN]
 * verdicts + Summary counts. No python runs at test time.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { lintRun } from '../src/ts-lint.ts'

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
})
