/**
 * PER-GATE ASK SWITCHES — THE GUIDANCE AND THE LINT HALF.
 *
 * THE REQUIREMENT THESE TESTS PIN, from the brief for the switch: *"the phase guidance / closeout text must say
 * when an ask is disabled, so the agent does not call `recursive_ask` for a gate that will not ask and then
 * stall."* With `gates.tddMode.ask: false` (the owner's default) phase 3 owes a `TDD Mode` marker that NOBODY
 * WILL BE ASKED FOR — the call records `strict` on its own. An agent that does not know that waits for a card
 * that is never raised, which is a stall with no failure to read.
 *
 * WHY IT IS NOT ENOUGH FOR THE TOOL TO BEHAVE. The tool is called by an agent that first has to decide to call
 * it. Three surfaces reach that decision, and all three now say it:
 *
 *   1. the `recursive_phase` payload's `ask` object (`personAsked` / `disabledDefault`) — the call the workflow
 *      already makes at phase entry;
 *   2. `phaseLintRulesMessage` — the ONE text rendered into BOTH the automatic pre-step reminder (`index.ts`)
 *      and the closeout report's `guidance` (`closeout-report.ts`);
 *   3. the lint failure itself, which under `gates` says "no person will be asked; call recursive_ask and this
 *      records `strict`" instead of leaving the agent to infer that it must find somebody.
 *
 * ⚠ THE NEGATIVE HALF IS ASSERTED EVERYWHERE. A guidance line that appeared when the gate DOES ask would be
 * noise in a dense message and would make its presence meaningless, and an appended lint sentence would move a
 * sentence `scripts/gen-workflow-map.mjs` cites. So each case checks both directions, and the lint case checks
 * that the message without a policy is BYTE-IDENTICAL to the pre-existing sentence.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { resolveGateAsks } from '../src/gates.ts'
import { phaseAskNote } from '../src/recursive_ask.tool.ts'
import { CURRENT_WORKFLOW_PROFILE, phaseLintRulesMessage } from '../src/phase-rules.ts'
import { closeoutReport } from '../src/closeout-report.ts'
import { lintPhaseSpecificRules } from '../src/ts-lint.ts'
import { toolError } from '../src/errors.ts'

const TDD = '03-implementation-summary.md'
const QA = '05-manual-qa.md'

/** The owner's default policy: tdd does not ask and records `strict`; QA asks. */
const DEFAULTS = resolveGateAsks(undefined)
/** The same policy with the TDD question turned back on — the control for every negative assertion. */
const TDD_ASKED = resolveGateAsks({ tddMode: { ask: true } })

/* ========================================================================== */
/* 1. the mapping: WHICH phase owes a gate, and whether that gate will ask    */
/* ========================================================================== */

describe('phaseAskNote — the phase-to-gate mapping and its policy', () => {
  it('names the gate, the config key and the label for a silenced ask', () => {
    // Phase 03 owes `tdd-mode`; the owner's default silences it and records `strict`.
    expect(phaseAskNote(TDD, DEFAULTS)).toEqual({ gate: 'tdd-mode', key: 'tddMode', default: 'strict' })
    // Phase 05 owes `qa-signoff`; by default it ASKS, so there is nothing to say.
    expect(phaseAskNote(QA, DEFAULTS)).toBeNull()
    // ...and when a workspace silences it, the note names the configured default.
    expect(phaseAskNote(QA, resolveGateAsks({ qaSignoff: { ask: false } }))).toEqual({
      gate: 'qa-signoff',
      key: 'qaSignoff',
      default: 'agent-operated',
    })
  })

  it('returns null when the gate will ask, and for a phase that owes no gate at all', () => {
    // The negative half: no note when a person IS asked, or the artifact has no gate.
    expect(phaseAskNote(TDD, TDD_ASKED)).toBeNull()
    expect(phaseAskNote('04-test-summary.md', DEFAULTS)).toBeNull()
    // `gate-block` has no default, so silencing it refuses rather than records — no note either way.
    expect(phaseAskNote('', resolveGateAsks({ gateBlock: { ask: false } }))).toBeNull()
  })
})

/* ========================================================================== */
/* 2. the pre-step reminder AND the closeout guidance — one function, so one  */
/*    test covers both surfaces                                               */
/* ========================================================================== */

