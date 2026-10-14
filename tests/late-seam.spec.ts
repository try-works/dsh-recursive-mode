/**
 * FIX 1 — `recursive_audit_team` REGISTERS WHEN THE `agentTeams` SERVICE ARRIVES **AFTER** THE PLUGIN APPLIED.
 *
 * WHAT THIS PROVES. `src/index.ts` resolves `ctx.agentTeams` TWICE on purpose: a one-shot `ctx.get(...)` at
 * apply time (the fast path, kept) and a `ctx.inject(['agentTeams'], ...)` row that fires whenever the service
 * is mounted later, with a flag so the tool is registered exactly once. This spec mounts the REAL plugin in a
 * real Cordis context, proves the service is ABSENT *after* that apply ran, mounts it afterwards from another
 * plugin's own fiber, and then asserts the tool is not merely LISTED but CALLABLE and BOUND to the late
 * service.
 *
 * ⚠ IT FAILS AGAINST THE OLD BEHAVIOUR, WHICH IS THE WHOLE POINT. With only the one-shot `ctx.get`,
 * `agentTeams` was undefined at apply time, the tool was registered nowhere, and a live session had
 * `team_task_create` working while `recursive_audit_team` answered `unknown tool`. Both halves of that are
 * asserted here: the negative BEFORE the service arrives (unregistered, and the call answers exactly
 * `unknown tool "recursive_audit_team"`), and the positive after.
 *
 * ⚠ WHAT IT DOES **NOT** PROVE — stated so a green is not read as more than it is:
 *   • it does NOT exercise a real `agentTeams` service. The seam is a FIXTURE that satisfies the structural
 *     `TeamRuntimeLike` contract (`createTask`/`updateTask`, plus the optional reads) and records what it was
 *     asked for. It proves the plugin's WIRING, not the host service's behaviour, and not the audit loop;
 *   • it does NOT prove the audit→repair→re-audit state machine — `teams-task-loop.spec.ts` models that;
 *   • it does NOT prove the tool is WITHDRAWN when the service goes away — only that it appears, once, when
 *     the service arrives;
 *   • it does NOT run a live session: no agent, no model, no Loader. The composition is built in-process.
 *
 * ⚠ THE VACUITY TRAP, AND HOW THIS SPEC REFUSES IT. If the fixture service were provided BEFORE the plugin
 * applied, the ONE-SHOT path alone would register the tool and every assertion below would still pass — the
 * spec would be green and prove nothing about late arrival. Two guards against that:
 *   (1) the service is asserted undefined, and the tool asserted unregistered, IMMEDIATELY AFTER the apply
 *       and BEFORE the provider is mounted, so the deferral is observed rather than assumed;
 *   (2) the provider THROWS if it is ever applied before the plugin under test, so reordering the mounts
 *       turns a silent vacuum into a loud failure instead of a passing test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import type { TeamRuntimeLike, TeamTaskViewLike } from '../src/teams-loop.ts'
import type { JobSpecLike, JobsRegistryLike } from '../src/jobs-runner.ts'

/** The tool this spec exists for: the one the one-shot path could not register. */
const TOOL = 'recursive_audit_team'

/**
 * Let every pending MICROTASK settle. A fiber activation is a microtask chain (`_reload` awaits once, then
 * runs the plugin callback), and providing a service wakes the dependents inside that same chain, so a
 * macrotask boundary is what makes "the service arrived" observable rather than racy.
 */
const settle = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

/** The tool catalogue the model would be shown, by name. */
function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map((schema) => schema.name)
}

/**
 * Errors the plugin's own fibers logged, filtered to registration failures.
 *
 * WHY THE LOG AND NOT A `try/catch`: a plugin fiber that throws while loading is CAUGHT by cordis and
 * reported to the logger (`Fiber._reload`), so a duplicate `ctx.tools.register` — which throws
 * `tool "..." is already registered` — never reaches the caller. "Nothing was thrown" is therefore not
 * evidence that nothing failed; reading the log is.
 */
