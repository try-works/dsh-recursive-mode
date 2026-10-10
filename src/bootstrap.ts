/**
 * Idempotent scaffold installer (R3). TS port of install-recursive-mode.py's
 * core: bootstrap the FULL canonical /.recursive/ control plane + cross-tool
 * bridges byte-identically (RECURSIVE.md marker-wrapped, AGENTS.md, STATE/
 * DECISIONS, memory routers + shards, config/recursive-router.json, .gitignore),
 * plus the agent/session-start Stage B (new vs resume) workspace-scoped to the
 * session's control-plane root (R1).
 *
 * ⚠ NO `.recursive/scripts/` IS CREATED, and a legacy one is removed once it is empty — see the block in
 * the scaffold below for the measurement that decided it.
 *
 * Templates + bodies + runtime scripts are SHIPPED package files under
 * references/ (never inlined TS string literals) and resolved relative to this
 * module (package install location), never process.cwd().
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
/** Package root: <package>/src/.. — references/ sits next to src/. */
export const PACKAGE_ROOT = join(MODULE_DIR, '..')

/** references/ root (shipped package files). */
export function referencesRoot(): string {
  return join(PACKAGE_ROOT, 'references')
}

export interface BootstrapResult {
  root: string
  bootstrapped: boolean
  created: string[]
  existing: string[]
}

export interface StageBResult {
  root: string
  source: 'new' | 'resume'
  bootstrapped: boolean
  runs: string[]
  activeRunId?: string
}

// Marker strings (byte-identical to the canonical installer).
const M = {
  recursiveStart: '<!-- RECURSIVE-MODE-CANONICAL:START -->',
  recursiveEnd: '<!-- RECURSIVE-MODE-CANONICAL:END -->',
  memoryStart: '<!-- RECURSIVE-MODE-MEMORY:START -->',
  memoryEnd: '<!-- RECURSIVE-MODE-MEMORY:END -->',
  agentsStart: '<!-- RECURSIVE-MODE-AGENTS:START -->',
  agentsEnd: '<!-- RECURSIVE-MODE-AGENTS:END -->',
  plansStart: '<!-- RECURSIVE-MODE-PLANS-BRIDGE:START -->',
  plansEnd: '<!-- RECURSIVE-MODE-PLANS-BRIDGE:END -->',
  cursorrulesStart: '# RECURSIVE-MODE-MEMORY-POINTERS:START',
  cursorrulesEnd: '# RECURSIVE-MODE-MEMORY-POINTERS:END',
  repoMdStart: '<!-- RECURSIVE-MODE-MEMORY-POINTERS:START -->',
  repoMdEnd: '<!-- RECURSIVE-MODE-MEMORY-POINTERS:END -->',
}

/** write_utf8_no_bom: LF newlines, no BOM. */
export function writeUtf8NoBom(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8' })
}

/** ensure_gitignore_line: add the line when absent (preserving existing). */
function ensureGitignoreLine(repoRoot: string, line: string): void {
  const gitignorePath = join(repoRoot, '.gitignore')
  const normalized = line.trim()
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
  const existingLines = existing.split(/\r?\n/)
  if (existingLines.some(c => c.trim() === normalized)) return
  let updated = existing
  if (updated && !updated.endsWith('\n')) updated += '\n'
  updated += normalized + '\n'
  writeUtf8NoBom(gitignorePath, updated)
}

/** upsert_marked_block: replace the START..END block, else append after existing. */
function upsertMarkedBlock(filePath: string, startMarker: string, endMarker: string, blockBody: string): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const block = startMarker + '\n' + blockBody + '\n' + endMarker
  const pattern = new RegExp(escapeRegExp(startMarker) + '[\\s\\S]*?' + escapeRegExp(endMarker))
  let updated: string
  if (pattern.test(existing)) {
    updated = existing.replace(pattern, block)
  } else if (existing.trim() !== '') {
    updated = existing.replace(/\s+$/, '') + '\n\n' + block + '\n'
  } else {
    updated = block + '\n'
  }
  if (updated !== existing) writeUtf8NoBom(filePath, updated)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** normalize_plain_or_wrapped_content: strip markers; return plain body when wrapped. */
