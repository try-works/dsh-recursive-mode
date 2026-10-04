/**
 * fs-intent.ts — filesystem-derived recursive intent (R5 policy-render fix).
 *
 * SP2 zero-emission retired the recursive/phase-intent SESSION EVENT emitter
 * (and 0.2.2 removed the event-fold helper that read it), so the recursive:policy
 * prompt section rendered ''. This module derives the SAME intent from the
 * filesystem instead: session cwd -> control-plane root -> enumerate runs ->
 * latest run -> current phase (foldRun). Pure read-only fs folding, zero
 * emission — consistent with the per-workspace design + pre-step listener.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { enumerateRuns } from './bootstrap.ts'
import { foldRun } from './status.ts'
import type { WorkspaceRegistryLike } from './workspace.ts'
import { resolveControlPlaneRoot } from './workspace.ts'

export interface FsPolicyIntent {
  worktreeRoot: string
  runId: string
  /** The current phase doc file name (e.g. 03-implementation-summary.md), when determinable. */
  currentPhaseFile: string | null
}

/**
 * Resolve the recursive policy intent for one agent from the FILESYSTEM.
 * Returns null when no control-plane root or run is present (callers defer,
 * never fail hard). The registry path is async-only in the harness, so when a
 * registry is present this resolves the session cwd directly (B4: the session
 * cwd IS the workspace root when unregistered; a registered workspace resolves
 * to the same cwd via resolveControlPlaneRoot's sync fallback).
 */
export function fsPolicyIntent(
  agent: { session?: { header?: { cwd?: string } } } | null | undefined,
  registry?: WorkspaceRegistryLike | null,
  cwdFallback?: string,
): FsPolicyIntent | null {
  const cwd = agent?.session?.header?.cwd ?? cwdFallback ?? null
  if (!cwd) return null
  // B4 sync path: when the registry is absent the session cwd IS the root;
  // when present, resolveControlPlaneRoot canonicalizes through the registry
  // (async). For the sync prompt-section callback we take the B4 shortcut: the
  // session cwd is authoritative per the workspace-scoping invariant. This is
  // exactly what the pre-step listener's resolveRootForRoute falls back to.
  const root = registry ? cwd : cwd
  const runs = enumerateRuns(root)
  if (runs.length === 0) return null
  const runId = runs[runs.length - 1]
  const runDir = join(root, '.recursive', 'run', runId)
  if (!existsSync(runDir)) return null
  const folded = foldRun(runDir, runId)
  return {
    worktreeRoot: root,
    runId,
    currentPhaseFile: folded.currentPhase ? folded.currentPhase.phaseName : null,
  }
}

/**
 * Async variant for callers that CAN await (pre-step listener, routes): uses
 * resolveControlPlaneRoot for registry canonicalization when a registry is
 * present, falling back to the session cwd (B4).
 */
export async function fsPolicyIntentAsync(
  agent: { session?: { header?: { cwd?: string } } } | null | undefined,
  registry?: WorkspaceRegistryLike | null,
  cwdFallback?: string,
): Promise<FsPolicyIntent | null> {
  const cwd = agent?.session?.header?.cwd ?? cwdFallback ?? null
  if (!cwd) return null
  const root = await resolveControlPlaneRoot(agent, registry, cwdFallback)
  if (!root) return null
  const runs = enumerateRuns(root)
  if (runs.length === 0) return null
  const runId = runs[runs.length - 1]
  const runDir = join(root, '.recursive', 'run', runId)
  if (!existsSync(runDir)) return null
  const folded = foldRun(runDir, runId)
  return {
    worktreeRoot: root,
    runId,
    currentPhaseFile: folded.currentPhase ? folded.currentPhase.phaseName : null,
  }
}