function registrationErrors(ctx: Context): string[] {
  return ctx.logger.buffer
    .filter((message) => message.type === 'error')
    .map((message) => (message.args ?? []).map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '))
    .filter((text) => text.includes(TOOL) || text.includes('already registered'))
}

/** A structural `agentTeams` FIXTURE — see the header for what it does and does not stand in for. */
interface TeamFixture {
  service: TeamRuntimeLike
  /** Every call the tool made THROUGH the seam, in order — the evidence that the late object is the bound one. */
  calls: string[]
}

function teamFixture(): TeamFixture {
  const calls: string[] = []
  let revision = 1
  const view = (): TeamTaskViewLike => ({
    id: 'task-late-1',
    revision,
    subject: 'Audit to pass: late-run 03',
    description: 'drive the audit loop',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
  })
  const service: TeamRuntimeLike = {
    createTask: async (_caller, request) => {
      calls.push('createTask:' + request.subject)
      return view()
    },
    updateTask: async (_caller, request) => {
      calls.push('updateTask:' + request.action)
      revision += 1
      return view()
    },
    getTask: (_caller, id) => {
      calls.push('getTask:' + id)
      return view()
    },
    listTasks: (_caller) => {
      calls.push('listTasks')
      return [view()]
    },
    interrupt: (_caller, targetName) => {
      calls.push('interrupt:' + targetName)
      return { previousStatus: 'running' }
    },
  }
  return { service, calls }
}

/**
 * THE MOUNT, as an ordinary Cordis plugin: its `apply` provides the service from ITS OWN fiber, which is how
 * a later composition layer mounts the agent-team row beside this bundle. `onApply` is the ordering
 * contract — each test states there whether the provider may run before or after the plugin under test, so
 * the mounts cannot be reordered into a vacuous pass.
 */
function teamProvider(service: TeamRuntimeLike, onApply: () => void) {
  return {
    name: 'fixture:agent-teams',
    apply(providerCtx: Context) {
      onApply()
      providerCtx.provide('agentTeams', service)
    },
  }
}

/** The proven harness shape (`work-delegation.spec.ts`): the real plugin, in-process, on the real ToolRuntime. */
async function mountPlugin(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin as never, { serverSurface: true, repoRoot: root } as never)
  return ctx
}

