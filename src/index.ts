import { type Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { RecursiveRuntime } from './runtime.ts'
import { createRecursiveStatusTool } from './recursive_status.tool.ts'
import { createRecursiveInitTool } from './recursive_init.tool.ts'
import { createRecursiveLockTool } from './recursive_lock.tool.ts'
import { createRecursiveLintTool } from './recursive_lint.tool.ts'
import { createRecursiveCloseoutTool } from './recursive_closeout.tool.ts'
import { createRecursiveScratchTool } from './recursive_scratch.tool.ts'
import { createRecursiveWorktreeTool } from './recursive_worktree.tool.ts'
import { createRecursivePhaseTool } from './recursive_phase.tool.ts'
import { createRecursiveAuditTeamTool } from './recursive_audit_team.tool.ts'
import { createRecursiveReviewTool } from './recursive_review.tool.ts'
import type { SubagentsRuntimeLike } from './delegation.ts'
import { registerRecursiveCommand } from './commands.ts'
import { evaluateToolGuard, coerceAskToDecision, type ToolGuardDecision } from './enforcement.ts'
import { appendGuardDecision, appendObservedTamper, type GuardDecisionRecord } from './guard-log.ts'
import type { GoalServiceLike } from './goals-projection.ts'
import type { TeamRuntimeLike } from './teams-loop.ts'
import { renderRecursivePolicy } from './policy.ts'
import { fsPolicyIntent } from './fs-intent.ts'
import { snapshotWorkspace } from './snapshot.ts'
import { mountRecursiveRoutesOnce, makeRecursiveRoutes, type RecursiveRouteHost } from './live-route.ts'
import { registerRecursiveSkill } from './skills.ts'
import { enumerateRuns, stageBWorkflowInit } from './bootstrap.ts'
import { getNextLegalPhase, getLockStatus } from './lock.ts'
import { resolveRunDir } from './run.ts'
import { phaseLintRulesMessage, ReminderOnceGate } from './phase-rules.ts'
import { settlementFromEvent, runDirForChild, recordSettlement } from './settlement.ts'

/**
 * rc.2 rebase (T31a) — the message-source vocabulary changed under us.
 *
 * At `dsh-v0.1.1-rc.2` `MessageSourceMap` carried a shared catch-all
 * `plugin: { kind: 'plugin'; plugin: string }` entry, which this file used for
 * its injected phase-lint reminder. At `dsh-v0.2.0-rc.2` that entry is GONE:
 * the map is merge-extensible and, in its own words, "each producer declares
 * its own `kind` in its own module; there is no shared catch-all `plugin`
 * kind". This was invisible in the old checkout because its `node_modules`
 * still held a stale `dsh-llm`.
 *
 * The idiom below is copied from the shipped `@deepseek-ai/dsh-repeat-tool-reminder`,
 * whose pre-step reminder is the closest analogue to ours: a user-role message
 * whose source declares its own kind and a `form: 'notice'` one-line account.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'recursive-mode': { kind: 'recursive-mode' } & ContextFormed
  }
}

/** Producer source stamped on every injected phase-lint reminder. */
const REMINDER_SOURCE = { kind: 'recursive-mode' } as const

export const name = '@try-works/dsh-recursive-mode'

export { RecursiveRuntime } from './runtime.ts'
export { createRecursiveStatusTool } from './recursive_status.tool.ts'
export { createRecursiveInitTool } from './recursive_init.tool.ts'
export { createRecursiveLockTool } from './recursive_lock.tool.ts'
export { createRecursiveLintTool } from './recursive_lint.tool.ts'
export { createRecursiveCloseoutTool } from './recursive_closeout.tool.ts'
export { createRecursiveScratchTool } from './recursive_scratch.tool.ts'
export { createRecursiveWorktreeTool } from './recursive_worktree.tool.ts'
export { createRecursivePhaseTool } from './recursive_phase.tool.ts'
export * from './status.ts'
export {
  PHASE_SEQUENCE,
  OPTIONAL_PHASES,
  normalizeForLockHash,
  lockHashFromContent,
  phaseIndex,
  isCoreArtifact,
  getPrerequisites,
  getLockStatus,
  getPrerequisiteBlockers,
  receiptPath,
  readReceipt,
  writeReceipt,
  invalidateReceipt,
  getStaleDownstreamPhases,
  getNextLegalPhase,
  getAllStaleReceipts,
  validateChain,
} from './lock.ts'
export type {
  LockReceipt,
  LockStatus,
  PrerequisiteBlocker,
  StaleDownstream,
  ChainPhaseResult,
  LockChainResult,
} from './lock.ts'
export * from './run.ts'
export * from './review.ts'
export * from './handoff.ts'
export * from './router.ts'
export * from './delegation.ts'
export * from './lifecycle.ts'
export * from './enforcement.ts'
export * from './policy.ts'
export * from './snapshot.ts'
export * from './live-route.ts'
export * from './teams-loop.ts'
export * from './skills.ts'

/**
 * Bundle plugin entry. The Loader activates this row once `tools` is available
 * (`inject` below); the RecursiveRuntime service is constructed directly so it
 * is provided on `ctx.recursive` for the lifetime of this fiber, and the
 * read-path tools (status/init/lock/lint) are registered through it (R2/R4).
 */
export const inject = ['tools']

/**
 * Plugin entry (SP2 R1). Stage A (mount-time, this apply): register the
 * isolated ctx.recursive service + the recursive_* tools + the /recursive
 * command + the recursive:policy prompt section + the LIVE board/strip route
 * (HTTP state + SSE), served per-workspace from the filesystem fold. No
 * repo/run work and NO session-event emission here: zero recursive/* events
 * are ever appended (resume-crash fix), and the board reads the live fs route.
 */
/** T38: the built-in guard's hook name — the chain's identity for "this was the plugin's own". */
const BUILTIN_GUARD_HOOK_NAME = 'builtin-tool-guard'

/**
 * T38 — the tool guard, as a function rather than an inline block.
 *
 * Extracted so the SAME code can run as a hook on the registry: a built-in and a
 * sibling then share one chain, one ordering rule and one failure policy, instead of
 * the built-in being privileged code that always runs first. Every side effect stays
 * here — the guard-decision log is written by whoever computes the decision, so moving
 * the call site cannot lose it.
 *
 * The `ask` coercion is unchanged and stays key-frozen: `coerceAskToDecision`'s output
 * is asserted with an exact `toEqual`, so the rebuilt object carries the guard's `rule`
 * and `transition` forward rather than letting the coercion drop them.
 */
function runToolGuard(
  recursive: RecursiveRuntime,
  exec: unknown,
  root: string,
  runId: string,
): ToolGuardDecision {
  const guardMode = recursive.enforcementConfig.toolGuards
  const decision = evaluateToolGuard(exec as never, root, runId, guardMode)
  const coerced = coerceAskToDecision(decision, guardMode)
  const final: ToolGuardDecision = coerced === decision
    ? decision
    : { ...coerced, rule: decision.rule, transition: decision.transition }
  // T15 (C/D): every decision is logged — allows included — so the rolling trace shows
  // what the guard decided AND why, not only refusals. File-backed evidence in the
  // control-plane config dir: zero session-event emission.
  if (root) {
    const record: GuardDecisionRecord = {
      at: new Date().toISOString(),
      runId,
      tool: (exec as { name?: string } | null)?.name ?? '',
      kind: final.kind,
      rule: final.rule ?? 'none',
    }
    if (final.kind === 'allow') {
      if (final.warn) record.reason = final.warn
    } else if (final.reason) {
      record.reason = final.reason
    }
    if (final.transition) record.transition = final.transition
    appendGuardDecision(root, record)
  }
  return final
}

export function apply(ctx: Context, config?: { shellOnly?: boolean; repoRoot?: string }) {
  // R4 shell split (02-to-be-plan.addendum-r4-r2-mount-resolution.md): the
  // global bare-name row in cordis.patch.yml mounts with config.shellOnly=true
  // to expose ONLY the client bundle for client discovery. It must register
  // NOTHING on the server root — no tools, no /recursive command, no
  // recursive:policy, no projection (BUG 4 always-on leak). The full server
  // surface is mounted ONLY by the recursive preset's isolated recursive-realm,
  // whose rows carry no config (shellOnly undefined).
  if (config?.shellOnly) return
  ctx.effect(function* () {
    // Workspace registry: optional host service (durable). Access via ctx.get —
    // property access requires inject and would fail boot when undeclared.
    // Resolve the control-plane root strictly from the session agent's cwd.
    const workspaceRegistry = ctx.get('workspaceRegistry') as never
    // T1 (goals projection): the goals service is on the host plane; it resolves
    // from inside the recursive-realm via inheritance (same as workspaceRegistry).
    // SAFETY: the goals service is an optional host service (could be absent); the
    // run projection treats null as "no goal backing" and never throws.
    const goals = ctx.get('goals') as GoalServiceLike | null
    const recursive = new RecursiveRuntime(ctx, { repoRoot: config?.repoRoot ?? process.cwd(), workspaceRegistry, goals })

    const repairedRoots = new Set<string>()
    const reminderGate = new ReminderOnceGate()
    // T3 (agentTeams task loop): wire the live ctx.agentTeams service (optional —
    // absent in compositions without the experimental agent-team row) into the
    // turn-driven task-board tool. The whole-loop driver (auditToPass) is also
    // exported for callers with a settlement observer.
    // SAFETY: ctx.get returns the live service as an opaque value; the single
    // boundary cast asserts it satisfies the TeamRuntimeLike structural seam
    // (createTask/updateTask plus optional wait/interrupt/board reads). The
    // live service's real Agent parameter is a superset of TeamCallerHandle, so
    // the seam passes the exact live Agent the tool extracts from exec.agent.
    const agentTeams = ctx.get('agentTeams') as TeamRuntimeLike | undefined
    // T36: the continuable-subagent seam the review tool drives. Optional for the
    // same reason as agentTeams — absent it, `recursive_review` still runs and
    // reports `unavailable`, naming that the repair path does not exist rather than
    // pretending the review was a success.
    const subagentsSeam = ctx.get('subagents') as SubagentsRuntimeLike | undefined

    // Packaged skill (dsh plugin standard): register the `recursive-mode` skill
    // into the host skills registry via ctx.skills.registerProvider (the
    // dsh-skill-badge bundled-provider shape). Optional — a composition without
    // a skills registry is valid and this no-ops (returns undefined).
    const skillDisposer = registerRecursiveSkill(ctx)

    const disposers = [
      ...(skillDisposer ? [skillDisposer] : []),
      ctx.tools.register(createRecursiveStatusTool(recursive)),
      ctx.tools.register(createRecursiveInitTool(recursive)),
      ctx.tools.register(createRecursiveLockTool(recursive)),
      ctx.tools.register(createRecursiveLintTool(recursive)),
      ctx.tools.register(createRecursiveCloseoutTool(recursive)),
      ctx.tools.register(createRecursiveScratchTool(recursive)),
      ctx.tools.register(createRecursiveWorktreeTool(recursive)),
      ctx.tools.register(createRecursivePhaseTool(recursive)),
      ctx.tools.register(createRecursiveReviewTool(recursive, subagentsSeam)),
      ...(agentTeams ? [ctx.tools.register(createRecursiveAuditTeamTool(agentTeams))] : []),
    ]

    // /recursive command (R4): preset-scoped registration, workspace-scoped dispatch.
    const commands = ctx.get('commands') as { register: (def: unknown) => () => void } | undefined
    if (commands) {
      disposers.push(registerRecursiveCommand({ commands } as never, recursive))
    }

    // recursive:policy prompt section (Phase C R5): workspace-scoped behavior +
    // current-phase contract rendered from folded state + enforcement config.
    const systemPrompt = ctx.get('systemPrompt') as { section: (def: unknown) => () => void } | undefined
    if (systemPrompt) {
      disposers.push(systemPrompt.section({
        name: 'recursive:policy',
        order: 55,
        text: (context: unknown) => {
          const agent = (context as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)?.agent
          if (!agent) return ''
          // SP3 R5 policy-render fix: derive intent from the FILESYSTEM, not the
          // retired recursive/phase-intent session event (zero-emission removed
          // the emitter; 0.2.2 deleted the event-fold helper that read it, so this
          // signal was ALWAYS null and this section rendered ''). Pure read-only fs
          // folding; no recursive/*
          // events are appended.
          const intent = fsPolicyIntent(agent, workspaceRegistry as never)
          if (!intent) return ''
          return renderRecursivePolicy({ worktreeRoot: intent.worktreeRoot, runId: intent.runId, config: recursive.enforcementConfig })
        },
      }))
    }

    // Phase C R3 (Layer 1, agent/pre-step proactive intent gate) is RETIRED
    // under zero-emission (SP2 R1): its only signal was the recursive/phase-intent
    // session event, whose emitter is now deleted, and it was ADVISORY by default
    // (it never rejected; its sole side effect was the now-removed emission).
    // Enforcement is preserved where it actually bites: Layer 2 (tools/pre-execute
    // inspects the REAL tool call args below) plus the recursive_lock tool's own
    // prerequisite validation in lockArtifact — strictly more reliable than the
    // heuristic intent scan. See 03-implementation-summary.addendum-r1-*.md.

    // Phase C R4: tools/pre-execute surgical guards (Layer 2, caller of the
    // transition set). Scope-filtered to the active run's worktree.
    //
    // T15 — this listener used to hand `evaluateToolGuard` an EMPTY runId, so its
    // `runDir` resolved to `<root>/.recursive/run` — the directory that holds run
    // DIRECTORIES, not artifacts. The monotonic lock-order and Phase-3 TDD
    // branches could therefore never fire; only the locked-write branch worked
    // (it resolves its target path directly). The REAL active run id is now
    // resolved per call, the same way recursive_status/phaseRules do it.
    const sessionsStore = ctx.get('sessions') as
      | { get?: (id: string) => { header?: { cwd?: string } } | undefined }
      | undefined
    // T38 — THE BUILT-IN GUARD IS NOW A HOOK ON THE SAME CHAIN AS EVERYONE ELSE.
    //
    // Registered at PRIORITY 0 so a sibling with a higher priority runs FIRST and can
    // pre-empt it cheaply — which is the point of participation. The guard stays the
    // baseline that runs when nobody objects.
    //
    // `fail_closed` because this is a GATING point: a guard that cannot decide must not
    // let the call through. The FULL decision rides back as an annotation, so `ask` and
    // `allow` survive with `warn`/`rule`/`transition` intact — the listener returns that
    // object VERBATIM, which is what keeps `guard-path` byte-identical.
    recursive.hooks.register('pre_trigger', {
      name: BUILTIN_GUARD_HOOK_NAME,
      priority: 0,
      onError: 'fail_closed',
      run: (input) => {
        const payload = input as { exec?: unknown; root?: string; runId?: string }
        const decision = runToolGuard(recursive, payload.exec, payload.root ?? '', payload.runId ?? '')
        return decision.kind === 'deny'
          ? { decision: 'deny' as const, reason: decision.reason ?? 'denied by the tool guard', annotations: { guardDecision: decision } }
          : { decision: 'continue' as const, annotations: { guardDecision: decision } }
      },
    })
    const toolRuntime = ctx as unknown as { on?: (event: string, listener: (payload: unknown, next?: unknown) => unknown) => () => void }
    if (toolRuntime.on) {
      disposers.push(toolRuntime.on('tools/pre-execute', async (payload, next) => {
        const exec = payload as { name?: string; arguments?: unknown; agent?: { session?: { header?: { cwd?: string } } } | null } | null
        if (!exec?.name) return typeof next === 'function' ? next() : { kind: 'allow' }
        // B3: per-call root is the session cwd (authoritative when the registry is
        // absent), never process.cwd().
        const cwd = exec?.agent?.session?.header?.cwd ?? ''
        const root = (await recursive.resolveRootForRoute(undefined, cwd, sessionsStore)) ?? cwd
        // T15 (A): the active run id is resolved from the FILESYSTEM on every call
        // — `resolveRunDir` is the canonical latest-run-by-mtime used by
        // recursive_status/phaseRules. Deliberately NO ttl/time cache: a cached run
        // id would silently reintroduce exactly the empty-runId bug being fixed
        // here, because a run created moments ago must be visible immediately. If a
        // cache is ever added it must be provably invalidated on run creation.
        const runId = root ? resolveRunDir(root)?.runId ?? '' : ''

        // T27 — THE NAMED POINT IS LIVE AT THE ENFORCEMENT SEAM. A sibling hook may
        // deny here BEFORE the built-in guard runs, so participation is real rather
        // than a reachable registry that nothing consults.
        //
        // With no hooks registered — the ordinary case — the chain returns `continue`
        // and the guard below runs exactly as it always has, which is what keeps
        // `guard-path.spec.ts`'s pinned contract byte-identical. That is the point of
        // putting the chain FIRST: it adds a way in without moving what was there.
        //
        // A `hold` is treated as a denial at this seam. `hold` means "stop and wait"
        // for a point that can resume later; a tool call has nothing to resume, so
        // pretending to hold would silently proceed. Better to refuse and say so.
        const preTrigger = await recursive.hooks.run('pre_trigger', {
          tool: exec.name,
          args: exec.arguments,
          exec,
          root,
          runId,
        })
        const decider = preTrigger.ran[preTrigger.ran.length - 1]

        // A SIBLING stopped the chain. Checked by the DECIDER, not by the built-in's
        // mere absence: a sibling with a LOWER priority than the guard runs after it, so
        // "the guard is in the trail" does not mean "the guard decided".
        if ((preTrigger.decision === 'deny' || preTrigger.decision === 'hold') && decider?.name !== BUILTIN_GUARD_HOOK_NAME) {
          const by = decider?.name ?? 'a pre_trigger hook'
          const why = preTrigger.reason ?? 'no reason given'
          // A `hold` is treated as a refusal at this seam. `hold` means "stop and wait"
          // for a point that can resume later; a tool call has nothing to resume, so
          // pretending to hold would silently proceed — worse than refusing, because the
          // caller would never learn a hook wanted to stop it.
          return {
            kind: 'deny',
            reason: preTrigger.decision === 'hold'
              ? 'held by pre_trigger hook ' + by + ': ' + why
              : 'denied by pre_trigger hook ' + by + ': ' + why,
          }
        }

        // The guard itself failed: it is fail_closed, so the refusal is reported with
        // its own error rather than as a silent allow.
        if (decider?.name === BUILTIN_GUARD_HOOK_NAME && decider.error !== undefined) {
          return { kind: 'deny', reason: 'the tool guard failed: ' + decider.error }
        }

        const builtIn = preTrigger.ran.find((entry) => entry.name === BUILTIN_GUARD_HOOK_NAME)
        const final = builtIn?.annotations?.guardDecision as ToolGuardDecision | undefined
        if (final === undefined) {
          // Unreachable while the built-in is registered unconditionally. It fails
          // CLOSED rather than allowing, because "we could not decide" is not permission.
          return { kind: 'deny', reason: 'the tool guard produced no decision' }
        }
        // The guard's own object, returned VERBATIM — the pinned contract.
        if (final.kind === 'deny') return final
        if (final.kind === 'allow' && final.warn) {
          // Package-tagged host logging; never a silent pass under approval=never.
          console.warn('[recursive] tool guard (advisory): ' + final.warn + ' — allowing')
        }
        return typeof next === 'function' ? next() : { kind: 'allow' }
      }))
    }

    // T15 (E): the fs/observed lock-tamper path. The harness contract is a plain
    // SYNCHRONOUS emit fired AFTER a successful write, so this listener cannot
    // veto anything and contractually must not throw — it only RECORDS. Before
    // T15 the plugin had no fs/observed listener at all (the string appeared in
    // comments only), so `detectTamper` was exported and unit-tested with no live
    // caller and a tampered lock surfaced nowhere but prompt text.
    const observationRuntime = ctx as unknown as { on?: (event: string, listener: (target: unknown, observation: unknown, actor: unknown) => void) => () => void }
    if (observationRuntime.on) {
      disposers.push(observationRuntime.on('fs/observed', (target, observation, actor) => {
        try {
          // Only a present observation can be a tamper; absent/unrelated are ignored.
          if ((observation as { kind?: string } | null)?.kind !== 'present') return
          const displayPath = (target as { displayPath?: string } | null)?.displayPath ?? ''
          if (!displayPath) return
          // Cheap shape test BEFORE any filesystem work: fs/observed fires on reads
          // too, so enumerating runs for every observation would be a readdir per
          // file touch. This is EXACTLY detectTamper's own admission test (same
          // normalized string, same two conditions), so it can never reject a
          // candidate detectTamper would have accepted.
          const normalized = displayPath.replace(/\\/g, '/')
          if (!normalized.endsWith('.md') || !normalized.includes('/.recursive/run/')) return
          // The actor is the tool execution. This event cannot await, so the root is
          // the actor's session cwd (the same B4 sync shortcut fsPolicyIntent takes:
          // the session cwd is authoritative, the registry path is async-only).
          const cwd = (actor as { agent?: { session?: { header?: { cwd?: string } } } } | null)?.agent?.session?.header?.cwd ?? ''
          if (!cwd) return
          const runId = resolveRunDir(cwd)?.runId ?? ''
          const tamper = recursive.detectTamper(normalized, cwd, runId)
          if (!tamper) return
          appendObservedTamper(cwd, {
            at: new Date().toISOString(),
            runId: tamper.runId,
            path: tamper.path,
            reason: tamper.reason,
          })
        } catch {
          // Observe-only: the fs/observed contract forbids throwing.
        }
      }))
    }

    // T36: capture a delegated child's SETTLEMENT at delivery time.
    //
    // WHY DELIVERY AND NOT HISTORY. The obvious implementation of a parent-side
    // settlement observer is to scan the session log for the `subagent-settled`
    // notice. That is prohibited: DSH deprecates synchronous reads of arbitrary
    // session history (`eventAt`/`snapshotEvents`/`ownEvents`) and states that new
    // production calls are prohibited, enforced by an executable lint check. The
    // sanctioned replacement is to process the DELIVERED event, which is this
    // listener — the same `session/event` seam the projection registry subscribes
    // to. The durable fact then lands in the run's own FILE state, which is where
    // every other plugin fact lands and keeps the plugin zero-emission.
    //
    // The loop needs this because there is NO parent-side promise to await: a
    // continuable child's settlement arrives as a durable user message on a later
    // turn, so the round observer must find a recorded settlement or honestly
    // report that none has landed yet.
    const sessionRuntime = ctx as unknown as { on?: (event: string, listener: (session: unknown, event: unknown) => void) => () => void }
    if (sessionRuntime.on) {
      disposers.push(sessionRuntime.on('session/event', (session, event) => {
        try {
          // Cheap shape test FIRST: session/event fires for EVERY committed event
          // in every session, so a non-settlement must be rejected before any
          // filesystem work. This is the same ordering the fs/observed listener
          // uses, for the same reason.
          const notice = settlementFromEvent(event as never)
          if (notice === null) return
          // B3: the session cwd is the authoritative control-plane root per call.
          const cwd = (session as { header?: { cwd?: string } } | null)?.header?.cwd ?? ''
          if (cwd === '') return
          const runDir = runDirForChild(cwd, notice.childId)
          // No run (or an ambiguous one) means the settlement is not filed rather
          // than filed wrongly: the loop will report "no settlement yet", which is
          // recoverable, whereas attaching evidence to the wrong run is not.
          if (runDir === null) return
          recordSettlement(runDir, notice)
        } catch {
          // Observe-only. This rides the hot path of every session event and must
          // never break the session it observes.
        }
      }))
    }

    // SP3 R5: agent/pre-step lint-rules injection (pre-step contract verified: the
    // listener returns { kind: 'enter', messages: [...messages, injected] } and the
    // returned array REPLACES the default [...claimed, context]). When the session's
    // control-plane root has an active recursive run whose current phase doc is
    // DRAFT, prepend a compact system-reminder with THAT phase's required sections +
    // gates. Pure fs read (zero-emission): never appends recursive/* events.
    const agentRuntime = ctx as unknown as { on?: (event: string, listener: (payload: unknown, next?: unknown) => unknown) => () => void }
    if (agentRuntime.on) {
      disposers.push(agentRuntime.on('agent/pre-step', async (payload, next) => {
        const p = payload as {
          messages?: Array<{ content: Array<{ type: string; text?: string }> }>,
          agent?: { session?: { header?: { cwd?: string } } } | null,
        } | null
        const messages = p?.messages ?? []
        const agent = p?.agent ?? null
        const cwd = agent?.session?.header?.cwd ?? ''
        // delegate first so later listeners keep veto power, then fold ours on
        if (typeof next === 'function') await next()
        if (!cwd) return { kind: 'enter', messages } as const
        const root = await recursive.resolveRootForRoute(undefined, cwd, undefined)
        if (!root) return { kind: 'enter', messages } as const
        // R3/R6 (run 09): idempotent scaffold REPAIR on session-start (new AND
        // resume). bootstrapScaffold is upsert-only: it adds missing control-plane
        // files/dirs + re-upserts marked blocks, NEVER overwriting user content or
        // touching run/ artifacts (in-flight 02-to-be-plan etc. are preserved).
        // Guarded once per root so repeated pre-steps are cheap no-ops.
        if (!repairedRoots.has(root)) {
          repairedRoots.add(root)
          stageBWorkflowInit({ root, source: 'resume' })
        }
        const runs = enumerateRuns(root)
        if (runs.length === 0) return { kind: 'enter', messages } as const
        const runId = runs[runs.length - 1]
        const runDir = join(root, '.recursive', 'run', runId)
        if (!existsSync(runDir)) return { kind: 'enter', messages } as const
        const phase = getNextLegalPhase(runDir)
        if (!phase) return { kind: 'enter', messages } as const
        // only inject when the phase doc is DRAFT (not locked/missing).
        const phasePath = join(runDir, phase)
        const status = existsSync(phasePath) ? getLockStatus(phasePath) : null
        if (status !== 'DRAFT') return { kind: 'enter', messages } as const
        if (!reminderGate.shouldInject(root, runId, phase)) return { kind: 'enter', messages } as const
                // LIVE BUG 6 (0.2.1): inject the lint-rules reminder AT MOST ONCE PER PHASE.
                // The scaffold repair above is deduped via repairedRoots; the reminder itself was
                // not, so every pre-step while DRAFT re-injected it.
                const reminder = phaseLintRulesMessage(phase)
        return {
          kind: 'enter',
          messages: [...messages, createUserMessage({ content: [{ type: 'text', text: reminder }], source: { ...REMINDER_SOURCE, form: 'notice', summary: 'phase ' + phase + ' lint rules' } })],
        } as const
      }))
    }

    // Phase C R8: fs/observed lock-tamper WARNINGS are served to the board via the
    // mountOnce-global: apply() runs per-session, but the route must register
    // exactly once (WebServer.register throws on duplicate kind+path) and serve
    // PER-WORKSPACE state. No-op when the host composes no webServer (headless).
    // (`sessionsStore` is resolved once, above the pre-execute listener, which now
    // needs it too.)
    const webServer = ctx.get('webServer') as
      | { register: (route: { kind: string; path: string; handler: unknown }) => () => void }
      | undefined
    if (webServer) {
      const host: RecursiveRouteHost = {
        // sessionId PRIMARY: the host resolves cwd from the attached session header;
        // the client-passed cwd is a fallback hint (hydration / headless).
        resolveRoot: async (sessionId: string | undefined, cwd: string) => recursive.resolveRootForRoute(sessionId, cwd, sessionsStore),
        snapshot: async (root: string) => snapshotWorkspace(root),
        revision: () => 1,
      }
      disposers.push(mountRecursiveRoutesOnce('@try-works/dsh-recursive-mode', () => makeRecursiveRoutes(host), webServer))
    }

    yield () => { for (const d of disposers) d() }
  })
}
