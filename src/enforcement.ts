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
 * Layer 2 - tools/pre-execute guard decision.
 * Pure predicate: inspects the pending tool execution (name + args) against
 * the run tree under the given worktree root.
 */
export type ToolGuardDecision = { kind: 'allow'; warn?: string } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }

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
  const runDir = join(worktreeRoot, '.recursive', 'run', activeRunId)

  // Monotonic lock-order denial (recursive_lock out of order).
  if (LOCK_TOOL_NAMES.has(name)) {
    const artifact = String(args.artifact ?? '')
    if (artifact) {
      const blockers = getPrerequisiteBlockers(runDir, artifact)
      if (blockers.length > 0) {
        const reason = 'monotonic lock-order: ' + blockers.map((b) => b.artifact + ' (' + b.status + ')').join(', ')
        return mode === 'strict' ? { kind: 'deny', reason } : { kind: 'ask', reason }
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
            return mode === 'strict' ? { kind: 'deny', reason } : { kind: 'ask', reason }
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
          return mode === 'strict' ? { kind: 'deny', reason } : { kind: 'ask', reason }
        }
      }
    }
  }

  return { kind: 'allow' }
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
