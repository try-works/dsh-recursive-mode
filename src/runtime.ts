import { Service, type Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
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
import { skipPhaseArtifact, SKIP_REASON_FIELD, SKIPPED_AT_FIELD, type SkipResult } from './skip.ts'
import { findOperation, countOperations, operationId, recordOperation } from './identity.ts'
import { createHookRegistry, type HookRegistry } from './hooks.ts'
import { runTracked, abortReason, type JobsRegistryLike } from './jobs-runner.ts'
import { resolveSubagentTarget } from './role-route.ts'
import { checkModelChoice, describeInventory, type LlmInventoryLike } from './model-inventory.ts'
import { recordJobRun } from './job-log.ts'
import { toolError } from './errors.ts'
import { readGuardDecisions, type GuardDecisionRecord } from './guard-log.ts'
import { resolveControlPlaneRoot, type WorkspaceRegistryLike } from './workspace.ts'
import { phaseRulesFor, delegatedReviewerCapability, type PhaseRules } from './phase-rules.ts'
import { closeoutReport, writeCloseoutReceipt } from './closeout-report.ts'
import { readScratch, writeScratch, appendScratch, type ScratchTarget } from './scratch.ts'
import { buildReviewBundle, type ReviewBundleInput } from './review.ts'
import { readMemoryEntries, retrieveMemory, renderMemorySection, selectMemory } from './memory.ts'
import { readFeedback, recordInjection, recordMemoryRead, settleInjections } from './memory-feedback.ts'
import { runPhase8Trigger, resolveExtractor, spawnExtractorRunner, phase8MemoryLockRefusal } from './training.ts'
import { buildAskQuestion, GATE_DEFAULT_ARTIFACT, pendingGateFor } from './recursive_ask.tool.ts'
import { contractDigest } from './policy.ts'
import type { WorkflowEngineLike } from './workflow-audit.ts'
import { createHandoff, createChildBrief, replyPath, childScratchPath, buildDelegationPrompt, type HandoffInput, type ChildBriefInput } from './handoff.ts'
import { loadRouterPolicy, routerPolicyPath, resolveRole, capabilityProbe, delegationDecisionBasis, type RouterPolicy, type RouterPolicyOverrides, type SubagentProviderLike, type RouteDecision, type CapabilityProbe } from './router.ts'
import { delegate, delegateContinuable, drainContinuableChildren, remainingDepthFor, validateReferences, referencesFromResult, writeActionRecord, evaluateDelegationResult, reviewOutputSchema, defaultReviewToolFilter, resolveFollowupSeam, type SubagentsRuntimeLike, type SubagentStartRequestLike, type SubagentResultLike, type Reference, type ActionRecordInput, type ContinuableDelegationLike, type SubagentParentHandle, type FollowupSeam } from './delegation.ts'
import { canRosterDispatch, describeSendFailure, describeSpawnFailure, findTeammate, findTeammateByChild, isTeamLeadCaller, liveMemberNamed, recordTeammate, teamCallSignal, teammateHoldPrompt, teammateNameFor, type TeammateRosterLike } from './teammate.ts'
import { validateTransition, coupleGateBlockToGoal, type PhaseTransitionIntent, type RecursivePhaseState, type GateCheckResult } from './lifecycle.ts'
import { resolveEnforcementConfig, DEFAULT_ENFORCEMENT, evaluateToolGuard, detectTamper, type EnforcementConfig, type ToolGuardDecision, type ToolExecLike } from './enforcement.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { renderRecursivePolicy, type PolicyContext } from './policy.ts'
import { snapshotWorkspace } from './snapshot.ts'
import { createLinkedWorktree, promoteBranch, listWorktrees, defaultWorktreeBranch, type CreateWorktreeResult, type PromoteBranchResult } from './worktree.ts'
import { changedPaths, gitFacts, gitBaselineProblem } from './git-context.ts'
import { syncRunGoal, blockRunGoal, resumeRunGoal, type GoalServiceLike, type SyncResult } from './goals-projection.ts'
import {
  RUN_START_APPROVE,
  RUN_START_ARTIFACT,
  RUN_START_GATE_ID,
  RUN_START_MARKER,
  RUN_START_NOT_APPROVED,
  readRunStartApproval,
  runStartArtifactPath,
} from './run-start.ts'
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
 * FU — the outcome of `initRun`'s first-commit step, additive to the init result so the caller (and the
 * model, via `recursive_init`) can see exactly what the commit did rather than have it happen invisibly.
 * Absent entirely when no commit was applicable (a repo that already had one, or not a repository).
 */
export interface FirstCommitResult {
  /** True when this call created a commit; false when it attempted and failed, or when it skipped. */
  committed: boolean
  /** The commit SHA, present only when `committed` is true. */
  sha: string | null
  /** The run-relative paths this call staged (`git add --`), in the order staged. */
  stagedPaths: string[]
  /** Non-null when a commit could not be made: the git failure, or 'skipped: <reason>'. */
  error: string | null
  /** True when the commit needed the `-c user.name/user.email` placeholder identity fallback. */
  usedPlaceholderIdentity: boolean
}

/**
 * PHASE 0 — the structural seam for the host's human-question channel (`ctx.userQuestions`).
 *
 * Declared here as a minimal seam for the same reason as every other harness touchpoint in this plugin:
 * the live `UserQuestionService` satisfies it structurally, so the plugin never imports the host package,
 * and a test can drive the run-start gate with a fake that behaves like the real one. The error case is
 * part of the contract, not an afterthought: the real `ask()` REJECTS (NO_PROVIDER / CALLER_NOT_LIVE /
 * ASK_ABORTED) instead of resolving with something that could be mistaken for an answer, which is what
 * lets `recursive_ask` fail closed rather than invent an approval.
 */
