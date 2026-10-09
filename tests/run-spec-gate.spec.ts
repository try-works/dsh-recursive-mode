/**
 * THE ORDERING FIX — the run-start gate cannot be raised over a hollow spec.
 *
 * THE DEFECT. `recursive_ask gate=run-start` raised "start this run or hold?" immediately after
 * `recursive_init` scaffolded Phase 0 — while every requirement was still `<short title>`, every acceptance
 * criterion was still `[observable condition 1]`, and the document was never shown to the person at all.
 * The owner: *"i was never shown the spec before that so how could i approve if i havent seen it"*.
 *
 * WHAT IS ASSERTED HERE:
 *   1. the classifier tells a SCAFFOLD from a WRITTEN SPEC, and reports its evidence with line numbers;
 *   2. the gate REFUSES (RM4404) while the artifact is the scaffold — and the refusal QUOTES the placeholders,
 *      so the reader can see what is missing instead of being told "not ready";
 *   3. a call that carries an explicit `answer` is refused the same way, so there is no approval path over a
 *      template, and nothing is recorded;
 *   4. the gate is ALLOWED the moment real content exists — the same call, on the same run, one document
 *      later. Clause 4 is what makes clause 2 a precondition rather than a wall.
 *
 * ⚠ WHAT WOULD MAKE `3` PASS VACUOUSLY: if `answer` were validated before the artifact was ever read, an
 * unoffered label would be refused with RM1142 and the assertion "no approval line was written" would hold
 * for the wrong reason. The test therefore asserts the CODE (RM4404, not RM1142) and drives a VALID label.
 * ⚠ AND WHAT WOULD MAKE `2` VACUOUS: a `recursive_init` that wrote no artifact at all, since a missing
 * document is refused by the same code. The test asserts the refusal names the SCAFFOLD (`<short title>`,
 * line 12) rather than the missing-file sentence, and asserts the file exists before the call.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { requirementsContent } from '../src/init-templates.ts'
import { classifyArtifact, describeEvidence, unfilledEvidence } from '../src/run-spec.ts'
import { RUN_START_ARTIFACT, RUN_START_APPROVE, RUN_START_GATE_ID, runStartSpecGuard } from '../src/run-start.ts'

const agentFor = (root: string) => ({ session: { header: { cwd: root } } })

/** The exact document `recursive_init` scaffolds. */
const SCAFFOLD = requirementsContent('01-calculator', 'feature')

/** One real Phase 0 requirements document: no placeholders, no unchecked boxes, both gates passing. */
const WRITTEN = [
  '# Phase 0 Requirements — 01-calculator',
  '',
  'Status: `DRAFT`',
  '',
  '## Requirements',
  '',
  '### `R1` The gate is refused while the spec is a stub',
  '',
  'Description: the run-start question is only raised once a person can read what they are approving.',
  'Acceptance criteria:',
  '- a scaffolded run refuses with RM4404 and quotes the placeholder lines',
  '- a written run is allowed to raise the gate',
  '',
  '## Out of Scope',
  '',
  '- `OOS1`: editing the document from the browser (the client is read-only)',
  '',
  '## Constraints',
  '',
  '- the plugin writes the refusal; it never writes the spec',
  '',
  '## Coverage Gate',
  '',
  '- [x] every requirement carries acceptance criteria',
  '',
  'Coverage: PASS',
  '',
  '## Approval Gate',
  '',
  '- [x] the requirements are ready for the run-start decision',
  '',
  'Approval: PASS',
  '',
].join('\n')

function payload(result: unknown): Record<string, unknown> {
  const env = JSON.parse(JSON.stringify(result)) as { value?: unknown; content?: Array<{ text: string }> }
  if (env.value !== undefined && env.value !== null && typeof env.value === 'object') {
    return env.value as Record<string, unknown>
  }
  if (Array.isArray(env.content) && env.content[0]?.text !== undefined) {
    return JSON.parse(env.content[0].text) as Record<string, unknown>
  }
  return env as unknown as Record<string, unknown>
}

/* ---------------- 1. the classifier ---------------- */

describe('the artifact classifier tells a scaffold from a written spec', () => {
  it('calls the scaffold `recursive_init` writes UNFILLED, with line-numbered evidence', () => {
    const verdict = classifyArtifact(SCAFFOLD)
    expect(verdict.verdict).toBe('unfilled')
    const evidence = unfilledEvidence(verdict)
    // The requirement title placeholder is the load-bearing one: it cannot appear in a written document.
    const title = evidence.find((hit) => hit.text === '### `R1` <short title>')
    expect(title, 'the scaffold no longer carries its requirement-title placeholder').toBeDefined()
    expect(title?.line).toBe(23)
    // The criteria placeholder AND the unfinished markers of its own (unchecked boxes, FAIL gates).
    expect(evidence.some((hit) => hit.text === '- [observable condition 1]')).toBe(true)
    expect(verdict.hits.filter((hit) => hit.id === 'unchecked-todo').length).toBeGreaterThanOrEqual(5)
    expect(verdict.hits.filter((hit) => hit.id === 'failed-gate').length).toBe(2)
    // The sentence a refusal quotes: line numbers AND the text, so the reader can go and look.
    expect(describeEvidence(evidence)).toContain('line 23: ### `R1` <short title>')
  })

  it('calls a real requirements document FILLED — no evidence at all', () => {
    const verdict = classifyArtifact(WRITTEN)
    expect(verdict.verdict).toBe('filled')
    expect(verdict.hits).toEqual([])
  })

  it('does NOT refuse a document whose only marker is an unmet gate', () => {
    // A person may hold `Coverage: FAIL` open as a real objection while having written real requirements, so
    // the weak markers are reported as context and never decide the verdict. This is the case that keeps the
    // guard from becoming a wall in front of a legitimate decision.
    const verdict = classifyArtifact(WRITTEN.replace('Coverage: PASS', 'Coverage: FAIL'))
    expect(verdict.verdict).toBe('filled')
    expect(verdict.hits).toEqual([{ id: 'failed-gate', line: 26, text: 'Coverage: FAIL' }])
  })
})