describe('FIX 1: the agentTeams seam registers the audit-team tool LATE', () => {
  const live: Context[] = []
  let root = ''
  let callSeq = 0

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-late-seam-'))
    mkdirSync(join(root, '.recursive', 'run'), { recursive: true })
  })

  afterEach(async () => {
    for (const ctx of live.splice(0)) {
      // Teardown must not mask an assertion that already failed, so its own noise is swallowed.
      try { await ctx.fiber.dispose() } catch { /* ignore */ }
    }
    rmSync(root, { recursive: true, force: true })
  })

  /** Drive one tool call the way the agent loop does: through the ToolRuntime, scoped to a session cwd. */
  async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('late-seam-' + callSeq++),
      name,
      arguments: args,
      agent: { session: { header: { cwd: root } } },
    } as never)
  }

  it('registers it when agentTeams is mounted AFTER apply, bound to that service', async () => {
    const team = teamFixture()
    /** Set by the PROVIDER plugin when it applies — so ordering is observed, never assumed. */
    let providerApplied = false
    /** Set by this test once the plugin under test has applied. */
    let pluginApplied = false

    const ctx = await mountPlugin(root)
    pluginApplied = true
    live.push(ctx)

    // (1) THE STATE THAT USED TO BE TERMINAL: applied, service absent, tool nowhere. Every assertion here
    // runs BEFORE the provider is mounted, which is what makes this a spec about LATE arrival.
    expect(providerApplied, 'the fixture service must not be mounted yet').toBe(false)
    expect(ctx.get('agentTeams'), 'the seam is absent at apply time').toBeUndefined()
    await settle()
    expect(toolNames(ctx), 'an absent seam leaves the one-shot path with nothing to register').not.toContain(TOOL)

    // ... and the call a session actually makes answers exactly what the live session reported.
    const early = await call(ctx, TOOL, { action: 'create', subject: 's', description: 'd' })
    expect(early.isError).toBe(true)
    if (!early.isError) throw new Error('an unregistered tool cannot succeed')
    expect(early.error.message).toContain('unknown tool "' + TOOL + '"')
    expect(team.calls, 'the fixture must not have been reached before it arrived').toEqual([])

    // (2) THE SERVICE ARRIVES, from a later plugin's own fiber.
    await ctx.plugin(teamProvider(team.service, () => {
      if (!pluginApplied) {
        throw new Error('VACUOUS SPEC: the fixture service was mounted before the plugin under test applied, '
          + 'so the one-shot path alone would register the tool and this spec would prove nothing')
      }
      providerApplied = true
    }))
    await settle()

    // The deferral is real, not an ordering accident: the provider applied, and the service this plugin could
    // not see at apply time is now visible to the SAME read (`ctx.get`) that came back undefined then.
    expect(providerApplied).toBe(true)
    expect(ctx.get('agentTeams')).toBe(team.service)

    // (3) THE TOOL EXISTS — ONCE — AND IS BOUND TO THE LATE SERVICE, not merely listed.
    expect(toolNames(ctx), 'the injected path must register the tool the one-shot path could not').toContain(TOOL)
    expect(toolNames(ctx).filter((name) => name === TOOL), 'exactly once, not twice').toHaveLength(1)

    const created = await call(ctx, TOOL, {
      action: 'create',
      subject: 'Audit to pass: late-run 03',
      description: 'drive the audit loop',
    })
    if (created.isError) {
      throw new Error('the late-registered tool answered an error: ' + JSON.stringify(created.error))
    }
    expect(created.value).toMatchObject({ id: 'task-late-1', revision: 1 })
    expect(team.calls, 'the tool reached the LATE service object, not a null seam').toEqual([
      'createTask:Audit to pass: late-run 03',
    ])
  })

  it('registers it EXACTLY ONCE when agentTeams is already present at apply time', async () => {
    // THE OTHER ARM OF THE FLAG, and the reason it exists. With the service present, the one-shot path
    // registers the tool AND the `ctx.inject(['agentTeams'], ...)` row also fires (cordis starts an injecting
    // fiber immediately when its service is already available). Without the flag the second registration
    // would throw `tool "recursive_audit_team" is already registered` inside the injected fiber — an error
    // the fiber logs rather than rethrows, which is why the log is asserted and not the absence of a throw.
    const team = teamFixture()
    let providerApplied = false
    let pluginApplied = false

    const ctx = new Context()
    live.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(teamProvider(team.service, () => {
      if (pluginApplied) {
        throw new Error('this control must mount the service BEFORE the plugin under test applied')
      }
      providerApplied = true
    }))
    expect(providerApplied, 'the control depends on the service being there first').toBe(true)
    expect(ctx.get('agentTeams')).toBe(team.service)

    await ctx.plugin(plugin as never, { serverSurface: true, repoRoot: root } as never)
    pluginApplied = true
    await settle()

    expect(toolNames(ctx).filter((name) => name === TOOL), 'one tool, registered by one of the two paths').toHaveLength(1)
    expect(registrationErrors(ctx), 'a second registration would be logged, not thrown').toEqual([])

    // And the eager registration is bound to the service too, so the assertion above is not merely a count.
    const created = await call(ctx, TOOL, { action: 'create', subject: 'eager', description: 'd' })
    if (created.isError) {
      throw new Error('the eagerly-registered tool answered an error: ' + JSON.stringify(created.error))
    }
    expect(team.calls).toContain('createTask:eager')
  })
})

/**
 * THE JOBS SEAM — THE FOURTH SEAM TO NEED THE LATE ATTACH, AND THE FIRST ONE WHOSE ABSENCE FROZE A RUN.
 *
 * WHAT THIS PROVES. `ctx.jobs` is mounted by a LATER loader layer than this plugin (the `recursive`
 * preset mounts `@deepseek-ai/dsh-tool-jobs`; the host mounts the registry), so the one-shot
 * `ctx.get('jobs')` at apply time legitimately comes back undefined on a host that HAS the registry —
 * and before this row existed, nothing ever re-resolved it, so every long operation ran untracked and,
 * worse, `runTracked` had only the absent-registry degradation to fall back on. This spec mounts the REAL
 * plugin, proves `jobs` is ABSENT after that apply, mounts it afterwards from another plugin's own fiber,
 * and then asserts the runtime uses it — BY USE, not by identity: a lint is started and the spec the late
 * registry received is inspected, owner included.
 *
 * ⚠ IT FAILS AGAINST THE OLD BEHAVIOUR, WHICH IS THE WHOLE POINT. With only the one-shot `ctx.get`, the
 * runtime held `null` forever and `attachedJobs()` answered `null` after the service arrived; the lint
 * therefore reached no registry at all and the fixture recorded zero specs. Both halves are asserted: the
 * negative BEFORE the service arrives, and the positive after.
 *
 * ⚠ WHAT IT DOES **NOT** PROVE — stated so a green is not read as more than it is:
 *   • it does NOT exercise the real `LocalJobRegistry`. The seam is a FIXTURE satisfying the structural
 *     `JobsRegistryLike` contract. It proves the plugin's WIRING, not the harness's owner-serving rule —
 *     `jobs-tracking.spec.ts` covers the owner value and the refusal degradation;
 *   • it does NOT prove the attachment is WITHDRAWN when the service goes away;
 *   • it does NOT run a live session: no agent, no model, no Loader. The composition is built in-process.
 *
 * ⚠ THE VACUITY TRAP, AND HOW THIS SPEC REFUSES IT. If the fixture registry were provided BEFORE the
 * plugin applied, the one-shot construction path would attach it and every assertion below would still
 * pass while proving nothing about late arrival. Two guards: the service and `attachedJobs()` are asserted
 * absent IMMEDIATELY AFTER the apply and BEFORE the provider is mounted, and the provider THROWS if it is
 * ever applied first, so reordering the mounts turns a silent vacuum into a loud failure.
 */
