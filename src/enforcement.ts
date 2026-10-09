/**
 * Enforcement config + pre-step gate + tool guards + tamper detection
 * (Phase C R3/R4/R7/R8, PROPOSAL 8.4/8.6/13.5).
 *
 * Layer 2 (tool guards) and Layer 8 (tamper) are the remaining enforcement
 * layers. Configurable strict|advisory per gate (default advisory).
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, isAbsolute, resolve, sep } from 'node:path'
import { getLockStatus } from './lock.ts'
import { validateTransition, type GateCheckResult } from './lifecycle.ts'
import {
  evaluateToolPolicy, loadToolPolicyFile,
  builtInToolPolicyDefault, LOCK_TOOL_NAMES, WRITE_TOOL_NAMES,
  type ToolPolicy, type ToolPolicyContext, type Decision as PolicyDecision,
} from './policy-globs.ts'
import { withPhaseBaseline, phaseNumberForArtifact, resolveFrom } from './phase-rules.ts'

/**
 * The BUILT-IN default rule list (T16) is defined in `src/policy-globs.ts`,
 * beside the evaluator and the loader that use it as the ABSENT-file fallback,
 * and re-exported here because it is part of the guard's documented behaviour.
 * (It cannot live in a module of its own: the list needs the loader's predicate
 * contract and the loader needs the list, which as two modules is a value-level
 * import cycle — the very thing that made a top-level wiring call throw.)
 */
export const builtInToolPolicy = builtInToolPolicyDefault

export type EnforcementMode = 'strict' | 'advisory'

/**
 * T28 — the budgets. Every unbounded loop and every unbounded result gets a named,
 * configurable cap, because a bound that is not named cannot be reviewed and a bound
 * that is not configurable gets hardcoded per call site (which is exactly what
 * happened to `maxDepth`).
 */
export interface BudgetConfig {
  /** Rounds ONE phase's audit loop may run, even when every round makes progress. */
  maxAuditRounds: number
  /**
   * How many times a phase may be sent back for repair. Distinct from T20's
   * no-progress bound: that one stops a loop REPEATING a finding, this one bounds a
   * loop that keeps finding genuinely NEW things — the case the no-progress bound
   * deliberately lets run.
   */
  maxRepairAttempts: number
  /** The ceiling for the WHOLE recursion, not a fresh allowance at each level. */
  maxDelegationDepth: number
  /** Delegated children one phase may start. */
  maxChildrenPerPhase: number
  /** Byte ceiling for one tool result. T24's caps bound the COUNT of findings; a few enormous findings need this. */
  maxResultBytes: number
}

export const DEFAULT_BUDGETS: BudgetConfig = {
  // Matches the historical `maxRounds ?? 3`, so adding the config changes no default.
  maxAuditRounds: 3,
  maxRepairAttempts: 3,
  // Matches the hardcoded `maxDepth ?? 2` this replaces, for the same reason.
  maxDelegationDepth: 2,
  maxChildrenPerPhase: 4,
  maxResultBytes: 65_536,
}

export interface EnforcementConfig {
  preStep: EnforcementMode
  toolGuards: EnforcementMode
  tamper: EnforcementMode
  /** T28: the caps. Always present, so a caller never has to guess a default. */
  budgets: BudgetConfig
}

const CONFIG_KEYS = ['preStep', 'toolGuards', 'tamper', 'budgets']
const BUDGET_KEYS: ReadonlyArray<keyof BudgetConfig> = [
  'maxAuditRounds', 'maxRepairAttempts', 'maxDelegationDepth', 'maxChildrenPerPhase', 'maxResultBytes',
]

/**
 * Validate the enforcement config shape (unknown keys fail at plugin load).
 *
 * A budget must be a POSITIVE INTEGER. Zero and negatives are rejected rather than
 * coerced: `0` would mean "never allowed", which bricks the phase it was meant to
 * bound, and a negative would read as already-exceeded everywhere it is compared.
 * A config error is loud at load, not mysterious later.
 */