/* ---------------- 2-4. the gate itself ---------------- */

describe('recursive_ask gate=run-start refuses while the spec is a scaffold', () => {
  async function mount() {
    const repo = mkdtempSync(join(tmpdir(), 'rm-specgate-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin as never, { repoRoot: repo } as never)
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('sg-init'),
      name: 'recursive_init',
      arguments: { runId: '01-calculator' },
      agent: agentFor(repo),
    } as never)
    const ask = (args: Record<string, unknown>) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('sg-ask'),
      name: 'recursive_ask',
      arguments: args,
      agent: agentFor(repo),
    } as never)
    const artifactPath = join(repo, '.recursive', 'run', '01-calculator', RUN_START_ARTIFACT)
    return {
      ask,
      repo,
      artifactPath,
      dispose: async () => {
        await ctx.fiber.dispose()
        rmSync(repo, { recursive: true, force: true })
      },
    }
  }

  it('REFUSES the ask with RM4404, quoting the scaffold it found', async () => {
    const m = await mount()
    try {
      // The precondition the whole test rests on: the scaffold IS there (a missing file would be a different
      // refusal, and one that named no placeholder).
      expect(existsSync(m.artifactPath)).toBe(true)
      const before = readFileSync(m.artifactPath, 'utf8')
      expect(before).toContain('### `R1` <short title>')

      const refused = payload(await m.ask({ gate: RUN_START_GATE_ID, runId: '01-calculator' }))

      expect(String(refused.error)).toContain('RM4404')
      expect(String(refused.error)).toContain(RUN_START_ARTIFACT)
      // It names WHAT is missing, at the line it is on — not "not ready yet".
      expect(String(refused.error)).toContain('### `R1` <short title>')
      expect(String(refused.error)).toContain('line 23')
      // And it still carries the question, so a caller can put the decision to the person in prose while the
      // card cannot honestly be raised.
      expect((refused.question as { options: Array<{ label: string }> }).options.map((o) => o.label))
        .toEqual([RUN_START_APPROVE, 'Hold'])
      // Nothing was written: a refusal is not a decision.
      expect(readFileSync(m.artifactPath, 'utf8')).not.toContain('Run Start:')
      expect(String(refused.gate)).toBe(RUN_START_GATE_ID)
    } finally {
      await m.dispose()
    }
  })

  it('REFUSES an explicit approval too — a valid label is not a way over a template', async () => {
    const m = await mount()
    try {
      const refused = payload(await m.ask({ gate: RUN_START_GATE_ID, runId: '01-calculator', answer: RUN_START_APPROVE }))
      // RM4404, NOT RM1142 (the unoffered-answer code): the label was valid and the document was not.
      expect(String(refused.error)).toContain('RM4404')
      expect(String(refused.error)).not.toContain('RM1142')
      expect(readFileSync(m.artifactPath, 'utf8')).not.toContain('Run Start:')
      // `relay` is no route either: the guard runs before the channel is consulted at all.
      const relayed = payload(await m.ask({ gate: RUN_START_GATE_ID, runId: '01-calculator', answer: RUN_START_APPROVE, relay: true }))
      expect(String(relayed.error)).toContain('RM4404')
      expect(readFileSync(m.artifactPath, 'utf8')).not.toContain('Run Start:')
    } finally {
      await m.dispose()
    }
  })

  it('ALLOWS the gate once the document carries real content', async () => {
    const m = await mount()
    try {
      // ONE DOCUMENT LATER: the same run, the same call, a written spec.
      writeFileSync(m.artifactPath, WRITTEN, 'utf8')
      expect(runStartSpecGuard(m.repo, '01-calculator')).toEqual({ ok: true })

      const asked = payload(await m.ask({ gate: RUN_START_GATE_ID, runId: '01-calculator' }))
      // ⚠ THE ALLOWED PATH IS THE OLD ONE: the question comes back and NOTHING is recorded. The fix changed
      // WHEN the gate may be raised, and nothing about what an ask does.
      expect(asked.error).toBeUndefined()
      expect((asked.question as { options: Array<{ label: string }> }).options.map((o) => o.label))
        .toEqual([RUN_START_APPROVE, 'Hold'])
      expect(readFileSync(m.artifactPath, 'utf8')).not.toContain('Run Start:')
    } finally {
      await m.dispose()
    }
  })
})
