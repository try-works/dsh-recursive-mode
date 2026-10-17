/**
 * PER-GATE HUMAN-ASK SWITCHES — `gates.<gate>.ask` and its recorded default.
 *
 * THE OWNER'S REQUIREMENTS, VERBATIM:
 *   *"every phase that has a human ask should also have the ask gate be configurable true/false so users can
 *   customize when they are asked or not"*
 *   *"i want tdd to defalt to ask: false and default: strict"*
 *
 * WHAT IS BEING PINNED. `tdd-mode`, `qa-signoff`, `gate-block` and `run-start` are the four human gates. A
 * disabled ask must NOT quietly mean "the agent decides": `recursive_ask` records the gate's CONFIGURED default
 * and says so (`source: "config"` + `ask: "disabled"`), a gate with no safe default (`gate-block`) refuses by
 * name, `run-start` cannot be silenced at all, and `qa.humanReview: true` beside `qaSignoff.ask: false` is a
 * contradiction that fails the MOUNT rather than letting either instruction win silently.
 *
 * The defaults are the owner's: absent `gates` config, TDD does NOT ask and records `strict`; the other three
 * DO ask. The first test asserts exactly that, because it is the behaviour the owner asked for.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { GATE_DEFAULT_LABELS, resolveGateAsks } from '../src/gates.ts'

const RUN = 'gate-run'
const TDD_ARTIFACT = '03-implementation-summary.md'
const QA_ARTIFACT = '05-manual-qa.md'

/** The tool result's JSON payload — the same reader the sibling ask specs use. */
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

interface AskMount {
  ctx: Context
  repo: string
  call: (args: Record<string, unknown>, callId: string) => Promise<unknown>
  artifactText: (file: string) => string
  /** Every channel request the plugin made — the proof that a person was or was not asked. */
  asked: Array<{ questions: Array<{ id: string; options: Array<{ label: string }> }> }>
  dispose: () => Promise<void>
}

/** Mount the REAL plugin with the given config, scaffold one run, and record channel traffic. */
async function mountAsk(config: Record<string, unknown> = {}, options: { answer?: string } = {}): Promise<AskMount> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-gate-ask-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin as never, { serverSurface: true, repoRoot: repo, ...config } as never)
  await ctx.recursive.initRun(RUN)
  const asked: AskMount['asked'] = []
  // An answerer that records the request and answers with the requested label (or withholds an answer when
  // the test is about a disabled ask — where it must never be called at all).
  ctx.recursive.attachUserQuestions({
    ask: (request: never) => {
      const parsed = request as unknown as { questions: Array<{ id: string; options: Array<{ label: string }> }> }
      asked.push(parsed)
      const id = parsed.questions[0]!.id
      const selected = options.answer === undefined ? [] : [options.answer]
      return Promise.resolve({ answers: [{ id, selected }] })
    },
  })
  return {
    ctx,
    repo,
    asked,
    call: (args, callId) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(callId),
      name: 'recursive_ask',
      arguments: args,
      agent: { session: { header: { cwd: repo } } },
    } as never),
    artifactText: (file) => readFileSync(join(repo, '.recursive', 'run', RUN, file), 'utf8'),
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

describe('the owner default: TDD does NOT ask, and records strict', () => {
  it('1. with no gates config at all, tdd-mode records strict and the person is NEVER asked', async () => {
    const m = await mountAsk()
    try {
      const result = payload(await m.call({ gate: 'tdd-mode', runId: RUN }, 'tdd-1'))

      // (a) NOBODY WAS ASKED. This is the owner's instruction, and the whole point of the switch.
      expect(m.asked, 'the channel must not be asked when gates.tddMode.ask is false').toHaveLength(0)
      // (b) the artifact still carries a truthful value — not silence, not an agent invention.
      expect(m.artifactText(TDD_ARTIFACT)).toContain('- TDD Mode: strict')
      // (c) and the RESULT says the decision came from config, so a reader knows no person was involved.
      expect(result.answer).toBe('strict')
      expect(result.source).toBe('config')
      expect(result.ask).toBe('disabled')
      expect(result.marker).toBe('- TDD Mode: strict')
    } finally {
      await m.dispose()
    }
  })

  it('2. gates.tddMode.ask: true restores the question (the switch is real, not hardcoded)', async () => {
    const m = await mountAsk({ gates: { tddMode: { ask: true } } }, { answer: 'pragmatic' })
    try {
      const result = payload(await m.call({ gate: 'tdd-mode', runId: RUN }, 'tdd-2'))
      expect(m.asked, 'the channel IS asked when the switch is on').toHaveLength(1)
      expect(m.asked[0]!.questions[0]!.id).toBe('tdd-mode')
      expect(result.answer).toBe('pragmatic')
      expect(result.source).toBe('channel')
    } finally {
      await m.dispose()
    }
  })
})

