import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapScaffold, enumerateRuns, stageBWorkflowInit } from '../src/bootstrap.ts'

describe('bootstrap.ts — scaffold installer + two-stage init (R6)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'bootstrap-'))
  })

  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('bootstraps the .recursive control-plane scaffold idempotently', () => {
    const first = bootstrapScaffold(repo)
    expect(first.created.length).toBeGreaterThan(0)
    expect(existsSync(join(repo, '.recursive', 'RECURSIVE.md'))).toBe(true)
    expect(existsSync(join(repo, '.recursive', 'STATE.md'))).toBe(true)
    expect(existsSync(join(repo, '.recursive', 'DECISIONS.md'))).toBe(true)
    expect(existsSync(join(repo, '.recursive', 'memory', 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(repo, '.recursive', 'memory', 'skills', 'SKILLS.md'))).toBe(true)

    // second run is a no-op (scaffold present)
    const second = bootstrapScaffold(repo)
    expect(second.created.length).toBe(0)
    expect(second.existing.length).toBeGreaterThan(0)
  })

  it('enumerates runs as directory names only (bounded)', () => {
    mkdirSync(join(repo, '.recursive', 'run', '01-alpha'), { recursive: true })
    mkdirSync(join(repo, '.recursive', 'run', '02-beta'), { recursive: true })
    writeFileSync(join(repo, '.recursive', 'run', '02-beta', '00-requirements.md'), 'x', 'utf8')
    const names = enumerateRuns(repo)
    expect(names).toContain('01-alpha')
    expect(names).toContain('02-beta')
    expect(names.every(n => !n.includes('.'))).toBe(true) // dir names only, never file paths
  })

  it('enumerateRuns returns [] when no run dir', () => {
    expect(enumerateRuns(repo)).toEqual([])
  })

  it('stageB (new session): bootstraps + enumerates runs, scoped to the workspace root', () => {
    mkdirSync(join(repo, '.recursive', 'run', '10-demo'), { recursive: true })
    const result = stageBWorkflowInit({ root: repo, source: 'new' })
    expect(result.bootstrapped).toBe(true)
    expect(result.runs).toContain('10-demo')
  })

  it('stageB (resume): never re-bootstraps, returns bounded active-run read', () => {
    bootstrapScaffold(repo)
    mkdirSync(join(repo, '.recursive', 'run', '10-demo'), { recursive: true })
    const result = stageBWorkflowInit({ root: repo, source: 'resume', activeRunId: '10-demo' })
    expect(result.bootstrapped).toBe(false)
    expect(result.runs).toContain('10-demo')
  })
})