describe('THE JOBS SEAM: a registry mounted after apply still reaches the runtime', () => {
  const RUN = 'late-jobs-run'
  const ARTIFACT = '00-requirements.md'

  /** A structural `ctx.jobs` FIXTURE — see the header for what it does and does not stand in for. */
  function jobsFixture(): { service: JobsRegistryLike; specs: JobSpecLike[] } {
    const specs: JobSpecLike[] = []
    const service: JobsRegistryLike = {
      start(spec) {
        specs.push(spec)
        // The real contract: `run` is invoked synchronously and its hooks are the handle.
        spec.run({ id: 'lint-1', append: () => {}, updateProgress: () => {} })
        return 'lint-1'
      },
    }
    return { service, specs }
  }

  /** The mount, as an ordinary Cordis plugin providing the service from ITS OWN fiber. */
  function jobsProvider(service: JobsRegistryLike, onApply: () => void) {
    return {
      name: 'fixture:jobs',
      apply(providerCtx: Context) {
        onApply()
        providerCtx.provide('jobs', service)
      },
    }
  }

  it('uses it when jobs is mounted AFTER apply, owner included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-late-jobs-'))
    const jobs = jobsFixture()
    let providerApplied = false
    let pluginApplied = false
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin as never, { serverSurface: true, repoRoot: root } as never)
      pluginApplied = true

      // (1) THE STATE THAT USED TO BE TERMINAL: applied, registry absent, runtime holding null.
      expect(providerApplied, 'the fixture registry must not be mounted yet').toBe(false)
      expect(ctx.get('jobs'), 'the seam is absent at apply time').toBeUndefined()
      await settle()
      expect(ctx.recursive.attachedJobs(), 'the one-shot path had nothing to attach').toBeNull()

      // (2) THE REGISTRY ARRIVES, from a later plugin's own fiber.
      await ctx.plugin(jobsProvider(jobs.service, () => {
        if (!pluginApplied) {
          throw new Error('VACUOUS SPEC: the fixture registry was mounted before the plugin under test '
            + 'applied, so the one-shot path alone would attach it and this spec would prove nothing')
        }
        providerApplied = true
      }))
      await settle()

      // The deferral is real, not an ordering accident: the service this plugin could not see at apply
      // time is now visible to the SAME read (`ctx.get`) that came back undefined then.
      expect(providerApplied).toBe(true)
      expect(ctx.get('jobs')).toBe(jobs.service)
      // (3) AND IT REACHED THE RUNTIME, which is what the injected row exists to do.
      expect(ctx.recursive.attachedJobs()).toBe(jobs.service)

      // (4) PROVEN BY USE — a lint goes THROUGH the late registry. A run directory with no artifact makes
      // the runtime answer `Artifact not found` WITHOUT calling the linter, so an artifact is authored
      // first; what is asserted is the spec the registry received, not the lint verdict.
      mkdirSync(join(root, '.recursive', 'run', RUN), { recursive: true })
      writeFileSync(join(root, '.recursive', 'run', RUN, ARTIFACT), '# Requirements\n\nStatus: `DRAFT`\n', 'utf8')
      await ctx.recursive.lintArtifact(RUN, ARTIFACT, { id: 'agent-late' })
      expect(jobs.specs, 'the late registry must have been reached').toHaveLength(1)
      expect(jobs.specs[0].kind).toBe('lint')
      // ⚠ THE OWNER, asserted here too so the two halves of the fix are covered by one composition: with no
      // owner the real registry would consult only the global layer and refuse.
      expect(jobs.specs[0].owner).toBe('agent-late')
    } finally {
      try { await ctx.fiber.dispose() } catch { /* teardown must not mask an assertion that already failed */ }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