function normalizePlainOrWrappedContent(content: string, startMarker: string, endMarker: string): string {
  const startIndex = content.indexOf(startMarker)
  const endIndex = content.lastIndexOf(endMarker)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return content.replace(/\r?\n+$/, '')
  }
  const prefix = content.slice(0, startIndex).replace(/\r?\n+$/, '')
  if (prefix.trim() !== '') return prefix
  const bodyStart = startIndex + startMarker.length
  return content.slice(bodyStart, endIndex).replace(/^\r?\n+|\r?\n+$/g, '')
}

/** upsert_or_migrate_canonical: canonical block upsert with plain-file migration. */
function upsertOrMigrateCanonical(filePath: string, startMarker: string, endMarker: string, canonicalBody: string): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const block = startMarker + '\n' + canonicalBody.replace(/\r?\n+$/, '') + '\n' + endMarker
  const pattern = new RegExp(escapeRegExp(startMarker) + '[\\s\\S]*?' + escapeRegExp(endMarker))
  let updated: string
  if (pattern.test(existing)) {
    updated = existing.replace(pattern, block)
  } else if (existing.trim() === '') {
    updated = block + '\n'
  } else if (existing.replace(/\r?\n+$/, '') === canonicalBody.replace(/\r?\n+$/, '')) {
    updated = block + '\n'
  } else {
    updated = existing.replace(/\s+$/, '') + '\n\n' + block + '\n'
  }
  if (updated !== existing) writeUtf8NoBom(filePath, updated)
}

/** Read a shipped body file (references/bodies/<name>) — CRLF-normalized. */
function body(name: string): string {
  return readFileSync(join(referencesRoot(), 'bodies', name), 'utf8').replace(/\r\n/g, '\n')
}

/** Read the canonical RECURSIVE.md template from shipped references/bootstrap/ — CRLF-normalized. */
function canonicalWorkflowContent(): string {
  return readFileSync(join(referencesRoot(), 'bootstrap', 'RECURSIVE.md'), 'utf8').replace(/\r\n/g, '\n')
}

