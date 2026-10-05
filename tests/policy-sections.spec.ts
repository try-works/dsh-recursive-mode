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
import { renderStableContract, renderPhaseTail, contractDigest } from '../src/policy.ts'
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
    expect(contractDigest({ ...DEFAULT_ENFORCEMENT, preStep: 'strict' })).not.toBe(contractDigest())
    expect(contractDigest({ ...DEFAULT_ENFORCEMENT, tamper: 'strict' })).not.toBe(contractDigest())
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