export function resolveEnforcementConfig(config: unknown): EnforcementConfig {
  const raw = (config ?? {}) as Record<string, unknown>
  const unknown = Object.keys(raw).filter((k) => !CONFIG_KEYS.includes(k))
  if (unknown.length > 0) {
    throw new Error('EnforcementConfig has unknown key(s) ' + unknown.join(', ') + ' - config is { preStep, toolGuards, tamper, budgets }')
  }
  const mode = (value: unknown): EnforcementMode => (value === 'strict' ? 'strict' : 'advisory')

  const rawBudgets = (raw.budgets ?? {}) as Record<string, unknown>
  if (typeof raw.budgets !== 'undefined' && (raw.budgets === null || typeof raw.budgets !== 'object')) {
    throw new Error('EnforcementConfig budgets must be an object of caps')
  }
  const unknownBudget = Object.keys(rawBudgets).filter((k) => !BUDGET_KEYS.includes(k as keyof BudgetConfig))
  if (unknownBudget.length > 0) {
    throw new Error('EnforcementConfig budgets has unknown key(s) ' + unknownBudget.join(', ') + ' - budgets are { ' + BUDGET_KEYS.join(', ') + ' }')
  }
  const budgets = { ...DEFAULT_BUDGETS }
  for (const key of BUDGET_KEYS) {
    const value = rawBudgets[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error('EnforcementConfig budgets.' + key + ' must be a positive integer (got ' + JSON.stringify(value) + ')')
    }
    budgets[key] = value
  }

  return {
    preStep: mode(raw.preStep),
    toolGuards: mode(raw.toolGuards),
    tamper: mode(raw.tamper),
    budgets,
  }
}

export const DEFAULT_ENFORCEMENT: EnforcementConfig = {
  preStep: 'advisory',
  toolGuards: 'advisory',
  tamper: 'advisory',
  budgets: DEFAULT_BUDGETS,
}

/**
 * T15: the rule that produced a guard decision (a machine-readable reason for
 * every allow/deny/ask the guard hands back). `'none'` means no guard predicate
 * fired; `'transition'` marks a decision whose only dissenting gate was the
 * advisory transition gate (see consultTransitionGate).
 *
 * `'phase-order'` is the WRITE half of the ordering rule the owner states as *only
 * one phase may be active at a time, and the phases should be sequential and the
 * active phase must be locked before proceeding to next phase*: `'lock-order'` refuses
 * locking ahead, `'phase-order'` refuses WRITING ahead. Two labels rather than one,
 * because the guard log has to tell the owner which of the two the agent attempted.
 */
export type GuardRule = 'lock-order' | 'phase-order' | 'tdd-evidence' | 'locked-write' | 'transition' | 'none'

/** T15: the transition gate's verdict as attached to a decision (advisory only). */
export interface GuardTransition {
  passed: boolean
  failures: string[]
}

/**
 * Layer 2 - tools/pre-execute guard decision.
 * Pure predicate: inspects the pending tool execution (name + args) against
 * the run tree under the given worktree root.
 *
 * T15: `rule` and `transition` are OPTIONAL and additive. They must stay
 * optional — `coerceAskToDecision` is asserted with `toEqual({ kind: ... })`
 * (an EXACT match) in tests/enforcement.spec.ts, so the coercion path may never
 * grow extra keys. `evaluateToolGuard` itself always sets `rule`.
 */
export type ToolGuardDecision =
  | { kind: 'allow'; warn?: string; rule?: GuardRule; transition?: GuardTransition }
  | { kind: 'deny'; reason: string; rule?: GuardRule; transition?: GuardTransition }
  | { kind: 'ask'; reason?: string; rule?: GuardRule; transition?: GuardTransition }

export interface ToolExecLike {
  name: string
  arguments?: unknown
  agent?: unknown
}

/* -------------------------------------------------------------------------- */
/* T16 — the policy the guard evaluates                                       */
/* -------------------------------------------------------------------------- */

/**
 * The BUILT-IN default rule list (T16) is defined in `src/policy-globs.ts`,
 * beside the evaluator and the loader that use it as the ABSENT-file fallback,
 * and re-exported here because it is part of the guard's documented behaviour.
 * (It cannot live in a module of its own: the list needs the loader's predicate
 * contract and the loader needs the list, which as two modules is a value-level
 * import cycle — the very thing that made a top-level wiring call throw.)
 */

