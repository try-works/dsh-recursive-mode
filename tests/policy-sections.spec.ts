/**
 * T22 — the stable contract / phase tail split, and the local digest.
 *
 * ⚠ THE ITEM'S PREMISE WAS ALREADY MEASURED AND ITS SCOPE CUT, and these tests are written against
 * the RESCOPED item rather than its original claim. The mechanism it was modelled on (`system_sections`
 * + `cache_boundary` + `cache_intent.surface_digest`) is not a plugin-visible seam in DSH: the
 * harness's only cache concepts live in the PROVIDER layer (`llm-pi-ai` accepts prompt-cache markers
 * and a retention preference), and whether any provider caches a prefix is provider-side and
 * unverified. The item therefore **withdrew its "largest cost lever" label**, and what survives is
 * exactly what is tested here: **a byte-identical prefix is a PRECONDITION for any provider-side
 * caching**, and the digest is a **local identifier** — never a cache directive.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { renderStableContract, renderPhaseTail, contractDigest, renderRecursivePolicy } from '../src/policy.ts'
import { DEFAULT_ENFORCEMENT } from '../src/enforcement.ts'

describe('T22 — the stable contract does not vary with the phase', () => {
  it('is byte-identical when rendered twice', () => {
    expect(renderStableContract()).toBe(renderStableContract())
  })

  it('names the phase VOCABULARY and the RULES, and no current phase', () => {
    const stable = renderStableContract()
    // Vocabulary that is true for the whole run.
    expect(stable).toContain('lock monotonically')
    expect(stable).toContain('00-requirements.md')
    // And nothing that belongs to a phase in flight: no artifact being worked on, no status FIELD.
    // (The lock RULE mentions `Status: LOCKED` — that is contract text, not a phase status, which is
    // why the assertion is on the rendered FIELD rather than on the words.)
    expect(stable).not.toContain('Current phase:')
    expect(stable).not.toContain('Next required artifact')
    expect(stable).not.toContain('- Status: ')
  })

  it('DOES vary with the contract — the modes are part of it', () => {
    // The contract is fixed for a RUN, so a mode change must change the prefix: a prefix that
    // ignored the modes would be stable in name only.
    const advisory = renderStableContract({ ...DEFAULT_ENFORCEMENT, toolGuards: 'advisory' })
    const strict = renderStableContract({ ...DEFAULT_ENFORCEMENT, toolGuards: 'strict' })
    expect(advisory).not.toBe(strict)
    expect(strict).toContain('tool guards strict')
    // ⚠ AND THE DEFAULT RENDER SAYS STRICT: the model-facing policy text takes the modes from the
    // config, so this is the prompt layer's half of the revert guard — a default that flipped back
    // to advisory would tell the model "tool guards advisory" and fail here.
    expect(renderStableContract()).toContain('pre-step strict, tool guards strict, tamper detection strict')
  })
})

describe('T22 — the tail is what changes between phases', () => {
  it('carries the current phase and its status', () => {
    const tail = renderPhaseTail({ label: 'Implementation summary', phaseName: '03-implementation-summary.md', status: 'DRAFT' })
    expect(tail).toContain('Implementation summary')
    expect(tail).toContain('DRAFT')
    expect(tail).toContain('03-implementation-summary.md')
  })

  it('CHANGES between phases, which is what makes the split meaningful', () => {
    const one = renderPhaseTail({ label: 'AS-IS', phaseName: '01-as-is.md', status: 'LOCKED' })
    const two = renderPhaseTail({ label: 'Implementation summary', phaseName: '03-implementation-summary.md', status: 'DRAFT' })
    expect(one).not.toBe(two)
    // The pair is the proof: the prefix is shared, the tail is not.
    expect(renderStableContract()).toBe(renderStableContract())
  })

  it('says the run is complete rather than rendering a blank phase', () => {
    const tail = renderPhaseTail(null)
    expect(tail).toContain('unknown')
    expect(tail).toContain('run complete')
  })
})

describe('T22 — the digest is a LOCAL identifier, not a cache directive', () => {
  it('is stable for the same contract, within a run', () => {
    expect(contractDigest()).toBe(contractDigest())
    expect(contractDigest(DEFAULT_ENFORCEMENT)).toBe(contractDigest())
  })

  it('CHANGES when the contract changes', () => {
    // ⚠ THE OVERRIDE IS `advisory` BECAUSE THE DEFAULT IS NOW `strict`. The property under test
    // is "a different contract gives a different digest", so the override has to name a mode that
    // DIFFERS from the default — overriding a gate to the default value would compare the digest
    // with itself and pass while proving nothing.
    expect(contractDigest({ ...DEFAULT_ENFORCEMENT, preStep: 'advisory' })).not.toBe(contractDigest())
    expect(contractDigest({ ...DEFAULT_ENFORCEMENT, tamper: 'advisory' })).not.toBe(contractDigest())
  })

  it('is short and stable in shape, so it can live in a prompt', () => {
    expect(contractDigest()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('claims nothing about caching — no directive vocabulary leaks into it', () => {
    // A digest that implied a provider cache would be the withdrawn "largest cost lever" label
    // wearing a hash.
    const digest = contractDigest()
    expect(digest).not.toContain('cache')
    expect(renderStableContract().toLowerCase()).not.toContain('cache_boundary')
    expect(renderStableContract().toLowerCase()).not.toContain('cache')
  })
})

/**
 * T22 — THE PREFIX PROPERTY, asserted on the RENDERED section rather than on its ingredients.
 *
 * This is the whole point of the split and the only claim that survived the premise check: the
 * section the prompt layer receives must BEGIN with the byte-identical contract, because a prefix
 * that a provider could cache has to be stable before it is first — whatever the provider then does
 * with it. Asserting it on the pieces would not prove the COMPOSITION put them in that order.
 */