/** Read the agents bridge block from shipped references/ — CRLF-normalized. */
function agentsBlockContent(): string {
  return readFileSync(join(referencesRoot(), 'agents-block.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\r?\n+$/, '')
}

/** default_router_policy(): byte-identical to recursive_router_lib.default_router_policy + pretty_json. */
function defaultRouterPolicy(): string {
  const roleRoutes: Record<string, Record<string, unknown>> = {
    orchestrator: { enabled: true, mode: 'local-only', cli: null, model: null, fallback: 'local-controller' },
    analyst: { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
    planner: { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
    implementer: { enabled: false, mode: 'external-cli', cli: null, model: null, fallback: 'local-controller' },
    'code-reviewer': { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
    tester: { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
    'memory-auditor': { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
  }
  const policy = {
    version: 1,
    defaults: {
      when_role_unconfigured: 'ask',
      when_cli_unavailable: 'fallback-local',
      when_model_unknown: 'ask',
      allow_auto_assign_if_single_cli: false,
      probe_timeout_ms: 50000,
      invoke_timeout_ms: 180000,
    },
    role_routes: roleRoutes,
    cli_overrides: {},
    custom_clis: [],
  }
  return JSON.stringify(policy, null, 2) + '\n'
}

/** ensure_router_scaffold: write config/recursive-router.json when missing. */
function ensureRouterScaffold(repoRoot: string): void {
  const configDir = join(repoRoot, '.recursive', 'config')
  const policyPath = join(configDir, 'recursive-router.json')
  if (!existsSync(policyPath)) {
    mkdirSync(configDir, { recursive: true })
    writeUtf8NoBom(policyPath, defaultRouterPolicy())
  }
}

/**
 * Idempotent scaffold install: reproduce the canonical installer's 82-file
 * tree byte-for-byte. Never overwrites existing user content; marked blocks
 * are re-upserted in place.
 */
export function bootstrapScaffold(root: string): BootstrapResult {
  const created: string[] = []
  const existing: string[] = []

  const noteDir = (rel: string) => {
    const p = join(root, rel)
    if (existsSync(p)) existing.push(rel + '/')
    else { mkdirSync(p, { recursive: true }); created.push(rel + '/') }
  }
  const noteFile = (rel: string, content?: string) => {
    const p = join(root, rel)
    if (existsSync(p)) { existing.push(rel); return }
    if (content !== undefined) {
      mkdirSync(dirname(p), { recursive: true })
      writeUtf8NoBom(p, content)
    } else {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, '')
    }
    created.push(rel)
  }

  const recursiveRoot = join(root, '.recursive')
  const memoryRoot = join(recursiveRoot, 'memory')
  const skillMemoryRoot = join(memoryRoot, 'skills')

  // Directories.
  for (const rel of [
    '.recursive', '.codex', '.agent', '.github',
    '.recursive/memory', '.recursive/memory/training', '.recursive/memory/skills', '.recursive/run', '.recursive/config',
  ]) noteDir(rel)
  for (const sub of ['domains', 'patterns', 'incidents', 'episodes', 'archive']) noteDir(join('.recursive/memory', sub))
  for (const sub of ['availability', 'usage', 'issues', 'patterns']) noteDir(join('.recursive/memory/skills', sub))

  // .gitkeeps.
  for (const rel of [
    '.recursive/memory/domains/.gitkeep', '.recursive/memory/patterns/.gitkeep', '.recursive/memory/incidents/.gitkeep',
    '.recursive/memory/episodes/.gitkeep', '.recursive/memory/archive/.gitkeep', '.recursive/memory/training/.gitkeep',
    '.recursive/memory/skills/availability/.gitkeep', '.recursive/memory/skills/usage/.gitkeep',
    '.recursive/memory/skills/issues/.gitkeep', '.recursive/memory/skills/patterns/.gitkeep', '.recursive/run/.gitkeep',
  ]) noteFile(rel, '')

  // Runtime scripts: TS-ONLY, AND THE EMPTY DIRECTORY IS NO LONGER CREATED.
  //
  // ⚠ WHY IT GONE. It used to be scaffolded EMPTY — no .py/.ps1 is vendored, because lint/lock/status/
  // closeout all run in-process as TS tools — while two shipped documents pointed INTO it: the `CLAUDE.md`
  // memory pointers at `.recursive/scripts/recursive-training-loader.py`, and the canonical `RECURSIVE.md`
  // at `.recursive/scripts/recursive-lock.py` / `verify-locks.py`. An empty directory that shipped documents
  // send an agent into is a TRAP, not tree-shape parity: the agent follows the documented path, finds
  // nothing, and the memory plane those documents promised never loads. Measured in three live runs — the
  // directory was empty in every one, and no run ever locked a phase. Nothing in this package reads or
  // executes anything from it; the only code that ever touched it is the legacy cleanup below.
  //
  // ⚠ THE CLEANUP STAYS, AND NOW FINISHES THE JOB. The pre-0.1.6 scaffold vendored 29 .py + .ps1 wrappers
  // into real workspaces, so those are still deleted wherever they are found — and the directory is then
  // removed when it is EMPTY, because leaving it behind is the same trap for the next agent. A directory
  // still holding anything else is that user's and is left untouched.
  {
    const scriptsDir = join(recursiveRoot, 'scripts')
    if (existsSync(scriptsDir)) {
      for (const name of readdirSync(scriptsDir)) {
        if (name.endsWith('.py') || name.endsWith('.ps1')) {
          rmSync(join(scriptsDir, name), { force: true })
        }
      }
      // ⚠ `rmdirSync`, NOT `rmSync({ recursive: false })`: measured — the latter throws `ERR_FS_EISDIR`
      // on a directory, and a silently caught error here would leave exactly the empty directory this
      // block exists to remove. A spec asserts the directory is GONE, so the wrong call cannot hide.
      try {
        if (readdirSync(scriptsDir).length === 0) rmdirSync(scriptsDir)
      } catch {
        // A directory that cannot be removed is not a scaffold failure, and never a reason to stop.
      }
    }
  }

  // Plain control-plane files (trailing newline).
  noteFile('.recursive/RECURSIVE.md', '# RECURSIVE.md\n')
  noteFile('.recursive/AGENTS.md', '# AGENTS.md\n')
  noteFile('.recursive/STATE.md', body('state.md') + '\n')
  noteFile('.recursive/DECISIONS.md', body('decisions.md') + '\n')
  noteFile('.recursive/memory/MEMORY.md', '# MEMORY.md\n')
  noteFile('.recursive/memory/skills/SKILLS.md', '# SKILLS.md\n')
  noteFile('.recursive/memory/skills/usage/skill-discovery-and-evaluation.md', body('skill-discovery.md') + '\n')
  noteFile('.recursive/memory/skills/patterns/delegated-verification-and-refresh.md', body('delegated-verification.md') + '\n')
  noteFile('.recursive/memory/skills/patterns/phase8-skill-memory-promotion.md', body('phase8-skill-memory.md') + '\n')
  noteFile('.codex/AGENTS.md', '# AGENTS.md\n')
  noteFile('.agent/PLANS.md', '# PLANS.md\n')
  noteFile('.cursorrules', '')
  noteFile('CLAUDE.md', '')
  noteFile('.github/copilot-instructions.md', '')

  // .gitignore.
  ensureGitignoreLine(root, '/.recursive/config/recursive-router-discovered.json')

  // Router config.
  ensureRouterScaffold(root)

  // Marked blocks.
  upsertMarkedBlock(join(recursiveRoot, 'AGENTS.md'), M.agentsStart, M.agentsEnd, body('recursive-agents-router.md'))
  upsertMarkedBlock(join(memoryRoot, 'MEMORY.md'), M.memoryStart, M.memoryEnd, body('memory-router.md'))
  upsertMarkedBlock(join(skillMemoryRoot, 'SKILLS.md'), M.memoryStart, M.memoryEnd, body('skill-memory-router.md'))
  upsertMarkedBlock(join(root, '.cursorrules'), M.cursorrulesStart, M.cursorrulesEnd, body('cursorrules.md'))
  upsertMarkedBlock(join(root, 'CLAUDE.md'), M.repoMdStart, M.repoMdEnd, body('claude.md'))
  upsertMarkedBlock(join(root, '.github', 'copilot-instructions.md'), M.repoMdStart, M.repoMdEnd, body('copilot.md'))
  upsertMarkedBlock(join(root, '.codex', 'AGENTS.md'), M.agentsStart, M.agentsEnd, body('codex-agents.md'))
  const rootAgents = join(root, 'AGENTS.md')
  if (existsSync(rootAgents)) {
    upsertMarkedBlock(rootAgents, M.agentsStart, M.agentsEnd, agentsBlockContent())
  }
  upsertMarkedBlock(join(root, '.agent', 'PLANS.md'), M.plansStart, M.plansEnd, body('plans-bridge.md'))

  // Canonical RECURSIVE.md (marker-wrapped, migrate plain installs).
  const canonicalBody = normalizePlainOrWrappedContent(canonicalWorkflowContent(), M.recursiveStart, M.recursiveEnd)
  upsertOrMigrateCanonical(join(recursiveRoot, 'RECURSIVE.md'), M.recursiveStart, M.recursiveEnd, canonicalBody)

  return { root, bootstrapped: created.length > 0, created, existing }
}

function buffersEqual(a: string, b: string): boolean {
  const ab = readFileSync(a)
  const bb = readFileSync(b)
  return ab.length === bb.length && ab.equals(bb)
}

/**
 * Enumerate runs as directory names only (bounded O(#dirs)). Never reads
 * run docs; never returns file paths.
 */
export function enumerateRuns(root: string): string[] {
  const runRoot = join(root, '.recursive', 'run')
  if (!existsSync(runRoot)) return []
  return readdirSync(runRoot, { withFileTypes: true })
    .filter(d => {
      if (d.isDirectory()) return true
      if (!d.isSymbolicLink()) return false
      try { return statSync(join(runRoot, d.name)).isDirectory() } catch { return false }
    })
    .map(d => d.name)
    .sort()
}

export interface StageBInput {
  root: string
  source: 'new' | 'resume'
  activeRunId?: string
}

/**
 * Stage B workflow init at agent/session-start. New: bootstrap if missing +
 * enumerate runs. Resume: idempotent REPAIR (not a full re-bootstrap) — the
 * upsert-only bootstrapScaffold adds missing control-plane files/dirs and
 * re-upserts marked blocks WITHOUT overwriting user content or touching run/
 * artifacts, then enumerates + notes the active run. The repair is safe on
 * fresh, partial, AND complete scaffolds (run 09 R3/R6). Always scoped to the
 * given control-plane root.
 */
export function stageBWorkflowInit(input: StageBInput): StageBResult {
  const { root, source, activeRunId } = input
  const bootstrap = bootstrapScaffold(root)
  const runs = enumerateRuns(root)
  return {
    root,
    source,
    bootstrapped: source === 'new' ? bootstrap.bootstrapped : false,
    runs,
    activeRunId,
  }
}