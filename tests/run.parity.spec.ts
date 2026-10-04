import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { discoverRuns, resolveRunDir } from '../src/run.ts'

const FIXTURE_REPO = fileURLToPath(new URL('../tests/fixtures/repo', import.meta.url))

describe('run.ts discovery (R1)', () => {
  it('discovers all run directories under .recursive/run/', () => {
    const runs = discoverRuns(FIXTURE_REPO)
    expect(runs).toContain('fixture-run')
    expect(runs).toContain('older-run')
  })

  it('resolves an explicit run id', () => {
    const resolved = resolveRunDir(FIXTURE_REPO, 'fixture-run')
    expect(resolved).not.toBeNull()
    expect(resolved!.runId).toBe('fixture-run')
    expect(resolved!.runDir).toMatch(/fixture-run[\\/]?$/)
  })

  it('resolves the latest run by mtime when no run id given', () => {
    const resolved = resolveRunDir(FIXTURE_REPO)
    expect(resolved).not.toBeNull()
    expect(['fixture-run', 'older-run']).toContain(resolved!.runId)
  })

  it('returns null when no runs exist', () => {
    // A directory with an empty .recursive/run/
    const empty = fileURLToPath(new URL('./fixtures/empty-repo', import.meta.url))
    expect(resolveRunDir(empty)).toBeNull()
    expect(discoverRuns(empty)).toEqual([])
  })
})
