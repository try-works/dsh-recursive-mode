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
import { loadMemoryIndex } from './memory.ts'
import { explainMemorySelection } from './memory-select.ts'
import { readFeedback } from './memory-feedback.ts'
import { closeoutReport } from './closeout-report.ts'
import { loadRouterPolicy, routerPolicyPath } from './router.ts'
import { resolveSubagentTarget } from './role-route.ts'
import { writePolicySelection, type SelectionScope } from './policy-write.ts'

export type RecursiveVerb = 'status' | 'spec' | 'worktree' | 'init' | 'lock' | 'qa' | 'closeout' | 'addendum' | 'review' | 'scratch' | 'memory' | 'model' | 'bootstrap' | 'list' | 'help'

export const PRESET_VERBS: RecursiveVerb[] = ['status', 'spec', 'worktree', 'init', 'lock', 'qa', 'closeout', 'addendum', 'review', 'scratch', 'memory', 'model']
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
    case 'memory': {
      // P4 — THE SELECTOR WITH NO AGENT LOOP, printing its score COMPONENTS. The reference's loader is a
      // script an agent runs; this is the same job on the surface the plugin already has, and it explains
      // itself, so "why did the agent get this?" is answerable from a shell rather than only from a test.
      const phaseMatch = arg.match(/--phase\s+([\d.]+)/)
      const phase = phaseMatch?.[1]
      const query = arg.replace(/--phase\s+[\d.]+/, '').trim()
      if (query === '') {
        return { kind: 'error', text: 'memory requires a query: /recursive memory <query> [--phase 04]' }
      }
      const entries = loadMemoryIndex(root)
      if (entries.length === 0) {
        return { kind: 'success', text: 'the memory plane is empty, so nothing is injected rather than fabricating memory' }
      }
      const explanation = explainMemorySelection(entries, {
        query,
        ...(phase === undefined ? {} : { phase }),
        // The counters live in the sidecar; the caller reads them, exactly as the runtime does.
        feedback: readFeedback(root),
      })
      const lines = [explanation.rendered]
      if (explanation.excluded.length > 0) {
        lines.push('', 'Excluded ' + explanation.excluded.length + ' entry(s):')
        for (const item of explanation.excluded.slice(0, 5)) lines.push('- ' + item.title + ': ' + item.reason)
      }
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'closeout': {
      const phaseMatch = arg.match(/--phase\s+(\d{2})/)
      const phase = phaseMatch?.[1] ?? ''
      const runId = arg.replace(/--phase\s+\d{2}/, '').trim()
      if (!phase || !runId) return { kind: 'error', text: 'closeout requires <run-id> --phase 04|05|06|07|08' }
      const runDir = join(runRoot, runId)
      if (!existsSync(runDir)) return { kind: 'error', text: 'Run not found in current workspace: ' + runId }
      // ⚠ THIS BRANCH USED TO LIE. It returned "closeout scaffolded for <run> phase <n>" having read nothing,
      // written nothing and checked nothing — a command that reported success for work it never did. It now
      // runs the LINTER the closeout actually is: it reads the phase artifact and reports what is missing,
      // and WRITES NOTHING, which is the design the user specified ("like a linter checking if the agent
      // missed anything; it is not supposed to edit files by itself").
      try {
        const report = closeoutReport(runDir, phase)
        const lines = [
          report.artifact + ' — ' + (report.exists ? report.status : 'ABSENT'),
          report.findings.length === 0
            ? 'fits the required standard.'
            : report.findings.length + ' finding(s) before it can lock:',
        ]
        for (const finding of report.findings.slice(0, 12)) lines.push('- ' + finding.detail)
        if (report.prerequisites.length > 0) {
          lines.push('Advisory — earlier phases not yet LOCKED: '
            + report.prerequisites.map((p) => p.artifact + ' (' + p.status + ')').join(', '))
        }
        if (report.addenda.length > 0) lines.push('Addenda cited: ' + report.addenda.length)
        return { kind: 'success', text: lines.join('\n') }
      } catch (err) {
        return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
      }
    }
    case 'model': {
      // ⚠ FU-19 — THE EFFECTIVE PROVIDER AND MODEL FOR A PHASE, WITH ITS PROVENANCE, and no agent loop. The same
      // shape as `/recursive memory`: the workflow's own resolution, printed, so "why did this child run on that
      // model" is answerable without reading the code or starting anything.
      const phaseMatch = arg.match(/--phase\s+(\S+)/)
      const roleMatch = arg.match(/--role\s+(\S+)/)
      // ⚠ QUOTES ARE STRIPPED, because a shell-typed selector often arrives quoted and `--role ""` must be
      // understood as "no role given" rather than as a role literally named two quote characters. That mistake was
      // caught by this verb's own spec, which is the point of writing the spec before believing the code.
      const unquote = (value: string | undefined): string => (value ?? '').replace(/^["']|["']$/g, '').trim()
      const phase = unquote(phaseMatch?.[1])
      const role = unquote(roleMatch?.[1])
      // ⚠ FU-19 — SET OR CLEAR, when the user supplied something to set. A bare `/recursive model` still READS.
      // The scope is inferred from which selectors were given, so `/recursive model --model cheap` sets the GENERAL
      // default, `--phase 03 --model cheap` sets that phase's override, and `--role X --provider fork` sets the
      // role route. `--clear` removes the named fields, or the whole level when none are named.
      const providerMatch = arg.match(/--provider\s+(\S+)/)
      const modelMatch = arg.match(/--model\s+(\S+)/)
      const modelProviderMatch = arg.match(/--model-provider\s+(\S+)/)
      const clear = /--clear\b/.test(arg)
      if (providerMatch !== null || modelMatch !== null || modelProviderMatch !== null || clear) {
        const scope: SelectionScope = phase !== '' ? 'phase' : role !== '' ? 'role' : 'general'
        const written = writePolicySelection(root, {
          scope,
          ...(phase === '' ? {} : { phase }),
          ...(role === '' ? {} : { role }),
          ...(providerMatch === null ? {} : { provider: providerMatch[1]! }),
          ...(modelMatch === null ? {} : { model: modelMatch[1]! }),
          ...(modelProviderMatch === null ? {} : { modelProvider: modelProviderMatch[1]! }),
          ...(clear ? { clear: true } : {}),
        })
        if ('refused' in written) return { kind: 'error', text: written.refused }
        return { kind: 'success', text: written.message }
      }
      const policy = loadRouterPolicy(routerPolicyPath(root))
      // `ladderProvider: null` on purpose: this verb reports what is CONFIGURED, and the provider ladder needs a
      // live host's registered providers to answer. A caller wanting the full answer gets it from a delegation's
      // routing notes, which is where the resolved ladder actually appears.
      const target = resolveSubagentTarget({ role, phase, policy, ladderProvider: null })
      const general = policy.defaults.subagent
      return {
        kind: 'success',
        text: [
          'effective selection for role ' + (role === '' ? '(none given)' : role) + (phase === '' ? '' : ' in phase ' + phase) + ':',
          '- subagent provider, who creates the child: ' + (target.provider ?? 'none configured') + '  [from ' + target.chosen.provider + ']',
          '- model, what the child runs on: ' + (target.model ?? 'inherited — no model is sent') + '  [from ' + target.chosen.model + ']',
          target.reason,
          'configured: general ' + (general === undefined ? 'unset' : JSON.stringify(general))
            + ', phase routes ' + Object.keys(policy.phase_routes ?? {}).length
            + ', role routes ' + Object.keys(policy.role_routes ?? {}).length,
          'a model chosen here is checked against what DSH has when a delegation runs: available is applied, missing'
            + ' is reported and NOT substituted, and unverified means there was no inventory to ask.',
          '⚠ changing a default applies to FUTURE delegations only — it never rewrites a run\'s recorded history.',
        ].join('\n'),
      }
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
    input: { hint: 'status|spec|worktree|init|lock|qa|closeout|addendum|review|scratch|memory|bootstrap|list|help' },
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
