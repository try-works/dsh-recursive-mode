import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldRun, resolveRunDir } from '../src/status.ts'
import type { RecursiveStatusResult } from '../src/types.ts'

const FIXTURES = fileURLToPath(new URL('../tests/fixtures', import.meta.url))
const REPO = join(FIXTURES, 'repo')
const GOLDEN = join(FIXTURES, 'expected-status.txt')
const GOLDEN_HASHES = join(FIXTURES, 'expected-status-with-hashes.txt')

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/** Extract the 'Phase Status:' block from a full py-status output (lines 6..25 of the golden). */
function goldenPhaseBlock(golden: string): string {
  const lines = normalizeNewlines(golden).split('\n')
  const start = lines.findIndex(l => l === 'Phase Status:')
  const end = lines.findIndex((l, i) => i > start && l === '')
  return lines.slice(start, end).join('\n')
}

describe('status.ts parity with recursive-status.py (folded state)', () => {
  it('R3: phase table matches the golden byte-for-byte (newline-normalized)', () => {
    const resolved = resolveRunDir(REPO, 'fixture-run')!
    const result = foldRun(resolved.runDir, resolved.runId)
    const golden = goldenPhaseBlock(readFileSync(GOLDEN, 'utf8'))
    const rendered = normalizeNewlines(renderPhaseTable(result))
    expect(rendered).toBe(golden)
  })

  it('R3: workflow profile, current phase, and phase statuses match the golden', () => {
    const resolved = resolveRunDir(REPO, 'fixture-run')!
    const result = foldRun(resolved.runDir, resolved.runId)
    expect(result.runId).toBe('fixture-run')
    expect(result.workflowProfile).toBe('memory-phase8')
    expect(result.currentPhase).toEqual({ key: '01', label: 'Phase 1 (AS-IS)', phaseName: '1 (AS-IS)', status: 'DRAFT' })
    // Statuses per the golden state matrix.
    const byKey = Object.fromEntries(result.phases.map(p => [p.key, p]))
    expect(byKey['00R'].status).toBe('LOCKED')
    expect(byKey['00R'].lockValid).toBe(true)
    expect(byKey['00W'].status).toBe('LOCKED')
    expect(byKey['00W'].lockValid).toBe(true)
    expect(byKey['01'].status).toBe('DRAFT')
    expect(byKey['01.5'].status).toBe('SKIPPED')
    expect(byKey['02'].status).toBe('DRAFT')
    expect(byKey['03'].status).toBe('PENDING')
    expect(byKey['03.5'].status).toBe('SKIPPED')
    expect(byKey['04'].status).toBe('PENDING')
    expect(byKey['05'].status).toBe('LOCKED')
    expect(byKey['05'].lockValid).toBe(false)
    expect(byKey['06'].status).toBe('PENDING')
    expect(byKey['07'].status).toBe('PENDING')
    expect(byKey['08'].status).toBe('PENDING')
  })

  it('R3: lock chain breaks at the first non-lock-valid artifact, matching the golden', () => {
    const resolved = resolveRunDir(REPO, 'fixture-run')!
    const result = foldRun(resolved.runDir, resolved.runId)
    const chain = renderLockChain(result, false)
    const goldenChain = normalizeNewlines(readFileSync(GOLDEN, 'utf8')).split('\n')
    const start = goldenChain.findIndex(l => l === 'Lock Chain:')
    const end = goldenChain.findIndex((l, i) => i > start && l.startsWith('Next Legal'))
    const expected = goldenChain.slice(start, end).join('\n')
    expect(chain).toBe(expected)
  })

  it('R3: latest-run selection picks fixture-run over older-run', () => {
    const resolved = resolveRunDir(REPO)!
    expect(resolved).not.toBeNull()
    expect(resolved!.runId).toBe('fixture-run')
  })

  it('R3: tampered lock folds to LOCKED* invalid with LockHash mismatch', () => {
    const resolved = resolveRunDir(REPO, 'fixture-run')!
    const result = foldRun(resolved.runDir, resolved.runId)
    const p5 = result.phases.find(p => p.key === '05')!
    expect(p5.status).toBe('LOCKED')
    expect(p5.lockValid).toBe(false)
    expect(p5.lockProblems).toContain('LockHash mismatch')
  })
})

function renderPhaseTable(result: RecursiveStatusResult): string {
  const lines = ['Phase Status:']
  for (const p of result.phases) {
    const label = p.label.padEnd(26)
    let display = p.status
    let suffix = ''
    if (display === 'SKIPPED') suffix = ' (not needed)'
    else if (display === 'LOCKED' && !p.lockValid) { display = 'LOCKED*'; suffix = ' (invalid)' }
    lines.push(`  ${label} [${display}]${suffix}`)
    if (p.blockers.length > 0 && display !== 'SKIPPED') {
      const preview = p.blockers.slice(0, 2).join('; ') + (p.blockers.length > 2 ? '; ...' : '')
      lines.push(`    blockers: ${preview}`)
    }
  }
  return lines.join('\n')
}

function renderLockChain(result: RecursiveStatusResult, showHashes: boolean): string {
  const lines = ['Lock Chain:']
  for (const p of result.phases) {
    if (p.status === 'SKIPPED') continue
    const artifactRel = `.recursive/run/${result.runId}/${p.file}`
    if (p.lockValid) {
      lines.push(`  [OK]  ${artifactRel}`)
      continue
    }
    // The py runtime breaks the chain at the first non-lock-valid artifact.
    if (!p.exists) lines.push(`  [PENDING] ${artifactRel}`)
    else if (p.status !== 'LOCKED') lines.push(`  [DRAFT]   ${artifactRel}`)
    else lines.push(`  [FAIL]    ${artifactRel} - ${p.lockProblems[0] ?? 'Not lock-valid'}`)
    break
  }
  return lines.join('\n')
}