import { Service, type Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { lintRun } from './ts-lint.ts'
import { requirementsContent, worktreeContent, laterPhaseContent, detectGitContext, RUN_SCAFFOLD_DIRS, type GitContext } from './init-templates.ts'
import { foldRun, getMdFieldValue, pendingWork, resolveRunDir } from './status.ts'
import {
  getLockStatus,
  PHASE_SEQUENCE,
  getNextLegalPhase,
  getPrerequisiteBlockers,
  getStaleDownstreamPhases,
  invalidateReceipt,
  lockHashFromContent,
  validateReceiptChain,
  writeReceipt,
  type ReceiptChainResult,
} from './lock.ts'
import type { PendingWorkItem, RecursiveStatusResult } from './types.ts'
import { findOperation, countOperations, operationId, recordOperation } from './identity.ts'
import { createHookRegistry, type HookRegistry } from './hooks.ts'
import { runTracked, abortReason, type JobsRegistryLike } from './jobs-runner.ts'
import { modelForRole } from './role-route.ts'
import { recordJobRun } from './job-log.ts'
import { toolError } from './errors.ts'
import { readGuardDecisions, type GuardDecisionRecord } from './guard-log.ts'
import { resolveControlPlaneRoot, type WorkspaceRegistryLike } from './workspace.ts'
import { phaseRulesFor, type PhaseRules } from './phase-rules.ts'
import { closeoutReport, writeCloseoutReceipt } from './closeout-report.ts'
import { readScratch, writeScratch, appendScratch, type ScratchTarget } from './scratch.ts'
import { buildReviewBundle, type ReviewBundleInput } from './review.ts'
import { readMemoryEntries, retrieveMemory, renderMemorySection, selectMemory } from './memory.ts'
import { readFeedback, recordInjection, settleInjections } from './memory-feedback.ts'
import { runPhase8Trigger, resolveExtractor, spawnExtractorRunner } from './training.ts'
import { buildAskQuestion, GATE_DEFAULT_ARTIFACT, pendingGateFor } from './recursive_ask.tool.ts'
import { contractDigest } from './policy.ts'
import type { WorkflowEngineLike } from './workflow-audit.ts'
import { createHandoff, createChildBrief, replyPath, childScratchPath, buildDelegationPrompt, type HandoffInput, type ChildBriefInput } from './handoff.ts'
import { loadRouterPolicy, routerPolicyPath, resolveRole, capabilityProbe, delegationDecisionBasis, type RouterPolicy, type RouterPolicyOverrides, type SubagentProviderLike, type RouteDecision, type CapabilityProbe } from './router.ts'
import { delegate, delegateContinuable, drainContinuableChildren, remainingDepthFor, validateReferences, referencesFromResult, writeActionRecord, evaluateDelegationResult, reviewOutputSchema, defaultReviewToolFilter, type SubagentsRuntimeLike, type SubagentStartRequestLike, type SubagentResultLike, type Reference, type ActionRecordInput, type ContinuableDelegationLike, type SubagentParentHandle } from './delegation.ts'
import { validateTransition, coupleGateBlockToGoal, type PhaseTransitionIntent, type RecursivePhaseState, type GateCheckResult } from './lifecycle.ts'
import { resolveEnforcementConfig, DEFAULT_ENFORCEMENT, evaluateToolGuard, detectTamper, type EnforcementConfig, type ToolGuardDecision, type ToolExecLike } from './enforcement.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { renderRecursivePolicy, type PolicyContext } from './policy.ts'
import { snapshotWorkspace } from './snapshot.ts'
import { createLinkedWorktree, promoteBranch, listWorktrees, defaultWorktreeBranch, type CreateWorktreeResult, type PromoteBranchResult } from './worktree.ts'
import { changedPaths, gitFacts } from './git-context.ts'
import { syncRunGoal, blockRunGoal, resumeRunGoal, type GoalServiceLike } from './goals-projection.ts'
import { auditToPass, renderTaskHistory, type TeamRuntimeLike, type AuditToPassResult, type TeamCallerHandle, type TeamTaskViewLike, type AuditRoundOutcome } from './teams-loop.ts'
import type { ContinuableChildId, ContinuableMessageId } from './delegation.ts'
import { runChildIds } from './settlement.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    recursive: RecursiveRuntime
  }
}

export interface LockArtifactResult {
  artifact: string
  runId: string
  status: string
  lockedAt: string | null
  lockHash: string | null
  receipt?: unknown
  blockers: string[]
}

export interface LintArtifactResult {
  artifact: string
  runId: string
  errors: string[]
  warnings: string[]
  passed: boolean
}

/**
 * T15 (G): the folded status PLUS the rolling guard-decision evidence. Declared
 * as an intersection rather than by editing RecursiveStatusResult/foldRun — the
 * fold's own shape is parity-asserted and stays exactly as it was.
 */
export type RecursiveStatusWithGuardDecisions = RecursiveStatusResult & {
  guardDecisions?: GuardDecisionRecord[]
  /**
   * T18: unresolved in-flight work, derived from the run directory on every call.
   * Always present (empty when nothing is in flight) so consumers need no null
   * check, and non-empty explains a `RM4403` lock refusal.
   */
  pendingWork?: PendingWorkItem[]
  /**
   * T32: the receipt-chain verdict, derived read-only on every call. Always present
   * so a caller can read `ok` without a null check; non-empty `breaks` names the
   * first broken link. This is what makes a spliced or edited chain VISIBLE rather
   * than merely detectable in a test.
   */
  receiptChain?: ReceiptChainResult
  /**
   * T22: the local identifier of the policy section's STABLE prefix.
   *
   * Surfaced so "did the contract change under me?" is answerable from the status alone — the same
   * digest the prompt carries, so a reader can compare them without re-rendering anything. It is an
   * IDENTIFIER, not a cache directive: whether any provider caches the prefix is provider-side and
   * unverified, which is why the item's "largest cost lever" label was withdrawn.
   */
  contractDigest?: string
}

/** How many recent decisions to read from the log before scoping to one run. */
const GUARD_DECISION_READ_LIMIT = 200

/**
 * T28: the delegating agent's own delegation depth, read structurally rather than by
 * importing the harness's `delegationDepthOf`. The plugin already models every
 * harness touchpoint as a minimal structural seam, and this keeps that convention —
 * an absent depth means top level, which is the safe reading for a budget.
 */
function parentDepthOf(parent: unknown): number {
  const depth = (parent as { options?: { subagentDepth?: unknown } } | null | undefined)?.options?.subagentDepth
  return typeof depth === 'number' && Number.isSafeInteger(depth) && depth > 0 ? depth : 0
}

/** How many of that run's decisions the status surface carries. */
const GUARD_DECISION_SURFACE_LIMIT = 20