describe('phaseLintRulesMessage — the reminder and the closeout guidance say it', () => {
  it('adds ONE line naming the disabled ask, the config key and the recording call', () => {
    const message = phaseLintRulesMessage(TDD, CURRENT_WORKFLOW_PROFILE, null, phaseAskNote(TDD, DEFAULTS))
    expect(message).toContain('the ask is DISABLED by config')
    expect(message).toContain('gates.tddMode.ask: false')
    expect(message).toContain('NO PERSON WILL BE ASKED')
    // The actionable half: the exact call, and the exact label it will record.
    expect(message).toContain('recursive_ask gate=tdd-mode')
    expect(message).toContain('records the configured default `strict`')
    // It is ONE line, not a paragraph: this message is injected on every phase entry.
    expect(message.split('\n').filter((line) => line.includes('DISABLED by config'))).toHaveLength(1)
  })

  it('is BYTE-IDENTICAL to the pre-existing text when the gate asks (or no policy is known)', () => {
    // Three ways to have "nothing to say": the gate asks, no note was computed, or the caller never passed one.
    const withNote = phaseLintRulesMessage(TDD, CURRENT_WORKFLOW_PROFILE, null, null)
    const withoutArg = phaseLintRulesMessage(TDD, CURRENT_WORKFLOW_PROFILE, null)
    expect(withNote).toBe(withoutArg)
    expect(withNote).not.toContain('DISABLED by config')
    // A phase whose gate DOES ask gets exactly that same text, even under a policy that silences another gate.
    const asking = phaseLintRulesMessage(TDD, CURRENT_WORKFLOW_PROFILE, null, phaseAskNote(TDD, TDD_ASKED))
    expect(asking).toBe(withoutArg)
  })
})

/* ========================================================================== */
/* 3. the CLOSEOUT TEXT — the same function, reached through the report       */
/* ========================================================================== */

describe('the closeout report carries the disabled-ask guidance', () => {
  function tempRun(): { root: string; runDir: string; dispose: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'rm-gate-guidance-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    return { root, runDir, dispose: () => rmSync(root, { recursive: true, force: true }) }
  }

  it('phase 05 guidance says nobody will be asked, when qaSignoff.ask is false', () => {
    const run = tempRun()
    try {
      const off = closeoutReport(run.runDir, '05', { gates: resolveGateAsks({ qaSignoff: { ask: false } }) })
      expect(off.guidance.some((line) => line.includes('gates.qaSignoff.ask: false'))).toBe(true)
      expect(off.guidance.some((line) => line.includes('records the configured default `agent-operated`'))).toBe(true)

      // NEGATIVE: the same report with no policy, and with the gate asking, carries no such line.
      const bare = closeoutReport(run.runDir, '05')
      expect(bare.guidance.some((line) => line.includes('DISABLED by config'))).toBe(false)
      const asking = closeoutReport(run.runDir, '05', { gates: resolveGateAsks(undefined) })
      expect(asking.guidance.some((line) => line.includes('DISABLED by config'))).toBe(false)
    } finally {
      run.dispose()
    }
  })
})

/* ========================================================================== */
/* 4. the LINT — the failure an agent actually reads                          */
/* ========================================================================== */