describe('a disabled ask records the configured default and says so', () => {
  it('3. qaSignoff ask:false records agent-operated with source config, no question', async () => {
    const m = await mountAsk({ gates: { qaSignoff: { ask: false } } })
    try {
      const result = payload(await m.call({ gate: 'qa-signoff', runId: RUN }, 'qa-1'))
      expect(m.asked).toHaveLength(0)
      expect(m.artifactText(QA_ARTIFACT)).toContain('- QA Execution Mode: agent-operated')
      expect(result.source).toBe('config')
      expect(result.ask).toBe('disabled')
    } finally {
      await m.dispose()
    }
  })

  it('4. gateBlock ask:false REFUSES by name and records nothing', async () => {
    const m = await mountAsk({ gates: { gateBlock: { ask: false } } })
    try {
      const before = m.artifactText(QA_ARTIFACT)
      const result = payload(await m.call({ gate: 'gate-block', runId: RUN, artifact: QA_ARTIFACT }, 'gb-1'))
      // A named refusal, not an invented decision: fix/reopen/abandon are the person's call.
      expect(String(result.error)).toContain('RM5507')
      expect(String(result.error)).toContain('gates.gate-block')
      expect(m.asked).toHaveLength(0)
      expect(m.artifactText(QA_ARTIFACT), 'nothing may be written when the gate cannot decide').toBe(before)
    } finally {
      await m.dispose()
    }
  })

  it('5. per-gate independence: tdd-mode stays silent while qa-signoff still asks', async () => {
    // The switches are separate: one disabled must not silence another. The owner's DEFAULTS are the clearest
    // control — `tddMode.ask: false` beside `qaSignoff.ask: true` — so both halves are exercised in one mount.
    // (`run-start` is NOT usable as the control: it refuses before asking while the requirements document is
    // still the unfilled template, which is deliberate behaviour and would prove nothing about the switch.)
    const m = await mountAsk({}, { answer: 'agent-operated' })
    try {
      payload(await m.call({ gate: 'tdd-mode', runId: RUN }, 'ind-1'))
      expect(m.asked, 'the silenced gate asks nobody').toHaveLength(0)

      payload(await m.call({ gate: 'qa-signoff', runId: RUN }, 'ind-2'))
      expect(m.asked, 'the enabled gate still asks').toHaveLength(1)
      expect(m.asked[0]!.questions[0]!.id).toBe('qa-signoff')
    } finally {
      await m.dispose()
    }
  })
})

describe('the configuration itself is checked', () => {
  it('6. qa.humanReview with qaSignoff.ask:false is CONTRADICTORY and fails the MOUNT', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-gate-contra-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await expect(ctx.plugin(plugin as never, {
        serverSurface: true,
        repoRoot: repo,
        qa: { humanReview: true },
        gates: { qaSignoff: { ask: false } },
      } as never)).rejects.toThrow(/contradictory[\s\S]*qa\.humanReview[\s\S]*gates\.qaSignoff\.ask/)
    } finally {
      await ctx.fiber.dispose().catch(() => undefined)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('7. a configured default that is not one of the gate\'s labels is REFUSED, naming gate and labels', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-gate-bad-default-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await expect(ctx.plugin(plugin as never, {
        serverSurface: true,
        repoRoot: repo,
        gates: { tddMode: { default: 'banana' } },
      } as never)).rejects.toThrow(/gates\.tddMode\.default is "banana"[\s\S]*strict \| pragmatic/)
    } finally {
      await ctx.fiber.dispose().catch(() => undefined)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('8. DRIFT PIN: the validated label lists equal the labels the gates actually offer', () => {
    // The labels live in `ASK_GATES` (question text) and in `GATE_DEFAULT_LABELS` (validation). A new label
    // added to one without the other would make a valid configured default unrepresentable, so pin them here.
    expect(GATE_DEFAULT_LABELS.tddMode).toEqual(['strict', 'pragmatic'])
    expect(GATE_DEFAULT_LABELS.qaSignoff).toEqual(['human', 'agent-operated', 'hybrid'])
    // And the resolved defaults are the owner's, with absence meaning ASKED everywhere but tddMode.
    const resolved = resolveGateAsks(undefined)
    expect(resolved.tddMode).toEqual({ ask: false, default: 'strict' })
    expect(resolved.qaSignoff).toEqual({ ask: true, default: 'agent-operated' })
    expect(resolved.runStart).toEqual({ ask: true })
    expect(resolved.gateBlock).toEqual({ ask: true })
  })
})
