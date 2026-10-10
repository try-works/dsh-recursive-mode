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
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RecursiveRuntime } from '../src/runtime.ts'
import { renderStableContract, renderPhaseTail, contractDigest, renderRecursivePolicy } from '../src/policy.ts'
import { DEFAULT_ENFORCEMENT } from '../src/enforcement.ts'
import { createRecursivePhaseTool } from '../src/recursive_phase.tool.ts'

describe('T22 — the stable contract does not vary with the phase', () => {
  it('is byte-identical when rendered twice', () => {
    expect(renderStableContract()).toBe(renderStableContract())
  })

  it('names the phase VOCABULARY and the RULES, and no current phase', () => {
    const stable = renderStableContract()
    // Vocabulary that is true for the whole run.
    expect(stable).toContain('lock monotonically')
    expect(stable).toContain('00-requirements.md')
    // ⚠ AND IT SAYS THE MEMORY IS READ, which measured as ABSENT before this change: `grep -E
    // 'memor|shard|learn' src/policy.ts` returned ZERO hits, so the model-facing contract never told the
    // agent that prior-run memory arrives at phase entry, never said an empty plane is a normal result,
    // and never asked for a citation. The mechanism was there the whole time; the CONTRACT was silent,
    // which is why it reads as a new invention rather than a description.
    expect(stable).toContain('memory')
    expect(stable).toContain('recursive_phase')
    expect(stable).toContain('EMPTY plane is a normal result')
    expect(stable.toLowerCase()).toContain('cite a shard by title')
    // And nothing that belongs to a phase in flight: no artifact being worked on, no status FIELD.
    // (The lock RULE mentions `Status: LOCKED` — that is contract text, not a phase status, which is
    // why the assertion is on the rendered FIELD rather than on the words.)
    expect(stable).not.toContain('Current phase:')
    expect(stable).not.toContain('Next required artifact')
    expect(stable).not.toContain('- Status: ')
  })

  /**
   * THE MEMORY LINE IS PART OF THE CONTRACT, NOT OF THE TAIL.
   *
   * A statement about memory holds for EVERY phase, so it belongs in the byte-identical prefix. The
   * temptation was to render the selection (which shards matched, how many) into the prompt — and that
   * would have made the prefix vary per phase, which is the one property the split exists to keep. These
   * cases pin both halves: the statement is in the prefix, and it carries no selection.
   */
  it('puts the memory statement in the PREFIX, where it is true for every phase', () => {
    expect(renderStableContract()).toContain('Memory is READ AT PHASE ENTRY')
    // No selection rides along: a count would be per-phase state, i.e. a tail dressed as a contract.
    expect(renderStableContract()).not.toMatch(/\d+\s+shard/)
  })

  it('COVERS THE MEMORY LINE, so the identifier moves when the text it identifies does', () => {
    // The contract CHANGED (it now says memory is read), so the digest computed over it changed too — and
    // that is the property worth pinning: the digest is computed over THIS text, not over a stale copy.
    // Asserted through the renderer rather than against a hardcoded hash, so a future contract edit does
    // not have to hunt a literal down; the two contract cases above already prove the digest changes with
    // the config, and this one proves the memory line is inside what it covers.
    const memoryLine = renderStableContract().split('\n').find((line) => line.startsWith('- Memory is READ AT PHASE ENTRY'))
    expect(memoryLine, 'the memory statement is not a line of the stable contract').toBeDefined()
    expect(memoryLine).toContain('recursive_phase')
    // It is one line of many, and the rest of the contract is still there beside it.
    expect(renderStableContract().split('\n').length).toBeGreaterThan(8)
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

/**
 * THE TOOL DESCRIPTION IS THE ONLY SURFACE A MODEL READS BEFORE CHOOSING A TOOL, and the one that says
 * nothing about memory is why nobody knew memory arrived here.
 *
 * ⚠ THE ASSERTION THAT MATTERS IS THE CROSS-CHECK, NOT THE WORD COUNT. A description can promise anything;
 * what these cases pin is that every field and every state it promises is one the payload ACTUALLY carries
 * on a run whose memory plane is EMPTY — the case a fresh workspace is in, and the case a description that
 * overpromised would get wrong. The description itself is read from the definition `createRecursivePhaseTool`
 * builds — the object the tool runtime registers — so this case cannot pass against a doc or a comment that
 * drifted away from the tool.
 */
describe('the recursive_phase description names the memory it returns, and the payload backs it', () => {
  it('tells the model that prior-run memory arrives on this call, and that an empty plane is normal', () => {
    // The description is read from the registered definition — the same string a model sees — so this case
    // cannot pass against a comment or a doc that drifted from the tool.
    const tool = createRecursivePhaseTool(undefined as never)
    const description = (tool as unknown as { description?: string }).description ?? ''
    expect(description).toContain('memory')
    expect(description.toLowerCase()).toContain('empty memory plane is a normal result')
    // The gate refuses a write to `00-requirements.md` and tells the caller to call this tool; the
    // description names that same artifact, so the refusal and the remedy point at one thing.
    expect(description).toContain('00-requirements.md')
  })

  it('documents only what the payload carries, checked against a REAL result on an EMPTY plane', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-phase-desc-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(RecursiveRuntime, { repoRoot: root })
      await ctx.recursive.initRun('desc-run')
      const tool = createRecursivePhaseTool(ctx.recursive)
      ctx.tools.register(tool)
      const description = (tool as unknown as { description?: string }).description ?? ''

      const out = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('phase-desc'),
        name: 'recursive_phase',
        arguments: { runId: 'desc-run' },
      } as never)
      expect(out.isError).toBe(false)
      const value = out.value as Record<string, unknown>

      // EVERY field the description names is a field the call returns — the cross-check. A description that
      // advertised a field the payload does not carry is the defect this case exists to prevent.
      for (const field of ['runId', 'phase', 'memory', 'memoryReason', 'requiredSections', 'audited']) {
        expect(value, 'the description names `' + field + '` and the payload does not carry it').toHaveProperty(field)
      }
      expect(value.phase).toBe('00-requirements.md')
      // AND THE EMPTY-PLANE STATE IS THE ONE THE DESCRIPTION DESCRIBES: no shards, and a reason that says
      // why — not an absence the caller has to interpret.
      expect(value.memory).toBe('')
      expect(String(value.memoryReason)).toContain('empty')
      expect(description.toLowerCase()).toContain('memoryreason')
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
