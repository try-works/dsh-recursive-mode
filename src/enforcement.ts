/**
 * Enforcement config + pre-step gate + tool guards + tamper detection
 * (Phase C R3/R4/R7/R8, PROPOSAL 8.4/8.6/13.5).
 *
 * Layer 2 (tool guards) and Layer 8 (tamper) are the remaining enforcement
 * layers. Configurable strict|advisory per gate (default advisory).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve, sep } from 'node:path'
import { getLockStatus, getPrerequisiteBlockers } from './lock.ts'
import { getMdFieldValue } from './status.ts'
import { validateTransition, type GateCheckResult } from './lifecycle.ts'

export type EnforcementMode = 'strict' | 'advisory'

export interface EnforcementConfig {
  preStep: EnforcementMode
  toolGuards: EnforcementMode
  tamper: EnforcementMode
}

/** Validate the enforcement config shape (unknown keys fail at plugin load). */
export function resolveEnforcementConfig(config: unknown): EnforcementConfig {
  const raw = (config ?? {}) as Record<string, unknown>
  const unknown = Object.keys(raw).filter((k) => !['preStep', 'toolGuards', 'tamper'].includes(k))
  if (unknown.length > 0) {
    throw new Error('EnforcementConfig has unknown key(s) ' + unknown.join(', ') + ' - config is { preStep, toolGuards, tamper }')
  }
  const mode = (value: unknown): EnforcementMode => (value === 'strict' ? 'strict' : 'advisory')
  return {
    preStep: mode(raw.preStep),
    toolGuards: mode(raw.toolGuards),
    tamper: mode(raw.tamper),
  }
}

export const DEFAULT_ENFORCEMENT: EnforcementConfig = { preStep: 'advisory', toolGuards: 'advisory', tamper: 'advisory' }

/** Tool names the locked-artifact write guard treats as write operations. */
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'fs_write', 'fs-write', 'pwsh', 'shell', 'bash', 'run_code'])

/** Tool names the monotonic lock-order guard treats as lock operations. */
const LOCK_TOOL_NAMES = new Set(['recursive_lock', 'recursive_lock_phase'])

/**
 * T15: the rule that produced a guard decision (a machine-readable reason for
 * every allow/deny/ask the guard hands back). `'none'` means no guard predicate
 * fired; `'transition'` marks a decision whose only dissenting gate was the
 * advisory transition gate (see consultTransitionGate).
 */
export type GuardRule = 'lock-order' | 'tdd-evidence' | 'locked-write' | 'transition' | 'none'

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

  // Monotonic lock-order denial (recursive_lock out of order).
  if (LOCK_TOOL_NAMES.has(name)) {
    const artifact = String(args.artifact ?? '')
    if (artifact) {
      const blockers = getPrerequisiteBlockers(runDir, artifact)
      if (blockers.length > 0) {
        const reason = 'monotonic lock-order: ' + blockers.map((b) => b.artifact + ' (' + b.status + ')').join(', ')
        return advisory(verdict(mode, reason, 'lock-order'), transition)
      }
      // TDD evidence gating on Phase 3 lock.
      if (artifact === '03-implementation-summary.md') {
        const artifactPath = join(runDir, artifact)
        const content = existsSync(artifactPath) ? readFileSync(artifactPath, 'utf8') : ''
        const tddMode = getMdFieldValue(content, 'TDD Mode') ?? ''
        if (tddMode === 'strict') {
          const hasRed = /RED|red evidence/i.test(content)
          const hasGreen = /GREEN|green evidence/i.test(content)
          if (!hasRed || !hasGreen) {
            const reason = 'TDD Mode: strict requires RED + GREEN evidence before locking Phase 3'
            return advisory(verdict(mode, reason, 'tdd-evidence'), transition)
          }
        }
      }
    }
  }

  // Locked-artifact write denial.
  if (WRITE_TOOL_NAMES.has(name)) {
    const target = firstTargetPath(args)
    if (target) {
      const normalized = target.replace(/\\/g, '/')
      if (normalized.endsWith('.md') && normalized.includes('/.recursive/run/')) {
        const abs = resolveTargetPath(normalized, worktreeRoot)
        if (abs && getLockStatus(abs) === 'LOCKED') {
          const reason = 'locked-artifact write denial: ' + normalized + ' carries Status: LOCKED (reopen explicitly to edit)'
          return advisory(verdict(mode, reason, 'locked-write'), transition)
        }
      }
    }
  }

  return advisory({ kind: 'allow', rule: 'none' }, transition)
}

/** strict denies, advisory asks — the decision kind that carries the rule. */
function verdict(mode: EnforcementMode, reason: string, rule: GuardRule): ToolGuardDecision {
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

/** Resolve a tool-target path to an absolute path under the worktree root. */
function resolveTargetPath(target: string, worktreeRoot: string): string | null {
  const normalized = target.replace(/\\/g, '/')
  if (isAbsolute(normalized)) {
    const abs = resolve(normalized)
    const rootAbs = resolve(worktreeRoot)
    const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
    if (abs !== rootAbs && !abs.startsWith(rootPrefix)) return null
    return abs
  }
  return resolve(worktreeRoot, normalized.replace(/^\.?\/?/, ''))
}

/** Extract the first candidate target path from a tool's arguments. */
function firstTargetPath(args: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'path', 'command', 'target', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Layer 8 - fs/observed lock-tamper detection.
 * A locked *.md whose observed version differs from the stored LockHash is
 * a tamper. Returns a tamper reason (or null when clean/not-applicable).
 */
export function detectTamper(
  targetPath: string,
  worktreeRoot: string,
  activeRunId: string,
): { runId: string; path: string; reason: string } | null {
  const normalized = targetPath.replace(/\\/g, '/')
  if (!normalized.endsWith('.md') || !normalized.includes('/.recursive/run/')) return null
  const abs = resolveTargetPath(normalized, worktreeRoot)
  if (!abs || !existsSync(abs)) return null
  const status = getLockStatus(abs)
  if (status === 'STALE_LOCK') {
    return { runId: activeRunId, path: normalized, reason: 'locked artifact hash mismatch (tampered): ' + normalized }
  }
  return null
}
