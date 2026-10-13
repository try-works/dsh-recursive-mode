/**
 * T36 — `recursive_review` is REACHABLE and HONEST.
 *
 * The driver, the observer and the verdict contract all have their own specs; what
 * this one proves is the layer the operator's requirement actually needs: that the
 * tool is registered, that a plugin mount can call it, and that when the continuable
 * seam is missing it reports `unavailable` naming the lost repair path instead of
 * pretending the review was a success. A review tool that silently degrades to
 * "approved" without being able to repair anything would be worse than no tool.
 *
 * ⚠ AND SINCE THE D3 TEST BELOW, IT ALSO PROVES THE REPAIR PATH IS LIVE. D3 was a real,
 * live-verified defect with no unit test: the tool factory captured `ctx.get('subagents')` at
 * apply time (before the service existed), so `sendRepair` resolved `undefined` while the round
 * still promised "The child is kept so the repair can be sent to it". The last test in this file
 * mounts a NATIVE route and provides the seam AFTER apply — the live order — and the repair has
 * to reach the child.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { TOOL_ERRORS } from '../src/errors.ts'
// The route path and the reply path are READ FROM THE PARSER/WRITER rather than restated here: a test that
// hardcoded `.recursive/config/recursive-router.json` would keep passing if the plugin moved the file and the
// route silently stopped resolving.
import { routerPolicyPath } from '../src/router.ts'
import { replyPath } from '../src/handoff.ts'
import { recordSettlement } from '../src/settlement.ts'

const signal = new AbortController().signal
const RUN_ID = 'review-run'

interface Mounted {
  ctx: Context
  repo: string
  dispose: () => Promise<void>
}

/**
 * ⚠ THE WORKSPACE ROUTE THAT MAKES `code-reviewer` RESOLVE **NATIVE**, and it must be a FILE.
 *
 * The plugin's own config cannot do this: `router.roles` / `router.subagent` / `router.defaults`
 * (`src/config.ts:135-194`) override only MODEL and provider per role — the route's TIER is decided by the
 * workspace policy the router loads (`src/router.ts` -> `routerPolicyPath`). With no file, the default
 * `when_role_unconfigured: 'ask'` REFUSES the role and `delegateContinuable` is never reached, which is
 * exactly what the refusal test below pins.
 *
 * ⚠ WHICH FIELDS ARE REQUIRED IS MEASURED, NOT ASSUMED, and `mode` is NOT where "continuable" lives. The
 * parser's only reads are:
 *   - `if (!route || !route.enabled)` — the ONE field that can refuse the role (router.ts:538);
 *   - `route.mode === 'external-cli' && cli !== null` — the only read of `mode`, and the only read of `cli`
 *     (router.ts:573-574); anything else falls through to the MODEL route;
 *   - `route.fallback` — read only at the FLOOR, after no native provider was registered (router.ts:637).
 * `mode: 'native'` therefore states the intent rather than steering the parser (it is the value the other
 * specs use, e.g. tests/router.spec.ts:210), and `cli: null` keeps the CLI branch unreachable even if a later
 * edit sets `mode`; `model: null` keeps the model ladder out of it, so the child inherits the session's model.
 * CONTINUABLE is the TOOL's argument — `mode: 'continuable'` in `recursive_review.tool.ts:130` — and no route
 * field can express it. The remaining requirement is a registered NATIVE provider: `nativeProviderFor` takes
 * the first of `[role, 'spawn', 'fork', 'dsh-sdk']` the service enumerates (router.ts:654-662), which the seam
 * below supplies through `list()`.
 */
const NATIVE_CODE_REVIEWER_ROUTE = {
  version: 1,
  defaults: {
    when_role_unconfigured: 'ask',
    when_cli_unavailable: 'fallback-local',
    when_model_unknown: 'ask',
    allow_auto_assign_if_single_cli: false,
    probe_timeout_ms: 50000,
    invoke_timeout_ms: 180000,
  },
  role_routes: {
    'code-reviewer': { enabled: true, mode: 'native', cli: null, model: null, fallback: 'self-audit' },
  },
}