const ARTIFACT_STUB = {
  '00-requirements.md': ['Run: ', 'Phase: 0', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
  '00-worktree.md': ['Run: ', 'Phase: 0 (Worktree)', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
  '01-as-is.md': ['Run: ', 'Phase: 1 (AS-IS)', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
  '02-to-be-plan.md': ['Run: ', 'Phase: 2 (TO-BE Plan)', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
  '03-implementation-summary.md': ['Run: ', 'Phase: 3 (Implementation)', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
  '04-test-summary.md': ['Run: ', 'Phase: 4 (Test Summary)', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
  '05-manual-qa.md': ['Run: ', 'Phase: 5 (Manual QA)', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
  '06-decisions-update.md': ['Run: ', 'Phase: 6 (Decisions Update)', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
  '07-state-update.md': ['Run: ', 'Phase: 7 (State Update)', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
  '08-memory-impact.md': ['Run: ', 'Phase: 8 (Memory Impact)', 'Status: DRAFT', 'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none', 'Scope note: '],
}

export class RecursiveRuntime extends Service {
  /** Recursive-mode runtime service. Owns run-state reads + lock/init/lint operations. */

  constructor(ctx: Context, config: { repoRoot?: string; workspaceRegistry?: WorkspaceRegistryLike; goals?: GoalServiceLike | null; jobs?: JobsRegistryLike | null; subagents?: SubagentsRuntimeLike | null; workflow?: WorkflowEngineLike | null } = {}) {
    super(ctx, 'recursive')
    this.repoRoot = config.repoRoot ?? process.cwd()
    this.workspaceRegistry = config.workspaceRegistry ?? null
    this.goalsService = config.goals ?? null
    // T10: the native jobs registry is OPTIONAL. Absent, long operations run inline and say
    // so; see `runTracked` for why that is better than refusing to work without a board.
    this.jobs = config.jobs ?? null
    // T39: the subagents seam, resolved at the COMPOSITION like the other optional services.
    this.subagentsSeam = config.subagents ?? null
    // T2: the workflow engine, likewise.
    this.workflow = config.workflow ?? null
  }

  /** T10: the native jobs registry, when the composition mounts one. */
  private readonly jobs: JobsRegistryLike | null

  /**
   * T23 — write a gate's answer into an artifact as a marker line.
   *
   * ⚠ REPLACED IN PLACE when the artifact already carries that gate's marker: two `TDD Mode:` lines
   * would leave two answers to one question and make "what was decided?" depend on which a reader
   * found first. The write is confined to the run directory, and an artifact that does not exist is
   * CREATED — a decision recorded nowhere is not recorded.
   */
  recordAskAnswer(root: string, runId: string, artifact: string, marker: string): { path: string; replaced: boolean } {
    const dir = join(root, '.recursive', 'run', runId)
    const path = join(dir, artifact)
    const label = marker.slice(2).split(':')[0].trim()
    let content = ''
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      // A missing artifact is created below, so the decision still has somewhere to live.
    }
    const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n')
    const at = lines.findIndex((line) => line.startsWith('- ' + label + ':'))
    const replaced = at >= 0
    if (replaced) lines[at] = marker
    else lines.push(marker)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, lines.join('\n') + '\n', 'utf8')
    return { path, replaced }
  }

  /**
   * T2: the workflow engine, when the composition mounts one.
   *
   * OPTIONAL like every other seam here — without it an audit fan-out reports that it could not be
   * orchestrated rather than pretending a fan-out happened. The engine's `workflow/*` events are
   * observe-only, so this is used to START a run and await its result, never to drive one.
   */
  private readonly workflow: WorkflowEngineLike | null

  /**
   * T39: the subagents seam the composition mounted, used when a caller does not pass one.
   *
   * ⚠ WHY THIS EXISTS, measured rather than assumed: `recursive_review.tool.ts` — the ONLY
   * production caller of `delegateReview` — passes **no `subagents`** at its call site, and
   * `delegateReview` reports *"no ctx.subagents runtime available (self-audit fallback)"* when
   * the input lacks one. So on a composition that HAS the service, the review tool's rounds
   * never reached a child at all, and the fallback message blamed a missing runtime that was
   * in fact mounted. Resolving the seam here fixes the wiring without asking every call site to
   * remember, while an explicit `input.subagents` still wins for a test or a narrower caller.
   */
  private subagentsSeam: SubagentsRuntimeLike | null

  /**
   * ⚠ FU-9 — ATTACH THE SEAM WHEN THE SERVICE APPEARS, not only when this plugin happens to apply.
   *
   * The composition resolved the seam with a ONE-SHOT `ctx.get('subagents')` at apply time, and a live run
   * showed what that costs: the review fell back to self-audit, the action record said
   * `Execution Mode: self-audit (continuable)` and `Status: failed`, and **no child was ever started** — while
   * the child DIRECTORY existed all along, because the plugin writes its own brief before calling any service.
   * I read the directory and built a host-limitation story on top of it; the record said otherwise.
   *
   * If the subagents service is mounted by a later loader layer, a one-shot get returns undefined and nothing
   * re-resolves it. `ctx.inject(['subagents'], …)` is the harness's own pattern for exactly this, and calling
   * this method from there makes the seam arrive whenever it arrives. Idempotent: the last attach wins, which
   * is what a re-apply after a reload wants.
   */
  attachSubagents(seam: SubagentsRuntimeLike | null): void {
    this.subagentsSeam = seam
  }

  /** What the composition attached, for a caller that needs to report or assert it. */
  attachedSubagents(): SubagentsRuntimeLike | null {
    return this.subagentsSeam
  }

  /**
   * ⚠ FU-9 — THE ROUTER'S PROVIDER MAP, BUILT FROM THE SEAM THAT IS ALREADY ATTACHED.
   *
   * `router.ts` returns the NATIVE tier for the first of `[role, 'spawn', 'fork', 'dsh-sdk']` present in this
   * map. Handed `{}` it tried the external CLI route (null in the default policy) and fell to the policy
   * fallback — self-audit — with a message naming neither. The router already preferred native; nobody ever
   * gave it a name. A live review self-audited for five rounds because of it.
   *
   * `SubagentProviderLike` is only a DESCRIPTOR (`{ name, capabilities? }`), so a provider is registered by
   * ASKING the service for it rather than by wrapping it. A service that cannot enumerate yields an empty map
   * and the previous behaviour, which is the correct degradation rather than a guess about the shape.
   */
  private providerMapFromSeam(): Record<string, SubagentProviderLike> {
    const seam = this.subagentsSeam
    if (seam === null || seam.getProvider === undefined) return {}
    const map: Record<string, SubagentProviderLike> = {}
    for (const name of ['spawn', 'fork', 'dsh-sdk']) {
      try {
        const found = seam.getProvider(name)
        if (found !== undefined && found !== null) map[name] = found as SubagentProviderLike
      } catch {
        // An unavailable name is not an error: the next candidate still gets its turn.
      }
    }
    return map
  }

  private readonly repoRoot: string
  private readonly workspaceRegistry: WorkspaceRegistryLike | null
  private readonly goalsService: GoalServiceLike | null
  /**
   * T27 — the hook registry, EXPOSED so a sibling plugin can participate in a run
   * without patching this one:
   *
   *     ctx.recursive.hooks.register('pre_trigger', { name: 'my-check', priority: 10, run })
   *
   * That is the whole point of the item: the plugin's own enforcement will be
   * re-expressed as built-in hooks on this same registry, so a sibling and a built-in
   * are peers — same ordering rules, same failure policy, same audit trail — rather
   * than one being privileged code and the other a guest.
   *
   * Public and created eagerly: a registry that has to be "got" before it can be used
   * is a registry whose ordering depends on when someone remembered to fetch it.
   */
  readonly hooks: HookRegistry = createHookRegistry()

  /**
   * T7 — router overrides from the settings namespace. Kept beside the config rather than
   * merged into the file so the workspace's `recursive-router.json` stays the declarative
   * source: `loadRouterPolicy` reads the file and lays these on top.
   */
  private _routerOverrides: RouterPolicyOverrides | undefined = undefined

  /** T7: set (or clear) the router overrides. Called from `apply` on every plugin load. */
  setRouterOverrides(overrides: RouterPolicyOverrides | undefined): void {
    this._routerOverrides = overrides
  }

  private _enforcementConfig: EnforcementConfig | null = null

  /**
   * T3 (agentTeams task loop): run the audit→repair→re-audit state machine on
   * ONE durable team task. The `teams` seam (live `ctx.agentTeams`) is injected
   * per-call so the loop stays unit-testable; `runAuditRound` is the caller's
   * round executor (live usage wires T4's continuable delegation). Locking the
   * phase artifact is `lockPhase` — the loop NEVER locks before an APPROVE.
   */
  async auditToPass(input: {
    teams: TeamRuntimeLike
    caller: TeamCallerHandle
    root: string
    runId: string
    phase: string
    artifact: string
    agent?: { session?: { header?: { cwd?: string } } } | null
    runAuditRound: (round: number, task: TeamTaskViewLike) => Promise<AuditRoundOutcome>
    blockedBy?: readonly string[]
    writeScopes?: readonly string[]
    reviewerName?: string
    maxRounds?: number
    waitTimeoutMs?: number
  }): Promise<AuditToPassResult & { history?: string; lock?: LockArtifactResult }> {
    const { teams, caller, runId, phase, artifact, runAuditRound, agent } = input
    let lockResult: LockArtifactResult | undefined
    const lockPhase = async () => { lockResult = await this.lockArtifact(runId, artifact, false, agent) }
    const result = await auditToPass({
      teams,
      caller,
      runId,
      phase,
      blockedBy: input.blockedBy,
      writeScopes: input.writeScopes,
      reviewerName: input.reviewerName,
      maxRounds: input.maxRounds,
      waitTimeoutMs: input.waitTimeoutMs,
      runAuditRound,
      lockPhase,
    })
    const report: AuditToPassResult & { history?: string; lock?: LockArtifactResult } = {
      ...result,
      history: renderTaskHistory(result.taskView, result.rounds),
    }
    if (lockResult !== undefined) report.lock = lockResult
    return report
  }

  /**
   * T1 (goals projection): project the run into the native goals service so it is
   * a first-class durable, resumable, blockable object. Best-effort — the run's
   * filesystem state is the source of truth; a goal is the durable projection.
   */
  projectRunToGoal(agent: { session?: { header?: { cwd?: string } } } | null | undefined, runId: string, state: Parameters<typeof syncRunGoal>[3] = 'active') {
    if (!agent) return { ok: false, reason: 'no agent' }
    return syncRunGoal(this.goalsService, agent, runId, state)
  }

  /** T1: block the run's goal on a gate-block (durable + UI-visible). */
  blockRunToGoal(agent: { session?: { header?: { cwd?: string } } } | null | undefined, runId: string, reason: { code: string; message: string }) {
    if (!agent) return { ok: false, reason: 'no agent' }
    return blockRunGoal(this.goalsService, agent, runId, reason)
  }

  /** T1: re-arm the run's goal on a reopen (blocked/paused -> active). */
  resumeRunToGoal(agent: { session?: { header?: { cwd?: string } } } | null | undefined, runId: string) {
    if (!agent) return { ok: false, reason: 'no agent' }
    return resumeRunGoal(this.goalsService, agent, runId)
  }

  /**
   * Workspace-scoped control-plane root (R1 binding invariant).
   * Resolves the session agent's canonical cwd -> workspace path via the
   * registry; NEVER scans list(). Returns null when unavailable (defer).
   */
  async resolveWorkspaceRoot(agent?: { session?: { header?: { cwd?: string } } } | null): Promise<string | null> {
    return resolveControlPlaneRoot(agent, this.workspaceRegistry)
  }

  /**
   * Run-scoped closeout receipt scaffold (R2), rooted under the given
   * workspace root. Refuses runIds outside the root (never crosses workspaces).
   */
  async closeoutRun(root: string, runId: string, phase: string, agent?: { session?: { header?: { cwd?: string } } } | null) {
    const runDir = join(root, '.recursive', 'run', runId)
    const runRoot = join(root, '.recursive', 'run')
    // workspace-scoping guard: the run must be under this root
    if (!runDir.startsWith(runRoot) || !existsSync(runDir)) {
      return { error: 'Run not found in current workspace: ' + runId }
    }
    // Declared OUTSIDE the try so the failure path can report it too: a refused closeout still tells the
    // caller whether its children were released.
    let drain: { children: number; drained: boolean; reason?: string } | null = null
    try {
      // T30 — THE RUN-CLOSE TRIGGER, at the RE-RUN of closeout phase 08 and nowhere else.
      //
      // ⚠ DETECTED FROM THE RECEIPT THAT ALREADY EXISTS, not from a counter kept beside it: if phase 08
      // has a receipt BEFORE this closeout runs, then it has been closed out before and this is the
      // re-run the parent asks for. A first lock would otherwise train the run on itself.
      //
      // ⚠ THE SEAMS ARE THE REAL FILESYSTEM HERE — this IS the production call site, so the write and
      // read seams that the tests inject are bound to the actual run root, and the registry read goes
      // to `memory/MEMORY.md` under the same root.
      const isPhase8 = phase.startsWith('08') || phase === '08-memory-impact.md'
      const rerun = isPhase8 && existsSync(join(runDir, 'locks', '08-memory-impact.receipt.json'))
      // ⚠ FU-3 — THE DRAIN IS COMPUTED **BEFORE** THE STUB WRITE, and the first version had it after:
      // `closeoutPhase` now THROWS when the artifact is already LOCKED (the FU-8 guard), so a drain placed
      // after that call never ran on exactly the runs that reach closeout twice — the ones that HAVE
      // children to release. Draining is a run-close action and does not depend on scaffolding a stub.
      const children = isPhase8 ? runChildIds(runDir) : []
      drain = isPhase8
        ? this.subagentsSeam === null
          ? { children: children.length, drained: false, reason: 'no subagents runtime is mounted, so the children could not be drained' }
          : await drainContinuableChildren(this.subagentsSeam, agent as never, children)
            .then(() => ({ children: children.length, drained: true }))
            .catch((err: unknown) => ({ children: children.length, drained: false, reason: err instanceof Error ? err.message : String(err) }))
        : null
      // ⚠ FU-12 — THE CLOSEOUT NO LONGER WRITES TO THE PHASE DOCUMENT.
      // It READS the artifact, reports what the standard requires and what is missing, and records that
      // examination as a receipt of its own under locks/<stem>.closeout.receipt.json — never over the doc.
      const result = closeoutReport(runDir, phase)
      // P3b: settle this run's injections against its own outcome. Only phases that LOCKED are evidence, and
      // a run settles once, at closeout.
      settleInjections(root, runDir, PHASE_SEQUENCE.filter((file) => getLockStatus(join(runDir, file)) === 'LOCKED'))
      writeCloseoutReceipt(runDir, phase)
      const training = isPhase8
        ? runPhase8Trigger(root, runId, {
            rerun,
            // The extractor is resolved but NOT spawned here: this plugin never embeds one, and an
            // unset command must surface as exit 2 rather than as a silent success.
            extractorAvailable: resolveExtractor(process.env) !== null,
            // FU-5: the PRODUCTION runner — spawn the command with `stdio: 'ignore'` and read the file it
            // was asked to write. `stdio: 'ignore'` is deliberate: this sandbox denies a child the piped
            // stdio a capture needs, and the response file is the parent's own interface anyway.
            runner: spawnExtractorRunner({ cwd: root, responseFile: join(runDir, 'training-response.json') }),
            write: (relativePath, content) => {
              const target = join(root, relativePath)
              mkdirSync(dirname(target), { recursive: true })
              writeFileSync(target, content, 'utf8')
              return relativePath
            },
            readText: (relativePath) => {
              try {
                return readFileSync(join(root, relativePath), 'utf8')
              } catch {
                return null
              }
            },
          })
        : null
      // ⚠ THE SECOND drain ASSIGNMENT WAS REMOVED (FU-12): it re-drained on the success path and
      // overwrote the value the throw path depends on. The assignment above is the one that matters.

      // ⚠ THE DRAIN HAPPENS BEFORE THE STUB WRITE, and the first version got this wrong: the FU-8 guard
      // THROWS when 08 is already LOCKED, so a drain placed after it never ran on exactly the runs that
      // reach closeout twice — leaking every child of a completed run. Draining is a RUN-CLOSE action and
      // does not depend on scaffolding a stub, so it happens first and is reported on BOTH paths.
      return { closeoutPhase: phase, runId, ...result, ...(training === null ? {} : { training }), ...(drain === null ? {} : { drain }) }
    } catch (err) {
      // The drain result is carried into the failure path too: a refused closeout still tells the caller
      // whether its children were released.
      return { error: (err as Error).message, ...(typeof drain !== 'undefined' && drain !== null ? { drain } : {}) }
    }
  }

  /**
   * Run-scoped scratchpad access (R5), rooted under the given workspace root.
   */
  scratchRun(root: string, runId: string, action: string, target: ScratchTarget, content?: string) {
    const runDir = join(root, '.recursive', 'run', runId)
    const runRoot = join(root, '.recursive', 'run')
    if (!runDir.startsWith(runRoot) || !existsSync(runDir)) {
      return { error: 'Run not found in current workspace: ' + runId }
    }
    try {
      if (action === 'read') {
        return { runId, target, action, content: readScratch(runDir, target), path: join(runDir, 'scratch', 'scratch.' + target) }
      }
      if (action === 'write') {
        const path = writeScratch(runDir, target, content ?? '')
        return { runId, target, action, path }
      }
      if (action === 'append') {
        const path = appendScratch(runDir, target, content ?? '')
        return { runId, target, action, path }
      }
      return { error: 'Unsupported scratch action: ' + action + ' (expected read|write|append)' }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }

  /**
   * Phase B (native delegation): build a review bundle (R1) + file-backed
   * handoff docs (R2), resolve the role via the router policy (R3), and call
   * ctx.subagents with the full request (R4). Workspace-scoped: every path
   * resolves under the session's control-plane root.
   *
   * DELEGATION IS ALWAYS CONTINUABLE (T35). The default mode is `continuable`:
   * an explicit `mode: 'one-shot'` is the ONLY way to give up the repair path,
   * and that path only exists for a caller that genuinely discards the result.
   *
   * WHY THIS IS THE DEFAULT. A one-shot child is NOT resumable — the harness
   * rejects a resume with "subagent cannot be resumed" — so choosing one-shot
   * forfeits the ability to send a failed review back to the agent that did the
   * work. A continuable child has ONE durable Session across activations, so a
   * REVISE reaches the SAME child with its working context intact instead of
   * spawning a fresh one that must re-read the whole handoff to rediscover what
   * it already knew. Since verification that cannot be followed by repair is
   * just a complaint, the repair path is the default rather than an option.
   *
   * `mode: 'continuable'` (T4) runs the audit→repair→re-audit loop on ONE
   * durable continuable child (startContinuable → followup with the repair
   * instruction → settle) and drains the child on closeout. It requires an
   * `awaitRoundResult` observer (the parent-side settlement seam) AND the exact
   * live `parent` Agent (continuable followup is object-identity authority);
   * when either is absent it falls back to one-shot `delegate()` with a flag —
   * never silently. One-shot `start()` is never called on the continuable path.
   */
  async delegateReview(input: {
    root: string
    runId: string
    phase: string
    role: string
    delegationId: string
    childId: string
    artifactPath: string
    upstreamArtifacts: string[]
    auditQuestions: string[]
    requiredOutput: string
    codeRefs?: string[]
    changedFiles?: string[]
    diffBasis?: ReviewBundleInput['diffBasis']
    policyPath?: string
    providers?: Record<string, SubagentProviderLike>
    subagents?: SubagentsRuntimeLike
    maxDepth?: number
    toolFilter?: unknown
    /**
     * T35: which child lifecycle to use. DEFAULT `continuable` — a one-shot
     * child cannot be resumed, so one-shot forfeits the repair path and must be
     * requested explicitly by a caller that will discard the result.
     */
    mode?: 'one-shot' | 'continuable'
    awaitRoundResult?: (childId: ContinuableChildId, messageId: ContinuableMessageId) => Promise<SubagentResultLike | null>
    /**
     * T39: interrupt the LIVE child when this delegation's job is killed — the one thing T10's
     * synchronous call sites cannot do, and the reason a delegation's kill can be genuinely
     * pre-emptive. Optional: without it a kill still parks the round and cannot reach the
     * child, which is stated rather than implied.
     */
    interrupt?: (childId: string, reason: string) => void
    maxRounds?: number
    /** T4: the exact live direct-parent Agent (object-identity authority). */
    parent?: SubagentParentHandle
  }) {
    const policy = loadRouterPolicy(input.policyPath ?? routerPolicyPath(input.root), this._routerOverrides)
    // ⚠ FU-9 — THE ROUTER GETS THE SAME SEAM FALLBACK THE DELEGATION ONE LINE BELOW ALREADY HAD, and not
    // getting it is why a live review self-audited for five rounds of investigation. `resolveRole` tries
    // `[role, 'spawn', 'fork', 'dsh-sdk']` against this map and returns the NATIVE tier for the first name it
    // finds; handed `{}` it fell through to an external CLI the policy leaves null and then to the policy
    // fallback, and its message named none of that. The router already preferred native — it was never given a
    // name to prefer. `SubagentProviderLike` is only a descriptor (`{ name, capabilities? }`), so a provider is
    // registered by ASKING the service for it; a service that cannot enumerate yields an empty map and the old
    // behaviour, which is the correct degradation rather than a guess.
    const providers = input.providers ?? this.providerMapFromSeam()
    // T39: the seam the caller passed, else the one the COMPOSITION mounted. See the field's
    // comment: without this the review tool's rounds silently self-audited on a host that had
    // the service all along.
    const subagents: SubagentsRuntimeLike | undefined = input.subagents ?? this.subagentsSeam ?? undefined
    const decision = resolveRole(input.role, policy, providers)
    const probe = capabilityProbe({ providers, role: input.role, policy })

    // R1 bundle + R2 handoff/brief/prompt (file-backed context-in contract).
    // T14 — PRIOR-RUN MEMORY, retrieved by relevance to THIS phase/artifact/role and written into
    // the bundle. Two facts decided the shape: there is NO native memory service (measured), so the
    // store is the plugin's own `.recursive/memory/` layer; and the prompt references the bundle by
    // PATH, so the content must go INTO the bundle rather than beside the prompt.
    //
    // `memoryRefs` is filled as well as the content, and it is NOT a duplicate: it was a DEAD SLOT —
    // rendered by the bundle and set by nobody — so the memory section a reviewer was meant to see
    // never existed. Refs give traceability; the content is what a reviewer can actually cite.
    const memoryEntries = retrieveMemory(
      readMemoryEntries(
        (path) => { try { return readFileSync(path, 'utf8') } catch { return null } },
        (kind) => {
          try {
            return readdirSync(join(input.root, '.recursive', 'memory', kind))
              .filter((name) => name.endsWith('.md'))
              .map((name) => join(input.root, '.recursive', 'memory', kind, name))
          } catch {
            // An absent or unreadable memory directory is a missing advantage, not a failed review.
            return []
          }
        },
      ),
      [input.phase, input.role, ...input.auditQuestions].join(' '),
    )
    const bundle = buildReviewBundle({
      root: input.root,
      runId: input.runId,
      phase: input.phase,
      role: input.role,
      artifactPath: input.artifactPath,
      upstreamArtifacts: input.upstreamArtifacts,
      auditQuestions: input.auditQuestions,
      requiredOutput: input.requiredOutput,
      codeRefs: input.codeRefs,
      changedFiles: input.changedFiles,
      diffBasis: input.diffBasis,
      ...(memoryEntries.length === 0 ? {} : {
        memory: renderMemorySection(memoryEntries),
        memoryRefs: [...new Set(memoryEntries.map((entry) => entry.source))],
      }),
    })
    const handoffPath = createHandoff({
      root: input.root,
      runId: input.runId,
      delegationId: input.delegationId,
      role: input.role,
      objective: input.requiredOutput,
      runDocRefs: input.upstreamArtifacts,
      codeRefs: input.codeRefs ?? [],
      auditQuestions: input.auditQuestions,
      requiredOutput: input.requiredOutput,
      decisionBasis: decision.reason,
      constraints: [
        'Workspace-scoped: never read another workspace\'s .recursive/ tree.',
        'Optionality: if the probe fails, fall back to self-audit — never weaken the audit.',
        'Fail loud: capability mismatches reject; do not silently degrade.',
      ],
    })
    const briefPath = createChildBrief({
      root: input.root,
      runId: input.runId,
      delegationId: input.delegationId,
      childId: input.childId,
      slice: 'Perform the delegated ' + input.role + ' for run ' + input.runId + ' (' + input.phase + ') and write your submission to reply.md.',
    })
    const prompt = buildDelegationPrompt({
      root: input.root,
      runId: input.runId,
      delegationId: input.delegationId,
      childId: input.childId,
      handoffPath,
      briefPath,
    })

    // R4: plugin-driven delegation with the full request shape. `parent` is the
    // exact live direct-parent Agent (object-identity authority in the live
    // subagent service); absent it, the live start() rejects the request.
    // T28: the depth budget replaces the hardcoded `?? 2`. The parent's own depth is
    // read structurally (the plugin's seam style) and SUBTRACTED, so the configured
    // ceiling bounds the whole recursion rather than being re-granted at every level
    // — a "depth 2" budget that resets per level bounds nothing.
    // T9: notes about routing decisions that could NOT be applied, so a caller is told rather
    // than left to infer it from a model that silently did not take effect.
    const routingNotes: string[] = []
    const request: SubagentStartRequestLike = {
      prompt: [{ type: 'text', text: prompt }],
      label: input.delegationId + '/' + input.childId,
      outputSchema: reviewOutputSchema(),
      toolFilter: input.toolFilter ?? defaultReviewToolFilter(),
      maxDepth: remainingDepthFor(this.enforcementConfig.budgets, parentDepthOf(input.parent), input.maxDepth),
    }
    if (input.parent !== undefined) request.parent = input.parent

    // T9 — PER-ROLE MODEL ROUTING, applied only where the provider SAYS it supports it.
    //
    // The harness rejects a start that sends `agentOptions` to a provider without the
    // `agentOptions` capability, so gating on the model alone would BREAK delegations on
    // providers that do not accept overrides — a routing feature that takes down the
    // delegation it was meant to improve. The capability decides, and an unsatisfied model
    // is reported rather than silently dropped.
    const roleModel = modelForRole(input.role, policy)
    if (roleModel !== null) {
      const target = decision.provider ?? ''
      const capable = providers[target]?.capabilities?.agentOptions === true
      if (capable) {
        request.agentOptions = { model: roleModel }
      } else {
        routingNotes.push(
          'role ' + input.role + ' names model ' + roleModel + ', but provider ' + (target || '(none)')
          + ' does not declare the agentOptions capability, so the model was NOT applied',
        )
      }
    }

    // T19 — DETERMINISTIC OPERATION IDENTITY for the delegation itself. The id
    // covers the inputs PLUS the artifact's BODY, and the body is what keeps a
    // re-review of a REPAIRED artifact a genuinely different operation rather than a
    // recognised repeat. `childId` is deliberately NOT part of it: a fresh round
    // allocates one at random, so including it would make the id meaningless.
    //
    // The body — not the `LockHash` — for the reason T37 found the hard way: a lock
    // hash covers the wall-clock `LockedAt`, so it changes between two locks of
    // byte-identical content and would make this identity fire only half the time.
    const artifactBody = (() => {
      try {
        return lockHashFromContent(
          readFileSync(input.artifactPath, 'utf8').replace(/^[ \t]*Status:.*$/m, '').replace(/^[ \t]*LockedAt:.*\n?/m, ''),
        )
      } catch {
        return 'absent'
      }
    })()
    const operation = operationId({
      act: 'delegate-review',
      input: {
        runId: input.runId,
        phase: input.phase,
        role: input.role,
        delegationId: input.delegationId,
        body: artifactBody,
      },
    })

    /**
     * T39 — the PRODUCTION provider of the interrupt seam.
     *
     * The delegation's job kill must reach the LIVE child, and the child is interrupted
     * through the SAME `subagents.interrupt` seam the continuable lifecycle already uses —
     * never a second stop path, so a board kill and a lifecycle stop cannot drift apart. The
     * authority is `{ kind: 'ancestor', agent: parent }`: the parent Agent is the object-
     * identity authority the seam expects, exactly as `followup` uses it.
     *
     * An explicit `input.interrupt` still WINS, so a caller with a better authority (a user-
     * initiated stop, say) can supply one. With no seam and no parent there is nothing to
     * interrupt, and this quietly does nothing rather than throwing: the kill already parked
     * the round, and a kill that cannot reach a child must not become an error in its place.
     */
    const interruptChild = input.interrupt ?? ((childId: string, reason: string) => {
      const seam = subagents
      if (seam?.interrupt === undefined || input.parent === undefined) return
      try {
        seam.interrupt(childId as ContinuableChildId, { kind: 'ancestor', agent: input.parent })
      } catch {
        // Best-effort, like the call site that uses it.
      }
    })

    let result: SubagentResultLike | null = null
    let error: string | null = null
    let continuable: ContinuableDelegationLike | null = null
    // T36: a parked round is NOT an error — it means the child has not settled yet.
    // Kept apart from `error` so a turn-shaped caller can resume instead of treating
    // an ordinary wait as a failure of the delegation.
    let parked = false
    let parkedReason: string | null = null
    // The run directory the operation index lives under. Computed once, and the
    // index is skipped entirely when there is no root: `join('', …)` would otherwise
    // resolve a RELATIVE path and could read or write an unrelated directory.
    const operationsDir = input.root ? join(input.root, '.recursive', 'run', input.runId) : ''

    // T19 — a RECOGNISED repeat is not re-executed. Only an operation that already
    // COMPLETED and was ACCEPTED blocks a retry: a failed or refused attempt must
    // stay retryable, and a repaired artifact is a different operation entirely
    // because its body is part of the id. Without this the same review could spawn a
    // second reviewer for an artifact that has not changed.
    const prior = operationsDir === '' ? null : findOperation(operationsDir, operation)
    if (prior?.outcome === 'accepted') {      throw new Error(
        'review of ' + input.phase + ' is a recognised repeat of an operation already accepted (operation ' +
        operation + '); the artifact has not changed since it passed',
      )
    }

    // T28 — THE CHILDREN BUDGET, counted FROM the index rather than tracked beside it,
    // so the bound cannot drift from the operations it bounds. Distinct operations,
    // not records: a resumed turn re-enters here with the same id and must not be
    // counted as another child.
    if (operationsDir !== '') {
      const started = countOperations(operationsDir, 'delegate-review', input.phase)
      if (started >= this.enforcementConfig.budgets.maxChildrenPerPhase) {
        throw new Error(
          'children budget reached: phase ' + input.phase + ' has already started ' + started +
          ' delegation(s), and the configured cap is ' + this.enforcementConfig.budgets.maxChildrenPerPhase,
        )
      }
    }

    if (decision.tier === 'native' || decision.tier === 'external-cli') {
      if (!subagents) {
        error = 'no ctx.subagents runtime available (self-audit fallback)'
      } else if (input.mode !== 'one-shot') {
        // T35: continuable BY DEFAULT — only an explicit 'one-shot' opts out of
        // the repair path, because a one-shot child cannot be resumed.
        continuable = await delegateContinuable({
          subagents,
          provider: decision.provider as string,
          label: input.delegationId + '/' + input.childId,
          prompt,
          childId: input.childId,
          maxDepth: remainingDepthFor(this.enforcementConfig.budgets, parentDepthOf(input.parent), input.maxDepth),
          toolFilter: input.toolFilter ?? defaultReviewToolFilter(),
          maxRounds: input.maxRounds ?? 3,
          // T9: the model the role resolved to, when the provider accepts overrides. It must be
          // forwarded THROUGH the continuable delegation — that seam builds the start request
          // itself, so setting it on `request` alone would never reach the provider.
          ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
          // T39: the ROUND AWAIT is the hangable part of a delegation — the child may work for
          // minutes — so it is what the board should be able to see as a running job.
          //
          // ⚠ SAFETY BY CONSTRUCTION, which is why this wrapper is safe to add at all: the
          // seam's contract is `SubagentResultLike | null`, and `delegateContinuable` reads a
          // null as PARKED. So every non-completed job outcome returns `null` — never a throw
          // and never an invented result — which means a killed or failed round parks exactly
          // as an unobserved round does. This wrapper therefore CANNOT convert a parked round
          // into a settlement, and the property holds without a special case.
          //
          // ⚠ MEASURED, and it corrects T39's own plan: `delegateReview` has NO interrupt
          // seam — its input carries none, and this module has no interrupt path (the audit
          // loop has one only because IT receives the teams runtime). So the job's cancel
          // cannot yet pre-empt the child; wiring that needs the seam added here first. The
          // job still gives the board visibility, and the signal is honoured at the boundary.
          awaitRoundResult: input.awaitRoundResult === undefined ? undefined : async (childId, messageId) => {
            const awaited = await runTracked(this.jobs, {
              kind: 'delegation',
              label: 'delegation round ' + input.runId + ' ' + input.phase,
              run: async ({ report, signal }) => {
                report('awaiting the review round')

                // T39 (part 2) — THE PRE-EMPTIVE KILL. A job kill aborts the signal, and this
                // listener turns that abort into an INTERRUPT of the LIVE CHILD, so the kill
                // stops the WORK rather than merely stopping our wait for it. That is the
                // difference between this call site and T10's synchronous ones, where no such
                // thing is possible.
                //
                // The seam is OPTIONAL and the no-seam case stays honest: without a provider
                // the kill still parks the round and never throws — it simply cannot reach the
                // child, and nothing here pretends otherwise.
                const onAbort = () => {
                  try {
                    interruptChild(input.childId, abortReason(signal))
                  } catch {
                    // Best-effort by design: an interrupt that throws must not replace the
                    // kill's own outcome with an unrelated error.
                  }
                }
                if (signal.aborted) onAbort()
                else signal.addEventListener('abort', onAbort, { once: true })

                try {
                  if (signal.aborted) throw new Error('the round was cancelled before it was awaited')
                  return await input.awaitRoundResult!(childId, messageId)
                } finally {
                  signal.removeEventListener('abort', onAbort)
                }
              },
            })
            if (awaited.status !== 'completed') return null
            // T39: record the round where the run id is known — same pattern as the lint, and
            // for the same reason (an event would carry the job, not the run).
            recordJobRun(input.root, input.runId, {
              kind: 'delegation',
              label: 'delegation round ' + input.runId + ' ' + input.phase,
              result: awaited,
            })
            return awaited.value ?? null
          },
          parent: input.parent,
        })
        if (continuable.parked === true) {
          // T36: no settlement has landed for this round yet. The child is still
          // working (or a repair was just sent), so the caller resumes on a later
          // turn with the SAME child id. `accepted` stays false, and no `result` is
          // fabricated — an unobserved round is never an approval.
          parked = true
          parkedReason = continuable.reason ?? null
        } else if (continuable.fellBackToOneShot) {
          // The seam has no continuable capability — keep the one-shot result.
          result = continuable.rounds[0]?.result ?? null
          if (!result) error = 'continuable fallback produced no result'
        } else if (continuable.ok && continuable.rounds.length > 0) {
          result = continuable.rounds[continuable.rounds.length - 1].result ?? null
          if (!result) error = 'continuable child produced no final result'
        } else {
          error = continuable.reason ?? 'continuable delegation failed'
        }
      } else {
        try {
          result = await delegate({
            subagents,
            provider: decision.provider as string,
            request,
          })
        } catch (err) {
          error = (err as Error).message
        }
      }
    } else {
      error = 'delegation resolved to ' + decision.tier + ' (' + decision.reason + ')'
    }

    const rawEvaluation = result ? evaluateDelegationResult(result) : { accepted: false, reason: error ?? 'no result' }

    // T8 — THE WIRING BUG THE ITEM'S RESCOPE NAMED. `validateReferences` existed, was
    // exported, was even reachable through this runtime — and was called by NOTHING on the
    // delegate path. The module header had always claimed the opposite ("validates the
    // child's references before writing an action record"), so a reviewer could cite files
    // that do not exist, or paths that escape the root, and the review was recorded as a
    // PASS. A claim nobody checks is worse than no claim, because it reads as evidence.
    //
    // Placed BEFORE the operation record and the action record, which is what makes it
    // matter: a review with unverifiable references is never indexed as `accepted`, so the
    // T19 repeat guard treats it as retryable instead of freezing a bad review in place.
    //
    // A delegation that claims NOTHING is not checked — refusing an empty list would be a
    // policy change (is a reference-free review invalid?) rather than a wiring fix, and it
    // is recorded here as a deliberate boundary rather than an oversight.
    const claims = result ? referencesFromResult(result) : []
    const referenceCheck = claims.length === 0 ? null : validateReferences(input.root, claims)
    const evaluation = referenceCheck === null || referenceCheck.ok
      ? rawEvaluation
      : { accepted: false, reason: 'review references failed: ' + referenceCheck.failures.join('; ') }

    // T19 — persist the attempt so a RESTART can match it. Only an accepted review is
    // recorded as `accepted`, which is what makes the recognition above block a
    // genuine repeat while leaving every failure path retryable. Best-effort: a
    // failed index write must never change the outcome of a review that already ran.
    if (operationsDir !== '') {
      recordOperation(operationsDir, {
        id: operation,
        act: 'delegate-review',
        at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        outcome: evaluation.accepted ? 'accepted' : 'unaccepted',
        phase: input.phase,
      })
    }

    // R6: record the attempt as an action record (accepted only if evaluation passes).
    const actionRecordPath = writeActionRecord({
      root: input.root,
      runId: input.runId,
      subagentId: input.childId,
      phase: input.phase,
      purpose: input.role + ' for run ' + input.runId,
      executionMode: decision.tier + (input.mode !== 'one-shot' ? ' (continuable)' : ''),
      artifactPath: input.artifactPath,
      upstreamArtifacts: input.upstreamArtifacts,
      reviewBundle: bundle.repoRelativePath,
      diffBasis: input.diffBasis?.normalizedDiffCommand,
      codeRefs: input.codeRefs,
      auditQuestions: input.auditQuestions,
      findings: evaluation.accepted && result?.structured ? [(result.structured as { verdict?: string })?.verdict ?? 'accepted'] : undefined,
      success: evaluation.accepted,
      stopReason: result?.stopReason,
      // ⚠ FU-9 — AND SAY WHICH KIND OF FAILURE, because the record previously could not. `result == null` means
      // the provider never produced anything at all (never started, or returned nothing) — which is what the
      // live record's `Stop Reason: n/a` was quietly telling me — while a present result that failed to be
      // accepted means a child DID run and its work was refused. Different problems, identical artifacts.
      failure: evaluation.accepted
        ? undefined
        : result == null
          ? 'no delegate result was produced (the provider never started, or returned nothing)'
          : 'the delegation returned without acceptance; stop reason ' + (result.stopReason ?? 'none reported'),
    })

    // T35: report the mode that ACTUALLY ran, not the one that was asked for. A
    // missing continuable capability is a real loss — the review can no longer be
    // sent back to the child that did the work — so it is NAMED rather than
    // hidden behind a generic success. `continuable-unavailable` is the honest
    // label for that case: the delegation still happened, the repair path did not.
    const delegationMode: 'continuable' | 'one-shot' | 'continuable-unavailable' | 'none'
      = continuable !== null
        ? (continuable.fellBackToOneShot ? 'continuable-unavailable' : 'continuable')
        : result !== null ? 'one-shot' : 'none'

    // T4: the durable child id is reported for the caller (a tool/closeout that
    // holds the live parent Agent may drain it explicitly); the HOST owns the
    // teardown drain (drainContinuableDescendants) at session close — this loop
    // never forces a drain with a wrong authority credential (childId ≠ parent).
    return {
      decision,
      probe,
      bundle,
      handoffPath,
      briefPath,
      replyPath: replyPath({ root: input.root, runId: input.runId, delegationId: input.delegationId, childId: input.childId }),
      childScratchPath: childScratchPath({ root: input.root, runId: input.runId, childId: input.childId }),
      prompt,
      request,
      result,
      evaluation,
      /** T9: routing decisions that could NOT be applied, so a caller is told rather than left to infer. */
      routingNotes,
      actionRecordPath,
      error,
      /** T35: which child lifecycle actually carried this delegation. */
      delegationMode,
      /** T19: the deterministic id of this review, persisted so a restart can match it. */
      operationId: operation,
      /**
       * T36: true when the round has NOT settled yet, so the caller resumes with
       * `continuable.childId` on a later turn. `parkedReason` carries the loop's own
       * sentence ("the child is still working") without it being an `error`.
       */
      parked,
      parkedReason,
      continuable: continuable ? { rounds: continuable.rounds, childId: continuable.childId, fellBackToOneShot: continuable.fellBackToOneShot, parked: continuable.parked === true } : null,
    }
  }

  /** R6: validate a child's claimed references against actual files. */
  validateReferences(root: string, references: Reference[]) {
    return validateReferences(root, references)
  }

  /** R7: probe availability for a role and render the decision basis prose. */
  probeDelegation(root: string, role: string, providers: Record<string, SubagentProviderLike> = {}) {
    const policy = loadRouterPolicy(routerPolicyPath(root), this._routerOverrides)
    const decision = resolveRole(role, policy, providers)
    const probe = capabilityProbe({ providers, role, policy })
    return {
      decision,
      probe,
      basis: delegationDecisionBasis({ role, available: probe.available, provider: probe.provider, fallback: 'self-audit' }),
    }
  }

  /**
   * B3: per-call workspace root resolution. The control-plane root is the
   * session's cwd (or registry-canonicalized), NEVER process.cwd() — the host
   * checkout is not the run's workspace. Reads resolve under that root only.
   */
  async resolveRootFor(agent?: { session?: { header?: { cwd?: string } } } | null): Promise<string | null> {
    return resolveControlPlaneRoot(agent, this.workspaceRegistry, this.repoRoot)
  }

  /**
   * SP2 R1 route adapter: resolve the control-plane root for the live route.
   * sessionId PRIMARY — the host looks up the attached session header cwd and
   * resolves the root from THAT; the client-passed cwd is a fallback hint only
   * (hydration / headless callers). Two sessions in one workspace collapse to
   * one root; a subdir cwd resolves up to the workspace root.
   */
  async resolveRootForRoute(sessionId: string | undefined, cwd: string, sessionsStore?: { get?: (id: string) => { header?: { cwd?: string } } | undefined } | null): Promise<string | null> {
    // 1) Attached session header (authoritative when present).
    if (sessionId && sessionsStore?.get) {
      const attached = sessionsStore.get(sessionId)
      const headerCwd = attached?.header?.cwd
      if (headerCwd) {
        const root = await resolveControlPlaneRoot({ session: { header: { cwd: headerCwd } } }, this.workspaceRegistry, this.repoRoot)
        if (root) return root
      }
    }
    // 2) Client cwd fallback (hydration / headless) — still registry-canonicalized.
    if (cwd) {
      const root = await resolveControlPlaneRoot({ session: { header: { cwd } } }, this.workspaceRegistry, this.repoRoot)
      if (root) return root
    }
    return null
  }

  async status(runId?: string, agent?: { session?: { header?: { cwd?: string } } } | null): Promise<RecursiveStatusWithGuardDecisions | null> {
    const root = await this.resolveRootFor(agent)
    if (!root) return null
    const resolved = resolveRunDir(root, runId)
    if (!resolved) return null
    // T15 (G): surface the rolling guard-decision evidence BESIDE the fold, spread
    // over it — foldRun's own output shape is parity-asserted (status.parity) and
    // must not change. Scoped to the resolved run so the field answers "what did
    // the guard decide about THIS run", newest first.
    const guardDecisions = readGuardDecisions(root, GUARD_DECISION_READ_LIMIT)
      .filter((d) => d.runId === resolved.runId)
      .slice(0, GUARD_DECISION_SURFACE_LIMIT)
    // T18: the pending set rides beside the fold for the same reason — foldRun's
    // shape is parity-asserted. Always present (empty when nothing is in flight)
    // so a consumer needs no null dance, and DERIVED on every call rather than
    // stored, so it cannot go stale.
    //
    // T32: the receipt-chain verdict rides here too. A chain that has been edited or
    // spliced must be VISIBLE on the status a caller actually reads, not only inside
    // a test — that was the whole finding: the mechanism was written and read by
    // nothing. Read-only, so asking cannot change the answer.
    return {
      ...foldRun(resolved.runDir, resolved.runId),
      guardDecisions,
      pendingWork: pendingWork(resolved.runDir),
      receiptChain: validateReceiptChain(resolved.runDir, resolved.runId),
      // T22: the same identifier the prompt's stable prefix carries, so a reader can compare status
      // against prompt without re-rendering the section.
      contractDigest: contractDigest(this.enforcementConfig),
    }
  }

  /**
   * LIVE BUG 6 refined: structured phase rules for the CURRENT phase. Resolves
   * the workspace root (same as status/lock), finds the latest run (or the
   * given runId), advances via getNextLegalPhase, and returns the phase's lint
   * rules + instructions. Returns null when no active phase exists. This is the
   * canonical data source for the recursive_phase tool.
   */
  async phaseRules(runId?: string, agent?: { session?: { header?: { cwd?: string } } } | null, files?: readonly string[]): Promise<(PhaseRules & { runId: string; phase: string; memory: string; memoryReason: string }) | null> {
    const root = await this.resolveRootFor(agent)
    if (!root) return null
    const resolved = resolveRunDir(root, runId)
    if (!resolved) return null
    const phase = getNextLegalPhase(resolved.runDir)
    if (!phase) return null
    // T29 — MEMORY AT RUN ENTRY, ON THIS CALL AND NOWHERE ELSE.
    //
    // ⚠ THE ONCE-GATE IS THIS FUNCTION, not a mechanism added beside it: `recursive_phase` calls it
    // once per phase entry, so riding the injection on its EXISTING return is what keeps it
    // once-per-run instead of once-per-turn. A second dedupe would be a second thing to get wrong.
    //
    // ⚠ AND NOTHING RELEVANT INJECTS NOTHING — `memory` is the empty string, with the reason saying
    // why, rather than a section that fabricates relevance the plane does not have.
    const requirements = (() => {
      try {
        return readFileSync(join(resolved.runDir, '00-requirements.md'), 'utf8')
      } catch {
        // A run with no requirements yet has a weaker query, not an error: the paths still count.
        return ''
      }
    })()
    // `phase` IS the artifact file name (`getNextLegalPhase` returns one of PHASE_SEQUENCE), so the gate
    // lookup needs no mapping — and the artifact's own text is what says whether it is still owed.
    const pending = pendingGateFor(phase, (() => {
      try {
        return readFileSync(join(resolved.runDir, phase), 'utf8')
      } catch {
        return null
      }
    })())
    const selection = selectMemory(root, {
      query: requirements.slice(0, 4000),
      // FU-4: the run's OWN changed paths, computed when the caller supplies none — so T29's path
      // weighting is fed by a real run rather than only by tests. `[]` from a non-git root is fine: the
      // query still ranks, and a memory hint must never be why a phase call fails.
      files: files ?? changedPaths(root),
      // P2: the phase in play, so an entry declaring it applies here outranks general guidance.
      // P3b: the counters, read ONCE here and handed to the ranking — the book is evidence about retrieval,
      // and where it lives is the caller's business, not the ranker's.
      feedback: readFeedback(root),
      phase,
    })
    // P3b: record what this phase was shown, so the loop has evidence to settle at closeout.
    recordInjection(resolved.runDir, selection.shards.map((shard) => ({
      source: shard.entry.source,
      title: shard.entry.title,
      score: shard.score,
    })), phase)
    return {
      runId: resolved.runId,
      phase,
      ...phaseRulesFor(phase),
      memory: selection.injected ? renderMemorySection(selection.shards.map((shard) => shard.entry)) : '',
      memoryReason: selection.reason,
      // FU-7 — THE PHASE-ENTRY CALL POINTS. Phase 03 owes a `TDD Mode` decision and phase 05 a
      // `QA Execution Mode` one; both are surfaced HERE, at the entry the tool already makes, so a
      // caller does not have to know the workflow's gate vocabulary to be asked the right question.
      // Omitted entirely once the artifact carries the marker (that IS the once-gate).
      ...(pending === null ? {} : { ask: { gate: pending, ...buildAskQuestion(pending), artifact: GATE_DEFAULT_ARTIFACT[pending] } }),
    }
  }

  /**
   * Scaffold a run directory with FULL per-phase templates (no-op if exists).
   * 00-requirements.md + 00-worktree.md are byte-identical to canonical
   * recursive-init.py (incl. git-context prefill); later phases carry every
   * required section (get_artifact_required_sections) + TODO + FAIL gates.
   * Also scaffolds addenda/subagents/router-prompts/evidence dirs. Returns the
   * run dir + created artifacts.
   *
   * When `opts.createWorktree` is true, a linked worktree is first created at
   * `.worktrees/<runId>/` and the run is scaffolded INSIDE it (per the
   * "all subsequent phases execute in worktree context" rule). The worktree
   * branch defaults to `recursive/<runId>` and is cut from `opts.baseBranch`
   * (default: current HEAD branch of the root checkout).
   */
  async initRun(runId: string, agent?: { session?: { header?: { cwd?: string } } } | null, opts?: { createWorktree?: boolean; baseBranch?: string }): Promise<{ runDir: string; runId: string; created: string[]; existing: string[]; worktree?: CreateWorktreeResult }> {
    const root = await this.resolveRootFor(agent)
    if (!root) throw new Error('cannot resolve workspace control-plane root for this session')
    let scaffoldRoot = root
    let worktree: CreateWorktreeResult | undefined
    if (opts?.createWorktree) {
      // T10: a linked-worktree create is the operation the item names as the "hung" one — git
      // can take a long time on a large repo — and like the linter it CANNOT stop mid-flight,
      // because `createLinkedWorktree` is synchronous. What the job buys is therefore the same
      // and is stated plainly: the board SEES it running and the caller can stop WAITING.
      //
      // The failure path is unchanged: `createLinkedWorktree` reports `{ ok: false, error }`
      // rather than throwing, so a refused create still throws exactly what it threw before.
      const created = await runTracked(this.jobs, {
        kind: 'worktree',
        label: 'worktree ' + runId,
        run: async ({ report, signal }) => {
          report('creating ' + runId)
          if (signal.aborted) throw new Error('worktree create cancelled before it started')
          return createLinkedWorktree({ repoRoot: root, runId, baseBranch: opts.baseBranch })
        },
      })
      if (created.status !== 'completed' || created.value === undefined) {
        throw new Error(created.detail ?? created.error ?? 'worktree create did not complete')
      }
      worktree = created.value
      if (!worktree.ok) throw new Error(worktree.error ?? 'worktree create failed')
      scaffoldRoot = worktree.worktreeDir
      // T39: recorded into the SCAFFOLD root, because a worktree run's layer lives INSIDE the
      // worktree — recording it against the main checkout would file it where no run exists.
      // A create that FAILED records nothing here: there is no run layer to record into, and
      // the failure already reaches the caller as the thrown error above.
      recordJobRun(scaffoldRoot, runId, { kind: 'worktree', label: 'worktree ' + runId, result: created })
    }
    const runDir = join(scaffoldRoot, '.recursive', 'run', runId)
    mkdirSync(runDir, { recursive: true })
    const created: string[] = []
    const existing: string[] = []

    // Scaffold dirs (canonical recursive-init sequence).
    for (const dir of RUN_SCAFFOLD_DIRS) {
      const p = join(runDir, dir)
      if (existsSync(p)) { existing.push(dir + '/'); continue }
      mkdirSync(p, { recursive: true })
      created.push(dir + '/')
    }

    // Git context for the Phase 0 diff-basis prefill (canonical parity). When a
    // worktree was created, the git context + Phase 0 record the WORKTREE.
    const { context: gitContext, error: prefillError } = detectGitContext(scaffoldRoot)

    // Phase 0 templates: byte-identical to canonical recursive-init.py.
    const phase0: Array<[string, string]> = [
      ['00-requirements.md', requirementsContent(runId, 'feature', '')],
      ['00-worktree.md', worktreeContent(runId, scaffoldRoot, gitContext, prefillError)],
    ]
    for (const [file, content] of phase0) {
      const path = join(runDir, file)
      if (existsSync(path)) { existing.push(file); continue }
      writeFileSync(path, content, 'utf8')
      created.push(file)
    }

    // Later phases: full required-sections scaffold.
    const laterPhases = [
      '01-as-is.md',
      '01.5-root-cause.md',
      '02-to-be-plan.md',
      '03-implementation-summary.md',
      '03.5-code-review.md',
      '04-test-summary.md',
      '05-manual-qa.md',
      '06-decisions-update.md',
      '07-state-update.md',
      '08-memory-impact.md',
    ]
    for (const file of laterPhases) {
      const path = join(runDir, file)
      if (existsSync(path)) { existing.push(file); continue }
      writeFileSync(path, laterPhaseContent(runId, file), 'utf8')
      created.push(file)
    }

    const result: { runDir: string; runId: string; created: string[]; existing: string[]; worktree?: CreateWorktreeResult } = { runDir, runId, created, existing }
    if (worktree) result.worktree = worktree
    // T1 (goals projection): arm a durable run goal for the driving session.
    // Best-effort — never fails a run init if the goals service is absent/odd.
    try { this.projectRunToGoal(agent, runId, 'active') } catch { /* goal projection is best-effort */ }
    return result
  }

  /**
   * Create a linked worktree for a run under the given workspace root. The
   * worktree branch defaults to `recursive/<runId>` and is cut from the given
   * base branch (default: the current HEAD branch of the root checkout).
   * Refuses to create over an existing run directory. Workspace-scoped.
   */
  createRunWorktree(root: string, runId: string, baseBranch?: string): CreateWorktreeResult {
    return createLinkedWorktree({ repoRoot: root, runId, baseBranch })
  }

  /**
   * Promote a branch up the dev/stage/main chain (fast-forward). Workspace-scoped.
   */
  promoteRunBranch(root: string, fromBranch: string, toBranch: string): PromoteBranchResult {
    return promoteBranch({ repoRoot: root, fromBranch, toBranch })
  }

  /**
   * Worktree + branch status for a workspace root: the linked worktrees,
   * which branch each is on, and the current checkout's base/upstream context.
   */
  worktreeStatus(root: string): Record<string, unknown> {
    const facts = gitFacts(root)
    const worktrees = listWorktrees(root)
    return {
      root,
      isWorktree: facts.isWorktree,
      branch: facts.branch,
      upstreamBranch: facts.upstreamBranch,
      worktrees,
    }
  }

  /**
   * Lock a DRAFT artifact (or reopen a LOCKED one). Validates prerequisites;
   * writes Status/LockedAt/LockHash + receipt. Returns the lock result.
   */
  async lockArtifact(runId: string, artifact: string, reopen = false, agent?: { session?: { header?: { cwd?: string } } } | null): Promise<LockArtifactResult> {
    const root = await this.resolveRootFor(agent)
    if (!root) throw new Error('cannot resolve workspace control-plane root for this session')
    const runDir = join(root, '.recursive', 'run', runId)
    const artifactPath = join(runDir, artifact)
    if (reopen) {
      return this.reopenArtifact(root, runDir, runId, artifact, artifactPath, agent)
    }
    if (!existsSync(artifactPath)) throw new Error('Artifact not found: ' + artifact)
    const status = getLockStatus(artifactPath)
    if (status === 'LOCKED') throw new Error('Artifact already LOCKED: ' + artifact)
    // B2: the pre-step gate reads transition intent from the session log; the
    // durable commit below is what the live fs route folds. No phase-intent event.
    const blockers = getPrerequisiteBlockers(runDir, artifact)
    if (blockers.length > 0) {
      // T1 (goals projection): a gate-block becomes a durable, UI-visible goal
      // block rather than a one-line advisory. Best-effort before the throw.
      const message = 'monotonic lock-order: ' + blockers.map(b => b.artifact + ' (' + b.status + ')').join(', ')
      try { this.blockRunToGoal(agent, runId, { code: 'prerequisite-blockers', message }) } catch { /* best-effort */ }
      throw new Error('Prerequisite blockers: ' + blockers.map(b => b.artifact + ' (' + b.status + ')').join(', '))
    }
    // T18 — QUIESCENCE. A lock is only sound at a point where nothing is in
    // flight, so a run with an unresolved delegation refuses to lock and names
    // what is blocking. Checked AFTER the prerequisite gate deliberately: the
    // monotonic lock-order rule is the canonical one that the parity goldens and
    // every existing test know, and a run that is both out of order AND has a
    // delegation open still reports ordering first, exactly as before this item.
    const inFlight = pendingWork(runDir)
    if (inFlight.length > 0) {
      throw new Error(toolError('PENDING_WORK', inFlight.map((p) => p.detail).join('; ')))
    }
    let content = readFileSync(artifactPath, 'utf8')
    const lockedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    content = setOrInsertField(content, 'Status', 'LOCKED', ['Phase'])
    content = setOrInsertField(content, 'LockedAt', lockedAt, ['Status'])
    const provisional = setOrInsertField(content, 'LockHash', '0'.repeat(64), ['LockedAt', 'Status'])
    const lockHash = lockHashFromContent(provisional)
    content = setOrInsertField(content, 'LockHash', lockHash, ['LockedAt', 'Status'])
    writeFileSync(artifactPath, content, 'utf8')
    const receipt = writeReceipt(runDir, artifact, artifactPath)
    // B2: the commit is durable — the live fs route folds it on the next GET.
    return {
      artifact,
      runId,
      status: 'LOCKED',
      lockedAt,
      lockHash,
      receipt,
      blockers: [],
    }
  }

  /** Reopen a LOCKED artifact to DRAFT (delete LockedAt/LockHash, invalidate downstream receipts). */
  private reopenArtifact(root: string, runDir: string, runId: string, artifact: string, artifactPath: string, agent?: { session?: { header?: { cwd?: string } } } | null): LockArtifactResult {
    if (!existsSync(artifactPath)) throw new Error('Artifact not found: ' + artifact)
    let content = readFileSync(artifactPath, 'utf8')

    // T19 — DETERMINISTIC OPERATION IDENTITY. Reopen is the one genuinely DESTRUCTIVE
    // operation here: it strips the lock fields and invalidates every downstream
    // receipt, so running it twice by accident destroys evidence. A retry after a
    // partial failure was previously indistinguishable from a fresh request.
    //
    // The id covers the INPUTS plus the STATE BEING REOPENED, and that third
    // component is what makes the rule correct rather than merely present:
    //   - a retry after a FAILED reopen still sees the same state, because a failed
    //     reopen leaves the artifact locked — so the retry IS recognised, which is
    //     the case the item exists for;
    //   - a DELIBERATE second reopen after a REPAIR sees a different state, so it is
    //     a different operation and runs — the legitimate workflow stays intact.
    // Keying on `{runId, artifact}` alone would have made the second reopen a no-op
    // and quietly broken reopen→fix→lock→reopen.
    //
    // The state is the artifact's BODY — its content with the lock fields normalised
    // out — and NOT its `LockHash`. That distinction is a bug fix, found by T37's
    // flake hunt: `LockHash` covers `LockedAt`, which is wall-clock truncated to the
    // SECOND, so two locks of byte-identical content hash differently whenever the
    // clock crosses a second boundary. Keying on it made this guard fire or not
    // depending on timing — it failed 6 of 12 measured runs. The body is stable
    // across a re-lock of identical content and differs as soon as the author
    // changes anything that matters.
    const bodyAtEntry = lockHashFromContent(
      content.replace(/^[ \t]*Status:.*$/m, '').replace(/^[ \t]*LockedAt:.*\n?/m, ''),
    )
    const operation = operationId({ act: 'reopen', input: { runId, artifact, body: bodyAtEntry } })
    if (findOperation(runDir, operation)?.outcome === 'applied') {
      // This exact operation already completed on this exact state. Reported as a
      // recognised repeat rather than executed again — a second strip-and-invalidate
      // would destroy whatever the first one left behind.
      throw new Error(
        'reopen ' + artifact + ' is a recognised repeat of an operation already applied (operation ' +
        operation + '); refusing to reopen it a second time',
      )
    }

    content = content.replace(/^[ \t]*Status:.*$/m, 'Status: `DRAFT`')
    content = content.replace(/^[ \t]*LockedAt:.*\n?/m, '')
    content = content.replace(/^[ \t]*LockHash:.*\n?/m, '')
    writeFileSync(artifactPath, content, 'utf8')
    // Record the attempt AFTER it succeeded, best-effort: a failed index write must
    // never change the outcome of an operation the caller already performed.
    recordOperation(runDir, { id: operation, act: 'reopen', at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), outcome: 'applied' })
    const hadReceipt = invalidateReceipt(runDir, artifact)
    const stale = getStaleDownstreamPhases(runDir, artifact)
    for (const entry of stale) invalidateReceipt(runDir, entry.artifact)
    // B2: reopen reverts to DRAFT — the live fs route folds the reverted state.
    // T1 (goals projection): re-arm the durable run goal (reopen un-blocks).
    try { this.resumeRunToGoal(agent, runId) } catch { /* best-effort */ }
    return {
      artifact,
      runId,
      status: 'DRAFT',
      lockedAt: null,
      lockHash: null,
      blockers: hadReceipt || stale.length > 0 ? ['Downstream receipts invalidated'] : [],
    }
  }

  /**
   * Lint an artifact with FULL canonical parity: runs the in-process ts-lint
   * port (ts-lint.ts `lintRun`) against the whole run and filters the verdict
   * lines to the requested artifact. `errors` = FAIL lines, `warnings` =
   * WARN lines, `passed` = no FAIL (WARN-only passes, matching the canonical
   * non-strict verdict).
   */
  async lintArtifact(runId: string, artifact?: string, agent?: { session?: { header?: { cwd?: string } } } | null): Promise<LintArtifactResult> {
    const root = await this.resolveRootFor(agent)
    if (!root) throw new Error('cannot resolve workspace control-plane root for this session')
    const runDir = join(root, '.recursive', 'run', runId)
    const target = artifact ?? getNextLegalPhase(runDir) ?? '00-requirements.md'
    const artifactPath = join(runDir, target)
    if (!existsSync(artifactPath)) {
      return { artifact: target, runId, errors: ['Artifact not found'], warnings: [], passed: false }
    }
    const linted = await runTracked(this.jobs, {
      kind: 'lint',
      // The label is what the board shows, so it names the run AND the artifact.
      label: 'lint ' + runId + ' ' + target,
      // NO TIMEOUT HERE, deliberately: a deadline would silently convert a slow-but-working
      // lint into a failure, which is a policy change rather than visibility. The job gives
      // the board a running entry and a kill switch, which is what the item asks for;
      // `runTracked`'s `timeoutMs` stays available to a caller who wants a deadline.
      run: async ({ report, signal }) => {
        report('linting ' + target)
        // A synchronous in-process linter cannot be interrupted mid-call, so the signal is
        // honoured at the BOUNDARY. Stated plainly rather than implied: a kill settles the
        // JOB — the board and the caller stop waiting — but a hung `lintRun` call itself
        // runs to completion in this process, because JavaScript cannot pre-empt it.
        if (signal.aborted) throw new Error('lint cancelled before it started')
        return lintRun(root, runId)
      },
    })
    // T39: record the run in the RUN LAYER, where the run id is known — see job-log.ts for why
    // this is a file rather than an event subscription (an event carries a job id, not the run
    // it belongs to, and parsing run ids back out of labels is a mapping that breaks silently).
    recordJobRun(root, runId, { kind: 'lint', label: 'lint ' + runId + ' ' + target, result: linted })
    if (linted.status !== 'completed' || linted.value === undefined) {
      // A killed or failed job is reported through the EXISTING error path, so the tool's
      // payload shape does not change and every existing assertion still holds.
      return {
        artifact: target,
        runId,
        errors: [linted.detail ?? linted.error ?? 'lint did not complete'],
        warnings: [],
        passed: false,
      }
    }
    const stdout = [...linted.value.errors, ...linted.value.warnings].join('\n')
    return parseLintOutput(stdout, target, runId)
  }

  /** Legacy structural fallback (kept for type reference; lintArtifact uses lintRun). */
  async lintArtifactStructuralFallback(runId: string, artifact: string, agent?: { session?: { header?: { cwd?: string } } } | null): Promise<LintArtifactResult> {
    const root = await this.resolveRootFor(agent)
    if (!root) throw new Error('cannot resolve workspace control-plane root for this session')
    const runDir = join(root, '.recursive', 'run', runId)
    const target = artifact ?? getNextLegalPhase(runDir) ?? '00-requirements.md'
    const artifactPath = join(runDir, target)
    if (!existsSync(artifactPath)) {
      return { artifact: target, runId, errors: ['Artifact not found'], warnings: [], passed: false }
    }
    // Structural fallback (no vendored script available).
    const content = readFileSync(artifactPath, 'utf8')
    const errors: string[] = []
    const warnings: string[] = []
    const status = getLockStatus(artifactPath)
    if (status === 'MISSING') errors.push('File missing')
    else if (status === 'DRAFT') warnings.push('Artifact is DRAFT (not locked)')
    else if (status === 'STALE_LOCK') errors.push('LockHash mismatch or missing lock fields')
    if (!/^[ \t]*## TODO[ \t]*$/m.test(content)) errors.push('Missing ## TODO section')
    for (const gate of ['Coverage', 'Approval']) {
      if (!new RegExp('^[ \t]*' + gate + ':\s*(PASS|FAIL)\s*$', 'm').test(content)) warnings.push('Missing ' + gate + ' gate')
    }
    return { artifact: target, runId, errors, warnings, passed: errors.length === 0 }
  }

  /** Phase C R4: Layer 2 tool guard decision (caller of the transition set). */
  guardTool(exec: ToolExecLike, root: string, runId: string, config?: EnforcementConfig): ToolGuardDecision {
    const mode = (config ?? this.enforcementConfig).toolGuards
    return evaluateToolGuard(exec, root, runId, mode)
  }

  /** Phase C R8: fs/observed tamper detection. */
  detectTamper(targetPath: string, root: string, runId: string) {
    return detectTamper(targetPath, root, runId)
  }

  /** Phase C R5: render the current-phase policy contract. */
  renderPolicy(root: string, runId: string, folded: RecursivePhaseState | null): string {
    return renderRecursivePolicy({ worktreeRoot: root, runId, folded, config: this.enforcementConfig } as PolicyContext)
  }

  /** Phase C R6: couple a gate-block to the goal service (graceful no-op). */
  coupleGateBlockToGoal(goalService: unknown, agent: unknown, ref: unknown, reason: { code: string; message: string }): boolean {
    return coupleGateBlockToGoal(goalService as never, agent, ref, reason)
  }

  /** Phase C R7: resolve the enforcement config (strict|advisory, default advisory). */
  get enforcementConfig(): EnforcementConfig {
    return this._enforcementConfig ?? DEFAULT_ENFORCEMENT
  }

  setEnforcementConfig(config: unknown): EnforcementConfig {
    this._enforcementConfig = resolveEnforcementConfig(config)
    return this._enforcementConfig
  }
}

/** set_or_insert_field: replace first field occurrence, else insert after the last listed after-field. */
function setOrInsertField(content: string, fieldName: string, value: string, afterFields: string[]): string {
  const line = fieldName + ': `' + value + '`'
  const fieldRe = new RegExp('^[ \\t]*(?:[-*][ \\t]+)?' + escapeRegExp(fieldName) + ':\\s*.*$', 'm')
  if (fieldRe.test(content)) {
    return content.replace(fieldRe, line)
  }
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let insertAt = 0
  for (const afterField of afterFields) {
    const afterRe = new RegExp('^[ \\t]*(?:[-*][ \\t]+)?' + escapeRegExp(afterField) + ':\\s*.*$', 'm')
    for (let i = 0; i < lines.length; i++) {
      if (afterRe.test(lines[i])) insertAt = Math.max(insertAt, i + 1)
    }
  }
  lines.splice(insertAt, 0, line)
  return lines.join('\n')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Parse the vendored lint-recursive-run.py stdout into a LintArtifactResult.
 * [FAIL] lines -> errors, [WARN] lines -> warnings. When the run directory has
 * multiple artifacts, FAIL/WARN lines carry the artifact path; we keep only the
 * lines for the requested artifact (or all when the path is ambiguous).
 */
function parseLintOutput(stdout: string, target: string, runId: string): LintArtifactResult {
  const errors: string[] = []
  const warnings: string[] = []
  const failRe = /^\[FAIL\]\s+(.*)$/gm
  const warnRe = /^\[WARN\]\s+(.*)$/gm
  const targetSuffix = target.replace(/^.*[\\/]/, '')
  const isForTarget = (line: string) => {
    const pathMatch = line.match(/[A-Za-z0-9_.-]+\.md/)
    return !pathMatch || pathMatch[0] === targetSuffix
  }
  let m: RegExpExecArray | null
  while ((m = failRe.exec(stdout)) !== null) {
    if (isForTarget(m[1])) errors.push(m[1].trim())
  }
  while ((m = warnRe.exec(stdout)) !== null) {
    if (isForTarget(m[1])) warnings.push(m[1].trim())
  }
  // If the target artifact appears nowhere in the output but the run was linted,
  // keep the parsed errors/warnings (canonical script lints the whole run).
  return { artifact: target, runId, errors, warnings, passed: errors.length === 0 }
}

