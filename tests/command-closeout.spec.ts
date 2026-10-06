import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeRecursiveCommand } from '../src/commands.ts'

/**
 * THE `closeout` VERB USED TO LIE.
 *
 * It returned "closeout scaffolded for <run> phase <n>" having read nothing, written nothing and checked
 * nothing — a command reporting success for work it never did. It is now the linter the closeout actually is:
 * it reads the phase artifact, reports what is missing, and writes nothing.
 *
 * These tests fail against the old behaviour on the first assertion, because "scaffolded" is not a report.
 */
describe('the closeout verb reports rather than claims', () => {
  let root = ''
  let runDir = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-closeout-verb-'))
    runDir = join(root, '.recursive', 'run', 'probe-run')
    mkdirSync(runDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reports what the artifact is missing, and does NOT claim to have scaffolded anything', () => {
    writeFileSync(join(runDir, '04-test-summary.md'), 'Run: `x`\nStatus: `DRAFT`\n\n## TODO\n', 'utf8')
    const result = executeRecursiveCommand(root, 'closeout probe-run --phase 04')
    expect(result.kind).toBe('success')
    expect(result.text, 'the old stub said this').not.toContain('scaffolded')
    expect(result.text).toContain('04-test-summary.md')
    expect(result.text).toContain('finding(s) before it can lock')
    expect(result.text).toContain('add the `## ')
  })

  it('WRITES NOTHING — the artifact is byte-identical afterwards', () => {
    const before = 'Run: `x`\nStatus: `DRAFT`\n\n## TODO\n'
    writeFileSync(join(runDir, '04-test-summary.md'), before, 'utf8')
    executeRecursiveCommand(root, 'closeout probe-run --phase 04')
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    expect(readFileSync(join(runDir, '04-test-summary.md'), 'utf8')).toBe(before)
  })

  it('says an absent artifact is ABSENT, which is a finding and not an error', () => {
    const result = executeRecursiveCommand(root, 'closeout probe-run --phase 07')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('ABSENT')
  })

  it('still refuses an unknown run, and an unsupported phase', () => {
    const missing = executeRecursiveCommand(root, 'closeout no-such-run --phase 04')
    expect(missing.kind).toBe('error')
    expect(missing.text).toContain('Run not found')

    const badPhase = executeRecursiveCommand(root, 'closeout probe-run --phase 03')
    expect(badPhase.kind).toBe('error')
    expect(badPhase.text).toContain('Unsupported closeout phase')
  })
})
