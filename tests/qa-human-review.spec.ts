/**
 * PART A + PART B — THE QA SIGN-OFF THAT NEVER REACHED THE PERSON, AND THE GATE THAT NOW HOLDS.
 *
 * THE OWNER'S REPORT, VERBATIM: *"the agent asks me for qa approval without sending a proper question ui
 * component for sign off, so i dont see any notification its just in the chat text and i miss it"*.
 *
 * THE MECHANISM, CONFIRMED IN CODE BEFORE THIS SPEC EXISTED. `recursive_ask` called
 * `channel.ask({ questions, agent, signal, wait })` from exactly ONE place — `askRunStartDirectly` — so for
 * `tdd-mode`, `qa-signoff` and `gate-block` a call without `answer` merely RETURNED the question as JSON
 * (`return { gate, marker, artifact, question }`). The model then retyped it in the transcript. No card was
 * ever rendered, so the host never notified anybody.
 *
 * WHAT IT COST. In a live run the agent asked the `qa-signoff` gate three times (13:26:57, 13:38:00,
 * 13:39:02), the person never saw a card and never answered, and the agent then wrote
 * `QA Execution Mode: agent-operated` into `05-manual-qa.md` and proceeded.
 *
 * PART A — every gate is now PUT TO THE PERSON when the composition mounts the channel: the call renders a
 * card, the person's own label is what gets recorded (`source: "channel"`), and a question that reached
 * nobody (or was cancelled, or came back as a non-label) is REFUSED with the cause named and NOTHING
 * written — so the artifact stays unanswered and the phase cannot lock on a non-answer.
 *
 * PART B — `qa.humanReview`, the phase-5 lint switch: with it on, an `agent-operated` QA mode FAILS, and the
 * artifact must carry the sign-off line `recursive_ask` writes plus an authored `## Human Review
 * Instructions` section. With it off — the default — the lint is byte-for-byte what it was.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import {
  askGateDirectly,
  qaSignOffLine,
  validateAskAnswerFor,
} from '../src/recursive_ask.tool.ts'
import { lintPhaseSpecificRules, parseQaSignOff } from '../src/ts-lint.ts'
import { CURRENT_WORKFLOW_PROFILE, QA_HUMAN_REVIEW_FIELDS, QA_HUMAN_REVIEW_SECTION, QA_SIGN_OFF_FIELD } from '../src/phase-rules.ts'

const RUN = 'qa-run'
const ARTIFACT = '05-manual-qa.md'

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

/** A channel error shaped like the harness's own: a `UserQuestionError` carrying a stable code. */
function channelError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