/**
 * Mount the real plugin over a temp repo holding one run with a DRAFT artifact.
 *
 * `route: true` writes the workspace policy file INSIDE the temp repo (`routerPolicyPath`), so a test that
 * needs a real tier gets one without touching the developer's own `.recursive/` tree. Default false: the
 * existing tests pin the no-route behaviour and must keep it.
 */
async function mount(options: { artifact?: boolean; route?: boolean } = {}): Promise<Mounted> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-reviewtool-'))
  const runDir = join(repo, '.recursive', 'run', RUN_ID)
  mkdirSync(runDir, { recursive: true })
  if (options.artifact !== false) {
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: `x`\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n', 'utf8')
  }
  if (options.route === true) {
    mkdirSync(join(repo, '.recursive', 'config'), { recursive: true })
    writeFileSync(routerPolicyPath(repo), JSON.stringify(NATIVE_CODE_REVIEWER_ROUTE, null, 2), 'utf8')
  }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, { repoRoot: repo } as never)
  return {
    ctx,
    repo,
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

/**
 * ⚠ D3 — PROVIDE THE `subagents` SERVICE **AFTER** THE PLUGIN APPLIED, which is the live composition order.
 *
 * The plugin resolves this service with a ONE-SHOT `ctx.get('subagents')` at apply time and hands that value
 * to the review tool's factory (`src/index.ts:304`, `:384`, `:402`); the real service appears LATER, through
 * `ctx.inject(['subagents'], …)` -> `recursive.attachSubagents` (`src/index.ts:312-314`). A mount that
 * provides the seam BEFORE the plugin — as the other delegation specs do — cannot see D3 at all: the factory
 * captures a real seam and the defect is invisible. This helper is the order that reproduces it.
 *
 * ⚠ BOTH CALLS ARE NEEDED, and that is measured rather than stylistic: `provide` is what `ctx.get`/`ctx.inject`
 * see, and `set` is what the harness's own property access reads. The same pair appears in
 * tests/e2e-harness.spec.ts:139-140 and tests/work-delegation.spec.ts:99-100.
 */
async function provideSubagentsLate(m: Mounted, seam: unknown): Promise<void> {
  await m.ctx.plugin({
    apply(providerCtx: Context) {
      providerCtx.provide('subagents', seam as never)
      ;(providerCtx as unknown as { set: (key: string, value: unknown) => void }).set('subagents', seam)
    },
  } as never, {} as never)
}

function review(m: Mounted, args: Record<string, unknown> = {}) {
  return m.ctx.tools.execute({
    signal,
    callId: ToolCallId('rev-1'),
    name: 'recursive_review',
    arguments: { runId: RUN_ID, ...args },
    agent: { session: { header: { cwd: m.repo } } },
  } as never)
}

describe('T36 — recursive_review is registered and callable', () => {
  it('is a real tool on the registration surface', async () => {
    const m = await mount()
    try {
      expect(m.ctx.tools.get('recursive_review')).toBeTruthy()
    } finally {
      await m.dispose()
    }
  })

  it('with NO continuable seam it reports `unavailable`, saying the review did NOT run', async () => {
    const m = await mount()
    try {
      const out = await review(m) as { isError?: boolean; value?: { status?: string; message?: string } }
      // The tool ran fine; what it REPORTS is that no review happened at all.
      // ⚠ THIS USED TO PIN "WITHOUT the continuable repair path", which was true only while a
      // one-shot fallback existed: a review ran, just an unrepairable one. T35 forbids that fallback
      // (delegation is ALWAYS continuable; one-shot must be ASKED for), so the delegation now refuses
      // and NO child is dispatched. Reporting "ran without" would claim a review that does not exist.
      expect(out.isError).toBeFalsy()
      expect(out.value?.status).toBe('unavailable')
      expect(out.value?.message).toContain('DID NOT RUN')
      // ⚠ AND IT NO LONGER ASSERTS A CAUSE IT DID NOT ESTABLISH. This used to require
      // "must be continuable", which was the seam-only wording — and a test then showed that wording
      // being printed for a review that had actually refused because the ROUTER resolved the role to
      // self-audit. The condition this mount produces is the ROUTER one (no role route is configured
      // for `code-reviewer` here), so the message must quote THAT reason, not invent a seam problem.
      expect(out.value?.message).toContain('no continuable reviewer was dispatched')
      expect(out.value?.message).toContain('self-audit')
    } finally {
      await m.dispose()
    }
  })

  it('refuses a phase with no artifact to review, with a CODED refusal', async () => {
    const m = await mount({ artifact: false })
    try {
      const out = await review(m)
      // The plugin's convention is a `{ error }` field in the returned value (all
      // nine other tools do the same), not the harness's isError flag — so that is
      // what a caller branches on, and it must carry the registry code.
      expect(JSON.stringify(out)).toContain(TOOL_ERRORS.NO_PHASE.code)
    } finally {
      await m.dispose()
    }
  })

  it('an unknown runId is NOT a refusal: status resolves the latest run instead', async () => {
    // Deliberate existing behaviour — `resolveRunDir` falls back to the latest run by
    // mtime, so an unknown id reviews what IS there rather than erroring. Pinned here
    // so a future change to that fallback shows up as a failure rather than as a
    // silently different review target.
    const m = await mount()
    try {
      const out = await review(m, { runId: 'no-such-run' })
      expect(JSON.stringify(out)).not.toContain(TOOL_ERRORS.NO_RUN.code)
    } finally {
      await m.dispose()
    }
  })

  /**
   * ⚠ D3 — THE SEAM IS RESOLVED AT CALL TIME, WHICH IS WHAT MAKES THE REPAIR REACHABLE.
   *
   * `recursive_review` declares `inject: ['tools']`, so `apply` runs BEFORE the `subagents` service exists in a
   * real composition, and the tool factory captured whatever `ctx.get('subagents')` returned then (undefined).
   * The runtime was given a late-attach for exactly this (`attachSubagents` via `ctx.inject`); the tool wiring
   * was not, so `sendRepair` resolved `undefined`, threw 'no continuable followup seam' into a bare catch, and
   * the round still promised "The child is kept so the repair can be sent to it". MEASURED live: a
   * prototype-level spy on `SubagentRuntime.sendMessage` logged ZERO invocations while that sentence printed.
   *
   * THE MOUNT BELOW IS THE LIVE ORDER — route, then plugin, then service — and the last assertions are chosen
   * so that reverting the call-time resolution FAILS here. That matters because a stale tool-level seam is NOT
   * observable everywhere: `delegateReview` reads `input.subagents ?? this.subagentsSeam`, so the CHILD is still
   * started through the runtime's own attachment. The one thing only the tool's seam can do is the repair, which
   * is why this test asserts on the repair rather than stopping at "a child was started".
   */
  it('D3: repairs the child it started, because the seam is resolved at CALL time', async () => {
    const m = await mount({ route: true })
    try {
      const runDir = join(m.repo, '.recursive', 'run', RUN_ID)
      const calls: string[] = []
      const repairs: Array<{ childId: string; text: string }> = []
      let startedChildId: string | null = null
      const FINDING = 'the rollback path is missing'

      // The seam the live host exposes, in shape only. `sendMessage` is the LIVE follow-up name (the service has
      // no `followup` method), and `list()` is what `providerMapFromSeam` asks so the router has a native provider.
      const seam = {
        list: () => ['spawn'],
        getProvider: (name: string) => (name === 'spawn' ? { name } : undefined),
        // ⚠ `this` IS LOAD-BEARING, exactly as on the live service: `startContinuable` opens with
        // `this.requireContinuations()` (packages/subagent/subagent/src/index.ts:261), and a loose extraction of
        // this method is a defect this plugin has already shipped once. A plugin that detached it would throw
        // before the call is recorded, so this test fails on an unbound extraction as well as on a stale seam.
        requireContinuations(): string { return 'ok' },
        async startContinuable(
          this: { requireContinuations: () => string },
          spec: { childId?: string; label?: string },
        ) {
          if (this.requireContinuations() !== 'ok') throw new Error('startContinuable lost its receiver')
          calls.push('startContinuable')
          // The host honours a caller-reserved child id and this fake must too: the brief and the prompt were
          // already written under that id, so inventing another one would put the reply where nobody reads it.
          const childId = spec.childId ?? 'child-d3'
          startedChildId = childId
          const delegationId = String(spec.label ?? '').split('/')[0] ?? ''
          // ⚠ THE CHILD RUNS AND SETTLES, which keeps this test off the observer's 30s poll: reply.md carries a
          // REVISE with ONE finding, and the settlement notice is recorded under the same child — the two facts a
          // live host's settlement seam leaves behind when a child finishes. Nothing else about the round is faked.
          writeFileSync(
            replyPath({ root: m.repo, runId: RUN_ID, delegationId, childId }),
            JSON.stringify({ verdict: 'REVISE', findings: [{ severity: 'HIGH', title: FINDING, detail: 'x' }] }),
            'utf8',
          )
          recordSettlement(runDir, { childId, summary: 'review complete', closingText: '' })
          return { childId, messageId: 'msg-1' }
        },
        async sendMessage(_parent: unknown, childId: string, content: ReadonlyArray<{ type: 'text'; text: string }>) {
          calls.push('sendMessage')
          repairs.push({ childId: String(childId), text: content.map((part) => part.text).join('') })
          return 'msg-2'
        },
      }

      await provideSubagentsLate(m, seam)
      expect(
        (m.ctx as unknown as { recursive: { attachedSubagents: () => unknown } }).recursive.attachedSubagents(),
        'the late attach must reach the runtime, or this test would be exercising the no-service path',
      ).not.toBeNull()

      const out = await review(m) as { isError?: boolean; value?: { status?: string; message?: string } }
      const payload = JSON.stringify(out)

      // THE REVIEW RAN. A refusal here would mean the route never resolved and this test proves nothing about D3.
      expect(out.isError).toBeFalsy()
      expect(payload, payload).not.toContain('DID NOT RUN')
      expect(out.value?.status, payload).toBe('revised')
      // THE CHILD WAS STARTED — and started BOUND, or `startContinuable` itself threw.
      expect(calls, 'the continuable child was never started: ' + payload).toContain('startContinuable')
      // AND THE ROUND NAMES THE CHILD THE SEAM RETURNED.
      expect(startedChildId).not.toBeNull()
      expect(payload, payload).toContain(String(startedChildId))
      // ⚠ AND THE REPAIR REACHED IT. THIS IS THE ASSERTION THE D3 FIX TURNS ON: the child id and the child's own
      // finding travel only if `sendRepair` resolved a LIVE seam. With the apply-time capture it resolves
      // undefined, `resolveFollowupSeam` returns undefined, the throw is swallowed, and the payload instead
      // carries the promise this defect was made of — asserted absent, immediately below.
      //
      // The assertion is "the child's OWN FINDING came back to the SAME child", not a count of messages: the
      // delegation loop's own follow-up would also ride this seam (it is resolved from the runtime's attachment),
      // so a count would pin incidental behaviour and fail for the wrong reason if that reader ever changes. The
      // finding identifies the DRIVER's repair specifically, which is the one the tool's seam owns.
      expect(calls, 'the repair never reached the seam: ' + payload).toContain('sendMessage')
      const driverRepair = repairs.find((repair) => repair.text.includes(FINDING))
      expect(driverRepair, 'no follow-up quoted the child\'s own finding: ' + payload).toBeDefined()
      expect(
        repairs.every((repair) => repair.childId === startedChildId),
        'every follow-up goes to the SAME child the round started',
      ).toBe(true)
      expect(payload, payload).toContain('A repair instruction was sent to the SAME child')
      expect(payload, payload).not.toContain('The child is kept so the repair can be sent to it')
    } finally {
      await m.dispose()
    }
    // ⚠ ABOVE THE OBSERVER'S OWN TIMEOUT ON PURPOSE. `settlementRoundObserver` is called by the tool with its
    // 30s default poll (`src/settlement.ts`), so if the settlement ever stopped being found, this test would sit
    // there for 30s and report `reviewing`. A margin above that poll makes the failure the readable assertion
    // above ("expected 'reviewing' to be 'revised'"), not a timeout. The happy path is under half a second.
  }, 60_000)
})
