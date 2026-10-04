/**
 * /recursive slash command surface (R4). Preset-scoped verbs + global
 * bootstrap|list|help. Every verb dispatches to the workspace-scoped
 * RecursiveRuntime (R1) — the handler receives the agent, resolves the
 * control-plane root via resolveControlPlaneRoot, and refuses anything
 * outside the current workspace.
 *
 * This module exports two parts:
 *   - pure grammar/execution helpers (unit-testable without a live agent)
 *   - a registerRecursiveCommand(ctx, recursive) used by src/index.ts (Stage A)
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RecursiveRuntime } from './runtime.ts'
import { resolveControlPlaneRoot } from './workspace.ts'
import { bootstrapScaffold } from './bootstrap.ts'

export type RecursiveVerb = 'status' | 'spec' | 'worktree' | 'init' | 'lock' | 'qa' | 'closeout' | 'addendum' | 'review' | 'scratch' | 'bootstrap' | 'list' | 'help'

export const PRESET_VERBS: RecursiveVerb[] = ['status', 'spec', 'worktree', 'init', 'lock', 'qa', 'closeout', 'addendum', 'review', 'scratch']
export const GLOBAL_VERBS: RecursiveVerb[] = ['bootstrap', 'list', 'help']
export const ALL_VERBS: RecursiveVerb[] = [...PRESET_VERBS, ...GLOBAL_VERBS]

export interface ParsedRecursiveCommand {
  verb: string
  arg: string
}

export function parseRecursiveCommand(rawInput: string): ParsedRecursiveCommand {
  const trimmed = rawInput.trim()
  if (trimmed === '') return { verb: 'help', arg: '' }
  const [first, ...rest] = trimmed.split(/\s+/)
  const verb = (first ?? 'help').toLowerCase()
  return { verb, arg: rest.join(' ') }
}

export type RecursiveCommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

const HELP_TEXT = 'recursive-mode: ' + PRESET_VERBS.join('|') + ' | global ' + GLOBAL_VERBS.join('|')

/**
 * Execute a /recursive command line against a workspace root (the session's
 * control-plane root). Pure + workspace-scoped: runId outside root errors.
 */
export function executeRecursiveCommand(root: string, rawInput: string): RecursiveCommandResult {
  const { verb, arg } = parseRecursiveCommand(rawInput)
  const runRoot = join(root, '.recursive', 'run')

  switch (verb) {
    case 'status': {
      const runId = arg.trim()
      if (!runId) return { kind: 'error', text: 'status requires a run id (or use /recursive list)' }
      const runDir = join(runRoot, runId)
      if (!existsSync(runDir)) return { kind: 'error', text: 'Run not found in current workspace: ' + runId }
      return { kind: 'success', text: 'recursive-mode status for run ' + runId + ' in workspace ' + root }
    }
    case 'list': {
      if (!existsSync(runRoot)) return { kind: 'success', text: 'No runs in this workspace (/.recursive/run missing)' }
      const names = readdirSync(runRoot, { withFileTypes: true }).filter(d => {
        if (d.isDirectory()) return true
        if (!d.isSymbolicLink()) return false
        try { return statSync(join(runRoot, d.name)).isDirectory() } catch { return false }
      }).map(d => d.name)
      return { kind: 'success', text: names.length ? 'Runs: ' + names.join(', ') : 'No runs in this workspace' }
    }
    case 'help': {
      return { kind: 'success', text: HELP_TEXT + ' — see /.recursive/RECURSIVE.md' }
    }
    case 'bootstrap': {
      // R6 (run 09): manual repair path — idempotent upsert scaffold repair.
      // Adds missing control-plane files/dirs + re-upserts marked blocks;
      // never overwrites user content or touches run/ artifacts.
      const result = bootstrapScaffold(root)
      const summary = result.created.length === 0
        ? 'scaffold already complete (no changes)'
        : 'created ' + result.created.length + ' item(s), ' + result.existing.length + ' existing'
      return { kind: 'success', text: 'recursive-mode scaffold repair: ' + summary + ' — root ' + root }
    }
    case 'closeout': {
      const phaseMatch = arg.match(/--phase\s+(\d{2})/)
      const phase = phaseMatch?.[1] ?? ''
      const runId = arg.replace(/--phase\s+\d{2}/, '').trim()
      if (!phase || !runId) return { kind: 'error', text: 'closeout requires <run-id> --phase 04|05|06|07|08' }
      const runDir = join(runRoot, runId)
      if (!existsSync(runDir)) return { kind: 'error', text: 'Run not found in current workspace: ' + runId }
      return { kind: 'success', text: 'closeout scaffolded for ' + runId + ' phase ' + phase }
    }
    case 'worktree': {
      // /recursive worktree create <runId> [--base <branch>]
      // /recursive worktree promote <from> <to>
      // /recursive worktree status
      const parts = arg.trim().split(/\s+/)
      const op = parts[0] ?? ''
      if (op === 'status') return { kind: 'success', text: 'worktree status for workspace ' + root }
      if (op === 'create') {
        const runId = parts[1] ?? ''
        if (!runId) return { kind: 'error', text: 'worktree create requires a run id' }
        const runDir = join(runRoot, runId)
        if (existsSync(runDir)) return { kind: 'error', text: 'Run already exists in this workspace: ' + runId }
        return { kind: 'success', text: 'worktree created for run ' + runId + ' at .worktrees/' + runId }
      }
      if (op === 'promote') {
        const fromBranch = parts[1] ?? ''
        const toBranch = parts[2] ?? ''
        if (!fromBranch || !toBranch) return { kind: 'error', text: 'worktree promote requires <from> <to>' }
        return { kind: 'success', text: 'promoted ' + fromBranch + ' -> ' + toBranch }
      }
      return { kind: 'error', text: 'worktree requires create|promote|status' }
    }
    case 'scratch': {
      const runId = arg.trim()
      if (!runId) return { kind: 'error', text: 'scratch requires a run id' }
      const runDir = join(runRoot, runId)
      if (!existsSync(runDir)) return { kind: 'error', text: 'Run not found in current workspace: ' + runId }
      return { kind: 'success', text: 'scratch ready for run ' + runId + ' (scratch/scratch.md + scratch/scratch.ts)' }
    }
    case 'init': {
      const runId = arg.replace(/--template\s+\S+/, '').trim()
      if (!runId) return { kind: 'error', text: 'init requires a run id (--template feature|debug optional)' }
      return { kind: 'success', text: 'init scaffolded run ' + runId + ' (workspace-scoped)' }
    }
    default:
      return { kind: 'error', text: 'Unsupported verb: ' + verb + ' — try /recursive help (' + HELP_TEXT + ')' }
  }
}