/** A temp repo with the real plugin mounted and one run scaffolded — the mount the ask specs use. */
async function mountAsk(options: { qa?: { humanReview: boolean } } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'rm-qa-review-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin as never, { serverSurface: true, repoRoot: repo, ...options } as never)
  await ctx.recursive.initRun(RUN)
  const call = (args: Record<string, unknown>, callId: string) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'recursive_ask',
    arguments: args,
    agent: { session: { header: { cwd: repo } } },
  } as never)
  return {
    ctx,
    repo,
    call,
    runDir: join(repo, '.recursive', 'run', RUN),
    /** The one file the QA gate writes into. */
    artifactText: () => readFileSync(join(repo, '.recursive', 'run', RUN, ARTIFACT), 'utf8'),
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

/* ========================================================================== */
/* PART A — the question is PUT TO THE PERSON, and only their answer records  */
/* ========================================================================== */

describe('PART A — a mounted channel is asked for the qa-signoff gate, and its answer is what records', () => {
  it('1. calls channel.ask with the gate’s question and this tool call, writes the marker, reports source: channel', async () => {
    const m = await mountAsk()
    try {
      // The channel records the EXACT request it was handed, and answers the way a person would.
      const requests: Array<{
        questions: Array<{ id: string; header: string; question: string; options: Array<{ label: string }> }>
        agent?: unknown
        signal?: unknown
        wait?: { callId?: unknown }
      }> = []
      m.ctx.recursive.attachUserQuestions({
        ask: (request: never) => {
          requests.push(request)
          return Promise.resolve({ answers: [{ id: 'qa-signoff', selected: ['hybrid'] }] })
        },
      })

      const result = payload(await m.call({ gate: 'qa-signoff', runId: RUN }, 'qa-card-1'))

      // (1) THE CHANNEL REALLY WAS ASKED — the defect was that it was not. The request carries the gate's
      // own question and options, so a live card would render the decision rather than a blank prompt.
      expect(requests).toHaveLength(1)
      const request = requests[0]!
      expect(request.questions).toHaveLength(1)
      expect(request.questions[0]).toMatchObject({ id: 'qa-signoff', header: 'QA sign-off' })
      expect(request.questions[0]!.options.map((option) => option.label)).toEqual(['human', 'agent-operated', 'hybrid'])
      // (2) THE CARD IS LINKED TO THIS CALL, which is what lets the host settle the right tool call with the
      // person's answer (`wait.callId` — the same seam plan-mode's exit uses).
      expect(request.wait).toEqual({ callId: 'qa-card-1' })

      // (3) THE PERSON'S ANSWER IS WHAT LANDED, and the result says where it came from.
      expect(result.gate).toBe('qa-signoff')
      expect(result.answer).toBe('hybrid')
      expect(result.marker).toBe('- QA Execution Mode: hybrid')
      expect(result.artifact).toBe(ARTIFACT)
      expect(result.source).toBe('channel')

      // (4) BOTH LINES ARE DURABLE: the mode marker, and the distinct sign-off line Part B requires.
      const text = m.artifactText()
      expect(text).toContain('- QA Execution Mode: hybrid')
      const recordedAt = /\(gate answer recorded (\d{4}-\d{2}-\d{2}T[^)]*)\)/.exec(String(result.signOff))
      expect(recordedAt, 'the result reports no sign-off line: ' + JSON.stringify(result)).not.toBeNull()
      expect(text).toContain(String(result.signOff))
      // The line the linter parses is the same line the tool says it wrote.
      expect(parseQaSignOff(text)).toEqual({ answer: 'hybrid', recordedAt: recordedAt![1] })
    } finally {
      await m.dispose()
    }
  })

  it('1b. askGateDirectly filters to the gate’s OWN labels — a stray label is not a decision', async () => {
    // The exported helper is exercised directly because its filtering is what the tool relies on: a UI can
    // return a label this gate never offered (or another gate's), and that must not become a mode.
    const askWith = (selected: string[]) => askGateDirectly({
      ask: () => Promise.resolve({ answers: [{ id: 'qa-signoff', selected }] }),
    } as never, {
      id: 'qa-signoff',
      header: 'QA sign-off',
      question: 'Who signs off the manual QA phase?',
      options: [{ label: 'human' }, { label: 'agent-operated' }, { label: 'hybrid' }],
    }, { agent: {}, callId: 'direct' })

    // Another gate's label, returned as a selection: nothing this gate offered, so nothing to record.
    const stray = await askWith(['strict'])
    expect(stray.kind).toBe('unusable')
    // TWO recognised labels is not "one of them": the gate records a decision, not a selection list.
    const multiple = await askWith(['human', 'agent-operated'])
    expect(multiple.kind).toBe('unusable')
    // And the honest positive: the gate's own single label IS the answer, with a foreign label dropped.
    const filtered = await askWith(['hybrid', 'strict'])
    expect(filtered).toEqual({ kind: 'answered', answer: 'hybrid' })
  })

  it('2. a channel that reaches NOBODY refuses with its cause, and records NOTHING (the live-run case)', async () => {
    const m = await mountAsk()
    try {
      // This is the case that silently proceeded in the live run: the question reached nobody. It must not
      // become a mode, and the refusal must name WHY rather than asserting a cause it does not know.
      m.ctx.recursive.attachUserQuestions({
        ask: () => Promise.reject(channelError('NO_PROVIDER', 'no user-questions answerer accepted the request')),
      })
      const before = m.artifactText()
      const refused = payload(await m.call({ gate: 'qa-signoff', runId: RUN }, 'qa-card-2'))

      expect(String(refused.error)).toContain('RM5506')
      expect(String(refused.error)).toContain('NO_PROVIDER')
      expect(refused.channel).toMatchObject({ outcome: 'unavailable', cause: 'NO_PROVIDER', relayable: true })
      // NOTHING WAS RECORDED: no marker, no sign-off line, no invented mode.
      const after = m.artifactText()
      expect(after).not.toContain('QA Execution Mode:')
      expect(after).not.toContain(QA_SIGN_OFF_FIELD + ':')
      expect(after).toBe(before)
      // The question still travels, so a composition without a card can put the decision in the transcript.
      expect((refused.question as { options: Array<{ label: string }> }).options.map((o) => o.label))
        .toEqual(['human', 'agent-operated', 'hybrid'])

      // ⚠ A CANCELLED CARD IS NOT A FAILURE TO DELIVER, and the payload says so: `relayable: false` is how a
      // caller can tell "the person dismissed it" from "the channel never worked".
      m.ctx.recursive.attachUserQuestions({
        ask: () => Promise.reject(channelError('ASK_CANCELLED', 'the user cancelled ask_user_question')),
      })
      const cancelled = payload(await m.call({ gate: 'qa-signoff', runId: RUN }, 'qa-card-2b'))
      expect(String(cancelled.error)).toContain('RM5506')
      expect(cancelled.channel).toMatchObject({ outcome: 'unavailable', cause: 'ASK_CANCELLED', relayable: false })
      expect(m.artifactText()).not.toContain('QA Execution Mode:')
    } finally {
      await m.dispose()
    }
  })

  it('2b. a person who answered with NO offered label is refused (RM5505), and records NOTHING', async () => {
    const m = await mountAsk()
    try {
      // A skip: the channel RESOLVED, so a person was reached, and they chose nothing. That is a decision
      // this gate cannot record — and the mode marker must not be invented from the model's preference.
      m.ctx.recursive.attachUserQuestions({
        ask: () => Promise.resolve({ answers: [{ id: 'qa-signoff', selected: [] }] }),
      })
      const skipped = payload(await m.call({ gate: 'qa-signoff', runId: RUN }, 'qa-card-skip'))
      expect(String(skipped.error)).toContain('RM5505')
      expect(String(skipped.error)).toContain('skip')
      expect(m.artifactText()).not.toContain('QA Execution Mode:')

      // A label the gate never offered, returned as a selection rather than as free text.
      m.ctx.recursive.attachUserQuestions({
        ask: () => Promise.resolve({ answers: [{ id: 'qa-signoff', selected: ['someone-else'] }] }),
      })
      const unknown = payload(await m.call({ gate: 'qa-signoff', runId: RUN }, 'qa-card-unknown'))
      expect(String(unknown.error)).toContain('RM5505')
      expect(String(unknown.error)).toContain('someone-else')
      expect(m.artifactText()).not.toContain('QA Execution Mode:')
    } finally {
      await m.dispose()
    }
  })

  it('3. with NO channel mounted the behaviour is UNCHANGED: the question is returned and nothing is recorded', async () => {
    const m = await mountAsk()
    try {
      const before = m.artifactText()
      const asked = payload(await m.call({ gate: 'qa-signoff', runId: RUN }, 'qa-no-channel'))

      // The relay shape, exactly as before Part A: gate, marker, artifact and the card-ready question.
      expect(asked.gate).toBe('qa-signoff')
      expect(asked.marker).toBe('QA Execution Mode')
      expect(asked.artifact).toBe(ARTIFACT)
      expect((asked.question as { options: Array<{ label: string }> }).options.map((o) => o.label))
        .toEqual(['human', 'agent-operated', 'hybrid'])
      // Nothing recorded, nothing claimed.
      expect(asked.source).toBeUndefined()
      expect(asked.path).toBeUndefined()
      expect(String(asked.error ?? '')).toBe('')
      expect(m.artifactText()).toBe(before)

      // And the relayed answer still records, through the same tool, in a later call.
      const recorded = payload(await m.call({ gate: 'qa-signoff', runId: RUN, answer: 'human' }, 'qa-no-channel-answer'))
      expect(recorded.marker).toBe('- QA Execution Mode: human')
      expect(m.artifactText()).toContain('- QA Execution Mode: human')
    } finally {
      await m.dispose()
    }
  })
})