describe('the phase-3 lint names the disabled ask instead of leaving a stall', () => {
  /** A phase-3 artifact with no `TDD Mode` marker — the failure this rule exists for. */
  const CONTENT = ['Run: `/.recursive/run/r1/`', 'Phase: `3 (Implementation)`', 'Status: `DRAFT`', ''].join('\n')

  function lint(gates?: ReturnType<typeof resolveGateAsks>): string[] {
    const root = mkdtempSync(join(tmpdir(), 'rm-gate-lint-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    try {
      const path = join(runDir, TDD)
      writeFileSync(path, CONTENT, 'utf8')
      return lintPhaseSpecificRules(
        path, CONTENT, CURRENT_WORKFLOW_PROFILE, runDir, root, [], null,
        gates === undefined ? {} : { gates },
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('appends the remedy when gates.tddMode.ask is false, and changes NOTHING otherwise', () => {
    const plain = lint()
    // ⚠ THE ANCHOR SENTENCE IS UNTOUCHED WHEN NO POLICY IS SUPPLIED. `scripts/gen-workflow-map.mjs` cites this
    // exact prefix, and every pre-existing caller passes no policy.
    expect(plain).toContain('TDD Compliance Log is missing TDD Mode: strict|pragmatic')

    const silenced = lint(resolveGateAsks(undefined))
    const line = silenced.find((issue) => issue.startsWith('TDD Compliance Log is missing TDD Mode'))
    expect(line, 'the TDD failure disappeared').toBeDefined()
    expect(line).toContain('the tdd-mode ask is DISABLED by config')
    expect(line).toContain('gates.tddMode.ask: false')
    expect(line).toContain('call recursive_ask gate=tdd-mode')
    expect(line).toContain('`strict`')
    // Still starts with the cited sentence, so the anchor keeps matching.
    expect(line!.startsWith('TDD Compliance Log is missing TDD Mode: strict|pragmatic')).toBe(true)

    // NEGATIVE: with the ask enabled the failure is the pre-existing sentence, byte for byte.
    const asked = lint(TDD_ASKED)
    expect(asked).toContain('TDD Compliance Log is missing TDD Mode: strict|pragmatic')
    expect(asked.some((issue) => issue.includes('DISABLED by config'))).toBe(false)
  })
})

/* ========================================================================== */
/* 5. the WIRING — the plugin's Config reaches the lint through the runtime   */
/* ========================================================================== */

describe('the config reaches the lint through the mounted runtime (the wiring proof)', () => {
  /** Mount the real plugin and lint phase 3 of a freshly scaffolded run. */
  async function lintPhase3(config: Record<string, unknown>): Promise<string[]> {
    const repo = mkdtempSync(join(tmpdir(), 'rm-gate-wiring-'))
    const ctx = new Context()
    const original = console.log
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { serverSurface: true, repoRoot: repo, ...config } as never)
      await ctx.recursive.initRun('r1')
      // `lintRun` prints the run's whole lint to the console; the assertion is about its verdict.
      console.log = () => {}
      const result = await ctx.recursive.lintArtifact('r1', TDD)
      return [...result.errors, ...result.warnings]
    } finally {
      console.log = original
      await ctx.fiber.dispose().catch(() => undefined)
      rmSync(repo, { recursive: true, force: true })
    }
  }

  it('the DEFAULT policy silences the phase-3 ask, and lintArtifact reports it — enabling the ask removes it', async () => {
    // ⚠ THIS IS THE ASSERTION THAT FAILS WITHOUT THE WIRING. If `lintArtifact` did not forward the resolved
    // policy into `lintRun`, both mounts would produce the plain sentence and the configured refusal below
    // could never appear. The scaffolded `03-implementation-summary.md` has no `TDD Mode`, so this failure is
    // the exact one an agent meets.
    const silenced = await lintPhase3({})
    expect(
      silenced.some((line) => line.includes('the tdd-mode ask is DISABLED by config')),
      'the config never reached the lint: ' + silenced.join(' | '),
    ).toBe(true)

    // NEGATIVE HALF: the same run with the switch on must NOT carry the remedy.
    const asked = await lintPhase3({ gates: { tddMode: { ask: true } } })
    expect(asked.some((line) => line.includes('DISABLED by config'))).toBe(false)
  })
})

/* ========================================================================== */
/* 6. the two refusals this slice NAMES                                      */
/* ========================================================================== */

describe('the unnamed refusals are registry-named now', () => {
  it('the invalid configured default carries RM1145 and its field path', () => {
    expect(toolError('BAD_GATE_DEFAULT', 'gates.tddMode.default is "banana"')).toContain('RM1145')
    expect(toolError('BAD_GATE_DEFAULT')).toContain('gates.<gate>.default')
  })

  it('the qa.humanReview contradiction carries RM2203 and both field names', () => {
    const sentence = toolError('QA_HUMAN_REVIEW_CONTRADICTION')
    expect(sentence).toContain('RM2203')
    expect(sentence).toContain('qa.humanReview')
    expect(sentence).toContain('gates.qaSignoff.ask')
  })

  it('the MOUNT refusals carry the codes (a bad label, and the contradiction)', async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['bad default', { gates: { tddMode: { default: 'banana' } } }, /RM1145[\s\S]*gates\.tddMode\.default is "banana"[\s\S]*strict \| pragmatic/],
      ['contradiction', { qa: { humanReview: true }, gates: { qaSignoff: { ask: false } } }, /RM2203[\s\S]*qa\.humanReview[\s\S]*gates\.qaSignoff\.ask/],
    ]
    for (const [label, config, expected] of cases) {
      const repo = mkdtempSync(join(tmpdir(), 'rm-gate-code-'))
      const ctx = new Context()
      try {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        await expect(
          ctx.plugin(plugin as never, { serverSurface: true, repoRoot: repo, ...config } as never),
          label + ' was accepted',
        ).rejects.toThrow(expected)
      } finally {
        await ctx.fiber.dispose().catch(() => undefined)
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })
})