export interface UserQuestionsLike {
  ask(request: {
    questions: Array<{ id: string; header?: string; question: string; options?: Array<{ label: string; description?: string }> }>
    agent?: unknown
    signal?: AbortSignal
    /** Links the card to the tool call that asked, the way plan-mode's exit does. */
    wait?: { callId?: unknown }
  }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
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

/**
 * What this runtime reads from the calling agent — the same structural seam the harness's
 * `SubagentParentHandle` (`./delegation.ts`) uses, plus the `id` a native job needs as its owner.
 *
 * The live `Agent` satisfies it: `exec.agent`, which every tool in this plugin already passes, carries
 * both `id` and `session.header.cwd`. Declaring it once keeps the runtime's agent parameter from being
 * re-spelled at eight call sites, and lets `agentOwner` be the single place the owner is derived.
 */
export interface AgentLike {
  readonly id?: string
  readonly session?: { readonly header?: { readonly cwd?: string } }
}

/**
 * The one field a native job needs from a caller: the owning session id.
 *
 * ⚠ ESTABLISHED FROM THE HARNESS'S OWN CONTRACT, not guessed. `JobSpec.owner` is a `SessionId`
 * (`packages/jobs/jobs/src/types.ts`), and `LocalJobRegistry.start` resolves it with
 * `agents.get(spec.owner)` (`packages/jobs/jobs-local/src/index.ts`) — the live AGENT REGISTRY lookup,
 * so the value must be the id that registry is keyed by (`brandString<SessionId>` in
 * `packages/core/agent/src/index.ts`). What the registry then asks is whether an attached job
 * controller serves that owner's SCOPE (`servesOwner` → `scopeOf(owner.ctx)`), which is why an
 * omitted owner checks only the GLOBAL layer: a preset's realm-scoped `tool-jobs` controller is not
 * there, and `start` refuses with "no job controller serves this agent".
 *
 * ⚠ THE `id` IS OPTIONAL HERE BECAUSE THE LIVE OBJECT MAY NOT CARRY ONE, and passing a non-answer is
 * worse than passing none: an id the registry cannot resolve throws "session "…" has no live agent".
 * `undefined` reproduces exactly the pre-existing behaviour, so this helper can only ever improve a
 * call, never make one worse. The other tools that hand an agent to a host service use the same
 * shape — `tool-pwsh` passes `...(exec.agent ? { owner: exec.agent.id } : {})`, and `tool-subagent`
 * passes `owner: parent.id`.
 */
function agentOwner(agent: AgentLike | null | undefined): string | undefined {
  const id = agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
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

  constructor(ctx: Context, config: { repoRoot?: string; workspaceRegistry?: WorkspaceRegistryLike; goals?: GoalServiceLike | null; jobs?: JobsRegistryLike | null; subagents?: SubagentsRuntimeLike | null; teams?: TeammateRosterLike | null; workflow?: WorkflowEngineLike | null } = {}) {
    super(ctx, 'recursive')
    this.repoRoot = config.repoRoot ?? process.cwd()
    this.workspaceRegistry = config.workspaceRegistry ?? null
    this.goalsService = config.goals ?? null
    // T10: the native jobs registry is OPTIONAL. Absent, long operations run inline and say
    // so; see `runTracked` for why that is better than refusing to work without a board.
    this.jobs = config.jobs ?? null
    // T39: the subagents seam, resolved at the COMPOSITION like the other optional services.
    this.subagentsSeam = config.subagents ?? null
    // ⚠ THE ROSTER SEAM (G2). Optional like every other seam: absent it, delegation keeps using
    // `ctx.subagents.startContinuable` exactly as it does today. See `src/teammate.ts`.
    this.teamsSeam = config.teams ?? null
    // T2: the workflow engine, likewise.
    this.workflow = config.workflow ?? null
  }

  /**
   * T10: the native jobs registry, when the composition mounts one.
   *
   * ⚠ NOT `readonly`, unlike a constructor-only seam would be: `attachJobs` below replaces it when the
   * registry is mounted after this plugin applies (see that method for why that is not optional). */
  private jobs: JobsRegistryLike | null

  /**
   * PHASE 0 — attach the goals service after construction.
   *
   * The composition resolves `goals` with ONE `ctx.get` at apply time and passes it to the constructor,
   * which is fine for a service that is already mounted. This seam exists for the two cases that pattern
   * cannot cover: a composition that mounts `goals` later (the same late-attach reason `attachSubagents`
   * and `attachLlmInventory` exist), and a test that needs the REAL runtime wired to a structural fake —
   * a fake passed through the plugin's Config is dropped, because the Config schema is the settings
   * namespace and strips keys it does not declare.
   */
  attachGoals(service: GoalServiceLike | null): void {
    this.goalsService = service
  }

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
   * ⚠ G2 — THE AGENT-TEAM ROSTER SEAM (`ctx.agentTeams`), when the composition mounts one.
   *
   * Optional in exactly the way `subagents` is optional: without it, delegation continues on the primitive path
   * unchanged. With it — and with the LIVE caller resolving as the team Lead — every delegated child is created
   * through `spawnTeammate` and followed up through `sendMessage`, so the child is a named, durable roster member
   * instead of an anonymous continuable child. Attachable after construction for the same measured reason as
   * `attachSubagents`/`attachJobs`: the agent-team row can be mounted by a LATER loader layer than this plugin.
   */
  private teamsSeam: TeammateRosterLike | null
  /** FU-19: the host's provider/model inventory, or null when no llm service is mounted. */
  private llmInventory: LlmInventoryLike | null = null

  /**
   * ⚠ THE JOBS SEAM, ATTACHABLE AFTER CONSTRUCTION — the THIRD time this plugin needed the same shape,
   * and the first time it cost a frozen run.
   *
   * `apply` resolves the registry with ONE `ctx.get('jobs')` and passes it to the constructor, which is
   * only a fast path: a composition that mounts the registry from a LATER loader layer leaves the
   * runtime holding `null`, and nothing re-resolves it. `attachSubagents` and `attachLlmInventory` exist
   * for exactly that reason, and `agentTeams` needed a `ctx.inject` row as well (FIX 1 in `src/index.ts`),
   * so this follows the established shape rather than inventing one.
   *
   * ⚠ IDEMPOTENT, AND THE CONSTRUCTOR ARGUMENT WINS. "Last attach wins" would be wrong HERE, and the
   * difference from the sibling seams is deliberate: `jobs` is the one seam that is ALSO a constructor
   * argument, and `ctx.get` resolves services by INHERITANCE, so an unrelated registry visible in the
   * context could silently replace the exact one a caller passed. The late attach therefore fills the
   * seam ONLY when nothing has filled it — which is precisely the case that was broken (a registry
   * mounted after this plugin applied, while the one-shot `ctx.get` had returned undefined) — and the
   * guard is repeated per invocation, so a refresh of the injecting fiber cannot accumulate anything.
   */
  attachJobs(jobs: JobsRegistryLike | null): void {
    if (this.jobs !== null) return
    this.jobs = jobs
  }

  /** What the composition attached, for a caller that needs to report or assert it. */
  attachedJobs(): JobsRegistryLike | null {
    return this.jobs
  }

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

  /**
   * ⚠ G2 — ATTACH THE ROSTER SEAM, the same late-attaching pattern as `attachSubagents`/`attachJobs`, for the
   * same measured reason: `agentTeams` may be mounted by a later loader layer than this plugin (FIX 1 in
   * `src/index.ts` proves the case for the audit tool). Idempotent: the last attach wins.
   */
  attachTeams(seam: TeammateRosterLike | null): void {
    this.teamsSeam = seam
  }

  /** What the roster seam is, for a caller that needs to report or assert it. */
  attachedTeams(): TeammateRosterLike | null {
    return this.teamsSeam
  }

  /**
   * ⚠ FU-19 — THE LLM INVENTORY SEAM, resolved the same late-attaching way the subagents seam is and for the same
   * measured reason: a one-shot `ctx.get` at apply time misses a service mounted by a later layer.
   *
   * Null is a legitimate value and it is NOT treated as "no models exist" — `describeInventory(null)` reports a
   * named unavailability, and `checkModelChoice` turns that into the `unverified` verdict. A missing inventory
   * therefore never silently approves a model and never silently replaces one.
   */
  attachLlmInventory(seam: LlmInventoryLike | null): void {
    this.llmInventory = seam
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
    this.lastProviderNames = []
    if (seam === null) return {}
    const map: Record<string, SubagentProviderLike> = {}
    // ⚠ ASK THE SERVICE WHAT IT HAS, FIRST. The previous version only probed three invented names and
    // registered whatever came back — and the live record then said `provider spawn`, so the router faithfully
    // returned a name the host does not serve and `start('spawn', …)` produced NOTHING. A name this plugin made
    // up is not a provider the host knows, and the difference is a child that runs versus a silent no-op.
    try {
      const listed = seam.list?.()
      if (Array.isArray(listed)) {
        for (const entry of listed) {
          if (typeof entry === 'string' && entry !== '') map[entry] = { name: entry }
          else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
            const named = entry as { name: string } & SubagentProviderLike
            map[named.name] = named
          }
        }
      }
    } catch {
      // A service that cannot enumerate is not an error: the probes below are the fallback, not the plan.
    }
    // The probes stay as a FALLBACK for a service that exposes getProvider but no list. Whatever they return is
    // registered under the name ASKED FOR, which is only sound because the name came from a real lookup.
    for (const name of ['spawn', 'fork', 'dsh-sdk']) {
      if (map[name] !== undefined) continue
      try {
        const found = seam.getProvider?.(name)
        if (found !== undefined && found !== null) map[name] = found as SubagentProviderLike
      } catch {
        // An unavailable name is not an error: the next candidate still gets its turn.
      }
    }
    this.lastProviderNames = Object.keys(map)
    return map
  }

  /** The provider names the last `providerMapFromSeam` call registered, for the record and for assertions. */
  private lastProviderNames: string[] = []

  /** What the router could choose from, so a failure can say whether the name it used was ever on offer. */
  knownProviderNames(): string[] {
    return this.lastProviderNames
  }

  private readonly repoRoot: string
  private readonly workspaceRegistry: WorkspaceRegistryLike | null
  private goalsService: GoalServiceLike | null
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
    agent?: AgentLike | null
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
   * PHASE 0 — read a run's start approval from its own Phase 0 artifact.
   *
   * The approval is a DURABLE line in `.recursive/run/<runId>/00-requirements.md`, not a value held in
   * memory, for the reason every other gate here is durable: a decision that only exists in a session
   * cannot be cited, and cannot survive the session it was made in. Read-only; asking changes nothing.
   */
  readRunStartApproval(root: string, runId: string): { approved: boolean; artifact: string; reason: string } {
    return readRunStartApproval(root, runId)
  }

  /**
   * PHASE 0 — the harness's blocking human-question channel (`ctx.userQuestions`), when this composition
   * mounts one.
   *
   * ⚠ WHY THE PLUGIN REACHES FOR THIS AT ALL. The other three gates answer through a question card and a
   * relayed label, which is fine for a decision the workflow acts on later. STARTING A RUN is different:
   * the first human turn is the only place the harness can say "arming this goal means autonomous rounds"
   * BEFORE arming it. This channel is the same one plan-mode's exit uses; `ask()` resolves only with a
   * real answer from a real person, and it THROWS when there is no answerer or no live root agent. So the
   * absence of this service cannot be papered over: `recursive_ask` refuses the run-start gate and names
   * the missing channel (RM5502).
   */
  private userQuestions: UserQuestionsLike | null = null

  /** Late-bind the human-question channel when the composition mounts it. */
  attachUserQuestions(service: UserQuestionsLike | null): void {
    this.userQuestions = service
  }

  /** The human-question channel this composition mounted, or null. */
  get userQuestionsChannel(): UserQuestionsLike | null {
    return this.userQuestions
  }

  /**
   * T1 (goals projection): project the run into the native goals service so it is
   * a first-class durable, resumable, blockable object. Best-effort — the run's
   * filesystem state is the source of truth; a goal is the durable projection.
   *
   * ⚠ PHASE 0 — AND IT ARMS NOTHING UNLESS THE RUN WAS STARTED. `create` returns an ARMED goal, and an
   * armed goal is the harness driving autonomous rounds, so this is the one place where "project the
   * state" can quietly equal "start the run". The approval is therefore REQUIRED from the caller and
   * has no default here: a caller that has not resolved the run's approval cannot arm a goal by
   * forgetting to pass one, and `syncRunGoal` refuses every branch that would create one without it.
   *
   * Unapproved is the EXPECTED state for a scaffolded run, so the refusal comes back as a plain
   * `{ ok: false }` carrying {@link RUN_START_NOT_APPROVED}: callers must treat that as normal work,
   * never as a warning (see `armRunGoalIfApproved`, the one caller that arms).
   */
  projectRunToGoal(agent: AgentLike | null | undefined, runId: string, state: Parameters<typeof syncRunGoal>[3] = 'active', approved = false): SyncResult {
    if (!agent) return { ok: false, reason: 'no agent' }
    return syncRunGoal(this.goalsService, agent, runId, state, approved)
  }

  /**
   * PHASE 0 — the approved-run arm step: read the run's approval from `root` and project the goal only
   * if it is there. This is the phase-progress path (`syncRunGoal` reached on ordinary work), so the
   * unapproved case is deliberately silent: `{ ok: false, reason: RUN_START_NOT_APPROVED }` with no
   * goal, no write and no throw. Read on EVERY call rather than cached, because the approval can arrive
   * mid-session and a cached "not yet" would leave an approved run unable to arm until a plugin reload.
   */
  armRunGoalIfApproved(agent: AgentLike | null | undefined, root: string, runId: string, state: Parameters<typeof syncRunGoal>[3] = 'active'): SyncResult {
    if (!agent) return { ok: false, reason: 'no agent' }
    const approval = this.readRunStartApproval(root, runId)
    return syncRunGoal(this.goalsService, agent, runId, state, approval.approved)
  }

  /** T1: block the run's goal on a gate-block (durable + UI-visible). */
  blockRunToGoal(agent: AgentLike | null | undefined, runId: string, reason: { code: string; message: string }): SyncResult {
    if (!agent) return { ok: false, reason: 'no agent' }
    return blockRunGoal(this.goalsService, agent, runId, reason)
  }

  /**
   * T1: re-arm the run's goal on a reopen (blocked/paused -> active). Never starts an unstarted run —
   * REOPEN IS NOT A BACK DOOR TO STARTING A RUN. `approved` is required for the same reason as in
   * `projectRunToGoal`: the phase-0 gate cannot be defaulted open. An approved run's approval outlives
   * a reopen because it is a durable line in the run's own Phase 0 artifact, not a held value.
   */
  resumeRunToGoal(agent: AgentLike | null | undefined, runId: string, approved = false): SyncResult {
    if (!agent) return { ok: false, reason: 'no agent' }
    return resumeRunGoal(this.goalsService, agent, runId, approved)
  }

  /**
   * Workspace-scoped control-plane root (R1 binding invariant).
   * Resolves the session agent's canonical cwd -> workspace path via the
   * registry; NEVER scans list(). Returns null when unavailable (defer).
   */
  async resolveWorkspaceRoot(agent?: AgentLike | null): Promise<string | null> {
    return resolveControlPlaneRoot(agent, this.workspaceRegistry)
  }

  /**
   * Run-scoped closeout receipt scaffold (R2), rooted under the given
   * workspace root. Refuses runIds outside the root (never crosses workspaces).
   */
  async closeoutRun(root: string, runId: string, phase: string, agent?: AgentLike | null) {
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
              // T40 - WRITER/READER AGREEMENT. The shards this trigger writes are memory-plane docs, so they
              // belong under .recursive/memory/ where the plane lint, the registry and the phase-8 artifact all
              // look - the seam previously joined them onto the workspace root, landing them OUTSIDE the plane.
              const target = join(root, '.recursive', relativePath)
              mkdirSync(dirname(target), { recursive: true })
              writeFileSync(target, content, 'utf8')
              return relativePath
            },
            readText: (relativePath) => {
              try {
                return readFileSync(join(root, '.recursive', relativePath), 'utf8')
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
    /**
     * ⚠ T36 — THE ID TO RESUME, WHEN A CONTINUABLE CHILD ALREADY EXISTS.
     *
     * `childId` above is a RESERVED IDENTITY for a child about to be created. On a retry the child
     * already exists, and passing its id as a creation id makes the host answer
     * `subagent "<id>" already exists` — a DUPLICATE_CHILD that no retry can ever get past. MEASURED
     * live: both a same-session retry and a later process returned that error, so a parked review
     * could never progress.
     *
     * `delegateContinuable` resumes only when it receives `resumeChild`, so this field is the one
     * that carries the distinction. Absent → create (the original behaviour, unchanged).
     */
    resumeChild?: string
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
    /**
     * ⚠ G2 — THE ROSTER SEAM FOR THIS CALL. Absent, the runtime's attached `ctx.agentTeams` is used; absent both,
     * the delegation runs on the `subagents` path exactly as it always has. Present AND a Lead caller, the child is
     * a rostered teammate (see `src/teammate.ts` for the gate and the protocol).
     */
    teams?: TeammateRosterLike
    maxDepth?: number
    toolFilter?: unknown
    /**
     * ⚠ FU-17 — THE BRIEF SLICE, WHEN THE CALLER OWNS IT.
     *
     * A review's slice is written here because a reviewer's briefing is review-shaped by definition. A WORK
     * delegation needs the opposite kind of briefing — what to produce and the standard it will be linted
     * against — and that is computed by `buildWorkSlice` from the phase rules. This seam lets a work caller pass
     * it in without this method growing a second, drifting copy of the phase standard.
     *
     * ADDITIVE BY CONSTRUCTION: absent, the review slice below is built exactly as it always was, which is what
     * keeps the review path's behaviour provable rather than merely claimed.
     */
    slice?: string
    /**
     * ⚠ FU-17 — whether this delegation is WORK or a REVIEW. It changes two things and nothing else: the slice
     * (when `slice` is passed) and the `Purpose` line of the action record, so a reader of the run can tell a
     * child that produced something from a child that judged something.
     */
    kind?: 'review' | 'work'
    /**
     * T35: which child lifecycle to use. DEFAULT `continuable` — a one-shot
     * child cannot be resumed, so one-shot forfeits the repair path and must be
     * requested explicitly by a caller that will discard the result.
     */
    /**
     * ⚠ FU-18 — IS THIS ROUND A CONTINUATION OF AN OPEN DELEGATION RATHER THAN A FRESH ONE?
     *
     * Set by a caller that is resuming the same child to deliver FEEDBACK. It is the difference between "run this
     * operation again", which the T19 guard exists to refuse, and "carry on with the operation that is already
     * open", which the guard must not refuse — see the guard below for why the obvious alternative is worse.
     */
    continuing?: boolean
    /**
     * ⚠ FU-19 — A PER-CALL CHOICE, which is what "change them on demand" means. Both win over every configured
     * level, and both are optional: absent means "resolve the ladder", NOT "clear".
     */
    providerOverride?: string | null
    modelOverride?: string | null
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
    // ⚠ G2/G3 — THE BRIEF AND THE PROMPT ARE BUILT **AFTER** THE CHILD EXISTS WHEN THE CHILD IS A TEAMMATE.
    //
    // The two paths need different orders, and the difference is forced by the roster, not chosen:
    //   • the primitive path reserves the child id up front (`input.childId`) and `startContinuable` HONOURS it, so
    //     the brief, the reply path and the start request can all agree BEFORE the call — which is exactly what
    //     this code has always done, and it stays byte-for-byte that;
    //   • `SpawnTeammateRequest` has NO `childId` (`roster.ts` generates one), and the reply path embeds the id
    //     (`subagents/<delegationId>/child-<childId>/`). So the roster dispatch is TWO STEPS: spawn, learn
    //     `member.id`, THEN write the brief/reply tree and deliver the instructions by `sendMessage`.
    // Keeping ONE builder means the brief cannot differ between the paths; only WHEN it runs differs.
    const teams: TeammateRosterLike | undefined = input.teams ?? this.teamsSeam ?? undefined
    // The loop's own prerequisites. If any is missing `delegateContinuable` will REFUSE, so a roster child must not
    // be spawned first — a teammate created for a round that cannot observe it would be a child nobody can use.
    const continuablePrereqs = subagents !== undefined && input.parent !== undefined && input.awaitRoundResult !== undefined
    // ⚠ THE GATE, AND THE ONE-SHOT EXCEPTION. The roster has no one-shot mode (`spawnTeammate` always creates a
    // continuable child), and T35 makes one-shot an EXPLICIT ask — so an explicit `mode: 'one-shot'` keeps the
    // primitive path rather than being silently upgraded to a teammate. Every OTHER delegated child is rostered.
    const rosterEligible = input.mode !== 'one-shot' && continuablePrereqs && canRosterDispatch(teams, input.parent)
    const teammateName = rosterEligible ? teammateNameFor(input.runId, input.delegationId, input.role) : ''
    const runDir = input.root === '' ? '' : join(input.root, '.recursive', 'run', input.runId)
    let briefPath = ''
    let prompt = ''
    /** Write the child's brief + prompt for a KNOWN child id; returns the prompt. */
    const writeBriefAndPrompt = (childId: string): string => {
      briefPath = createChildBrief({
        root: input.root,
        runId: input.runId,
        delegationId: input.delegationId,
        childId,
        // ⚠ FU-17 — `input.slice` wins when a work caller supplies one; otherwise this is byte-for-byte the review
        // slice it has always been. A work brief cannot be built here without a second copy of the phase standard.
        slice: input.slice ?? 'Perform the delegated ' + input.role + ' for run ' + input.runId + ' (' + input.phase + ') and write your submission to reply.md.',
      })
      prompt = buildDelegationPrompt({
        root: input.root,
        runId: input.runId,
        delegationId: input.delegationId,
        childId,
        handoffPath,
        briefPath,
      })
      return prompt
    }
    // The primitive path builds both now, from the reserved id — the original behaviour, unchanged.
    if (!rosterEligible) writeBriefAndPrompt(input.childId)

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
      // ⚠ THIS REQUEST FEEDS THE EXPLICIT `mode: 'one-shot'` PATH, AND IT NEEDED A SIGNAL TOO.
      // `subagents.start` forwards the request verbatim and the in-process driver reads
      // `request.signal.aborted` BARE (packages/subagent/subagent-in-process-driver/src/index.ts:109),
      // so an absent signal throws `Cannot read properties of undefined (reading 'aborted')` before
      // any child starts. The continuable spec already carried one and the (now-removed) silent
      // fallback was fixed for the same reason — this is the third and last place the plugin builds
      // a start request, and T35 keeps this path alive for callers that explicitly ask for one-shot.
      signal: new AbortController().signal,
    }
    if (input.parent !== undefined) request.parent = input.parent

    // ⚠ FU-19 — THE PROVIDER/MODEL LADDER, APPLIED WHERE THE PROVIDER SAYS IT CAN BE.
    //
    // The ladder (per-call → phase → role → general default) is resolved by `resolveSubagentTarget`, which also
    // reports WHICH LEVEL chose each value — so "why did this child run on that model" is answerable from the
    // decision rather than by reading this code. `modelForRole` was the single-level version of this and is gone.
    //
    // ⚠ THE CAPABILITY GATE STAYS AUTHORITATIVE, unchanged: the harness REJECTS a start that sends `agentOptions`
    // to a provider without the `agentOptions` capability, so gating on the model alone would BREAK delegations on
    // providers that do not accept overrides — a routing feature that takes down the delegation it was meant to
    // improve. A choice that cannot be honoured is REPORTED, never silently dropped.
    const target = resolveSubagentTarget({
      role: input.role,
      phase: input.phase,
      policy,
      ...(input.providerOverride === undefined && input.modelOverride === undefined
        ? {}
        : { override: { provider: input.providerOverride ?? null, model: input.modelOverride ?? null } }),
      ladderProvider: decision.provider ?? null,
    })
    if (target.provider !== null && target.provider !== decision.provider) {
      // The user named a provider. The router still says WHICH TIER it resolved, but the name used to create the
      // child is the user's — and the note states both rather than leaving two answers in the record.
      routingNotes.push(
        'provider ' + target.provider + ' chosen from ' + target.chosen.provider
        + ' (the router tier resolved as ' + decision.tier + ')',
      )
    }
    if (target.model !== null) {
      const chosenProvider = target.provider ?? decision.provider ?? ''
      const capable = providers[chosenProvider]?.capabilities?.agentOptions === true
      // ⚠ FU-19 — THE CHOICE IS CHECKED AGAINST WHAT DSH ACTUALLY HAS, and the three-state verdict decides what
      // happens next. `missing` means the inventory ANSWERED and does not have this model: it is NOT applied, and
      // crucially NO OTHER MODEL IS SUBSTITUTED — the child inherits the session default and the note says so.
      // `unverified` (no inventory to ask) still applies the model, because refusing on the strength of a service
      // that merely was not mounted would refuse something the user asked for on no evidence.
      const check = checkModelChoice(await describeInventory(this.llmInventory), target.model)
      if (check.verdict === 'missing') {
        routingNotes.push(
          'model ' + target.model + ' was chosen (from ' + target.chosen.model + '), but ' + check.reason
          + ' — it was NOT applied and no other model was substituted, so the child inherits the session default',
        )
      } else if (!capable) {
        routingNotes.push(
          'model ' + target.model + ' was chosen (from ' + target.chosen.model + '), but provider '
          + (chosenProvider || '(none)') + ' does not declare the agentOptions capability, so the model was NOT applied',
        )
      } else {
        request.agentOptions = { model: target.model }
        routingNotes.push('model ' + target.model + ' applied (from ' + target.chosen.model + '); inventory says: ' + check.reason)
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
    /**
     * ⚠ G2 — THE ROSTER CHILD THIS ROUND TALKS TO, once it is known. `childId` is the member id the roster
     * generated (the request can never carry one), and `name` is the only handle the roster's follow-up accepts.
     */
    let rosterChild: { name: string; childId: string } | null = null
    /**
     * ⚠ G3 — THE NAMED ROSTER REFUSAL, when a roster dispatch was attempted and failed. It is a string rather than
     * an exception because the run still has to RECORD the attempt: the action record and the operation log are
     * written for a refusal too, and a refusal that fell back to an unrecorded child would be the exact defect the
     * provenance gate exists to catch. NEVER set on the primitive path.
     */
    let rosterFailure: string | null = null
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
    // ⚠ FU-18 — A CONTINUATION IS NOT A REPEAT, and the distinction has to live HERE rather than in the operation
    // id. The tempting fix is to fold the round into the id so a feedback round becomes a different operation,
    // and it is the wrong one: T28's children budget below counts DISTINCT OPERATIONS and its own comment says a
    // resumed turn "re-enters here with the same id and must not be counted as another child". Making a
    // continuation a new identity would fix this refusal and silently miscount the budget instead.
    //
    // The collision it resolves: the T19 guard refuses an operation already accepted against an UNCHANGED
    // artifact, which is right in general — re-reviewing an artifact nothing has touched since it passed wastes a
    // child. But when the main agent sends FEEDBACK, the artifact has not changed YET: the child has not repaired
    // it. So the guard refused exactly the call that starts the repair. A continuation is the operation still
    // running, so it is exempt; a genuinely fresh delegation against an unchanged artifact is still refused.
    if (prior?.outcome === 'accepted' && input.continuing !== true) {
      throw new Error(
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

    // ⚠ G2/G3 — THE ROSTER DISPATCH, BEFORE ANY CHILD IS DISPATCHED AND BEFORE THE TIER BRANCH DECIDES ANYTHING.
    //
    // WHY HERE. The two-step protocol has to run BEFORE the round loop (the loop needs the child id), and it must
    // NOT run when the router resolved to self-audit or when the continuable loop would refuse — a teammate spawned
    // for a round that cannot observe it is a child nobody can use. So it is gated on exactly the conditions under
    // which a child will really be dispatched:
    //   (a) the roster seam exists and the LIVE caller is its Lead (`canRosterDispatch`),
    //   (b) the tier is going to dispatch a child (`native`/`external-cli`), and it is not an explicit one-shot,
    //   (c) the continuable loop's prerequisites are present.
    //
    // THE SEQUENCE, and each step is a property a test asserts:
    //   1. RESOLVE the child id — reuse the delegation's existing teammate (durable registry first, then the live
    //      roster under the deterministic name), and SPAWN only when neither knows it. Names are never reusable, so
    //      spawning per round would fail on the second one;
    //   2. SPAWN (two-step) with a HOLD prompt, learn `member.id` (the request cannot carry one), write
    //      `subagents/<delegationId>/child-<member.id>/brief.md`, then deliver the real brief/prompt with
    //      `agentTeams.sendMessage`;
    //   3. hand that id to the round loop as a RESUME with the roster's repair seam, so `startContinuable` is never
    //      called for a teammate and a REVISE returns to the SAME teammate BY NAME.
    // A refusal leaves `rosterFailure` set and NO child; the dispatch branch then does not run at all. It NEVER
    // falls back to `startContinuable` — an unrecorded child is the exact defect this change removes.
    let resumeChild = input.resumeChild === undefined ? undefined : input.resumeChild as ContinuableChildId
    let rosterFollowup: FollowupSeam | undefined
    if (
      rosterEligible
      && teams !== undefined
      && subagents !== undefined
      && (decision.tier === 'native' || decision.tier === 'external-cli')
    ) {
      const prepared = await this.prepareTeammateChild({
        teams,
        runId: input.runId,
        root: input.root,
        delegationId: input.delegationId,
        role: input.role,
        name: teammateName,
        provider: (target.provider ?? decision.provider ?? '') as string,
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        ...(input.resumeChild === undefined ? {} : { resumeChild: input.resumeChild }),
        // On a RESUME the caller's driver delivers the follow-up (or already did) — exactly as the primitive path
        // assumes — so this must not send anything. A fresh round must OPEN the round with the prompt.
        deliver: input.resumeChild === undefined,
        writeBriefAndPrompt,
      })
      if (prepared.ok) {
        routingNotes.push(...prepared.notes)
        // ⚠ A LEGACY CHILD KEEPS ITS SURFACE: on a resume of a child the roster does not know, `legacy` is set, no
        // teammate is claimed, and the loop keeps the primitive follow-up seam. Nothing is created either way.
        if (prepared.legacy !== true) {
          rosterChild = { name: prepared.name, childId: prepared.childId }
          resumeChild = prepared.childId as ContinuableChildId
          rosterFollowup = prepared.followup
          // The one-shot `request` is not used for a teammate, but this method reports it — keep it coherent rather
          // than handing a caller a request whose prompt is the empty string the deferred builder started with.
          request.prompt = [{ type: 'text', text: prompt }]
          // ⚠ WHAT DOES NOT TRAVEL THROUGH THE ROSTER, SAID RATHER THAN LEFT TO BE DISCOVERED. A teammate IS a real
          // continuable child, but `SpawnTeammateRequest` carries only name, description, prompt, context, provider
          // and signal (`agent-team/src/types.ts`) — no toolFilter, no maxDepth, no agentOptions. So a roster child
          // runs with the composition's default toolset and model: the reviewer's read-only filter and the routed
          // model are NOT applied to it. Both are reported, so no reader infers either from the record.
          if (input.toolFilter !== undefined || decision.tier === 'native') {
            routingNotes.push(
              'this child is the rostered teammate "' + rosterChild.name + '": the delegation toolFilter was NOT '
              + 'applied, because SpawnTeammateRequest has no such field — the composition\'s default tools apply',
            )
          }
          if (request.agentOptions !== undefined) {
            routingNotes.push(
              'model ' + String(request.agentOptions.model) + ' was NOT applied to teammate "' + rosterChild.name
              + '": SpawnTeammateRequest carries no agentOptions, so the composition\'s model applies',
            )
          }
        }
      } else {
        rosterFailure = prepared.message
        error = rosterFailure
      }
    }

    if (rosterFailure !== null) {
      // A roster dispatch was REQUIRED and failed. Nothing is dispatched in its place: a fallback child would be
      // unrecorded, so the operation log would claim a dispatch no roster member answers — refused by the
      // provenance gate, and dishonest even where it is not. `error` already carries the named sentence.
    } else if (decision.tier === 'native' || decision.tier === 'external-cli') {
      if (!subagents) {
        error = 'no ctx.subagents runtime available (self-audit fallback)'
      } else if (input.mode !== 'one-shot') {
        // T35: continuable BY DEFAULT — only an explicit 'one-shot' opts out of
        // the repair path, because a one-shot child cannot be resumed.
        //
        // ⚠ G2 — THE ROSTER CHILD WAS PREPARED ABOVE (spawn-or-reuse, brief, delivery), and this loop RESUMES it:
        // `resumeChild` is set on that path, so `startContinuable` is never called for a teammate, and the repair
        // seam is the roster's. On the primitive path both are exactly what they always were.
        continuable = await delegateContinuable({
          subagents,
          provider: (target.provider ?? decision.provider ?? '') as string,
          label: input.delegationId + '/' + (rosterChild?.childId ?? input.childId),
          prompt,
          childId: input.childId,
          // ⚠ T36 — A RETRY MUST RESUME, NOT RE-CREATE. `childId` above reserves an identity for a
          // child that does not exist yet; when the caller says a child already exists, its id must
          // travel as `resumeChild` instead, or the host refuses with `subagent "<id>" already exists`
          // and every retry of a parked review fails the same way.
          //
          // ⚠ AND ON THE ROSTER PATH THIS IS THE TARGET AS WELL: the child is already a teammate, so the loop
          // must RESUME it — that is what keeps `startContinuable` off this path entirely.
          ...(resumeChild === undefined ? {} : { resumeChild }),
          // ⚠ G2 — THE REPAIR GOES BACK THROUGH THE ROSTER. `delegateContinuable` sends every REVISE through this
          // seam, so a repair reaches the SAME teammate BY NAME instead of by the child id the primitive uses.
          ...(rosterFollowup === undefined ? {} : { followup: rosterFollowup }),
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
              // ⚠ THE OWNER THE REGISTRY REQUIRES, taken from the EXACT LIVE PARENT AGENT this call already
              // carries. `input.parent` is the handle `recursive_review`/`recursive_delegate` build from
              // `exec.agent`, and `SubagentParentHandle.id` is documented as its session id, so no new
              // plumbing is needed to answer the registry's `agents.get(spec.owner)` lookup.
              //
              // ⚠ AND THIS CALL SITE CANNOT ALWAYS ANSWER IT, which is stated rather than papered over:
              // `parent` is OPTIONAL on this input (`runtime.ts` :731), and a caller that omits it — a
              // workflow-engine or hand-built call — leaves the owner undefined, so the registry falls back
              // to the pre-fix behaviour (global layer, refusal, degraded inline). Passing a plausible
              // substitute would be worse: an id with no live agent throws from `resolveOwner` instead.
              owner: agentOwner(input.parent),
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
                if (signal?.aborted === true) onAbort()
                else signal?.addEventListener('abort', onAbort, { once: true })

                try {
                  // ⚠ FU-9 — THE `?.` IS THE FIX FOR THE WHOLE INVESTIGATION. `signal` is typed as an
                  // `AbortSignal` but a caller can reach here with nothing, and `signal.aborted` on undefined
                  // throws `Cannot read properties of undefined (reading 'aborted')` — which the delegation's
                  // catch recorded as its reason, the driver misread as "no continuable repair path", and which
                  // therefore meant THE CHILD NEVER STARTED. Every artifact this investigation chased — no child
                  // session, no reply, no settlement, four brief-only child directories — was downstream of this
                  // one unguarded property read. An absent signal means "nobody can cancel this", not "crash".
                  if (signal?.aborted === true) throw new Error('the round was cancelled before it was awaited')
                  return await input.awaitRoundResult!(childId, messageId)
                } finally {
                  signal?.removeEventListener('abort', onAbort)
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
        } else if (continuable.refused === 'continuable-unavailable') {
          // ⚠ THE REFUSAL REPLACED A SILENT ONE-SHOT FALLBACK. There is no one-shot result to keep:
          // the delegation declined to dispatch at all, because T35 requires a continuable child and
          // a one-shot child cannot be repaired. Surfacing the refusal as the error is the honest
          // report — the previous branch said "the seam has no continuable capability" and kept a
          // one-shot result the caller had not asked for.
          error = continuable.reason ?? 'the delegation refused: the continuable seam is unavailable'
        } else if (continuable.ok && continuable.rounds.length > 0) {
          result = continuable.rounds[continuable.rounds.length - 1].result ?? null
          if (!result) error = 'continuable child produced no final result'
        } else {
          // ⚠ A ROUND THAT SETTLED IS A RESULT, EVEN WHEN IT WAS NOT ACCEPTED — and this branch used to
          // discard it. The condition above requires `continuable.ok`, so a child that REPORTED and was
          // refused (`success: false`, or a non-completed stop reason) fell through to here: `result` stayed
          // null, the action record said "NO SETTLEMENT arrived within the wait", and the child's own stop
          // reason — the one fact that explains the refusal — was dropped on the floor. It is the same defect
          // as the parked one, one branch over: an absence asserted where the code had evidence. Keeping the
          // result is what lets the record say "the delegation returned without acceptance; stop reason error"
          // instead of blaming a wait that ended perfectly well.
          result = continuable.rounds[continuable.rounds.length - 1]?.result ?? null
          if (result === null) error = continuable.reason ?? 'continuable delegation failed'
        }
      } else {
        try {
          result = await delegate({
            subagents,
            provider: (target.provider ?? decision.provider ?? '') as string,
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

    /**
     * ⚠ G2 — THE CHILD THIS DELEGATION ACTUALLY TALKED TO, and every record below must name THIS id.
     *
     * On the primitive path it is the reserved `input.childId` — the host honours a reserved id, so this is the
     * same string the old code used and the records are byte-identical. On the roster path the reserved id never
     * became a child: `SpawnTeammateRequest` has no `childId`, so the roster generated `member.id`, and the reply
     * tree was written under `child-<member.id>/`. If the operation line and the action record kept naming the
     * reserved id, the provenance gate would resolve `child-<member.id>` from the cited reply path and find no
     * dispatch of it — refusing a phase this plugin really did dispatch.
     */
    const actualChildId = continuable?.childId ?? rosterChild?.childId ?? input.childId

    // T19 — persist the attempt so a RESTART can match it. Only an accepted review is
    // recorded as `accepted`, which is what makes the recognition above block a
    // genuine repeat while leaving every failure path retryable. Best-effort: a
    // failed index write must never change the outcome of a review that already ran.
    if (operationsDir !== '') {
      recordOperation(operationsDir, {
        id: operation,
        act: 'delegate-review',
        at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        // ⚠ A PARK IS NOT A REFUSAL, and `unaccepted` said it was. This line used to be
        // `accepted ? 'accepted' : 'unaccepted'`, so a round that had merely not settled yet was indexed
        // exactly like a delegation that was evaluated and refused — while the round it really was (still in
        // flight, resume the same child) was nowhere in the run's own operation log. The defect the action
        // record had, the log had too. The new value is honest on both readings that matter: it is not
        // `accepted`, so every retry gate still treats the operation as unfinished and retryable — which is
        // what a parked round is — and it no longer claims the delegation was judged and rejected.
        outcome: parked ? 'parked' : (evaluation.accepted ? 'accepted' : 'unaccepted'),
        phase: input.phase,
        // ⚠ WHAT THIS RECORD IS FOR, beyond the T19 repeat guard: it is the run's own answer to "did this run
        // dispatch this delegation?". The id alone cannot answer it — it is a hash over the inputs, so a
        // reader cannot recover the delegation from it — and until these two fields existed, a phase could
        // cite a hand-written action record and lock, because the gate had nothing to match the citation
        // against. Recorded for EVERY outcome, including a park and a refusal: the gate asks whether the
        // plugin dispatched this delegation, not whether the dispatch succeeded.
        delegationId: input.delegationId,
        // ⚠ G2 — THE LEARNED CHILD, not the reserved one (see `actualChildId`): a roster teammate's id is the only
        // one any citation of its reply can name, and this line is what the provenance gate matches against.
        childId: actualChildId,
      })
    }

    // R6: record the attempt as an action record (accepted only if evaluation passes).
    const actionRecordPath = writeActionRecord({
      root: input.root,
      runId: input.runId,
      // ⚠ G2 — the same learned id as the operation line above, for the same reason: the record's `Subagent ID`
      // and the run's dispatch line must agree, whichever path created the child.
      subagentId: actualChildId,
      // ⚠ THE RECORD SAYS WHICH DELEGATION PRODUCED IT, which is what lets the delegation gate reconcile a
      // citation in `## Subagent Contribution Verification` against the run's own operation index. Without it,
      // the record is only a well-formed document in a directory the linter already trusts — the exact gap a
      // live run walked through with six hand-written records.
      delegationId: input.delegationId,
      phase: input.phase,
      // ⚠ FU-17 — the kind is stated in the record. `Status` says accepted, failed or parked; nothing said whether
      // the child PRODUCED the phase's work or JUDGED it, and a reader of a run could not tell the two apart.
      purpose: input.role + (input.kind === 'work' ? ' (work)' : '') + ' for run ' + input.runId,
      // ⚠ G2 — A READER MUST BE ABLE TO TELL A ROSTER DISPATCH FROM A RAW ONE. Both are "continuable", and the
      // roster name is the only handle a follow-up can use, so it is stated inside the same parenthetical. Absent
      // on the primitive path, where the record is exactly the record it always was.
      executionMode: decision.tier
        + (input.mode !== 'one-shot'
          ? ' (continuable' + (rosterChild === null ? '' : ', team ' + rosterChild.name) + ')'
          : ''),
      artifactPath: input.artifactPath,
      upstreamArtifacts: input.upstreamArtifacts,
      reviewBundle: bundle.repoRelativePath,
      diffBasis: input.diffBasis?.normalizedDiffCommand,
      codeRefs: input.codeRefs,
      auditQuestions: input.auditQuestions,
      findings: evaluation.accepted && result?.structured ? [(result.structured as { verdict?: string })?.verdict ?? 'accepted'] : undefined,
      success: evaluation.accepted,
      stopReason: result?.stopReason,
      // ⚠ A PARKED ROUND IS RECORDED AS PARKED — the whole defect in one field. `success: evaluation.accepted`
      // is false for a park (correct: nothing was accepted), and `writeActionRecord` reads this flag to state
      // the third state instead of collapsing it into `failed`.
      ...(parked ? { parked: true } : {}),
      // ⚠ FU-9 — AND SAY WHICH KIND OF FAILURE, because the record previously could not. `result == null` means
      // the provider never produced anything at all (never started, or returned nothing) — which is what the
      // live record's `Stop Reason: n/a` was quietly telling me — while a present result that failed to be
      // accepted means a child DID run and its work was refused. Different problems, identical artifacts.
      //
      // ⚠ AND `parked` IS BRANCHED FIRST. A parked round produced NO result at all — that IS what parking
      // means — so without this branch first it fell into the `result == null` text below: "the continuable
      // start was made and NO SETTLEMENT arrived within the wait (the child never reported, or never ran)".
      // That is the exact false conclusion this fix exists for, and it was reached whatever the record's
      // Status said. Order is therefore load-bearing here.
      // ⚠ G2/G3 — A NAMED ROSTER REFUSAL IS ITS OWN FAILURE, and it must not wear the "no settlement arrived"
      // sentence below: NO child was started, so that text would be a false conclusion drawn from a path the call
      // never took. Branching it FIRST keeps every other path's text byte-identical, because `rosterFailure` is null
      // unless a roster dispatch was actually attempted.
      failure: evaluation.accepted
        ? undefined
        : rosterFailure !== null
          ? rosterFailure
          : parked
          // ⚠ WHAT IS KNOWN, AND ONLY WHAT IS KNOWN, WITH THE ID THE READER NEEDS TO ACT.
          //
          // The text this replaces said "the child never reported, or never ran" — a CONCLUSION drawn from an
          // ABSENCE, and it was false: a live child went on to complete three review rounds and reply eighteen
          // minutes later, while the main agent read `Status: failed`, concluded the child was dead, and
          // obtained its review by other means. So the parked message asserts nothing about the child's state
          // beyond "no settlement had landed when the wait ended", keeps "may still be working" as the
          // possibility it is, and NAMES the childId plus the exact next step, because advice to resume is
          // unactionable without the id. The identity diagnostics stay, because they are what makes a
          // misconfigured provider readable — but they are diagnostics, not the reason.
          ? 'no settlement had landed when the wait ended, so this round is PARKED, not failed: nothing was'
            + ' accepted and nothing was refused, and the child may still be working. The next step is to RESUME'
            + ' this round, not to re-dispatch it or replace the child: call `recursive_review` again on a later'
            + ' turn with childId ' + String(continuable?.childId ?? input.childId) + ' (the child the round was'
            + ' started for, which stays resumable). Diagnostics: tier ' + decision.tier
            + ', provider ' + (decision.provider ?? 'none chosen')
            + ', names on offer [' + (this.lastProviderNames.join(', ') || 'none') + ']'
            // ⚠ FU-9 — THE PARENT IDENTITY, because the host refuses a prompt when it cannot resolve the
            // parent session as a live Agent (`subagent/parent-unavailable`, index.ts L429-436), and the tool
            // builds this handle with a CAST (`exec.agent as unknown as SubagentParentHandle`). A cast is not
            // a contract: if the id here is not the one the host looks up, the refusal is real and the
            // classifier's crash has been hiding it. Printing it here costs nothing and settles the question.
            + '; parent id ' + ((input.parent as { id?: string } | undefined)?.id ?? 'none')
            + ', parent session keys [' + (input.parent === undefined ? 'no parent' : Object.keys(input.parent as object).join(', ')) + ']'
          : result == null
            // ⚠ THE TWO STATES ARE NOT THE SAME AND THE MESSAGE USED TO CONFLATE THEM. The one-shot path cannot
            // resolve to nothing — the host's `start` returns a run or throws (assertCapabilities, expectProvider)
            // — so a null result on the CONTINUABLE path means the opposite of what I first wrote: the start WAS
            // made and NO SETTLEMENT ARRIVED within the wait. That distinction cost me two rounds of looking at
            // provider names, so the record now states which path a run took and what it was waiting for.
            // (A park is handled above and never reaches this branch; this one is a continuable round that
            // produced neither a result nor the park signal, which IS a failure to report.)
            ? (input.mode !== 'one-shot'
              ? 'the continuable start was made and NO SETTLEMENT arrived within the wait (the child never reported,'
                + ' or never ran); tier ' + decision.tier + ', provider ' + (decision.provider ?? 'none chosen')
                + ', names on offer [' + (this.lastProviderNames.join(', ') || 'none') + ']'
                // ⚠ FU-9 — THE PARENT IDENTITY, because the host refuses a prompt when it cannot resolve the
                // parent session as a live Agent (`subagent/parent-unavailable`, index.ts L429-436), and the tool
                // builds this handle with a CAST (`exec.agent as unknown as SubagentParentHandle`). A cast is not
                // a contract: if the id here is not the one the host looks up, the refusal is real and the
                // classifier's crash has been hiding it. Printing it here costs nothing and settles the question.
                + '; parent id ' + ((input.parent as { id?: string } | undefined)?.id ?? 'none')
                + ', parent session keys [' + (input.parent === undefined ? 'no parent' : Object.keys(input.parent as object).join(', ')) + ']'
              : 'no delegate result was produced by the one-shot path; tier ' + decision.tier
                + ', provider ' + (decision.provider ?? 'none chosen'))
            : 'the delegation returned without acceptance; stop reason ' + (result.stopReason ?? 'none reported')
              + (result.success === false ? ' (the child itself reported success:false)' : ''),
    })

    // T35: report the mode that ACTUALLY ran, not the one that was asked for. When the continuable
    // capability is missing the delegation now REFUSES rather than degrading, so
    // `continuable-unavailable` means "no delegation ran at all" — not "one ran without repairs".
    const delegationMode: 'continuable' | 'one-shot' | 'continuable-unavailable' | 'none'
      = continuable !== null
        ? (continuable.refused === 'continuable-unavailable' ? 'continuable-unavailable' : 'continuable')
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
      // ⚠ G2 — the paths and the prompt name the child that ACTUALLY carries the round. On the primitive path that
      // is the reserved id, so these are the strings they always were.
      replyPath: replyPath({ root: input.root, runId: input.runId, delegationId: input.delegationId, childId: actualChildId }),
      childScratchPath: childScratchPath({ root: input.root, runId: input.runId, childId: actualChildId }),
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
      /**
       * ⚠ G2 — THE ROSTER CHILD THIS ROUND TALKED TO, when it was one (`{ name, childId }`), else null.
       *
       * Reported because both halves are unguessable from outside: the NAME is the only address a follow-up can
       * use, and the child id was LEARNED from the roster rather than reserved. `childId` here is also what a
       * caller must pass as `resumeChild` on the next turn.
       */
      teammate: rosterChild,
      /** T19: the deterministic id of this review, persisted so a restart can match it. */
      operationId: operation,
      /**
       * T36: true when the round has NOT settled yet, so the caller resumes with
       * `continuable.childId` on a later turn. `parkedReason` carries the loop's own
       * sentence ("the child is still working") without it being an `error`.
       */
      parked,
      parkedReason,
      continuable: continuable ? { rounds: continuable.rounds, childId: continuable.childId, refused: continuable.refused, missing: continuable.missing, parked: continuable.parked === true,
        // ⚠ FU-9 — `ok` AND `reason` TRAVEL WITH IT. The adapter that builds the review driver's view read only
        // `rounds`, `childId`, `fellBackToOneShot` and `parked`, so every failure branch's REASON — the whole
        // point of the field — was discarded one layer above the message that needed it, and `ok: false` was
        // replaced by a hardcoded `ok: true`. A driver cannot report which branch fired if the branch's own
        // name never reaches it.
        ok: continuable.ok, reason: continuable.reason } : null,
    }
  }

  /**
   * ⚠ G2/G3 — PUT A DELEGATION ON THE AGENT-TEAM ROSTER, IN TWO STEPS, AND RETURN THE HANDLE THE LOOP NEEDS.
   *
   * The protocol, in the order the constraints force:
   *   1. **RESUME** — the caller already has a child (a parked round being resumed). Its id is known, so nothing is
   *      created and nothing is sent: the round that parked already delivered whatever it needed to. The brief is
   *      rewritten (idempotent) and the (delegation, role) → name mapping is refreshed.
   *   2. **REUSE** — a fresh round for a delegation that already has a teammate. The durable registry
   *      (`subagents/teammates.json`) is authoritative; the live roster is the second source, under the SAME
   *      deterministic name. Reuse is not an optimisation: teammate names are never reusable
   *      (`TEAM_MEMBER_NAME_TAKEN`), so spawning per round would fail on the second one.
   *   3. **SPAWN** — only when neither knows the child. The first message is the HOLD prompt, because the brief
   *      cannot exist yet: its reply path embeds a child id that only the roster can generate. Once `member.id` is
   *      learned, the mapping is RECORDED FIRST (a child that exists must never become anonymous, even if the next
   *      step fails), the brief/reply tree is written under `subagents/<delegationId>/child-<member.id>/`, and the
   *      real instructions are delivered with `sendMessage`.
   *
   * RETURNS the child id plus the roster's repair seam (`sendMessage` addressed by NAME), or a NAMED failure. It
   * never falls back: a failure here means no child, and the caller reports that rather than dispatching an
   * unrecorded one.
   */
  private async prepareTeammateChild(input: {
    teams: TeammateRosterLike
    runId: string
    root: string
    delegationId: string
    role: string
    name: string
    provider: string
    parent?: SubagentParentHandle
    resumeChild?: string
    /** Deliver the round-opening prompt. False on a resume, whose follow-up the caller's driver owns. */
    deliver: boolean
    /** Write the brief + reply tree for a known child id and return the delegation prompt. */
    writeBriefAndPrompt: (childId: string) => string
  }): Promise<
    | { ok: true; name: string; childId: string; reused: boolean; followup?: FollowupSeam; notes: string[]; legacy?: true }
    | { ok: false; code: string; message: string }
  > {
    const { teams, delegationId, role, name } = input
    const caller = input.parent
    const runDir = input.root === '' ? '' : join(input.root, '.recursive', 'run', input.runId)
    const notes: string[] = []
    const record = (childId: string): void => {
      if (runDir === '') return
      try {
        recordTeammate(runDir, { delegationId, role, name, childId, at: new Date().toISOString() })
      } catch (err) {
        // A mapping that could not be written costs the NEXT round its reuse (it re-reads the live roster first),
        // so it is reported rather than swallowed — but it does not fail a dispatch that already happened.
        notes.push(
          'the teammate mapping could not be recorded in the run (' + (err instanceof Error ? err.message : String(err))
          + '), so a later round must find teammate "' + name + '" in the live roster to reuse it',
        )
      }
    }
    /**
     * The repair seam, addressed BY NAME. `delegateContinuable` calls this with the child id it knows; the roster
     * is addressed by name, so the name is captured here — one seam per child, built where the name is known.
     */
    const followup: FollowupSeam = async (_parent, _childId, content) => {
      const send = teams.sendMessage
      if (send === undefined) {
        throw new Error(describeSendFailure({ delegationId, name, error: 'the roster has no sendMessage' }).message)
      }
      try {
        const sent = await send.call(teams, caller, {
          target: name,
          content: content.map((block) => ({ type: 'text' as const, text: block.text })),
          signal: teamCallSignal(),
        })
        return sent.messageId
      } catch (err) {
        throw new Error(describeSendFailure({ delegationId, name, error: err }).message)
      }
    }

    // 1 — RESUME.
    if (input.resumeChild !== undefined) {
      const childId = input.resumeChild
      /**
       * ⚠ A RESUMED CHILD KEEPS THE SURFACE IT WAS CREATED ON. A run that parked a delegation under the PRIMITIVE
       * path (before this change, or with no roster) holds a child id that no roster knows. Following that child up
       * through `sendMessage` would address a teammate name the roster does not have, and fail — for a child that
       * exists and is perfectly repairable. So the roster is used ONLY when it can prove this child is one of its
       * own: a durable mapping for this child id, or a live roster member with the deterministic name AND that id.
       * Otherwise the delegation stays on the primitive follow-up seam, which is exactly how the child was created.
       * NOTHING is spawned either way — a resume never creates a child.
       */
      const known = runDir === '' ? null : findTeammateByChild(runDir, childId)
      const live = known === null ? liveMemberNamed(teams, caller, name) : null
      const isRosterChild = known !== null || (live !== null && live.id === childId)
      if (!isRosterChild) {
        input.writeBriefAndPrompt(childId)
        notes.push(
          'the resumed child ' + childId + ' has no record in `subagents/teammates.json` and no roster member named "'
          + name + '", so this round keeps the primitive follow-up seam it was created on; nothing was spawned',
        )
        return { ok: true, name, childId, reused: true, notes, legacy: true }
      }
      input.writeBriefAndPrompt(childId)
      record(childId)
      return { ok: true, name, childId, reused: true, followup, notes }
    }

    // 2 — REUSE: the durable mapping first, then the live roster under the same deterministic name.
    const recorded = runDir === '' ? null : findTeammate(runDir, delegationId, role)
    let childId = recorded !== null && recorded.name === name ? recorded.childId : ''
    if (childId === '') {
      const live = liveMemberNamed(teams, caller, name)
      if (live !== null) {
        childId = live.id
        notes.push(
          'reused the LIVE roster teammate "' + name + '" (' + childId + ') for delegation ' + delegationId
          + ': no durable mapping matched it, so the roster row is what this round resumes',
        )
      }
    }
    if (childId !== '') {
      const promptText = input.writeBriefAndPrompt(childId)
      if (input.deliver) {
        const send = teams.sendMessage
        if (send === undefined) {
          return { ok: false, code: 'TEAM_SEND_FAILED', message: describeSendFailure({ delegationId, name, error: 'the roster has no sendMessage' }).message }
        }
        try {
          await send.call(teams, caller, {
            target: name,
            content: [{ type: 'text', text: promptText }],
            signal: teamCallSignal(),
          })
        } catch (err) {
          return { ok: false, code: 'TEAM_SEND_FAILED', message: describeSendFailure({ delegationId, name, error: err }).message }
        }
      }
      record(childId)
      return { ok: true, name, childId, reused: true, followup, notes }
    }

    // 3 — SPAWN. A provider is required by the roster (`requiredText(request.provider, …)`), and it is resolved by
    // the router above — so an empty one is a routing gap, named rather than sent as an empty string.
    if (input.provider.trim() === '') {
      return {
        ok: false,
        code: 'TEAM_PROVIDER_MISSING',
        message: 'no subagent provider was resolved for delegation ' + delegationId + ' (role ' + role + '), so the '
          + 'agent-team roster cannot create its teammate — the roster requires a non-empty `provider`. The child was '
          + 'NOT dispatched and no unrecorded substitute was started. Enable this role in the router policy (or '
          + 'configure a provider for the phase) and call again.',
      }
    }
    const spawn = teams.spawnTeammate
    const send = teams.sendMessage
    if (spawn === undefined || send === undefined) {
      return {
        ok: false,
        code: 'TEAM_SPAWN_FAILED',
        message: 'the agent-team roster seam for delegation ' + delegationId + ' has no '
          + (spawn === undefined ? 'spawnTeammate' : 'sendMessage') + ', so no teammate could be created and no '
          + 'unrecorded substitute was started.',
      }
    }
    const description = ('recursive-mode delegation ' + delegationId + ' (role ' + role + ') for run ' + input.runId)
      .slice(0, 200)
    let learned = ''
    try {
      const spawned = await spawn.call(teams, caller, {
        name,
        description,
        // ⚠ THE HOLD PROMPT, AND IT IS NOT A PLACEHOLDER. The brief cannot be written yet — its reply path embeds the
        // child id the roster is about to generate — so the first message says exactly that and tells the child to
        // WAIT, which is what keeps its instructions coherent: it knows a brief is coming and what it will contain.
        prompt: [{ type: 'text', text: teammateHoldPrompt({ delegationId, role, name }) }],
        // `fresh` matches the plugin's whole briefing posture: the child is given files by path, not a copied
        // conversation, so a fork would add context the delegation never chose.
        context: 'fresh',
        provider: input.provider,
        signal: teamCallSignal(),
      })
      learned = typeof spawned?.member?.id === 'string' ? spawned.member.id : ''
    } catch (err) {
      const failure = describeSpawnFailure({ delegationId, role, name, provider: input.provider, error: err })
      return { ok: false, code: failure.code, message: failure.message }
    }
    if (learned === '') {
      return {
        ok: false,
        code: 'TEAM_SPAWN_FAILED',
        message: 'the agent-team roster reported teammate "' + name + '" for delegation ' + delegationId
          + ' with no member id, so its reply path cannot be written. The child may exist; inspect the roster '
          + '(listMembers) before dispatching again, and do not start an unrecorded substitute.',
      }
    }
    // ⚠ RECORDED BEFORE THE BRIEF IS WRITTEN, because the child EXISTS from this line on: if the write or the
    // delivery below fails, the next attempt must be able to find this teammate and finish the briefing rather than
    // spawning a second one under a name the roster will refuse.
    record(learned)
    let promptText = ''
    try {
      promptText = input.writeBriefAndPrompt(learned)
    } catch (err) {
      return {
        ok: false,
        code: 'TEAM_SPAWN_FAILED',
        message: 'teammate "' + name + '" (' + learned + ') was created for delegation ' + delegationId
          + ', but its brief could not be written: ' + (err instanceof Error ? err.message : String(err))
          + '. The child is recorded in `subagents/teammates.json`, so a retry resumes it; nothing was dispatched in '
          + 'its place.',
      }
    }
    try {
      await send.call(teams, caller, {
        target: name,
        content: [{ type: 'text', text: promptText }],
        signal: teamCallSignal(),
      })
    } catch (err) {
      return {
        ok: false,
        code: 'TEAM_SEND_FAILED',
        message: describeSendFailure({ delegationId, name, error: err }).message
          + ' The teammate (' + learned + ') and its brief both exist, so a retry can finish the delivery.',
      }
    }
    return { ok: true, name, childId: learned, reused: false, followup, notes }
  }

  /**
   * ⚠ G2 — DELIVER A FOLLOW-UP TO THE CHILD THAT DID THE WORK, ON WHICHEVER SURFACE OWNS IT.
   *
   * WHY THIS IS ONE METHOD AND NOT TWO CALL SITES. Both delegation tools deliver a repair themselves (the
   * round driver re-reads a reply fail-closed and can disagree with the loop, so it must be able to send the
   * instruction even when the loop believed it was approved). Those call sites used `resolveFollowupSeam` directly,
   * which addresses a child by id — and a roster teammate is addressed BY NAME. Routing the decision through one
   * place is what stops the two tools from drifting apart, and it is where the roster's own mapping is read.
   *
   * THE RULE, and it is never mixed: a child this plugin dispatched as a teammate is followed up THROUGH THE
   * ROSTER, by the name recorded for it; any other child uses the primitive follow-up seam exactly as before. A
   * failed roster send is REPORTED (named, with the child kept) rather than retried down the primitive route, so
   * the caller can tell which surface was used and the child is never abandoned silently.
   */
  async deliverRepair(input: {
    root: string
    runId: string
    delegationId: string
    childId: string
    instruction: string
    parent?: SubagentParentHandle
    subagents?: SubagentsRuntimeLike
    teams?: TeammateRosterLike
  }): Promise<{ via: 'team' | 'subagents'; target?: string }> {
    const teams = input.teams ?? this.teamsSeam ?? undefined
    const runDir = input.root === '' ? '' : join(input.root, '.recursive', 'run', input.runId)
    const roster = runDir === '' ? null : findTeammateByChild(runDir, input.childId)
    if (
      roster !== null
      && teams !== undefined
      && typeof teams.sendMessage === 'function'
      && isTeamLeadCaller(teams, input.parent)
    ) {
      try {
        await teams.sendMessage(input.parent, {
          target: roster.name,
          content: [{ type: 'text', text: input.instruction }],
          signal: teamCallSignal(),
        })
        return { via: 'team', target: roster.name }
      } catch (err) {
        throw new Error(describeSendFailure({ delegationId: input.delegationId, name: roster.name, error: err }).message)
      }
    }
    const followup = resolveFollowupSeam(input.subagents ?? this.subagentsSeam ?? undefined)
    if (followup === undefined) throw new Error('no continuable followup seam')
    await followup(input.parent ?? {}, input.childId, [{ type: 'text', text: input.instruction }], {
      source: { kind: 'coordinator', form: 'relay', senderSessionId: input.parent?.id ?? '' },
    })
    return { via: 'subagents' }
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
   * FU — the same delegated-reviewer verdict `phaseRules` puts in its payload, for a caller that needs it
   * WITHOUT the payload.
   *
   * ⚠ WHY IT IS A METHOD AND NOT A SECOND COMPUTATION. The pre-step reminder is built in `index.ts` from the
   * artifact name alone, so the capability statement could not reach it — and a rule that is only ever
   * emitted on a branch no caller can reach is a dead rule, which is the defect class this whole change is
   * about. Exposing the ONE resolution keeps the reminder's line derived from the same facts as the payload's
   * field, instead of a second copy of the policy read that could drift from it.
   */
  delegatedReviewerCapability(root: string, artifactPath: string, role?: string) {
    return delegatedReviewerCapability({
      ...(role === undefined ? {} : { role }),
      seam: this.subagentsSeam,
      resolveRoute: (resolvedRole) => resolveRole(resolvedRole, loadRouterPolicy(routerPolicyPath(root), this._routerOverrides), this.providerMapFromSeam()),
      artifactExists: existsSync(artifactPath),
    })
  }

  /**
   * B3: per-call workspace root resolution. The control-plane root is the
   * session's cwd (or registry-canonicalized), NEVER process.cwd() — the host
   * checkout is not the run's workspace. Reads resolve under that root only.
   */
  async resolveRootFor(agent?: AgentLike | null): Promise<string | null> {
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

  async status(runId?: string, agent?: AgentLike | null): Promise<RecursiveStatusWithGuardDecisions | null> {
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
  async phaseRules(runId?: string, agent?: AgentLike | null, files?: readonly string[]): Promise<(PhaseRules & { runId: string; phase: string; memory: string; memoryReason: string }) | null> {
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
    // ⚠ AND RECORD THAT THE READ HAPPENED, EVEN WHEN IT RETURNED NOTHING — the fact the phase-0 write gate
    // (`memory-read` in `policy-globs.ts`) is keyed on. `recordInjection` above can only write a row when a
    // shard was selected, so on an EMPTY plane it writes nothing at all and a gate reading it would refuse
    // forever in a fresh workspace. The receipt is written on every phase entry, `injected: false` included:
    // the requirement is that memory was READ before the run's requirements were authored, not that the
    // plane had something to say. This is the ONE place a read becomes durable, because this function is the
    // one place a phase entry reads memory (see the T29 note above).
    recordMemoryRead(resolved.runDir, phase, {
      injected: selection.injected,
      shards: selection.shards.length,
      reason: selection.reason,
    })
    return {
      runId: resolved.runId,
      phase,
      ...phaseRulesFor(phase),
      // FU-11 — THE GIT PRECONDITION, AT PHASE ENTRY, WHERE IT CAN STILL BE ACTED ON.
      //
      // MEASURED: in a non-git workspace the requirement surfaced only as a LOCK refusal, after the
      // phase-0 docs had been authored — so the caller learned that the artifact it had just written
      // could never be locked, at the end of the chain, from a sentence that named the git preconditions
      // but not their consequence. `recursive_phase` is the entry call the workflow ALREADY makes before
      // authoring (and the one the memory-read gate already requires for `00-requirements.md`), so it is
      // where the capability statement belongs: no new call, no new refusal, nothing relaxed.
      //
      // READ FROM LIVE FACTS ON EVERY ENTRY (`gitFacts`, the same accessor `initRun` prefills the diff
      // basis from), never cached: a caller who runs `git init` mid-run must see the notice disappear on
      // the next phase entry rather than be told a stale impossibility. It is total — a non-git root
      // returns nulls — so this cannot be why a phase call fails.
      //
      // ONE VERDICT FUNCTION (`gitBaselineProblem`), not a single null-check: a repo with NO COMMITS has
      // a non-null `gitDir` (so `git rev-parse --git-dir` succeeds) and a null `headSha`, and that state
      // used to pass silently. All three unusable-baseline states now fire, each with its own sentence.
      gitRequired: gitBaselineProblem(gitFacts(root)),
      // FU — WHETHER A DELEGATED REVIEWER IS REACHABLE FOR THIS PHASE, AND IF NOT, WHICH CONDITION STOPS ONE.
      //
      // ⚠ THE CONDITIONS ARE READ FROM THE PATH `recursive_review` ITSELF TAKES, not from a hopeful probe:
      // the SAME seam field `delegateReview` falls back to, the SAME provider map built from it, and the
      // SAME workspace router policy file — so the statement and the call cannot disagree about the seam.
      // The artifact check mirrors the tool's own `NO_PHASE` refusal, and its `row.exists` lookup.
      //
      // ⚠ AND IT IS STATED, NOT FIXED. The host defect that actually broke the profiled run — a continuable
      // start whose spec carries no signal reaching a host read of `signal.aborted` — is invisible from here
      // and stays reported; see `delegatedReviewerCapability`'s own note for the other two refusals
      // (`T19` repeat, `T28` children budget) that this statement deliberately does not claim to cover.
      delegatedReviewer: this.delegatedReviewerCapability(root, join(resolved.runDir, phase)),
      // ⚠ `'phase'` IS PASSED BECAUSE THIS IS NOT A REVIEW BUNDLE. The renderer's wording used to be the
      // reviewer's (*"relevant to this REVIEW"*) and this payload inherited it, so the sentence named a
      // reader this text never reaches. The context is the ONE thing that differs between the two callers
      // (see `MemoryRenderContext`), so the renderer stays single.
      memory: selection.injected ? renderMemorySection(selection.shards.map((shard) => shard.entry), 'phase') : '',
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
   * run dir + created artifacts, plus `firstCommit` describing the baseline
   * commit this call made (see the in-body note).
   *
   * When `opts.createWorktree` is true, a linked worktree is first created at
   * `.worktrees/<runId>/` and the run is scaffolded INSIDE it (per the
   * "all subsequent phases execute in worktree context" rule). The worktree
   * branch defaults to `recursive/<runId>` and is cut from `opts.baseBranch`
   * (default: current HEAD branch of the root checkout).
   */
  async initRun(runId: string, agent?: AgentLike | null, opts?: { createWorktree?: boolean; baseBranch?: string }): Promise<{ runDir: string; runId: string; created: string[]; existing: string[]; worktree?: CreateWorktreeResult; firstCommit?: FirstCommitResult }> {
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
        // ⚠ THE OWNER, from the calling agent this method was already given (`exec.agent`, threaded by
        // `recursive_init`). Without it the registry checks only the GLOBAL controller layer, where the
        // preset's realm-scoped `tool-jobs` controller does not appear, and `start` refuses.
        owner: agentOwner(agent),
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

    // ------------------------------------------------------------------------------------------------
    // FU — THE FIRST COMMIT: in a repository with NO COMMITS, init closes the baseline hole itself.
    //
    // WHY HERE AND NOWHERE ELSE. Phase 0 records a diff basis (a commit SHA) that the linter resolves
    // against live git, and `detectGitContext` just above degrades to the `<resolve-before-locking>`
    // placeholder when HEAD does not resolve. A zero-commit repo therefore scaffolds an unlockable run:
    // the lock later dies with "Unable to resolve baseline reference '<resolve-before-locking>'". Making
    // the first commit HERE — AFTER the scaffold is written — gives the prefill a real HEAD the next time
    // init runs, and gives `recursive_phase`'s `gitRequired` verdict nothing to complain about.
    //
    // ⚠ THE SAFETY PROPERTIES, ALL LOAD-BEARING:
    //   - STAGE ONLY WHAT THIS CALL WROTE. The pathspecs are the `created` entries plus the run dir's own
    //     `.recursive/run/<runId>` path; `existing` files are NEVER re-staged as if new, and there is no
    //     `git add -A` / `git add .` / `git commit -a` anywhere. An unrelated untracked file in the same
    //     repo must not enter this commit (that is the assertion the test mutates to `git add -A` to prove
    //     bites).
    //   - BEST-EFFORT. A failed commit (no identity, hooks, read-only git, sandbox) must not fail init:
    //     init failing because a convenience commit failed is a worse defect than the one this fixes.
    //     The failure is recorded and returned, and if it failed, the run is genuinely unlockable —
    //     `recursive_phase`'s verdict will say so on the next entry, which is the honest outcome.
    //   - IDEMPOTENT. Only when `gitBaselineProblem` says `no-commits`. A repo that already has a commit
    //     is untouched: no `--amend`, no reset, no force, no branch/HEAD/remote/index mutation beyond
    //     `git add` of the named paths and one `git commit`.
    //   - IDENTITY, DISCLOSED. A fresh repo frequently has no user.name/user.email. Attempt the commit
    //     normally; if it fails, retry ONCE with `-c user.name=… -c user.email=…` on the single command
    //     (never repo/global config, which would mutate the user's configuration), and record
    //     `usedPlaceholderIdentity` so the author is visible in the log rather than silently wrong.
    // ------------------------------------------------------------------------------------------------
    let firstCommit: FirstCommitResult | undefined
    const scaffoldFacts = gitFacts(scaffoldRoot)
    // "no commits" = a git repository (gitDir resolves) whose HEAD has never been created. `gitBaselineProblem`
    // returns a SENTENCE (the caller-facing notice), so test the two FACTS directly rather than matching prose.
    if (scaffoldFacts.gitDir !== null && scaffoldFacts.headSha === null) {
      // The scaffold root is the repo the commit belongs to: the main checkout, or the freshly created
      // worktree when `createWorktree` is set (a worktree commit is still a commit of the shared repo).
      const gitDirOk = scaffoldFacts.gitDir !== null
      // Paths are repo-relative; `runDir` is absolute, so relativize against the commit's cwd.
      const runRel = relative(scaffoldRoot, runDir).replace(/\\/g, '/')
      // STAGE EXACTLY WHAT THIS CALL WROTE: only created FILES. Git does not track empty directories;
      // passing a new directory as a pathspec recursively stages its contents, including a file someone
      // might place there between mkdir and commit, so directory entries (`.../`) are deliberately omitted.
      // Existing files/dirs are NEVER staged. No `git add -A` / `git add .` / `git commit -a`.
      const createdPaths = created.filter((p) => !p.endsWith('/')).map((p) => (runRel + '/' + p).replace(/\/+/g, '/'))
      // A path that is gitignored must be skipped rather than failing the whole commit.
      const isIgnored = (rel: string): boolean => {
        try {
          execFileSync('git', ['check-ignore', '--quiet', '--', rel], { cwd: scaffoldRoot, stdio: 'ignore' })
          return true
        } catch {
          return false
        }
      }
      const stagedPaths = [...new Set(createdPaths)].filter((p) => !isIgnored(p))
      const attemptCommit = (withPlaceholder: boolean): { sha: string | null; error: string | null } => {
        if (!gitDirOk) return { sha: null, error: 'not a git repository: git rev-parse --git-dir returned no directory' }
        try {
          execFileSync('git', ['add', '--', ...stagedPaths], { cwd: scaffoldRoot, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (err) {
          return { sha: null, error: 'git add failed: ' + (err instanceof Error ? err.message : String(err)) }
        }
        // `-c` is a GLOBAL git option and must precede the `commit` subcommand.
        const commitArgs = withPlaceholder
          ? ['-c', 'user.name=recursive-init', '-c', 'user.email=recursive-init@invalid.local', 'commit', '--only', '-m', 'recursive-init: scaffold run ' + runId, '--', ...stagedPaths]
          : ['commit', '--only', '-m', 'recursive-init: scaffold run ' + runId, '--', ...stagedPaths]
        try {
          execFileSync('git', commitArgs, { cwd: scaffoldRoot, stdio: ['ignore', 'pipe', 'pipe'] })
          const sha = (() => {
            try {
              return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scaffoldRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
            } catch {
              return null
            }
          })()
          return { sha: sha || null, error: sha ? null : 'commit succeeded but HEAD did not resolve' }
        } catch (err) {
          const details = err && typeof err === 'object' && 'stderr' in err
            ? String((err as { stderr?: Buffer }).stderr ?? '')
            : ''
          return { sha: null, error: 'git commit failed: ' + (details || (err instanceof Error ? err.message : String(err))) }
        }
      }
      let attempt = attemptCommit(false)
      let usedPlaceholder = false
      if (attempt.error !== null && /identity|user\.name|user\.email|who you are|auto-detect email/i.test(attempt.error)) {
        attempt = attemptCommit(true)
        usedPlaceholder = attempt.error === null
      }
      firstCommit = {
        committed: attempt.sha !== null,
        sha: attempt.sha,
        stagedPaths,
        error: attempt.error,
        usedPlaceholderIdentity: usedPlaceholder,
      }
      // ⚠ THE PRE-FILL HAPPENED BEFORE THE COMMIT, so `00-worktree.md` still records the
      // `<resolve-before-locking>` placeholder (HEAD did not resolve when it was scaffolded). Now that the
      // commit exists, re-prefill it so the run's diff basis resolves against the commit init just made —
      // otherwise init would "succeed" and still leave the run unlockable, which is the exact defect.
      // This is a WORKING-TREE rewrite (the file was created by this call), not an index/HEAD mutation, so
      // it is not part of the first commit: the first commit IS the baseline the run now diffs against.
      // ⚠ ONLY A FILE THIS CALL CREATED IS REWRITTEN. An `existing` 00-worktree.md is the caller's content
      // and is never overwritten; such a run keeps whatever basis it recorded, and the commit is still
      // reported, so the caller can decide. This keeps "stage and rewrite only what init scaffolded" true
      // for `created` and `existing` alike.
      if (firstCommit.committed && created.includes('00-worktree.md')) {
        const refreshed = detectGitContext(scaffoldRoot)
        if (!refreshed.error) {
          writeFileSync(join(runDir, '00-worktree.md'), worktreeContent(runId, scaffoldRoot, refreshed.context, null), 'utf8')
        }
      }
    }

    const result: { runDir: string; runId: string; created: string[]; existing: string[]; worktree?: CreateWorktreeResult; firstCommit?: FirstCommitResult; runStartApproval: { approved: boolean; artifact: string; reason: string; gate: string } } = { runDir, runId, created, existing, runStartApproval: { ...this.readRunStartApproval(scaffoldRoot, runId), gate: RUN_START_GATE_ID } }
    if (worktree) result.worktree = worktree
    if (firstCommit) result.firstCommit = firstCommit
    // ⚠ PHASE 0 — SCAFFOLDING A RUN MUST NOT START IT. This used to arm a durable run goal right here,
    // and arming is what makes the harness drive autonomous rounds: asking for a run spec was enough to
    // start an unattended run. The rule is that phase 0 requires EXPLICIT approval to start a run and
    // goal, so init now ONLY SCAFFOLDS and REPORTS what is owed. `result.runStartApproval` is that
    // report, and it is the pointer the model needs: the run stays inert until `recursive_ask` answers
    // the `run-start` gate (which re-reads the approval and arms the goal through `armRunGoalIfApproved`).
    // The spec is not forbidden — the whole run directory was just written. What is withheld is the goal.
    return result
  }

  /**
   * PHASE 0 — THE APPROVAL ACT: record the human's `Start run` decision and arm the run's goal.
   *
   * ⚠ THE ONLY PATH THAT STARTS A RUN. It exists as one method rather than as "write a line, then
   * project the goal" at the tool, because those two steps must not be separable: an approval recorded
   * without the arm (or an arm without the record) is exactly the half-state that made this defect hard
   * to see. `tests/run-start-approval.spec.ts` drives both halves through this one call.
   *
   * The approval line goes into the run's own Phase 0 artifact, so it is durable, citable, and survives
   * the session — and so a reader of the run can answer "was this run started, and by what?" without the
   * transcript. `answer` is validated against the gate's own labels before it reaches here.
   */
  approveRunStart(root: string, runId: string, agent?: AgentLike | null, answer: string = RUN_START_APPROVE): { ok: boolean; reason: string; path: string; replaced: boolean; goal: SyncResult } {
    if (root.trim() === '' || runId.trim() === '') {
      return { ok: false, reason: 'a run start needs a workspace root and a run id', path: '', replaced: false, goal: { ok: false, reason: 'no run to start' } }
    }
    const path = runStartArtifactPath(root, runId)
    // The record is written through the same in-place marker write every other gate uses, so a changed
    // mind REPLACES its line instead of leaving two answers to one question.
    const written = this.recordAskAnswer(root, runId, RUN_START_ARTIFACT, '- ' + RUN_START_MARKER + ': ' + answer)
    const approval = this.readRunStartApproval(root, runId)
    if (!approval.approved) {
      // A `Hold` (or anything else) is recorded as the decision it is and STARTS NOTHING. The goal is
      // not merely paused: an unstarted run has no goal at all (see goals-projection.ts branch 3).
      return { ok: false, reason: approval.reason, path: written.path, replaced: written.replaced, goal: { ok: false, reason: RUN_START_NOT_APPROVED } }
    }
    const goal = this.armRunGoalIfApproved(agent, root, runId, 'active')
    return { ok: true, reason: '', path: written.path, replaced: written.replaced, goal }
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
  async lockArtifact(runId: string, artifact: string, reopen = false, agent?: AgentLike | null): Promise<LockArtifactResult> {
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
    // ⚠ A SKIPPED ARTIFACT IS SETTLED, AND LOCKING IT DIRECTLY WOULD LEAVE BOTH RECORDS. The lock
    // writes `Status: LOCKED` and the skip's `SkippedAt`/`SkipReason` lines would survive underneath
    // it, so the artifact would claim the work was done and that it does not apply. The remedy is one
    // call and it is the honest one: reopen withdraws the skip record (and invalidates the receipt the
    // skip wrote), and then the phase can be locked like any other.
    if (status === 'SKIPPED') {
      throw new Error(
        'Artifact is recorded as SKIPPED, not DRAFT: ' + artifact + '. Reopen it first (recursive_lock with' +
        ' { artifact: "' + artifact + '", reopen: true }), which withdraws the skip record, and then lock the' +
        ' work - locking it in place would leave the artifact carrying both a lock and a stale skip reason.',
      )
    }
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
    // T40 - THE PHASE-8 MEMORY GATE. Phase 8 exists to promote this run's durable memory, and until
    // this gate the step was a TODO line the agent ticked for itself: a live workspace held three
    // completed runs and a .recursive/memory/ tree still holding only bootstrap placeholders, with
    // run 03's artifact declaring the step done against ANOTHER plugin's store. The requirement is
    // now a fact about files: a path under the plane, declared by the artifact, whose own text
    // carries THIS run's Source-Runs. Placed AFTER quiescence and BEFORE the lint gate: lint stays
    // last (its documented invariant), lock order stays first, and a below-standard artifact is
    // reported with the one thing it must still do. Mode-independent, like every other refusal in
    // this chain - lockArtifact has no mode input and the lock chain has never been advisory-gated.
    const memoryRefusal = phase8MemoryLockRefusal(root, runId, artifact)
    if (memoryRefusal !== null) {
      try { this.blockRunToGoal(agent, runId, { code: 'phase8-memory-missing', message: memoryRefusal }) } catch { /* best-effort, like the prerequisite gate */ }
      throw new Error(memoryRefusal)
    }
    // README §4.1 — THE STANDARD GATE. `recursive_lock` promises that it "refuses
    // if the artifact does not meet the standard", and until this gate existed it
    // checked existence, re-lock, lock ORDER and quiescence and never consulted the
    // linter, so a 14-FAIL artifact locked cleanly and its receipt certified work no
    // check had accepted. The linter is the authority on the standard, so the same
    // entry point the `recursive_lint` tool calls is consulted here.
    //
    // PLACED LAST among the refusals, immediately before the LOCKED-fields mutation:
    // every cheaper refusal keeps its existing precedence, and in particular LOCK
    // ORDER STAYS FIRST — a run that is both out of order AND below standard still
    // reports ordering, exactly as it did before this gate. The already-LOCKED check
    // and the `reopen` branch precede this point too, so nothing previously locked is
    // disturbed and reopen does not suddenly demand a standard it never had.
    //
    // A plain `Error`, in the same style as the refusals above, rather than a new
    // `toolError` code: no registry entry describes "below the phase standard", and
    // inventing one would add a code `tests/errors.spec.ts` has to be taught, for a
    // refusal whose remedy is the FAIL list it already carries.
    //
    // CONSERVATIVE WHEN THE LINT CANNOT RUN: a lint whose job was killed or failed
    // returns `passed: false` with the reason in `errors`, so an artifact that could
    // not be checked is refused rather than waved through — "not measured" is not
    // "meets the standard".
    const lint = await this.lintArtifact(runId, artifact, agent)
    if (!lint.passed) {
      // ⚠ FU-11 — WHEN THE BLOCKER IS THE ENVIRONMENT, SAY SO INSTEAD OF "FIX THE CAUSE AND RETRY".
      //
      // MEASURED, in a live diagnostic run in a NON-GIT workspace: two `recursive_lock` calls were
      // refused here, naming the git preconditions correctly (`HEAD is detached; expected branch …`,
      // `Unable to verify git diff basis: Unable to resolve baseline reference '<resolve-before-locking>':
      // fatal: not a git repository`), and the caller then spent its repair on the ONE other line the
      // plugin had emitted — the report-only transition advisory — because it read as a cause it could
      // fix. This branch is the honest place to say that no artifact edit is the remedy: the diff basis
      // and the lock hash are the tamper mechanism, both are git facts, and `lockArtifact` has no
      // git-less mode. The refusal is UNCHANGED in kind and precedence — the extra sentence is appended
      // to the same message, after the linter's own failures, so a caller still reads the verdict first.
      //
      // IT FIRES ON THE LINTER'S OWN WORDS, not on a second git probe: the run-level FAIL this appends to
      // is emitted because git could not answer, so the detection cannot disagree with the refusal it
      // explains. `.git` itself is never re-examined here.
      const gitBlocker = lint.errors.some((error) => error.includes('not a git repository'))
      throw new Error(
        'Artifact ' + artifact + ' does not meet the phase standard, so it was not locked: ' + lint.errors.join('; ')
        + (gitBlocker
          // The appended clause ends WITHOUT a full stop on purpose: the caller renders this through
          // `codeRuntimeRefusal`, whose sentence continues ("… can clear it. Next: fix the cause …"), and a
          // terminal period here produced "… can clear it.. Next: …" in the live transcript.
          ? ' - ENVIRONMENT BLOCKER, not an artifact defect: the workspace is not a git repository, and the diff'
          + ' basis plus the lock hash are the tamper mechanism, so this phase cannot be locked until the run'
          + ' executes in a git repository with at least one commit; no edit to ' + artifact + ' can clear it'
          : ''),
      )
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

  /**
   * SETTLE A PHASE THAT DOES NOT APPLY, IN PLACE — the legitimate skip.
   *
   * The runtime method exists for the same reason `lockArtifact` does: the marker must be written by
   * the PLUGIN, not by the model's `write` tool, because the phase-order guard binds writes to the
   * active phase and a skipped phase is by definition not the active one — an agent told to "mark it
   * skipped" with `edit` would be refused by our own write rule. The tool that owns phase settlement
   * is therefore the one that writes it, and the decision logic lives in `src/skip.ts` (which this
   * method only resolves paths and reports for).
   *
   * ⚠ THE ARTIFACT IS NEVER REMOVED, here or anywhere else in this plugin: the skip is a decision
   * recorded in the file, which is what keeps "a run artifact is evidence and the chain should only
   * grow" true while still letting a run move past a phase that does not apply to it.
   */
  async skipArtifact(runId: string, artifact: string, reason: string, agent?: AgentLike | null): Promise<SkipResult> {
    const root = await this.resolveRootFor(agent)
    if (!root) throw new Error('cannot resolve workspace control-plane root for this session')
    const runDir = join(root, '.recursive', 'run', runId)
    return skipPhaseArtifact(runDir, runId, artifact, reason)
  }

  /** Reopen a LOCKED artifact to DRAFT (delete LockedAt/LockHash, invalidate downstream receipts). */
  private reopenArtifact(root: string, runDir: string, runId: string, artifact: string, artifactPath: string, agent?: AgentLike | null): LockArtifactResult {
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
    // ⚠ A REOPEN IS ALSO THE UN-SKIP, so the skip record goes with the status it belonged to. Leaving
    // `SkippedAt`/`SkipReason` on a DRAFT artifact would leave a phase that is being worked on carrying
    // a stale statement that it does not apply — and the reason text would silently survive into the
    // next lock. The DECISION itself is not lost: the receipt the skip wrote is invalidated right
    // below (reopen invalidates this artifact's receipt and every stale downstream one), so the chain
    // records that a settlement happened and was withdrawn, which is the honest history.
    content = content.replace(new RegExp('^[ \\t]*' + SKIPPED_AT_FIELD + ':.*\\n?', 'm'), '')
    content = content.replace(new RegExp('^[ \\t]*' + SKIP_REASON_FIELD + ':.*\\n?', 'm'), '')
    writeFileSync(artifactPath, content, 'utf8')
    // Record the attempt AFTER it succeeded, best-effort: a failed index write must
    // never change the outcome of an operation the caller already performed.
    recordOperation(runDir, { id: operation, act: 'reopen', at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), outcome: 'applied' })
    const hadReceipt = invalidateReceipt(runDir, artifact)
    const stale = getStaleDownstreamPhases(runDir, artifact)
    for (const entry of stale) invalidateReceipt(runDir, entry.artifact)
    // B2: reopen reverts to DRAFT — the live fs route folds the reverted state.
    // T1 (goals projection): re-arm the durable run goal (reopen un-blocks).
    // ⚠ PHASE 0: only for a run that WAS started — the approval is read from the run's own Phase 0
    // artifact here, so reopening an unapproved run cannot arm the goal init deliberately withheld.
    try { this.resumeRunToGoal(agent, runId, this.readRunStartApproval(root, runId).approved) } catch { /* best-effort */ }
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
  async lintArtifact(runId: string, artifact?: string, agent?: AgentLike | null): Promise<LintArtifactResult> {
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
      // ⚠ THE OWNER — AND THIS IS THE ONE THAT FROZE EVERY LIVE RUN. `lockArtifact` calls this method
      // (`runtime.ts` :1724) and a lock is the only way a run advances, so a refusal here stopped the
      // chain at phase 0: all twelve artifacts stayed DRAFT, `.recursive/locks/` was never created, and
      // `operations.jsonl` recorded no lock operation at all. The harness's refusal was
      // "background jobs unavailable: no job controller serves this agent (load
      // @deepseek-ai/dsh-tool-jobs in its composition)" — from a registry that WAS mounted, because the
      // spec carried no owner and only the global layer was consulted.
      owner: agentOwner(agent),
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
  async lintArtifactStructuralFallback(runId: string, artifact: string, agent?: AgentLike | null): Promise<LintArtifactResult> {
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

  /** Phase C R7: resolve the enforcement config (strict|advisory, default strict). */
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