/* ========================================================================== */
/* PART B — qa.humanReview, through the phase-5 lint                          */
/* ========================================================================== */

/**
 * A `05-manual-qa.md` that meets the PRE-EXISTING standard (mode, executor, tools, evidence, sign-off,
 * traceability, gates) so the cases below report the human-review rules and not collateral noise.
 *
 * The evidence path is written by the caller into the repository, because the existing rules check that a
 * cited path EXISTS; a fixture that skipped it would fail every case for the same unrelated reason.
 */
function qaArtifact(options: {
  mode?: string
  approvedBy?: string
  date?: string
  signOff?: string | null
  instructions?: string | null
} = {}): string {
  const mode = options.mode ?? 'human'
  const signOff = options.signOff === undefined ? qaSignOffLine(mode, '2026-10-17T06:00:00.000Z') : options.signOff
  const instructions = options.instructions === undefined
    ? [
        '## ' + QA_HUMAN_REVIEW_SECTION,
        '',
        '- ' + QA_HUMAN_REVIEW_FIELDS[0] + ': http://127.0.0.1:3080',
        '- ' + QA_HUMAN_REVIEW_FIELDS[1] + ': the manual QA checklist runs end to end and the lock gate refuses an out-of-order lock',
        '- ' + QA_HUMAN_REVIEW_FIELDS[2] + ': call recursive_ask with gate qa-signoff, then fill User Sign-Off -> Approved by and Date',
        '',
      ].join('\n')
    : options.instructions ?? ''
  return [
    'Run: `/.recursive/run/' + RUN + '/`',
    'Phase: `05 Manual QA`',
    'Status: `DRAFT`',
    'Inputs:',
    '- `/.recursive/run/' + RUN + '/02-to-be-plan.md`',
    'Outputs:',
    '- `/.recursive/run/' + RUN + '/05-manual-qa.md`',
    'Scope note: manual QA for the fixture run.',
    '',
    '## TODO',
    '',
    '- [x] record the QA execution record',
    '',
    '## QA Execution Record',
    '',
    '- QA Execution Mode: ' + mode,
    '- Agent Executor: the run agent, driving the fixture repository through its own tools',
    '- Tools Used: `recursive_lock`, `recursive_lint`',
    '',
    '## QA Scenarios and Results',
    '',
    '- Scenario: lock an artifact whose prerequisite is still DRAFT. Result: refused, and the refusal names the prerequisite.',
    '',
    '## Evidence and Artifacts',
    '',
    '- `/.recursive/run/' + RUN + '/evidence/qa/manual-qa-scenario-1.txt`',
    '',
    '## User Sign-Off',
    '',
    '- Approved by: ' + (options.approvedBy ?? 'A Person'),
    '- Date: ' + (options.date ?? '2026-10-17'),
    ...(signOff === null ? [] : [signOff]),
    '',
    '## Requirement Completion Status',
    '',
    '- R1 | Status: complete | Rationale: the scenario above exercises the guard',
    '',
    '## Traceability',
    '',
    '- R1 is traced to the QA scenario above.',
    '',
    '## Coverage Gate',
    '',
    'Coverage: PASS',
    '',
    '## Approval Gate',
    '',
    'Approval: PASS',
    '',
    instructions,
    '',
  ].join('\n')
}