/**
 * The policy in force for one guard call: the worktree's policy file when
 * present (a broken file fails closed), the built-in list when absent, plus the
 * current phase's narrowing baseline. Exported so a reviewer — and
 * `recursive:policy` later — can read the effective rules instead of inferring
 * them from a code path.
 */
export function resolveToolPolicyForGuard(worktreeRoot: string, runId: string, activePhaseArtifact?: string): ToolPolicy {
  const loaded = loadToolPolicyFile(worktreeRoot)
  // A caller that already asked `currentPhaseArtifact` for this call passes the answer in,
  // so one guard call reads the run tree's lock statuses ONCE rather than twice. The
  // no-cache discipline is unchanged: an omitted argument still reads the filesystem here.
  return withPhaseBaseline(loaded.policy, activePhaseArtifact ?? currentPhaseArtifact(worktreeRoot, runId))
}

/**
 * The artifact whose phase baseline applies: the HIGHEST-numbered phase artifact
 * present in the run (a run at phase 3 has `00`-`03` on disk). Read from the
 * filesystem on every call — the same no-cache discipline the active run id
 * needs, because a cached phase would apply yesterday's baseline to today's lock.
 */
export function currentPhaseArtifact(worktreeRoot: string, runId: string): string {
  if (!worktreeRoot || !runId) return ''
  const runDir = join(worktreeRoot, '.recursive', 'run', runId)
  let names: string[]
  try {
    names = readdirSync(runDir)
  } catch {
    return ''
  }
  let best = ''
  let bestPhase = -1
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const phase = phaseNumberForArtifact(name)
    if (!phase) continue
    const value = Number(phase)
    if (value > bestPhase) {
      bestPhase = value
      best = name
    }
  }
  // ⚠ FIX 2 (half a) — PRESENCE IS NO LONGER EVIDENCE OF PROGRESS, AND THIS USED TO ASSUME IT WAS.
  //
  // The loop above returns the HIGHEST-numbered phase artifact present, on the documented assumption that "a run at
  // phase 3 has `00`-`03` on disk". That assumption stopped being true when `recursive_init` began scaffolding ALL
  // TWELVE artifacts, `08-memory-impact.md` included — so from turn 0 the phase-8 baseline governed every guard call.
  // Phase 8 is the documentation phase, whose rule denies writes outside the run tree, so a run sitting at phase 3
  // had its SOURCE EDITS denied as though it were finished and merely writing up. A live verification pass recorded
  // five denials out of five while trying to author phase artifacts.
  //
  // The workflow's own notion of progress is the LOCK, so the phase in force is the LOWEST-numbered artifact that is
  // not locked — the phase actually being worked on. Once everything is locked the run is complete, and the previous
  // answer still stands, which keeps the old behaviour exactly where the old reasoning held. Still read from the
  // filesystem on every call, for the same no-cache reason the directory listing is.
  let inForce = ''
  let inForcePhase = Number.POSITIVE_INFINITY
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const phase = phaseNumberForArtifact(name)
    if (!phase) continue
    const value = Number(phase)
    if (getLockStatus(join(runDir, name)) === 'LOCKED') continue
    if (value < inForcePhase) {
      inForcePhase = value
      inForce = name
    }
  }
  return inForce !== '' ? inForce : best
}

export function evaluateToolGuard(
  exec: ToolExecLike,
  worktreeRoot: string,
  activeRunId: string,
  mode: EnforcementMode = 'advisory',
): ToolGuardDecision {
  const name = exec.name
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  const runId = typeof activeRunId === 'string' ? activeRunId.trim() : ''
  const runDir = join(worktreeRoot, '.recursive', 'run', runId)

  // T15: the transition gate is consulted BEFORE the verdict so its result can
  // ride along on every lock-tool decision — including a refusal.
  const transition = consultTransitionGate(name, args, worktreeRoot, runId)

  // T16: the verdict comes from the ordered policy, not from branches here. The
  // policy file is re-read per call on purpose: a policy a human just edited
  // must take effect on the next tool call, not after a restart.
  //
  // The ACTIVE phase is resolved ONCE, by the ONE selector, and is used twice: it
  // selects the phase baseline (narrowing rules) and it is carried into the context so
  // the phase-order rule can refuse a WRITE that is ahead of the active phase. Both
  // halves of the ordering rule therefore read the same answer for the same call.
  const activePhaseArtifact = currentPhaseArtifact(worktreeRoot, runId)
  const policy = resolveToolPolicyForGuard(worktreeRoot, runId, activePhaseArtifact)
  const context: ToolPolicyContext = { args, runDir, runId, worktreeRoot, activePhaseArtifact }
  const decision = evaluateToolPolicy(policy, name, args, context)
  return advisory(verdictFor(mode, decision), transition)
}

