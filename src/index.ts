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
import { registerRecursiveCommand } from './commands.ts'
import { evaluateToolGuard, coerceAskToDecision } from './enforcement.ts'
import type { GoalServiceLike } from './goals-projection.ts'
import type { TeamRuntimeLike } from './teams-loop.ts'
import { renderRecursivePolicy } from './policy.ts'
import { fsPolicyIntent } from './fs-intent.ts'
import { snapshotWorkspace } from './snapshot.ts'
import { mountRecursiveRoutesOnce, makeRecursiveRoutes, type RecursiveRouteHost } from './live-route.ts'
import { registerRecursiveSkill } from './skills.ts'
import { enumerateRuns, stageBWorkflowInit } from './bootstrap.ts'
import { getNextLegalPhase, getLockStatus } from './lock.ts'
import { phaseLintRulesMessage, ReminderOnceGate } from './phase-rules.ts'

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
    const toolRuntime = ctx as unknown as { on?: (event: string, listener: (payload: unknown, next?: unknown) => unknown) => () => void }
    if (toolRuntime.on) {
      disposers.push(toolRuntime.on('tools/pre-execute', (payload, next) => {
        const exec = payload as { name?: string; arguments?: unknown; agent?: { session?: { header?: { cwd?: string } } } | null } | null
        if (!exec?.name) return typeof next === 'function' ? next() : { kind: 'allow' }
        // B3: per-call root is the session cwd (authoritative when the registry is
        // absent), never process.cwd().
        const root = exec?.agent?.session?.header?.cwd ?? ''
        const decision = evaluateToolGuard(exec as never, root, '', recursive.enforcementConfig.toolGuards)
        if (decision.kind === 'allow') return typeof next === 'function' ? next() : { kind: 'allow' }
        if (decision.kind === 'deny') return decision
        // T6 (approval ask→policy bridge): an `ask` must never be a silent
        // allow. Strict coerces to deny; advisory allows but carries a warn that
        // the caller logs below. The approval seam is the follow-on (Phase D).
        const coerced = coerceAskToDecision(decision, recursive.enforcementConfig.toolGuards)
        if (coerced.kind === 'deny') return coerced
        if (coerced.kind === 'allow' && coerced.warn) {
          // Package-tagged host logging; never a silent pass under approval=never.
          console.warn('[recursive] tool guard (advisory): ' + coerced.warn + ' — allowing')
        }
        return typeof next === 'function' ? next() : { kind: 'allow' }
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
    const webServer = ctx.get('webServer') as
      | { register: (route: { kind: string; path: string; handler: unknown }) => () => void }
      | undefined
    const sessionsStore = ctx.get('sessions') as
      | { get?: (id: string) => { header?: { cwd?: string } } | undefined }
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