describe('T22 — the rendered section begins with the stable contract', () => {
  function renderForPhase(fileName: string, body: string): string {
    const root = mkdtempSync(join(tmpdir(), 'rm-t22-'))
    try {
      const runDir = join(root, '.recursive', 'run', 'r1')
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, fileName), body, 'utf8')
      return renderRecursivePolicy({ worktreeRoot: root, runId: 'r1' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('STARTS with the contract, byte for byte', () => {
    const rendered = renderForPhase('01-as-is.md', '# As-is\n\nStatus: `DRAFT`\n')
    expect(rendered.startsWith(renderStableContract())).toBe(true)
  })

  it('keeps the prefix byte-identical between two different phases', () => {
    // The precondition for any provider-side caching: a prefix that changed with the phase would be
    // stable in name only.
    const first = renderForPhase('01-as-is.md', '# As-is\n\nStatus: `DRAFT`\n')
    const second = renderForPhase('03-implementation-summary.md', '# Impl\n\nStatus: `DRAFT`\n')
    const prefix = renderStableContract()
    expect(first.startsWith(prefix)).toBe(true)
    expect(second.startsWith(prefix)).toBe(true)
    // ⚠ NOTE ON WHAT THIS CASE DOES *NOT* CLAIM: with no lock chain in the fixture, `foldRun`
    // derives no current phase, so both renders carry the same "unknown" tail and the two strings
    // are equal. That is the fixture, not the split — the split's non-triviality is asserted in the
    // tail describe above, where two explicit phases give two different tails. Asserting inequality
    // HERE would be asserting something about the fixture.
    expect(first).toBe(second)
  })

  it('keeps the lines the CONSUMERS read — a recomposition must not lose content', () => {
    // `docs-contract` and `r5-parity` assert these by presence, and they are the reason the
    // recomposition was verified against them rather than assumed safe.
    const rendered = renderForPhase('03-implementation-summary.md', '# Impl\n\nStatus: `DRAFT`\n')
    expect(rendered).toContain('recursive_phase')
    expect(rendered).toContain('required sections')
    expect(rendered).toContain('Current phase:')
  })

  it('exposes the SAME digest through the status, so prompt and status can be compared', async () => {
    // The point of surfacing it: "did the contract change under me?" is answerable without
    // re-rendering the section, by comparing what the prompt carried with what the status reports.
    const root = mkdtempSync(join(tmpdir(), 'rm-t22s-'))
    const ctx = new Context()
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root })
      await runtime.initRun('r1')
      const status = await runtime.status('r1') as { contractDigest?: string }
      expect(status.contractDigest).toBe(contractDigest())
      expect(status.contractDigest).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