/**
 * Map the policy's verdict onto the guard's decision kind: `strict` denies,
 * `advisory` asks (the pre-T16 wording, unchanged), `allow` stays an allow. The
 * decision's `rule` is the label of the rule that decided it, so a policy
 * verdict is traceable to an auditable line in the policy file.
 */
function verdictFor(mode: EnforcementMode, decision: PolicyDecision): ToolGuardDecision {
  const rule = (decision.rule ?? 'none') as GuardRule
  if (decision.kind === 'allow') return { kind: 'allow', rule }
  const reason = decision.reason ?? 'tool policy denied this call'
  return mode === 'strict' ? { kind: 'deny', reason, rule } : { kind: 'ask', reason, rule }
}

/**
 * T15 — consult the transition gate (`validateTransition`) from the guard,
 * ADVISORY-FIRST.
 *
 * The gate's result is ATTACHED to the decision as `transition` and NEVER
 * changes the verdict (allow/deny/ask), which continues to come from the
 * guard's own predicates. Rationale: `validateTransition` enforces a SUPERSET
 * of the guard's checks — it additionally requires `Audit: PASS`, a
 * `Requirement Completion Status` section, a delegation-basis marker,
 * `## Effective Inputs Re-read`, and (for phase 3) that the RED/GREEN evidence
 * FILES exist. Promoting those to blocking would deny locks the lock tool
 * itself allows, and would take the parity fixtures red — they carry none of
 * those markers. So: the gate reports, the guard decides, and a gate failure
 * under an otherwise-allowed call surfaces as an advisory `warn` (never a
 * silent allow).
 *
 * Only lock-tool calls with a REAL run id and a non-empty artifact are
 * consulted; a missing run id means the caller has no run context (the gate
 * would resolve prerequisites against the run ROOT and be meaningless).
 */
function consultTransitionGate(
  name: string,
  args: Record<string, unknown>,
  worktreeRoot: string,
  runId: string,
): GateCheckResult | undefined {
  if (!LOCK_TOOL_NAMES.has(name)) return undefined
  if (!worktreeRoot || !runId) return undefined
  const artifact = String(args.artifact ?? '')
  if (!artifact) return undefined
  try {
    return validateTransition({ runId, worktreeRoot, targetArtifact: artifact, kind: 'lock' })
  } catch {
    // Best-effort evidence: a transition read must never fail the guard call.
    return undefined
  }
}

/** Attach the transition verdict, and warn when the guard allows against it. */
function advisory(decision: ToolGuardDecision, transition: GateCheckResult | undefined): ToolGuardDecision {
  if (!transition) return decision
  if (decision.kind !== 'allow') return { ...decision, transition }
  if (transition.passed) return { ...decision, transition }
  // The verdict stays `allow`; the gate only names itself as the dissenting
  // voice, so an advisory pass is never silent.
  return {
    ...decision,
    rule: 'transition',
    warn: 'transition gate (advisory) failed: ' + transition.failures.join('; '),
    transition,
  }
}

/**
 * T6 (approval ask→policy bridge): an `ask` decision must never be a silent
 * allow. Under `strict` it coerces to `deny`; under `advisory` it stays `allow`
 * but flags a `warn` so the caller never lets it through unlogged. Non-ask
 * decisions pass through unchanged.
 */
export function coerceAskToDecision(decision: ToolGuardDecision, mode: EnforcementMode = 'advisory'): ToolGuardDecision {
  if (decision.kind !== 'ask') return decision
  if (mode === 'strict') {
    return { kind: 'deny', reason: decision.reason ?? 'ask under strict enforcement denies' }
  }
  // advisory: allow, but carry the warning so the caller logs (never silent).
  return { kind: 'allow', warn: decision.reason ?? 'ask under advisory enforcement allows' }
}

