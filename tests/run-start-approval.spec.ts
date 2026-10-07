/**
 * PHASE 0 — A SPEC IS NOT A RUN. STARTING A RUN IS A HUMAN DECISION.
 *
 * THE DEFECT. `recursive_init` scaffolded a run, and the plugin then created and ARMED a goal for it in
 * the same breath — objective `recursive-run:<id>`, phase `active`, no approval of any kind. `create`
 * returns an ARMED goal, so the harness immediately began driving autonomous goal rounds for a session
 * whose user had only asked for a spec.
 *
 * THE RULE. "Creating a spec before a run exists should not create a goal. Phase 0 requires explicit
 * approval to start a run and goal."
 *
 * WHAT THESE TESTS ARE FOR. Every clause below is written so that it FAILS on the old behaviour — the
 * first one asserts the ABSENCE of a goal after scaffolding, which the old code could not produce. The
 * two halves are deliberately adjacent: the unapproved run must be inert, and the approved run must work
 * exactly as it did, because a gate that also broke the workflow would be a different defect.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { RecursiveRuntime } from '../src/runtime.ts'
import type { GoalServiceLike, GoalViewLike } from '../src/goals-projection.ts'
import {
  RUN_START_APPROVE,
  RUN_START_ARTIFACT,
  RUN_START_GATE_ID,
  RUN_START_HOLD,
  RUN_START_MARKER,
  RUN_START_NOT_APPROVED,
} from '../src/run-start.ts'
import { buildAskQuestionFor, validateAskAnswerFor } from '../src/recursive_ask.tool.ts'

/**
 * A structural fake of the live `goals` service — the same shape `tests/goals-projection.spec.ts` uses.
 *
 * ⚠ `create` records the view as ARMED, and that is the property under test: the defect was not "a
 * record appeared", it was "the harness got continuation authority it was never given". So the fake
 * keeps a `created` count, which is how "no goal exists" is asserted as a fact rather than as
 * "the objective string did not match".
 */
function fakeGoals() {
  let revision = 0
  const store: { current?: GoalViewLike; created: number; mutations: string[] } = { created: 0, mutations: [] }
  const mutate = (phase: GoalViewLike['phase'], ref: { id: string; revision: number }): GoalViewLike => {
    if (!store.current || store.current.id !== ref.id) throw new Error('goal revision mismatch')
    store.mutations.push(phase as string)
    store.current = { ...store.current, phase, revision: ref.revision + 1 }
    return store.current
  }
  const service: GoalServiceLike = {
    get: () => store.current,
    create: (_agent, req) => {
      revision += 1
      store.created += 1
      const created: GoalViewLike = { id: 'g' + revision, revision, objective: req.objective, phase: 'active' }
      store.current = created
      return created
    },
    block: (_agent, ref) => mutate('blocked', ref),
    pause: (_agent, ref) => mutate('paused', ref),
    resume: (_agent, ref) => mutate('active', ref),
    complete: (_agent, ref) => mutate('complete', ref),
    clear: (_agent, ref) => { store.current = undefined; return { id: ref.id, revision: ref.revision + 1 } },
  }
  return { service, store }
}

function tempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const agentFor = (root: string) => ({ session: { header: { cwd: root } } })

/**
 * The tool result's JSON payload.
 *
 * Read from `value` (the typed result the tool returned) rather than re-parsing the rendered text: the
 * envelope's `value` IS the payload, and going through the text would make these assertions depend on the
 * renderer's formatting as well as on the behaviour under test.
 */
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

