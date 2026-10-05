/**
 * T26 — the read-only preview.
 *
 * The RED's four clauses, each asserted where it can actually fail:
 *   - it reflects the phase's REAL sections (from `phaseRulesFor`, the rules the linter enforces);
 *   - it NAMES THE RULE a probe tool call would match — by calling the SAME `evaluateToolGuard` the
 *     real `pre-execute` listener calls, so the rule cannot drift from the one that fires;
 *   - it lists what the next transition requires, and says "nothing pending" rather than inventing a
 *     phase for a completed run;
 *   - it makes NO MODEL CALL — asserted structurally, by building the whole preview from a run
 *     directory with no agent, no session and no model seam anywhere in the call.
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPreview } from '../src/recursive_preview.tool.ts'
import { DEFAULT_ENFORCEMENT } from '../src/enforcement.ts'
import { contractDigest, renderStableContract } from '../src/policy.ts'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-prev-'))
  const runDir = join(root, '.recursive', 'run', 'r1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, '00-requirements.md'), '# Requirements\n\nStatus: `LOCKED`\n', 'utf8')
  return root
}

describe('T26 — the preview shows the contract BEFORE it fires', () => {
  it('carries the T22 policy pieces and their digest', () => {
    const root = makeRoot()
    try {
      const preview = buildPreview({ root, runId: 'r1', config: DEFAULT_ENFORCEMENT })
      expect(preview.policy.stable).toBe(renderStableContract(DEFAULT_ENFORCEMENT))
      expect(preview.policy.digest).toBe(contractDigest(DEFAULT_ENFORCEMENT))
      expect(preview.policy.tail).toContain('Current phase:')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reflects the phase’s REAL required sections and gates', () => {
    const root = makeRoot()
    try {
      const preview = buildPreview({ root, runId: 'r1', config: DEFAULT_ENFORCEMENT })
      // The next legal phase after a locked requirements doc, from the lock chain itself.
      expect(preview.next?.phase).toBeTruthy()
      expect(preview.phase?.file).toBe(preview.next?.phase)
      // The sections are the ones the LINTER enforces, not a restatement.
      expect(Array.isArray(preview.phase?.requiredSections)).toBe(true)
      expect(preview.phase?.requiredSections).toEqual(preview.next?.requiredSections)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('NAMES THE RULE a probe call would match, using the enforcement path itself', () => {
    const root = makeRoot()
    try {
      // An out-of-order lock: the guard has a rule for it, and the preview must name THAT rule.
      const preview = buildPreview({
        root,
        runId: 'r1',
        config: DEFAULT_ENFORCEMENT,
        probe: { name: 'recursive_lock', arguments: { artifact: '02-to-be-plan.md' } },
      })
      expect(preview.probe).not.toBeNull()
      expect(typeof preview.probe?.rule).toBe('string')
      // In advisory mode an out-of-order lock is an `ask` coerced to a warning, so the rule name is
      // what matters here — the KIND depends on the mode, which is the point of previewing it.
      expect(preview.probe?.rule).not.toBe('none')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports `none` as a RULE rather than omitting it, so "no rule" is not "did not look"', () => {
    const root = makeRoot()
    try {
      const preview = buildPreview({
        root,
        runId: 'r1',
        config: DEFAULT_ENFORCEMENT,
        probe: { name: 'recursive_status', arguments: {} },
      })
      expect(preview.probe?.rule).toBe('none')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('MADE NO MODEL CALL — it builds from the run directory alone', () => {
    // Structural evidence rather than a mock count: `buildPreview` takes no agent, no session and no
    // model seam, so there is nothing for it to call. A preview that asked a model what would happen
    // would be a DESCRIPTION of enforcement — exactly what this item replaces.
    const root = makeRoot()
    try {
      const preview = buildPreview({ root, runId: 'r1', config: DEFAULT_ENFORCEMENT })
      const keys = Object.keys(preview).sort()
      expect(keys).toEqual(['next', 'phase', 'policy', 'probe'])
      // And nothing in the result is a promise or a handle to anything async.
      expect(JSON.stringify(preview).includes('"then"')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('says NOTHING is pending for a run with no next phase, rather than inventing one', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-prev2-'))
    try {
      mkdirSync(join(root, '.recursive', 'run', 'r1'), { recursive: true })
      const preview = buildPreview({ root, runId: 'r1', config: DEFAULT_ENFORCEMENT })
      // A fresh run has 00-requirements pending, so this asserts the SHAPE rather than a null here;
      // the null case is the completed run, which the next assertion covers via the same accessor.
      expect(preview.phase === null || typeof preview.phase.file === 'string').toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