/**
 * Resolve a tool-target path to an absolute path under the worktree root.
 * T16: the path arithmetic moved to `phase-rules.ts` (shared with the phase
 * baselines, so the guard and a baseline can never disagree about which path a
 * call names); what stays here is this module's containment rule.
 */
function resolveTargetPath(target: string, worktreeRoot: string): string | null {
  const abs = resolveFrom(worktreeRoot, target)
  if (!abs) return null
  if (!isAbsolute(target.replace(/\\/g, '/'))) return abs
  const rootAbs = resolve(worktreeRoot)
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  if (abs !== rootAbs && !abs.startsWith(rootPrefix)) return null
  return abs
}

/**
 * The ADMISSION test for the tamper path: the resolved absolute path when
 * `targetPath` names a run-tree `*.md` — a tamper CANDIDATE — and `null`
 * otherwise. Pure path arithmetic on every branch (no filesystem work), so a
 * caller may use it as a cheap shape check before paying for `existsSync`.
 *
 * ⚠ THE BLIND SPOT THIS FUNCTION EXISTS TO CLOSE. The admission test used to be a
 * substring test on the target STRING alone, looking for `/.recursive/run/`. A
 * repo-relative path has no separator before `.recursive`, so
 * `.recursive/run/<id>/00-requirements.md` — the spelling a model actually types,
 * and its backslash form — was rejected before ANYTHING was examined, and
 * tampering with a locked artifact through that spelling was invisible
 * (measured: `detectTamper` returned a record for the absolute path and `null`
 * for the relative one, on the same file). The identical defect, in the identical
 * spelling, was fixed one module over in `policy-globs.ts` `lockedWriteRule`; this
 * is that fix's shape, reused rather than reinvented.
 *
 * So the marker is looked for on the path the target RESOLVES to as well as on
 * the string as written. The `||` is load-bearing and the string test is KEPT
 * rather than replaced, because a resolved-only test would SHRINK the admitted
 * set: an absolute target that literally carries the marker but resolves away
 * from it (`…/.recursive/run/../…`) was caught before and must stay caught. The
 * net effect is a strict SUPERSET of the previous behaviour, so no tamper that
 * was visible before can become invisible.
 *
 * EXPORTED because `src/index.ts`'s `fs/observed` listener must apply the SAME
 * admission test before calling `detectTamper`. That listener used to carry a
 * hand-copied mirror of this test, and a mirror is exactly what leaves half the
 * defect behind: widening `detectTamper` alone changes nothing, because the
 * listener rejects the spelling first. One function cannot disagree with itself.
 */
export function tamperCandidatePath(targetPath: string, worktreeRoot: string): string | null {
  const normalized = targetPath.replace(/\\/g, '/')
  if (!normalized.endsWith('.md')) return null
  const abs = resolveTargetPath(normalized, worktreeRoot)
  if (!abs) return null
  const resolved = abs.replace(/\\/g, '/')
  if (!normalized.includes('/.recursive/run/') && !resolved.includes('/.recursive/run/')) return null
  return abs
}

/**
 * Layer 8 - fs/observed lock-tamper detection.
 * A locked *.md whose observed version differs from the stored LockHash is
 * a tamper. Returns a tamper reason (or null when clean/not-applicable).
 *
 * The admission test lives in `tamperCandidatePath` (above), shared with the
 * `fs/observed` listener in `src/index.ts` — see the note there for why sharing
 * it is the point and not a tidiness preference. What this function reports is
 * unchanged: the same record shape, carrying the target AS WRITTEN.
 */
export function detectTamper(
  targetPath: string,
  worktreeRoot: string,
  activeRunId: string,
): { runId: string; path: string; reason: string } | null {
  const normalized = targetPath.replace(/\\/g, '/')
  const abs = tamperCandidatePath(normalized, worktreeRoot)
  if (!abs || !existsSync(abs)) return null
  const status = getLockStatus(abs)
  if (status === 'STALE_LOCK') {
    return { runId: activeRunId, path: normalized, reason: 'locked artifact hash mismatch (tampered): ' + normalized }
  }
  return null
}