describe('PHASE 0 — a scaffolded run exists without a goal', () => {
  it('recursive_init creates NO goal, and reports that approval is owed', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { repoRoot: root } as never)
      // The goals seam is attached AFTER the mount: the plugin's Config is the settings namespace and
      // strips keys it does not declare, so a fake passed in through Config would silently vanish.
      ctx.recursive.attachGoals(goals.service)

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-init'),
        name: 'recursive_init',
        arguments: { runId: '01-calculator' },
        agent: agentFor(root),
      } as never)
      const out = payload(result)

      // (1) THE DEFECT ITSELF: no goal was created, so the harness was given nothing to drive.
      expect(goals.store.created, 'recursive_init created a goal: ' + JSON.stringify(goals.store.current)).toBe(0)
      expect(goals.store.current).toBeUndefined()

      // (2) AND THE SPEC IS STILL A SPEC: the run directory and its Phase 0 artifacts exist. The rule
      // forbids starting a run, not creating one — "creating a spec before a run exists" must stay legal.
      expect(existsSync(join(root, '.recursive', 'run', '01-calculator', RUN_START_ARTIFACT))).toBe(true)
      expect(out.runId).toBe('01-calculator')

      // (3) The result POINTS AT THE GATE rather than leaving the model to guess why nothing is running.
      expect(out.runStartApproval).toMatchObject({ approved: false, artifact: RUN_START_ARTIFACT, gate: RUN_START_GATE_ID })
      expect(String((out.runStartApproval as { reason: string }).reason).length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the run stays inert through ordinary phase work: no goal on repeated projections', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      const runtime = new RecursiveRuntime(ctx, { repoRoot: root, goals: goals.service })
      await runtime.initRun('01-calculator', agentFor(root))

      // `syncRunGoal` is reached on ordinary work; the unapproved state must be a STABLE, QUIET value.
      for (const state of ['active', 'paused', 'active', 'blocked'] as const) {
        const sync = runtime.armRunGoalIfApproved(agentFor(root), root, '01-calculator', state)
        expect(sync).toEqual({ ok: false, reason: RUN_START_NOT_APPROVED })
      }
      expect(goals.store.created).toBe(0)
      expect(goals.store.current).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('PHASE 0 — explicit approval starts the run, and the goal works as before', () => {
  it('answering gate=run-start records the approval and CREATES + ARMS the goal', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { repoRoot: root } as never)
      // The goals seam is attached AFTER the mount: the plugin's Config is the settings namespace and
      // strips keys it does not declare, so a fake passed in through Config would silently vanish.
      ctx.recursive.attachGoals(goals.service)
      const call = (args: Record<string, unknown>, callId: string) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(callId),
        name: 'recursive_ask',
        arguments: args,
        agent: agentFor(root),
      } as never)

      await call({ gate: RUN_START_GATE_ID, runId: '01-calculator' }, 'rs-warm')
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-init'),
        name: 'recursive_init',
        arguments: { runId: '01-calculator' },
        agent: agentFor(root),
      } as never)
      expect(goals.store.created).toBe(0)

      const asked = payload(await call({ gate: RUN_START_GATE_ID, runId: '01-calculator' }, 'rs-ask'))
      // ASKING starts nothing and records nothing: there is a question and no decision.
      expect(goals.store.created).toBe(0)
      expect((asked.question as { options: Array<{ label: string }> }).options.map((o) => o.label))
        .toEqual([RUN_START_APPROVE, RUN_START_HOLD])

      const started = payload(await call({ gate: RUN_START_GATE_ID, runId: '01-calculator', answer: RUN_START_APPROVE }, 'rs-answer'))

      // (1) THE APPROVAL IS DURABLE, in the run's own Phase 0 artifact — citable without a transcript.
      expect(readFileSync(join(root, '.recursive', 'run', '01-calculator', RUN_START_ARTIFACT), 'utf8'))
        .toContain('- ' + RUN_START_MARKER + ': ' + RUN_START_APPROVE)
      expect(started.armed).toBe(true)

      // (2) THE GOAL EXISTS, IS ARMED, and carries the marker the projection matches on.
      expect(goals.store.created).toBe(1)
      expect(goals.store.current?.objective).toBe('recursive-run:01-calculator · active')
      expect(goals.store.current?.phase).toBe('active')

      // (3) AND EVERY EXISTING GOAL BEHAVIOUR STILL WORKS. Phase sync mutates the SAME goal (no second
      // create), and a resume re-arms it — the loop the run depends on. Driven through the MOUNTED
      // runtime, which is the object the tools actually call.
      const sync = ctx.recursive.armRunGoalIfApproved(agentFor(root), root, '01-calculator', 'blocked')
      expect(sync.ok).toBe(true)
      expect(goals.store.current?.phase).toBe('blocked')
      expect(goals.store.created, 'phase sync created a second goal').toBe(1)

      const resumed = ctx.recursive.resumeRunToGoal(agentFor(root), '01-calculator', true)
      expect(resumed.ok).toBe(true)
      expect(goals.store.current?.phase).toBe('active')
      expect(goals.store.created).toBe(1)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a `Hold` is recorded as the decision it is, and starts NOTHING', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { repoRoot: root } as never)
      // The goals seam is attached AFTER the mount: the plugin's Config is the settings namespace and
      // strips keys it does not declare, so a fake passed in through Config would silently vanish.
      ctx.recursive.attachGoals(goals.service)
      const call = (args: Record<string, unknown>) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-hold'),
        name: 'recursive_ask',
        arguments: args,
        agent: agentFor(root),
      } as never)

      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-init'),
        name: 'recursive_init',
        arguments: { runId: '02-calculator' },
        agent: agentFor(root),
      } as never)

      const held = payload(await call({ gate: RUN_START_GATE_ID, runId: '02-calculator', answer: RUN_START_HOLD }))
      // Declining is a real decision, so it belongs in the record — but it is not consent.
      expect(readFileSync(join(root, '.recursive', 'run', '02-calculator', RUN_START_ARTIFACT), 'utf8'))
        .toContain('- ' + RUN_START_MARKER + ': ' + RUN_START_HOLD)
      expect(goals.store.created).toBe(0)
      expect(goals.store.current).toBeUndefined()
      expect(held.armed).toBe(false)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('REFUSES an unoffered answer: an approval is a label the gate offered, not any string', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { repoRoot: root } as never)
      // The goals seam is attached AFTER the mount: the plugin's Config is the settings namespace and
      // strips keys it does not declare, so a fake passed in through Config would silently vanish.
      ctx.recursive.attachGoals(goals.service)
      const refused = payload(await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-bad'),
        name: 'recursive_ask',
        arguments: { gate: RUN_START_GATE_ID, runId: 'r1', answer: 'yes' },
        agent: agentFor(root),
      } as never))
      // RM1142 = the answer is not one of the labels the gate offered, with the labels named.
      expect(String(refused.error)).toContain('RM1142')
      expect(String(refused.error)).toContain(RUN_START_APPROVE)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * PHASE 0 — THE HUMAN CHANNEL, and what each path can and cannot claim.
 *
 * ⚠ WHAT IS AND IS NOT PROVEN HERE. `recursive_ask` asks `ctx.userQuestions.ask()` — the harness's
 * blocking human question channel — and treats ITS verdict as authoritative, falling back to the
 * relayed `answer` only when nobody could be asked. A unit test can establish the CONTRACT that makes
 * that safe: a channel that answers decides (even against the caller's argument), a channel that
 * rejects leaves the relayed answer as the only source, and a channel with no answer at all refuses with
 * RM5503 rather than recording an approval nobody made. What it CANNOT establish is that the live
 * service renders a card for a plugin-authored question: that is a host behaviour, and this suite has no
 * live composition to observe it.
 */
describe('PHASE 0 — the blocking channel decides when it can answer', () => {
  it('records the CHANNEL’s selection, and its decline overrides the caller’s argument', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { repoRoot: root } as never)
      // The goals seam is attached AFTER the mount: the plugin's Config is the settings namespace and
      // strips keys it does not declare, so a fake passed in through Config would silently vanish.
      ctx.recursive.attachGoals(goals.service)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-init'),
        name: 'recursive_init',
        arguments: { runId: 'r1' },
        agent: agentFor(root),
      } as never)

      // A channel that answers the way a person would.
      ctx.recursive.attachUserQuestions({
        ask: () => Promise.resolve({ answers: [{ id: RUN_START_GATE_ID, selected: [RUN_START_HOLD] }] }),
      })
      const declined = payload(await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-channel-hold'),
        name: 'recursive_ask',
        // The model asks for `Start run`; the PERSON said hold. The person wins.
        arguments: { gate: RUN_START_GATE_ID, runId: 'r1', answer: RUN_START_APPROVE },
        agent: agentFor(root),
      } as never))
      expect(declined.answer).toBe(RUN_START_HOLD)
      expect(declined.source).toBe('user-questions')
      expect(declined.armed).toBe(false)
      expect(goals.store.created, 'a person declined and a goal was armed anyway').toBe(0)

      // The same channel, now approving. No `answer` argument is even needed: the channel IS the answer.
      ctx.recursive.attachUserQuestions({
        ask: () => Promise.resolve({ answers: [{ id: RUN_START_GATE_ID, selected: [RUN_START_APPROVE] }] }),
      })
      const started = payload(await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-channel-start'),
        name: 'recursive_ask',
        arguments: { gate: RUN_START_GATE_ID, runId: 'r1' },
        agent: agentFor(root),
      } as never))
      expect(started.armed).toBe(true)
      expect(started.source).toBe('user-questions')
      expect(goals.store.created).toBe(1)
      expect(goals.store.current?.objective).toBe('recursive-run:r1 · active')
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a channel that REJECTS is refused as unanswered — the relayed answer is NOT a way round it', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { repoRoot: root } as never)
      ctx.recursive.attachGoals(goals.service)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-init'),
        name: 'recursive_init',
        arguments: { runId: 'r1' },
        agent: agentFor(root),
      } as never)
      // A channel that behaves like the real one for a caller it will not serve: it REJECTS. The channel
      // IS mounted, so a person could have been asked and was not — and the caller's own answer must not
      // become the decision.
      ctx.recursive.attachUserQuestions({
        ask: () => Promise.reject(new Error('human interaction requires the exact live calling agent when an agent is supplied')),
      })
      const refused = payload(await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-relay'),
        name: 'recursive_ask',
        arguments: { gate: RUN_START_GATE_ID, runId: 'r1', answer: RUN_START_APPROVE },
        agent: agentFor(root),
      } as never))
      expect(String(refused.error)).toContain('RM5503')
      expect(goals.store.created).toBe(0)
      expect(readFileSync(join(root, '.recursive', 'run', 'r1', RUN_START_ARTIFACT), 'utf8')).not.toContain(RUN_START_MARKER)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('REFUSES when a mounted channel could not ask AND no answer was supplied (RM5503)', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { repoRoot: root } as never)
      // The goals seam is attached AFTER the mount: the plugin's Config is the settings namespace and
      // strips keys it does not declare, so a fake passed in through Config would silently vanish.
      ctx.recursive.attachGoals(goals.service)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-init'),
        name: 'recursive_init',
        arguments: { runId: 'r1' },
        agent: agentFor(root),
      } as never)
      ctx.recursive.attachUserQuestions({ ask: () => Promise.reject(new Error('no user-questions answerer accepted the request')) })

      const refused = payload(await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-unanswered'),
        name: 'recursive_ask',
        arguments: { gate: RUN_START_GATE_ID, runId: 'r1' },
        agent: agentFor(root),
      } as never))
      expect(String(refused.error)).toContain('RM5503')
      // Nothing was written and nothing was armed: an unconfirmable start is refused, not guessed.
      expect(goals.store.created).toBe(0)
      expect(goals.store.current).toBeUndefined()
      expect(readFileSync(join(root, '.recursive', 'run', 'r1', RUN_START_ARTIFACT), 'utf8')).not.toContain(RUN_START_MARKER)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('with no channel mounted, ASKING surfaces the question and records NOTHING', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { repoRoot: root } as never)
      // The goals seam is attached AFTER the mount: the plugin's Config is the settings namespace and
      // strips keys it does not declare, so a fake passed in through Config would silently vanish.
      ctx.recursive.attachGoals(goals.service)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-init'),
        name: 'recursive_init',
        arguments: { runId: 'r1' },
        agent: agentFor(root),
      } as never)

      const ask = (args: Record<string, unknown>, id: string) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(id),
        name: 'recursive_ask',
        arguments: args,
        agent: agentFor(root),
      } as never)

      // ASK: the question, and no decision anywhere. This is the first half of the round trip a person
      // goes through in a composition without the blocking channel.
      const asked = payload(await ask({ gate: RUN_START_GATE_ID, runId: 'r1' }, 'rs-noc-ask'))
      expect((asked.question as { options: Array<{ label: string }> }).options.map((o) => o.label))
        .toEqual([RUN_START_APPROVE, RUN_START_HOLD])
      expect(goals.store.created).toBe(0)
      expect(readFileSync(join(root, '.recursive', 'run', 'r1', RUN_START_ARTIFACT), 'utf8')).not.toContain(RUN_START_MARKER)

      // ANSWER: the same call WITH the person's reply. Only now does anything happen.
      const started = payload(await ask({ gate: RUN_START_GATE_ID, runId: 'r1', answer: RUN_START_APPROVE }, 'rs-noc-answer'))
      expect(started.armed).toBe(true)
      expect(goals.store.created).toBe(1)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a mounted channel is ALWAYS consulted: an answer argument cannot bypass the person', async () => {
    const root = tempRepo('rm-runstart-')
    const ctx = new Context()
    const goals = fakeGoals()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { repoRoot: root } as never)
      ctx.recursive.attachGoals(goals.service)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-init'),
        name: 'recursive_init',
        arguments: { runId: 'r1' },
        agent: agentFor(root),
      } as never)

      // The channel is asked EVEN THOUGH the caller supplied an answer, and nobody answers it.
      let asked = 0
      ctx.recursive.attachUserQuestions({
        ask: () => { asked += 1; return Promise.reject(new Error('no user-questions answerer accepted the request')) },
      })
      const refused = payload(await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('rs-bypass'),
        name: 'recursive_ask',
        arguments: { gate: RUN_START_GATE_ID, runId: 'r1', answer: RUN_START_APPROVE },
        agent: agentFor(root),
      } as never))
      expect(asked, 'the person was never asked').toBe(1)
      expect(String(refused.error)).toContain('RM5503')
      expect(goals.store.created).toBe(0)
      expect(goals.store.current).toBeUndefined()
      expect(readFileSync(join(root, '.recursive', 'run', 'r1', RUN_START_ARTIFACT), 'utf8')).not.toContain(RUN_START_MARKER)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('PHASE 0 — the gate data is well formed and the workflow gates are untouched', () => {
  it('the run-start question passes the plugin’s own validation, with the labels the gate uses', () => {
    const question = buildAskQuestionFor(RUN_START_GATE_ID)
    expect(question.id).toBe(RUN_START_GATE_ID)
    expect(question.options.map((o) => o.label)).toEqual([RUN_START_APPROVE, RUN_START_HOLD])
    // The wording is the point of the gate: a person answering it must be told that approving arms a goal.
    expect(question.question.toLowerCase()).toContain('goal')
    expect(() => validateAskAnswerFor(RUN_START_GATE_ID, RUN_START_APPROVE)).not.toThrow()
    expect(() => validateAskAnswerFor(RUN_START_GATE_ID, 'yes')).toThrow(/Start run \| Hold/)
  })

  it('the three workflow gates still validate exactly as before', () => {
    expect(buildAskQuestionFor('tdd-mode').options.map((o) => o.label)).toEqual(['strict', 'pragmatic'])
    expect(validateAskAnswerFor('qa-signoff', 'hybrid')).toBe('hybrid')
    expect(() => validateAskAnswerFor('tdd-mode', 'maybe')).toThrow(/strict \| pragmatic/)
  })
})
