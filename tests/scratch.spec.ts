import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readScratch, writeScratch, appendScratch, scratchPathFor, childScratchPath, readParentScratch, writeChildScratch } from '../src/scratch.ts'

describe('scratch.ts — run-scoped disposable scratchpad (R5)', () => {
  let repo: string
  let runDir: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'scratch-'))
    runDir = join(repo, '.recursive', 'run', '42-scratch-run')
    mkdirSync(runDir, { recursive: true })
  })

  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('writes and reads scratch.md and scratch.ts under the run dir', () => {
    writeScratch(runDir, 'md', '# scratch notes')
    expect(readScratch(runDir, 'md')).toContain('# scratch notes')
    writeScratch(runDir, 'ts', 'const x: number = 1')
    expect(readScratch(runDir, 'ts')).toContain('const x')
  })

  it('appends to scratch.md', () => {
    writeScratch(runDir, 'md', 'line1')
    appendScratch(runDir, 'md', 'line2')
    const content = readScratch(runDir, 'md')
    expect(content).toContain('line1')
    expect(content).toContain('line2')
  })

  it('paths live at scratch/scratch.<target> under the run dir', () => {
    expect(scratchPathFor(runDir, 'md')).toBe(join(runDir, 'scratch', 'scratch.md'))
    expect(scratchPathFor(runDir, 'ts')).toBe(join(runDir, 'scratch', 'scratch.ts'))
  })

  it('throws for a missing run dir (never creates runs implicitly)', () => {
    const missing = join(repo, '.recursive', 'run', 'nope')
    expect(() => writeScratch(missing, 'md', 'x')).toThrow(/run/i)
  })

  it('rejects unknown targets', () => {
    expect(() => scratchPathFor(runDir, 'py' as never)).toThrow(/target/i)
  })

  it('child scratch lives at scratch/<child-id>.md and parent read stays read-only (R5)', () => {
    const child = childScratchPath(runDir, 'child-a')
    expect(child).toBe(join(runDir, 'scratch', 'child-a.md'))
    writeChildScratch(runDir, 'child-a', 'child notes')
    expect(readFileSync(child, 'utf8')).toContain('child notes')
    // parent scratch.md is untouched by a child write
    writeScratch(runDir, 'md', 'parent notes')
    expect(readParentScratch(runDir, 'md')).toContain('parent notes')
    expect(readFileSync(child, 'utf8')).toContain('child notes')
  })

  it('rejects a child scratch escaping the scratch dir', () => {
    expect(() => childScratchPath(runDir, '../escape')).toThrow(/escapes/)
  })
})