/** Run the phase-5 lint over `content`, in a repo where the cited evidence path exists. */
function lintQa(content: string, humanReview?: boolean): string[] {
  const root = mkdtempSync(join(tmpdir(), 'rm-qa-lint-'))
  try {
    const runDir = join(root, '.recursive', 'run', RUN)
    mkdirSync(join(runDir, 'evidence', 'qa'), { recursive: true })
    writeFileSync(join(runDir, 'evidence', 'qa', 'manual-qa-scenario-1.txt'), 'QA scenario record\n', 'utf8')
    writeFileSync(join(runDir, ARTIFACT), content, 'utf8')
    // The two calls are written out rather than spread from an array: the seventh argument is a MUTABLE
    // `string[] | null`, and a `as const` tuple would hand it a `readonly []`.
    return humanReview === undefined
      ? lintPhaseSpecificRules(join(runDir, ARTIFACT), content, CURRENT_WORKFLOW_PROFILE, runDir, root, [], null)
      : lintPhaseSpecificRules(join(runDir, ARTIFACT), content, CURRENT_WORKFLOW_PROFILE, runDir, root, [], null, { humanReview })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The phase-5 findings the PART B rules are responsible for. Every message names the config. */
function humanReviewFindings(content: string, humanReview = true): string[] {
  return lintQa(content, humanReview).filter((issue) => issue.includes('qa.humanReview'))
}

describe('PART B — qa.humanReview makes the phase-5 gate a person’s decision', () => {
  it('4. humanReview: true REFUSES the agent-operated downgrade, naming the config', () => {
    const findings = humanReviewFindings(qaArtifact({ mode: 'agent-operated', approvedBy: 'N/A', date: 'N/A' }))
    // The exact escape the live run used: the agent wrote `agent-operated` and moved on. Under the switch
    // that mode is the failure, and the refusal comes from CONFIG rather than from an artifact nit.
    const refused = findings.find((issue) => issue.includes('refused by configuration'))
    expect(refused, 'the agent-operated downgrade was not refused: ' + JSON.stringify(findings)).toBeDefined()
    expect(String(refused)).toContain('qa.humanReview')
    expect(String(refused)).toContain('agent-operated')
    // The mode is not the only thing missing: the artifact has no human evidence either. Both are reported.
    expect(findings.some((issue) => issue.includes('Approved by'))).toBe(true)
    expect(findings.some((issue) => issue.includes('Date'))).toBe(true)
  })

  it('5. humanReview: true REQUIRES the sign-off line recursive_ask writes — missing FAILS, present passes', () => {
    const missing = humanReviewFindings(qaArtifact({ signOff: null }))
    const signOffFinding = missing.find((issue) => issue.includes('sign-off line recursive_ask writes'))
    expect(signOffFinding, 'a missing sign-off line was not reported: ' + JSON.stringify(missing)).toBeDefined()
    expect(String(signOffFinding)).toContain(QA_SIGN_OFF_FIELD)

    // PRESENT: the line the tool writes satisfies the rule, and the fully authored artifact is clean.
    expect(humanReviewFindings(qaArtifact())).toEqual([])

    // AND A MISMATCH IS NOT A SIGN-OFF: the line records one decision and the mode another.
    const mismatched = humanReviewFindings(qaArtifact({ mode: 'hybrid', signOff: qaSignOffLine('human', '2026-10-17T06:00:00.000Z') }))
    expect(mismatched.some((issue) => issue.includes('same decision as QA Execution Mode'))).toBe(true)

    // A hand-typed line in the right shape but the wrong one (no ISO stamp) is not the writer's shape.
    const forged = humanReviewFindings(qaArtifact({ signOff: '- ' + QA_SIGN_OFF_FIELD + ': human (approved by me)' }))
    expect(forged.some((issue) => issue.includes('sign-off line recursive_ask writes'))).toBe(true)
  })

  it('6. humanReview: true REQUIRES an authored ## Human Review Instructions section, naming each missing part', () => {
    const absent = humanReviewFindings(qaArtifact({ instructions: null }))
    const missingSection = absent.find((issue) => issue.includes('## ' + QA_HUMAN_REVIEW_SECTION))
    expect(missingSection, 'a missing human-review section was not reported: ' + JSON.stringify(absent)).toBeDefined()
    // The refusal names the section AND what it must hold, so the fix is inferable without reading the rule.
    expect(String(missingSection)).toContain('where the product runs')
    expect(String(missingSection)).toContain('how they sign off')

    // A SCAFFOLD IS NOT AN ANSWER: the closeout writes `<...>` placeholders, and they must not pass.
    const scaffolded = humanReviewFindings(qaArtifact({
      instructions: [
        '## ' + QA_HUMAN_REVIEW_SECTION,
        '',
        '- ' + QA_HUMAN_REVIEW_FIELDS[0] + ': <the URL the product is running at, or the exact command a person runs>',
        '- ' + QA_HUMAN_REVIEW_FIELDS[1] + ': <the observable behaviour the person must confirm, step by step>',
        '- ' + QA_HUMAN_REVIEW_FIELDS[2] + ': <how the person signs off>',
        '',
      ].join('\n'),
    }))
    for (const field of QA_HUMAN_REVIEW_FIELDS) {
      expect(scaffolded.some((issue) => issue.includes(field)), 'placeholder ' + field + ' was accepted').toBe(true)
    }

    // PARTIAL: only the first field is authored — the other two are named, one finding each.
    const partial = humanReviewFindings(qaArtifact({
      instructions: [
        '## ' + QA_HUMAN_REVIEW_SECTION,
        '',
        '- ' + QA_HUMAN_REVIEW_FIELDS[0] + ': the exact command `pnpm --filter app dev`',
        '',
      ].join('\n'),
    }))
    expect(partial.some((issue) => issue.includes(QA_HUMAN_REVIEW_FIELDS[1]))).toBe(true)
    expect(partial.some((issue) => issue.includes(QA_HUMAN_REVIEW_FIELDS[2]))).toBe(true)
  })

  it('7. humanReview: false (and absent) leaves the phase-5 lint EXACTLY as it was', () => {
    // The switch is only a switch: with it off, the findings are IDENTICAL to a call that never heard of it,
    // for both an agent-operated artifact and a human one. This is what "existing runs keep working" means
    // in checkable terms, rather than "nothing appeared to break".
    for (const mode of ['agent-operated', 'human', 'hybrid'] as const) {
      const content = qaArtifact({ mode })
      expect(lintQa(content, false)).toEqual(lintQa(content))
      expect(humanReviewFindings(content, false)).toEqual([])
    }
    // And the pre-existing rules are still there — the agent-operated mode still needs its executor, tools
    // and evidence. Turning the config off must not quietly drop the standard that already existed.
    const agentOperated = lintQa(qaArtifact({ mode: 'agent-operated' }), false)
    expect(agentOperated.some((issue) => issue.includes('Agent Executor'))).toBe(false) // present in the fixture
    const stripped = qaArtifact({ mode: 'agent-operated' }).replace('- Agent Executor: the run agent, driving the fixture repository through its own tools', '')
    expect(lintQa(stripped, false).some((issue) => issue.includes('Agent Executor'))).toBe(true)
  })
})

/* ========================================================================== */
/* WIRING — the config reaches the lint through the runtime, or this fails    */
/* ========================================================================== */

describe('PART B wiring — qa.humanReview on the plugin’s Config reaches the phase-5 lint', () => {
  /** A run whose 05 artifact is the agent-operated shape, plus the 00-requirements that picks the profile. */
  function seedRun(repo: string): void {
    const runDir = join(repo, '.recursive', 'run', RUN)
    mkdirSync(join(runDir, 'evidence', 'qa'), { recursive: true })
    writeFileSync(join(runDir, 'evidence', 'qa', 'manual-qa-scenario-1.txt'), 'QA scenario record\n', 'utf8')
    // The strict profile is read from the Phase 0 document; without it the phase-5 rules never run.
    writeFileSync(join(runDir, '00-requirements.md'), [
      'Run: `/.recursive/run/' + RUN + '/`',
      'Phase: `00 Requirements`',
      'Status: `DRAFT`',
      'Workflow version: `' + CURRENT_WORKFLOW_PROFILE + '`',
      'Inputs:',
      '- operator brief',
      'Outputs:',
      '- `/.recursive/run/' + RUN + '/00-requirements.md`',
      'Scope note: requirements for the fixture run.',
      '',
      '## TODO',
      '',
      '- [x] elicit requirements',
      '',
      '## Requirements',
      '',
      '### `R1` the QA gate',
      '',
      'Description: the QA phase is signed off by a person.',
      'Acceptance criteria:',
      '- the lint refuses an agent-operated mode under human review',
      '',
      '## Out of Scope',
      '',
      '- nothing',
      '',
      '## Constraints',
      '',
      '- the linter is the authority',
      '',
      '## Coverage Gate',
      '',
      'Coverage: PASS',
      '',
      '## Approval Gate',
      '',
      'Approval: PASS',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(runDir, ARTIFACT), qaArtifact({ mode: 'agent-operated', approvedBy: 'N/A', date: 'N/A', signOff: null }), 'utf8')
  }

  async function lintViaRuntime(qa: { humanReview: boolean } | undefined): Promise<string[]> {
    const repo = mkdtempSync(join(tmpdir(), 'rm-qa-wiring-'))
    const ctx = new Context()
    const original = console.log
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { serverSurface: true, repoRoot: repo, ...(qa === undefined ? {} : { qa }) } as never)
      seedRun(repo)
      // `lintRun` prints the run's whole lint to the console; the assertion is about its verdict.
      console.log = () => {}
      const result = await ctx.recursive.lintArtifact(RUN, ARTIFACT, { session: { header: { cwd: repo } } })
      return [...result.errors, ...result.warnings]
    } finally {
      console.log = original
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  }

  it('with qa.humanReview: true the runtime lint reports the config refusal; without it, it does not', async () => {
    const on = await lintViaRuntime({ humanReview: true })
    expect(on.some((line) => line.includes('qa.humanReview')), 'the config never reached the lint: ' + on.join(' | ')).toBe(true)
    expect(on.some((line) => line.includes('refused by configuration'))).toBe(true)

    // ⚠ THE NEGATIVE HALF IS THE WIRING PROOF. If `lintArtifact` ignored `setQaConfig`, the ON case would
    // pass for the wrong reason — so the same run, with the switch absent, must NOT carry the refusal.
    const off = await lintViaRuntime(undefined)
    expect(off.filter((line) => line.includes('qa.humanReview'))).toEqual([])
  })
})

describe('PART A — validateAskAnswerFor still guards the channel-write path', () => {
  it('the filter and the validator agree on what a recordable answer is', () => {
    // Belt and braces: the tool validates the channel's answer before writing the marker. These two checks
    // are what make that validation meaningful rather than decorative.
    expect(validateAskAnswerFor('qa-signoff', 'hybrid')).toBe('hybrid')
    expect(() => validateAskAnswerFor('qa-signoff', 'strict')).toThrow(/human \| agent-operated \| hybrid/)
  })
})
