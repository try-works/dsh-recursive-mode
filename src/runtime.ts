import { Service, type Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lintRun } from './ts-lint.ts'
import { requirementsContent, worktreeContent, laterPhaseContent, detectGitContext, RUN_SCAFFOLD_DIRS, type GitContext } from './init-templates.ts'
import { foldRun, getMdFieldValue, pendingWork, resolveRunDir } from './status.ts'
import {
  getLockStatus,
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
import { findOperation, operationId, recordOperation } from './identity.ts'
import { toolError } from './errors.ts'
import { readGuardDecisions, type GuardDecisionRecord } from './guard-log.ts'
import { resolveControlPlaneRoot, type WorkspaceRegistryLike } from './workspace.ts'
import { phaseRulesFor, type PhaseRules } from './phase-rules.ts'
import { closeoutPhase } from './closeout.ts'
import { readScratch, writeScratch, appendScratch, type ScratchTarget } from './scratch.ts'
import { buildReviewBundle, type ReviewBundleInput } from './review.ts'
import { createHandoff, createChildBrief, replyPath, childScratchPath, buildDelegationPrompt, type HandoffInput, type ChildBriefInput } from './handoff.ts'
import { loadRouterPolicy, routerPolicyPath, resolveRole, capabilityProbe, delegationDecisionBasis, type RouterPolicy, type SubagentProviderLike, type RouteDecision, type CapabilityProbe } from './router.ts'
import { delegate, delegateContinuable, validateReferences, writeActionRecord, evaluateDelegationResult, reviewOutputSchema, defaultReviewToolFilter, type SubagentsRuntimeLike, type SubagentStartRequestLike, type SubagentResultLike, type Reference, type ActionRecordInput, type ContinuableDelegationLike, type SubagentParentHandle } from './delegation.ts'
import { validateTransition, coupleGateBlockToGoal, type PhaseTransitionIntent, type RecursivePhaseState, type GateCheckResult } from './lifecycle.ts'
import { resolveEnforcementConfig, DEFAULT_ENFORCEMENT, evaluateToolGuard, detectTamper, type EnforcementConfig, type ToolGuardDecision, type ToolExecLike } from './enforcement.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { renderRecursivePolicy, type PolicyContext } from './policy.ts'
import { snapshotWorkspace } from './snapshot.ts'
import { createLinkedWorktree, promoteBranch, listWorktrees, defaultWorktreeBranch, type CreateWorktreeResult, type PromoteBranchResult } from './worktree.ts'
import { gitFacts } from './git-context.ts'
import { syncRunGoal, blockRunGoal, resumeRunGoal, type GoalServiceLike } from './goals-projection.ts'
import { auditToPass, renderTaskHistory, type TeamRuntimeLike, type AuditToPassResult, type TeamCallerHandle, type TeamTaskViewLike, type AuditRoundOutcome } from './teams-loop.ts'
import type { ContinuableChildId, ContinuableMessageId } from './delegation.ts'

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
}