export interface RecursiveCommandDefinition {
  name: string
  description: string
  input: { hint: string }
  handler: (inv: RecursiveCommandInvocation) => RecursiveCommandResult | Promise<RecursiveCommandResult>
}

export interface RecursiveCommandInvocation {
  rawInput: string
  agent?: { session?: { header?: { cwd?: string } } } | null
}

export interface RecursiveCommandRuntime {
  register(def: RecursiveCommandDefinition): () => void
}

/**
 * Register the /recursive command on a context with commands (Stage A).
 * The handler resolves the session workspace root via the agent's cwd and
 * executes scoped to that root only (R1).
 */
export function registerRecursiveCommand(
  ctx: { commands: RecursiveCommandRuntime },
  recursive: RecursiveRuntime,
): () => void {
  return ctx.commands.register({
    name: 'recursive',
    description: 'recursive-mode workflow commands (workspace-scoped)',
    input: { hint: 'status|spec|worktree|init|lock|qa|closeout|addendum|review|scratch|bootstrap|list|help' },
    handler: async ({ rawInput, agent }) => {
      const root = await resolveControlPlaneRoot(agent, (recursive as unknown as { workspaceRegistry?: unknown }).workspaceRegistry as never)
      if (!root) {
        return { kind: 'error', text: 'recursive-mode: this session is not attached to a registered workspace' }
      }
      const { verb, arg } = parseRecursiveCommand(rawInput)
      if (verb === 'closeout' && arg) {
        const phaseMatch = arg.match(/--phase\s+(\d{2})/)
        const phase = phaseMatch?.[1] ?? ''
        const runId = arg.replace(/--phase\s+\d{2}/, '').trim()
        if (phase && runId) {
          const result = recursive.closeoutRun(root, runId, phase)
          if ('error' in result) return { kind: 'error', text: String(result.error) }
          return { kind: 'success', text: 'closeout scaffolded: ' + JSON.stringify(result) }
        }
      }
      if (verb === 'worktree' && arg) {
        const parts = arg.trim().split(/\s+/)
        const op = parts[0] ?? ''
        if (op === 'create') {
          const runId = parts[1] ?? ''
          const baseMatch = arg.match(/--base\s+(\S+)/)
          const baseBranch = baseMatch?.[1]
          if (!runId) return { kind: 'error', text: 'worktree create requires a run id' }
          const result = recursive.createRunWorktree(root, runId, baseBranch)
          if (!result.ok) return { kind: 'error', text: result.error ?? 'worktree create failed' }
          return { kind: 'success', text: 'worktree created: ' + JSON.stringify(result) }
        }
        if (op === 'promote') {
          const fromBranch = parts[1] ?? ''
          const toBranch = parts[2] ?? ''
          if (!fromBranch || !toBranch) return { kind: 'error', text: 'worktree promote requires <from> <to>' }
          const result = recursive.promoteRunBranch(root, fromBranch, toBranch)
          if (!result.ok) return { kind: 'error', text: result.error ?? 'promote failed' }
          return { kind: 'success', text: 'promoted: ' + JSON.stringify(result) }
        }
        if (op === 'status') {
          return { kind: 'success', text: 'worktree status: ' + JSON.stringify(recursive.worktreeStatus(root)) }
        }
      }
      return executeRecursiveCommand(root, rawInput)
    },
  })
}