/** How many recent decisions to read from the log before scoping to one run. */
const GUARD_DECISION_READ_LIMIT = 200

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

  constructor(ctx: Context, config: { repoRoot?: string; workspaceRegistry?: WorkspaceRegistryLike; goals?: GoalServiceLike | null } = {}) {
    super(ctx, 'recursive')
    this.repoRoot = config.repoRoot ?? process.cwd()
    this.workspaceRegistry = config.workspaceRegistry ?? null
    this.goalsService = config.goals ?? null
  }

  private readonly repoRoot: string
  private readonly workspaceRegistry: WorkspaceRegistryLike | null
  private readonly goalsService: GoalServiceLike | null
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
  closeoutRun(root: string, runId: string, phase: string) {
    const runDir = join(root, '.recursive', 'run', runId)
    const runRoot = join(root, '.recursive', 'run')
    // workspace-scoping guard: the run must be under this root
    if (!runDir.startsWith(runRoot) || !existsSync(runDir)) {
      return { error: 'Run not found in current workspace: ' + runId }
    }
    try {
      const result = closeoutPhase(runDir, phase)
      return { closeoutPhase: phase, runId, ...result }
    } catch (err) {
      return { error: (err as Error).message }
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
    maxRounds?: number
    /** T4: the exact live direct-parent Agent (object-identity authority). */
    parent?: SubagentParentHandle
  }) {
    const policy = loadRouterPolicy(input.policyPath ?? routerPolicyPath(input.root))
    const providers = input.providers ?? {}
    const decision = resolveRole(input.role, policy, providers)
    const probe = capabilityProbe({ providers, role: input.role, policy })

    // R1 bundle + R2 handoff/brief/prompt (file-backed context-in contract).
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
    const request: SubagentStartRequestLike = {
      prompt: [{ type: 'text', text: prompt }],
      label: input.delegationId + '/' + input.childId,
      outputSchema: reviewOutputSchema(),
      toolFilter: input.toolFilter ?? defaultReviewToolFilter(),
      maxDepth: input.maxDepth ?? 2,
    }
    if (input.parent !== undefined) request.parent = input.parent

    let result: SubagentResultLike | null = null
    let error: string | null = null
    let continuable: ContinuableDelegationLike | null = null
    // T36: a parked round is NOT an error — it means the child has not settled yet.
    // Kept apart from `error` so a turn-shaped caller can resume instead of treating
    // an ordinary wait as a failure of the delegation.
    let parked = false
    let parkedReason: string | null = null
    if (decision.tier === 'native' || decision.tier === 'external-cli') {
      if (!input.subagents) {
        error = 'no ctx.subagents runtime available (self-audit fallback)'
      } else if (input.mode !== 'one-shot') {
        // T35: continuable BY DEFAULT — only an explicit 'one-shot' opts out of
        // the repair path, because a one-shot child cannot be resumed.
        continuable = await delegateContinuable({
          subagents: input.subagents,
          provider: decision.provider as string,
          label: input.delegationId + '/' + input.childId,
          prompt,
          childId: input.childId,
          maxDepth: input.maxDepth ?? 2,
          toolFilter: input.toolFilter ?? defaultReviewToolFilter(),
          maxRounds: input.maxRounds ?? 3,
          awaitRoundResult: input.awaitRoundResult,
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
            subagents: input.subagents,
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

    const evaluation = result ? evaluateDelegationResult(result) : { accepted: false, reason: error ?? 'no result' }

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
      actionRecordPath,
      error,
      /** T35: which child lifecycle actually carried this delegation. */
      delegationMode,
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
    const policy = loadRouterPolicy(routerPolicyPath(root))
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
    }
  }

  /**
   * LIVE BUG 6 refined: structured phase rules for the CURRENT phase. Resolves
   * the workspace root (same as status/lock), finds the latest run (or the
   * given runId), advances via getNextLegalPhase, and returns the phase's lint
   * rules + instructions. Returns null when no active phase exists. This is the
   * canonical data source for the recursive_phase tool.
   */
  async phaseRules(runId?: string, agent?: { session?: { header?: { cwd?: string } } } | null): Promise<(PhaseRules & { runId: string; phase: string }) | null> {
    const root = await this.resolveRootFor(agent)
    if (!root) return null
    const resolved = resolveRunDir(root, runId)
    if (!resolved) return null
    const phase = getNextLegalPhase(resolved.runDir)
    if (!phase) return null
    return { runId: resolved.runId, phase, ...phaseRulesFor(phase) }
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
      worktree = createLinkedWorktree({ repoRoot: root, runId, baseBranch: opts.baseBranch })
      if (!worktree.ok) throw new Error(worktree.error ?? 'worktree create failed')
      scaffoldRoot = worktree.worktreeDir
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
    const result = lintRun(root, runId)
    const stdout = [...result.errors, ...result.warnings].join('\n')
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

