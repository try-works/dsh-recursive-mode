/**
 * ts-lint.ts (R1, run 09): FULL TS port of the canonical lint-recursive-run.py.
 * In-process lint with byte-identical [FAIL]/[WARN] verdicts + Summary.
 * No python is shelled out anywhere in the plugin.
 *
 * Constants + per-phase required sections are imported from phase-rules.ts
 * (single source of truth, already at 14/14 canonical parity).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { verifyBranchBase, verifyWorktreeBranch } from './git-context.ts'
import {
  CURRENT_WORKFLOW_PROFILE,
  STRICT_WORKFLOW_PROFILE,
  COMPAT_WORKFLOW_PROFILE,
  STRICT_WORKFLOW_PROFILES,
  LATE_PHASE_ARTIFACTS,
  AUDITED_PHASE_FILES,
  PRIOR_RECURSIVE_EVIDENCE_FILES,
  DIFF_AUDITED_FILES,
  TRACEABILITY_REQUIRED_FILES,
  AUDIT_REQUIRED_HEADINGS,
  DIFF_BASIS_FIELDS,
  getArtifactRequiredSections,
} from './phase-rules.ts'

// ---- remaining constants not in phase-rules.ts ----
export const PRODUCT_DIFF_PHASE_FILES = new Set(['03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md'])
export const DECISIONS_DIFF_PHASE_FILES = new Set(['06-decisions-update.md'])
export const STATE_DIFF_PHASE_FILES = new Set(['07-state-update.md'])
export const MEMORY_DIFF_PHASE_FILES = new Set(['08-memory-impact.md'])
export const MEMORY_ALLOWED_TYPES = new Set(['index', 'domain', 'pattern', 'incident', 'episode'])
export const MEMORY_ALLOWED_STATUSES = new Set(['CURRENT', 'SUSPECT', 'STALE', 'DEPRECATED', 'DRAFT'])
export const MEMORY_REQUIRED_FIELDS = [
  'Type', 'Status', 'Scope', 'Owns-Paths', 'Watch-Paths', 'Source-Runs',
  'Validated-At-Commit', 'Last-Validated', 'Tags',
]
export const TDD_MODES = new Set(['strict', 'pragmatic'])
export const QA_EXECUTION_MODES = new Set(['human', 'agent-operated', 'hybrid'])
export const TRANSIENT_RUNTIME_DIR_MARKERS = new Set([
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis',
  '.tox', '.nox', '.target', '.playwright-mcp', '.cargo-target-dir',
])
export const TRANSIENT_RUNTIME_FILE_NAMES = new Set(['.ds_store', 'thumbs.db'])
export const TRANSIENT_RUNTIME_SUFFIXES = ['.pyc', '.pyo', '.pyd']
export const DIFF_BASIS_ALLOWED_TYPES = new Set(['local commit', 'local branch', 'remote ref', 'merge-base derived'])
export const WORKING_TREE_COMPARISON_REFS = new Set(['working-tree', 'working-tree@head', 'worktree', 'working-tree+head'])
export const INVENTORY_DISPOSITIONS = new Set(['in-scope', 'out-of-scope', 'constraint', 'quality-gate'])
export const PHASE2_REQUIREMENT_DISPOSITION_STATUSES = new Set([
  'planned', 'planned-via-merge', 'planned-indirectly', 'deferred', 'out-of-scope', 'blocked',
  'superseded by approved addendum',
])
export const REQUIREMENT_DISPOSITION_STATUSES = new Set([
  'implemented', 'verified', 'deferred', 'out-of-scope', 'blocked', 'superseded by approved addendum',
])
export const SKILL_USAGE_RELEVANCE_STATUSES = new Set(['relevant', 'not-relevant', 'yes', 'no'])
export const FINAL_REQUIREMENT_DISPOSITION_FILES = new Set([
  '04-test-summary.md', '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md',
])
export const REQUIREMENT_CHANGED_FILE_ACCOUNTING_FILES = new Set([
  '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md',
])
export const SUBAGENT_ACTION_REQUIRED_HEADINGS = [
  'Metadata', 'Inputs Provided', 'Claimed Actions Taken', 'Claimed File Impact',
  'Claimed Artifact Impact', 'Claimed Findings', 'Verification Handoff',
]
export const SKILL_MEMORY_ROUTER_NAMES = new Set(['MEMORY.md', 'SKILLS.md'])
export const RUN_ARTIFACT_SEQUENCE = [
  '00-requirements.md', '00-worktree.md', '01-as-is.md', '01.5-root-cause.md', '02-to-be-plan.md',
  '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md', '05-manual-qa.md',
  '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md',
]
export const REQUIREMENT_ID_RE = /^(R\d+|SRC-\d{3})$/

export interface LintIssue {
  severity: 'FAIL' | 'WARN'
  filePath: string
  message: string
}

export interface LintResult {
  errors: string[]
  warnings: string[]
  failCount: number
  warnCount: number
  passed: boolean
  summary: string
}

/** write_issue: collect [severity] path: message + remediation lines. */
const issues: LintIssue[] = []
function writeIssue(severity: 'FAIL' | 'WARN', filePath: string, message: string, remediationLines?: string[]): void {
  issues.push({ severity, filePath, message })
  console.log(`[${severity}] ${filePath}: ${message}`)
  if (remediationLines) {
    console.log('Remediation (copy/paste):')
    for (const line of remediationLines) console.log('  ' + line)
  }
  console.log()
}

/** trim_md_value: strip surrounding quotes/backticks. */
export function trimMdValue(value: string): string {
  let trimmed = value.trim()
  for (const quote of ['`', '"', "'"]) {
    if (trimmed.startsWith(quote) && trimmed.endsWith(quote) && trimmed.length >= 2) {
      const inner = trimmed.slice(1, -1)
      if (!inner.includes(quote)) return inner.trim()
    }
  }
  return trimmed
}

/** get_md_field_value: first `Field: value` line. */
export function getMdFieldValue(content: string, fieldName: string): string | null {
  const re = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escapeRegExp(fieldName)}:[ \\t]*(.+?)\\s*$`, 'm')
  const m = content.match(re)
  if (!m) return null
  return trimMdValue(m[1])
}

/** has_header_field: any `Field:` line. */
export function hasHeaderField(content: string, fieldName: string): boolean {
  const re = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escapeRegExp(fieldName)}:`, 'm')
  return re.test(content)
}

/** has_heading: `## Heading` line. */
export function hasHeading(content: string, headingText: string): boolean {
  const re = new RegExp(`^[ \\t]*##\\s+${escapeRegExp(headingText)}\\s*$`, 'm')
  return re.test(content)
}

/** get_heading_body: text under `## Heading` until next heading or end. */
export function getHeadingBody(content: string, headingText: string): string {
  const re = new RegExp(`^[ \\t]*##\\s+${escapeRegExp(headingText)}\\s*$\\n?(.*?)(?=^[ \\t]*##\\s+|\Z)`, 'ms')
  const m = content.match(re)
  if (!m) return ''
  return (m[1] ?? '').trim()
}

/** get_subheading_body: text under `### Heading` (or level N) until next N-or-less heading. */
export function getSubheadingBody(content: string, headingText: string, level = 3): string {
  const hashes = '#'.repeat(level)
  const re = new RegExp(`^[ \\t]*${escapeRegExp(hashes)}\\s+${escapeRegExp(headingText)}\\s*$\\n?(.*?)(?=^[ \\t]*#{1,${level}}\\s+|\Z)`, 'ms')
  const m = content.match(re)
  if (!m) return ''
  return (m[1] ?? '').trim()
}

/** has_gate_line: `Gate: PASS|FAIL` line. */
export function hasGateLine(content: string, gateName: string): boolean {
  const re = new RegExp(`^[ \\t]*${escapeRegExp(gateName)}:\\s*(PASS|FAIL)\\s*$`, 'm')
  return re.test(content)
}

/** get_gate_status: PASS|FAIL|MISSING. */
export function getGateStatus(content: string, gateName: string): string {
  const re = new RegExp(`^[ \\t]*${escapeRegExp(gateName)}:\\s*(PASS|FAIL)\\s*$`, 'm')
  const m = content.match(re)
  return m ? m[1].toUpperCase() : 'MISSING'
}

/** get_todo_stats: [has_todo, total, checked, unchecked] under ## TODO. */
export function getTodoStats(content: string): [boolean, number, number, number] {
  const lines = content.split(/\r?\n/)
  let inTodo = false, hasTodo = false, checked = 0, unchecked = 0, total = 0
  for (const line of lines) {
    if (!inTodo) {
      if (/^\s*##\s+TODO\s*$/.test(line)) { inTodo = true; hasTodo = true }
      continue
    }
    if (/^\s*##\s+/.test(line) || /^\s*#\s+/.test(line)) break
    const item = line.match(/^\s*[-*]\s+\[([ xX])\]\s+/)
    if (item) {
      total += 1
      if (item[1].toLowerCase() === 'x') checked += 1
      else unchecked += 1
    }
  }
  return [hasTodo, total, checked, unchecked]
}

/** get_latest_run_directory: newest mtime subdir of run_root. */
export function getLatestRunDirectory(runRoot: string): string | null {
  let runs: string[] = []
  try { runs = readdirSync(runRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return null }
  if (runs.length === 0) return null
  runs.sort((a, b) => statSync(join(runRoot, b)).mtimeMs - statSync(join(runRoot, a)).mtimeMs)
  return runs[0]
}

/** get_workflow_profile: from Workflow version field or late-phase presence. */
export function getWorkflowProfile(runDir: string): string {
  const reqPath = join(runDir, '00-requirements.md')
  if (existsSync(reqPath)) {
    const content = readFileSync(reqPath, 'utf8')
    const wf = getMdFieldValue(content, 'Workflow version')
    if (wf === CURRENT_WORKFLOW_PROFILE) return CURRENT_WORKFLOW_PROFILE
    if (wf === STRICT_WORKFLOW_PROFILE) return STRICT_WORKFLOW_PROFILE
    if (wf === COMPAT_WORKFLOW_PROFILE) return COMPAT_WORKFLOW_PROFILE
  }
  if (LATE_PHASE_ARTIFACTS.some(a => existsSync(join(runDir, a)))) return COMPAT_WORKFLOW_PROFILE
  return 'legacy'
}

/** is_placeholder_only: empty or placeholder token. */
export function isPlaceholderOnly(text: string): boolean {
  const compact = text.trim()
  if (!compact) return true
  return compact === '...' || compact === '<content>' || compact === '[...]' || compact === '[same structure]'
}

/** parse_requirement_ids: Rd+ ids from Requirements heading. */
export function parseRequirementIds(requirementsContent: string): string[] {
  const body = getHeadingBody(requirementsContent, 'Requirements') || requirementsContent
  const ids = [...new Set(body.match(/\bR\d+\b/g) ?? [])]
  ids.sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))
  return ids
}

/** requirement_sort_key: Rd+ < SRC-d{3} < other. */
export function requirementSortKey(value: string): [number, number | string, string] {
  if (/^R\d+$/.test(value)) return [0, parseInt(value.slice(1), 10), value]
  if (/^SRC-\d{3}$/.test(value)) return [1, parseInt(value.split('-')[1], 10), value]
  return [2, value, value]
}

/** normalize_source_text: collapse whitespace, strip quotes/backticks, lowercase. */
export function normalizeSourceText(value: string): string {
  return value.replace(/`/g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** source_quote_matches: normalized quote appears in requirements content. */
export function sourceQuoteMatches(sourceQuote: string, requirementsContent: string): boolean {
  const nq = normalizeSourceText(sourceQuote)
  const nr = normalizeSourceText(requirementsContent)
  return Boolean(nq) && nr.includes(nq)
}

/** escapeRegExp helper. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** content_sha256: sha256 hex of UTF-8 content (LF-normalized). */
export function contentSha256(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

/** extract_paths_from_text: backtick paths with / or . in name, non-git, non-placeholder. */
export function extractPathsFromText(text: string): Set<string> {
  const paths = new Set<string>()
  const re = /`([^`\n]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const candidate = m[1].trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (!candidate || candidate.toLowerCase().startsWith('git ')) continue
    if (candidate.startsWith('<') && candidate.endsWith('>')) continue
    const name = candidate.split('/').pop() ?? ''
    if (candidate.includes('/') || name.includes('.')) paths.add(candidate)
  }
  return paths
}

/** extract_paths_from_field_value: backtick paths, else split on ,; newline. */
export function extractPathsFromFieldValue(text: string): Set<string> {
  const paths = extractPathsFromText(text)
  if (paths.size > 0) return paths
  const discovered = new Set<string>()
  for (const candidateRaw of trimMdValue(text).split(/[,;\n]/)) {
    const candidate = candidateRaw.trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (!candidate || candidate.toLowerCase().startsWith('git ')) continue
    if (candidate.startsWith('<') && candidate.endsWith('>')) continue
    const name = candidate.split('/').pop() ?? ''
    if (candidate.includes('/') || name.includes('.')) discovered.add(candidate)
  }
  return discovered
}

/** extract_paths_from_named_field: inline value or block body until next field. */
export function extractPathsFromNamedField(content: string, fieldName: string): Set<string> {
  const inlineValue = getMdFieldValue(content, fieldName)
  if (inlineValue !== null) return extractPathsFromFieldValue(inlineValue)
  const re = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escapeRegExp(fieldName)}:[ \\t]*$\\n(.*?)(?=^[ \\t]*(?:[-*][ \\t]+)?[A-Za-z][^:\\n]*:[ \\t]*|\Z)`, 'ms')
  const m = content.match(re)
  if (!m) return new Set()
  const out = new Set<string>()
  for (const path of extractPathsFromText(m[1] ?? '')) {
    const normalized = normalizeRepoPath(path)
    if (normalized) out.add(normalized)
  }
  return out
}

/** get_named_field_text: inline value or block body until next field. */
export function getNamedFieldText(content: string, fieldName: string): string | null {
  const inlineValue = getMdFieldValue(content, fieldName)
  if (inlineValue !== null) return inlineValue
  const re = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escapeRegExp(fieldName)}:[ \\t]*$\\n(.*?)(?=^[ \\t]*(?:[-*][ \\t]+)?[A-Za-z][^:\\n]*:[ \\t]*|\Z)`, 'ms')
  const m = content.match(re)
  if (!m) return null
  return (m[1] ?? '').trim()
}

/** has_meaningful_value: non-empty and not in disallowed set. */
export function hasMeaningfulValue(value: string | null, disallowed?: Set<string>): boolean {
  if (value === null) return false
  const normalized = trimMdValue(value).trim()
  if (!normalized) return false
  return !(disallowed ?? new Set()).has(normalized.toLowerCase())
}

/** collect_subagent_delegation_issues: audit-context consistency rules. */
export function collectSubagentDelegationIssues(auditContext: string): string[] {
  const issues: string[] = []
  const mode = getMdFieldValue(auditContext, 'Audit Execution Mode')
  const availability = getMdFieldValue(auditContext, 'Subagent Availability')
  const overrideReason = getMdFieldValue(auditContext, 'Delegation Override Reason')
  if (availability === 'unavailable' && mode === 'subagent') {
    issues.push('Audit Context cannot claim Audit Execution Mode: subagent when Subagent Availability is unavailable')
  }
  if (availability === 'available' && mode === 'self-audit') {
    if (!hasMeaningfulValue(overrideReason, new Set(['n/a', 'none']))) {
      issues.push('Audit Context is missing Delegation Override Reason even though subagents were available and self-audit was chosen')
    }
  }
  return issues
}

/** collect_paths_under_prefix: sorted paths under a prefix. */
export function collectPathsUnderPrefix(text: string, prefix: string): string[] {
  return [...extractPathsFromText(text)].filter(p => p.startsWith(prefix)).sort()
}

/** find_missing_repo_paths: paths not existing under repo_root. */
export function findMissingRepoPaths(repoRoot: string, paths: string[]): string[] {
  return paths.filter(p => !existsSync(join(repoRoot, p)))
}

/** normalize_repo_path: backslash->slash, strip leading /. */
export function normalizeRepoPath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').trim().replace(/^\/+/, '')
}

/** is_addendum_artifact: file name contains .addendum-. */
export function isAddendumArtifact(fileName: string): boolean {
  return fileName.includes('.addendum-')
}

/** is_transient_runtime_path: __pycache__, .pyc, etc. */
export function isTransientRuntimePath(normalizedPath: string): boolean {
  const candidate = normalizeRepoPath(normalizedPath)
  if (!candidate) return false
  const parts = candidate.split('/')
  if (parts.some(p => TRANSIENT_RUNTIME_DIR_MARKERS.has(p))) return true
  const fileName = parts[parts.length - 1].toLowerCase()
  if (TRANSIENT_RUNTIME_FILE_NAMES.has(fileName)) return true
  return TRANSIENT_RUNTIME_SUFFIXES.some(s => fileName.endsWith(s))
}

/** filter_runtime_changed_files: drop the run's own dir + transient paths. */
export function filterRuntimeChangedFiles(paths: string[], runId: string): string[] {
  const filtered: string[] = []
  for (const rawPath of paths) {
    const normalized = normalizeRepoPath(rawPath)
    if (!normalized) continue
    if (normalized.startsWith(`.recursive/run/${runId}/`)) continue
    if (isTransientRuntimePath(normalized)) continue
    filtered.push(normalized)
  }
  return [...new Set(filtered)].sort()
}

/** run_git: run git -C repo args, return [stdout, error]. */
export function runGit(repoRoot: string, ...args: string[]): [string | null, string | null] {
  try {
    const out = execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return [String(out).trim(), null]
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number }
    if (e && typeof e === 'object' && 'status' in e) {
      const stderr = (e.stderr ?? '').toString().trim()
      const stdout = (e.stdout ?? '').toString().trim()
      const message = stderr || stdout || `git ${args.join(' ')} failed`
      return [null, message]
    }
    return [null, `Unable to execute git: ${String(err)}`]
  }
}

/** normalize_baseline_type: canonicalize baseline type with aliases. */
export function normalizeBaselineType(value: string | null): string | null {
  if (value === null) return null
  const compact = trimMdValue(value).trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ')
  if (DIFF_BASIS_ALLOWED_TYPES.has(compact)) return compact
  const aliases: Record<string, string> = {
    'commit': 'local commit', 'branch': 'local branch', 'remote': 'remote ref',
    'remote branch': 'remote ref', 'merge base': 'merge-base derived',
  }
  return aliases[compact] ?? null
}

/** normalize_comparison_reference: map working-tree refs. */
export function normalizeComparisonReference(value: string | null): string | null {
  if (value === null) return null
  const compact = trimMdValue(value).trim()
  if (!compact) return null
  if (WORKING_TREE_COMPARISON_REFS.has(compact.toLowerCase())) return 'working-tree'
  return compact
}

/** parse_diff_basis_source: heading body of Diff Basis For Later Audits / Diff Basis. */
export function parseDiffBasisSource(content: string): string {
  let body = getHeadingBody(content, 'Diff Basis For Later Audits')
  if (body) return body
  body = getHeadingBody(content, 'Diff Basis')
  if (body) return body
  return content
}

/** get_run_diff_basis: read diff-basis fields from 00-worktree.md. */
export function getRunDiffBasis(runDir: string): Record<string, string | null> {
  const worktreePath = join(runDir, '00-worktree.md')
  if (!existsSync(worktreePath)) {
    return { baseline_type: null, baseline_reference: null, comparison_reference: null, normalized_baseline: null, normalized_comparison: null, normalized_diff_command: null, base_branch: null, worktree_branch: null, notes: null }
  }
  const content = readFileSync(worktreePath, 'utf8')
  const source = parseDiffBasisSource(content)
  return {
    baseline_type: getMdFieldValue(source, 'Baseline type'),
    baseline_reference: getMdFieldValue(source, 'Baseline reference'),
    comparison_reference: getMdFieldValue(source, 'Comparison reference'),
    normalized_baseline: getMdFieldValue(source, 'Normalized baseline') ?? getMdFieldValue(source, 'Normalized baseline commit') ?? getMdFieldValue(source, 'Base commit'),
    normalized_comparison: getMdFieldValue(source, 'Normalized comparison') ?? getMdFieldValue(source, 'Normalized comparison reference') ?? getMdFieldValue(source, 'Worktree branch'),
    normalized_diff_command: getMdFieldValue(source, 'Normalized diff command') ?? getMdFieldValue(source, 'Diff command convention'),
    base_branch: getMdFieldValue(source, 'Base branch'),
    worktree_branch: getMdFieldValue(source, 'Worktree branch'),
    notes: getMdFieldValue(source, 'Diff basis notes') ?? getMdFieldValue(source, 'Notes'),
  }
}

/**
 * verify_recorded_branches: worktree + branch awareness at lint time. Compares
 * the branches recorded in 00-worktree.md against live git state. Returns a
 * list of FAIL messages (empty when consistent). Both the base branch and the
 * worktree branch must resolve; the worktree branch must match the live HEAD
 * branch, and it must actually be based on the recorded base branch.
 */
export function verifyRecordedBranches(repoRoot: string, diffBasis: Record<string, string | null>, runDir: string): string[] {
  const fails: string[] = []
  const baseBranch = trimMdValue(diffBasis.base_branch ?? '')
  const worktreeBranch = trimMdValue(diffBasis.worktree_branch ?? '')
  // Nothing recorded -> nothing to verify (defer, consistent with missing fields).
  if (!baseBranch && !worktreeBranch) return fails
  const wtCheck = verifyWorktreeBranch(repoRoot, worktreeBranch || null)
  if (!wtCheck.ok && wtCheck.reason) fails.push(wtCheck.reason)
  const baseCheck = verifyBranchBase(repoRoot, baseBranch || null, worktreeBranch || null)
  if (!baseCheck.ok && baseCheck.reason) fails.push(baseCheck.reason)
  return fails
}

/** normalize_diff_basis: validate + compute the executable diff basis. */
export function normalizeDiffBasis(repoRoot: string, diffBasis: Record<string, string | null>): [Record<string, string> | null, string | null] {
  const baselineType = normalizeBaselineType(diffBasis.baseline_type)
  const baselineReference = trimMdValue(diffBasis.baseline_reference ?? '')
  const comparisonReference = normalizeComparisonReference(diffBasis.comparison_reference)
  const normalizedBaseline = trimMdValue(diffBasis.normalized_baseline ?? '')
  const normalizedComparison = normalizeComparisonReference(diffBasis.normalized_comparison)
  const normalizedDiffCommand = trimMdValue(diffBasis.normalized_diff_command ?? '')

  const missingFields: string[] = []
  if (!baselineType) missingFields.push('Baseline type')
  if (!baselineReference) missingFields.push('Baseline reference')
  if (!comparisonReference) missingFields.push('Comparison reference')
  if (!normalizedBaseline) missingFields.push('Normalized baseline')
  if (!normalizedComparison) missingFields.push('Normalized comparison')
  if (!normalizedDiffCommand) missingFields.push('Normalized diff command')
  if (missingFields.length > 0) return [null, `Diff basis is missing required field(s): ${missingFields.join(', ')}`]

  const baselineTypeN = baselineType!
  const baselineReferenceN = baselineReference!
  const comparisonReferenceN = comparisonReference!
  const normalizedBaselineN = normalizedBaseline!
  const normalizedComparisonN = normalizedComparison!
  const normalizedDiffCommandN = normalizedDiffCommand!
  const comparisonGitRef = normalizedComparisonN === 'working-tree' ? 'HEAD' : normalizedComparisonN
  let computedBaseline: string | null
  let error: string | null
  if (baselineType === 'merge-base derived') {
    const [out, err] = runGit(repoRoot, 'merge-base', comparisonGitRef, baselineReferenceN)
    computedBaseline = out
    error = err ? `Unable to compute merge-base for diff basis: ${err}` : null
  } else {
    const [out, err] = runGit(repoRoot, 'rev-parse', '--verify', `${baselineReferenceN}^{commit}`)
    computedBaseline = out
    error = err ? `Unable to resolve baseline reference '${baselineReference}': ${err}` : null
  }
  if (error || computedBaseline === null) return [null, error ?? 'Unable to compute diff basis']
  if (normalizedBaselineN !== computedBaseline) {
    return [null, `Recorded Normalized baseline does not match the executable diff basis (${normalizedBaselineN} != ${computedBaseline})`]
  }

  let expectedCommand: string
  let gitArgs: string[]
  if (normalizedComparisonN === 'working-tree') {
    expectedCommand = `git diff --name-only ${computedBaseline}`
    gitArgs = ['diff', '--name-only', computedBaseline]
  } else {
    const [computedComparison, cmpError] = runGit(repoRoot, 'rev-parse', '--verify', `${normalizedComparisonN}^{commit}`)
    if (cmpError || computedComparison === null) return [null, `Unable to resolve comparison reference '${normalizedComparison}': ${cmpError}`]
    expectedCommand = `git diff --name-only ${computedBaseline}..${computedComparison}`
    gitArgs = ['diff', '--name-only', `${computedBaseline}..${computedComparison}`]
    if (normalizedComparisonN !== computedComparison) {
      return [null, `Recorded Normalized comparison does not match the executable diff basis (${normalizedComparisonN} != ${computedComparison})`]
    }
  }
  if (normalizedDiffCommandN !== expectedCommand) {
    return [null, `Recorded Normalized diff command does not match the executable diff basis (${normalizedDiffCommandN} != ${expectedCommand})`]
  }

  return [{
    baseline_type: baselineTypeN,
    baseline_reference: baselineReferenceN,
    comparison_reference: comparisonReferenceN,
    normalized_baseline: computedBaseline,
    normalized_comparison: normalizedComparisonN,
    normalized_diff_command: expectedCommand,
    comparison_git_ref: comparisonGitRef,
    git_args: gitArgs.join(' '),
  }, null]
}

/** get_git_changed_files: git diff --name-only + untracked (--relative). */
export function getGitChangedFiles(repoRoot: string, diffBasis: Record<string, string | null>): [string[] | null, string | null] {
  const [normalizedBasis, basisError] = normalizeDiffBasis(repoRoot, diffBasis)
  if (basisError) return [null, basisError]
  const gitArgs = (normalizedBasis!.git_args ?? '').split(' ').filter(Boolean)
  try {
    const diffOut = execFileSync('git', ['-C', repoRoot, ...gitArgs, '--relative'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const untrackedOut = execFileSync('git', ['-C', repoRoot, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const tracked = String(diffOut).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    const untracked = String(untrackedOut).split(/\r?\n/).map(s => s.trim()).filter(s => s && !isTransientRuntimePath(s))
    return [[...new Set([...tracked, ...untracked])].sort(), null]
  } catch (err) {
    return [null, `Unable to execute git: ${String(err)}`]
  }
}

/** get_phase_owned_actual_changed_files: which changed files belong to this phase. */
export function getPhaseOwnedActualChangedFiles(fileName: string, actualChangedFiles: string[] | null, repoRoot?: string): string[] | null {
  if (actualChangedFiles === null) return null
  if (fileName === '02-to-be-plan.md') return null
  const ownedPaths: string[] = []
  for (const path of actualChangedFiles) {
    if (path === '.recursive/DECISIONS.md') {
      if (DECISIONS_DIFF_PHASE_FILES.has(fileName)) ownedPaths.push(path)
      continue
    }
    if (path === '.recursive/STATE.md') {
      if (STATE_DIFF_PHASE_FILES.has(fileName)) ownedPaths.push(path)
      continue
    }
    if (path.startsWith('.recursive/memory/')) {
      if (MEMORY_DIFF_PHASE_FILES.has(fileName)) ownedPaths.push(path)
      continue
    }
    ownedPaths.push(path)
  }
  if (PRODUCT_DIFF_PHASE_FILES.has(fileName)) {
    if (repoRoot === undefined) return ownedPaths
    return ownedPaths.filter(p => existsSync(join(repoRoot, p)))
  }
  if (DECISIONS_DIFF_PHASE_FILES.has(fileName) || STATE_DIFF_PHASE_FILES.has(fileName) || MEMORY_DIFF_PHASE_FILES.has(fileName)) return ownedPaths
  return null
}

/** get_related_addenda_paths: run_dir/addenda/<base>.addendum-*.md (+ upstream-gap). */
export function getRelatedAddendaPaths(runDir: string, artifactName: string): string[] {
  const addendaDir = join(runDir, 'addenda')
  if (!existsSync(addendaDir)) return []
  const baseName = artifactName.endsWith('.md') ? artifactName.slice(0, -3) : artifactName
  let matches: string[] = []
  try {
    matches = readdirSync(addendaDir).filter(n => n.startsWith(baseName + '.addendum-') && n.endsWith('.md')).sort()
    const upstream = readdirSync(addendaDir).filter(n => n.startsWith(baseName + '.upstream-gap.') && n.includes('.addendum-') && n.endsWith('.md')).sort()
    matches.push(...upstream)
  } catch { return [] }
  return matches
}

/** get_stage_local_addenda_paths: run_dir/addenda/<base>.addendum-*.md. */
export function getStageLocalAddendaPaths(runDir: string, artifactName: string): string[] {
  const addendaDir = join(runDir, 'addenda')
  if (!existsSync(addendaDir)) return []
  const baseName = artifactName.endsWith('.md') ? artifactName.slice(0, -3) : artifactName
  try { return readdirSync(addendaDir).filter(n => n.startsWith(baseName + '.addendum-') && n.endsWith('.md')).sort() }
  catch { return [] }
}

/** get_current_phase_upstream_gap_addenda_paths: run_dir/addenda/<base>.upstream-gap.*.addendum-*.md. */
export function getCurrentPhaseUpstreamGapAddendaPaths(runDir: string, artifactName: string): string[] {
  const addendaDir = join(runDir, 'addenda')
  if (!existsSync(addendaDir)) return []
  const baseName = artifactName.endsWith('.md') ? artifactName.slice(0, -3) : artifactName
  try { return readdirSync(addendaDir).filter(n => n.startsWith(baseName + '.upstream-gap.') && n.includes('.addendum-') && n.endsWith('.md')).sort() }
  catch { return [] }
}

/** get_header_field_block: lines under `Field:` until a stop field. */
export function getHeaderFieldBlock(content: string, fieldName: string, stopFields: string[]): string {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let collecting = false
  const captured: string[] = []
  const stopPatterns = stopFields.map(sf => new RegExp(`^\\s*${escapeRegExp(sf)}:`))
  const fieldPattern = new RegExp(`^\\s*${escapeRegExp(fieldName)}:\\s*$`)
  for (const line of lines) {
    if (!collecting) {
      if (fieldPattern.test(line)) collecting = true
      continue
    }
    if (stopPatterns.some(p => p.test(line))) break
    captured.push(line)
  }
  return captured.join('\n').trim()
}

/** get_header_input_paths: paths under Inputs:. */
export function getHeaderInputPaths(content: string): Set<string> {
  return extractPathsFromText(getHeaderFieldBlock(content, 'Inputs', ['Outputs', 'Scope note']))
}

/** get_phase_expected_input_artifact_names: expected input artifacts for a phase. */
export function getPhaseExpectedInputArtifactNames(fileName: string, runDir: string): string[] {
  const present = new Set(RUN_ARTIFACT_SEQUENCE.filter(a => existsSync(join(runDir, a))))
  let candidates: string[] = []
  if (fileName === '00-worktree.md') candidates = ['00-requirements.md']
  else if (fileName === '01-as-is.md') candidates = ['00-requirements.md']
  else if (fileName === '01.5-root-cause.md') candidates = ['01-as-is.md']
  else if (fileName === '02-to-be-plan.md') {
    candidates = ['00-requirements.md', '01-as-is.md']
    if (present.has('01.5-root-cause.md')) candidates.push('01.5-root-cause.md')
  } else if (fileName === '03-implementation-summary.md') candidates = ['02-to-be-plan.md']
  else if (fileName === '03.5-code-review.md') candidates = ['02-to-be-plan.md', '03-implementation-summary.md']
  else if (fileName === '04-test-summary.md') {
    candidates = ['02-to-be-plan.md', '03-implementation-summary.md']
    if (present.has('03.5-code-review.md')) candidates.push('03.5-code-review.md')
  } else if (fileName === '05-manual-qa.md') candidates = ['02-to-be-plan.md']
  else if (fileName === '06-decisions-update.md') candidates = RUN_ARTIFACT_SEQUENCE.filter(a => present.has(a) && a !== '06-decisions-update.md')
  else if (fileName === '07-state-update.md') candidates = ['06-decisions-update.md']
  else if (fileName === '08-memory-impact.md') candidates = RUN_ARTIFACT_SEQUENCE.filter(a => present.has(a) && a !== '08-memory-impact.md')
  return candidates.filter(a => present.has(a))
}

/** get_expected_effective_input_addenda_paths: expected addenda cited in Inputs. */
export function getExpectedEffectiveInputAddendaPaths(runDir: string, fileName: string): string[] {
  if (isAddendumArtifact(fileName)) return []
  const expectedPaths: string[] = []
  const runPrefix = `.recursive/run/${basename(runDir)}/`
  for (const artifactName of getPhaseExpectedInputArtifactNames(fileName, runDir)) {
    for (const addendumPath of getStageLocalAddendaPaths(runDir, artifactName)) {
      expectedPaths.push(`${runPrefix}addenda/${addendumPath}`)
    }
  }
  for (const addendumPath of getCurrentPhaseUpstreamGapAddendaPaths(runDir, fileName)) {
    expectedPaths.push(`${runPrefix}addenda/${addendumPath}`)
  }
  return [...new Set(expectedPaths)].sort()
}

/** parse_requirement_completion_entries: `- R1 | Status: ... | ...` rows. */
export function parseRequirementCompletionEntries(sectionBody: string): [Record<string, Record<string, string>>, string[]] {
  const entries: Record<string, Record<string, string>> = {}
  const issues: string[] = []
  for (const rawLine of sectionBody.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('-') && !line.startsWith('*')) continue
    const body = trimMdValue(line.slice(1).trim())
    const parts = body.split('|').map(p => trimMdValue(p.trim())).filter(Boolean)
    if (parts.length < 2) continue
    const requirementId = trimMdValue(parts[0])
    if (!REQUIREMENT_ID_RE.test(requirementId)) continue
    const fields: Record<string, string> = { 'Requirement ID': requirementId }
    for (const part of parts.slice(1)) {
      const idx = part.indexOf(':')
      if (idx < 0) continue
      fields[part.slice(0, idx).trim()] = trimMdValue(part.slice(idx + 1).trim())
    }
    if (requirementId in entries) {
      issues.push(`Requirement Completion Status contains duplicate entries for ${requirementId}`)
      continue
    }
    entries[requirementId] = fields
  }
  return [entries, issues]
}

/** is_meaningful_requirement_field: non-empty, not placeholder/none/n/a/tbd/todo. */
export function isMeaningfulRequirementField(value: string | null): boolean {
  if (value === null) return false
  const normalized = trimMdValue(value).trim()
  if (!normalized) return false
  return !['...', 'none', 'n/a', 'tbd', 'todo'].includes(normalized.toLowerCase())
}

/** collect_requirement_field_paths: normalized repo paths from field values. */
export function collectRequirementFieldPaths(fields: Record<string, string>, fieldNames: string[]): Set<string> {
  const paths = new Set<string>()
  for (const fieldName of fieldNames) {
    const rawValue = fields[fieldName] ?? ''
    for (const path of extractPathsFromFieldValue(rawValue)) {
      const normalized = normalizeRepoPath(path)
      if (normalized) paths.add(normalized)
    }
  }
  return paths
}

/** collect_meaningful_requirement_fields: drop ID/Status + placeholders. */
export function collectMeaningfulRequirementFields(fields: Record<string, string>): Record<string, string> {
  const meaningful: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'Requirement ID' || key === 'Status') continue
    if (isMeaningfulRequirementField(value)) meaningful[key] = value
  }
  return meaningful
}

/** normalize_skill_usage_relevance: yes->relevant, no->not-relevant. */
export function normalizeSkillUsageRelevance(value: string | null): string {
  const normalized = trimMdValue(value ?? '').trim().toLowerCase()
  if (normalized === 'yes') return 'relevant'
  if (normalized === 'no') return 'not-relevant'
  return normalized
}

/** lint_requirement_disposition_fields: per-status field requirements (implemented/verified/deferred/...). */
export function lintRequirementDispositionFields(
  requirementId: string,
  status: string,
  fields: Record<string, string>,
  fileName: string,
  runDir: string,
  repoRoot: string,
  actualChangedFiles: string[] | null,
): string[] {
  const issues: string[] = []
  const actualChangedScope = new Set(actualChangedFiles ?? [])
  const meaningfulFields = collectMeaningfulRequirementFields(fields)
  const allowedFieldsByStatus: Record<string, Set<string>> = {
    'implemented': new Set(['Changed Files', 'Implementation Evidence', 'Audit Note']),
    'verified': new Set(['Changed Files', 'Implementation Evidence', 'Verification Evidence', 'Audit Note']),
    'deferred': new Set(['Rationale', 'Deferred By', 'Addendum', 'Audit Note']),
    'out-of-scope': new Set(['Rationale', 'Scope Decision', 'Addendum', 'Audit Note']),
    'blocked': new Set(['Rationale', 'Blocking Evidence', 'Audit Note']),
    'superseded by approved addendum': new Set(['Addendum', 'Audit Note']),
  }
  const unexpected = Object.keys(meaningfulFields).filter(k => !(allowedFieldsByStatus[status] ?? new Set()).has(k)).sort()
  if (unexpected.length > 0) {
    issues.push(`Requirement ${requirementId} with Status ${status} contains contradictory field(s): ${unexpected.join(', ')}`)
  }

  if (status === 'implemented') {
    const changedFiles = fields['Changed Files'] ?? ''
    const changedPaths = collectRequirementFieldPaths(fields, ['Changed Files'])
    const implEvidence = fields['Implementation Evidence'] ?? ''
    const implPaths = collectRequirementFieldPaths(fields, ['Implementation Evidence'])
    if (!isMeaningfulRequirementField(changedFiles)) {
      issues.push(`Requirement ${requirementId} with Status implemented must cite Changed Files`)
    } else if (changedPaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status implemented must cite repo paths in Changed Files`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...changedPaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} Changed Files path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
      if (actualChangedScope.size > 0) {
        const unexplained = [...changedPaths].filter(p => !actualChangedScope.has(p)).sort()
        if (unexplained.length > 0) issues.push(`Requirement ${requirementId} Changed Files are outside the current diff scope: ${unexplained.slice(0, 5).join(', ')}`)
      }
    }
    if (!isMeaningfulRequirementField(implEvidence)) {
      issues.push(`Requirement ${requirementId} with Status implemented must cite Implementation Evidence`)
    } else if (implPaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status implemented must cite file or artifact paths in Implementation Evidence`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...implPaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} Implementation Evidence path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
      if (changedPaths.size > 0 && [...implPaths].every(p => !changedPaths.has(p)) && ![...implPaths].some(p => p.startsWith(`.recursive/run/${basename(runDir)}/`))) {
        issues.push(`Requirement ${requirementId} Implementation Evidence must reference the changed files or a current-run artifact that does so`)
      }
    }
  } else if (status === 'verified') {
    const changedFiles = fields['Changed Files'] ?? ''
    const changedPaths = collectRequirementFieldPaths(fields, ['Changed Files'])
    const implEvidence = fields['Implementation Evidence'] ?? ''
    const verifEvidence = fields['Verification Evidence'] ?? ''
    const implPaths = collectRequirementFieldPaths(fields, ['Implementation Evidence'])
    const verifPaths = collectRequirementFieldPaths(fields, ['Verification Evidence'])
    if (!isMeaningfulRequirementField(changedFiles)) {
      issues.push(`Requirement ${requirementId} with Status verified must cite Changed Files`)
    } else if (changedPaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status verified must cite repo paths in Changed Files`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...changedPaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} Changed Files path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
      if (actualChangedScope.size > 0) {
        const unexplained = [...changedPaths].filter(p => !actualChangedScope.has(p)).sort()
        if (unexplained.length > 0) issues.push(`Requirement ${requirementId} Changed Files are outside the current diff scope: ${unexplained.slice(0, 5).join(', ')}`)
      }
    }
    if (!isMeaningfulRequirementField(implEvidence)) {
      issues.push(`Requirement ${requirementId} with Status verified must cite Implementation Evidence`)
    } else if (implPaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status verified must cite file or artifact paths in Implementation Evidence`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...implPaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} Implementation Evidence path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
      if (changedPaths.size > 0 && [...implPaths].every(p => !changedPaths.has(p)) && ![...implPaths].some(p => p.startsWith(`.recursive/run/${basename(runDir)}/`))) {
        issues.push(`Requirement ${requirementId} Implementation Evidence must reference the changed files or a current-run artifact that does so`)
      }
    }
    if (!isMeaningfulRequirementField(verifEvidence)) {
      issues.push(`Requirement ${requirementId} with Status verified must cite Verification Evidence`)
    } else if (verifPaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status verified must cite test, review, QA, or artifact paths in Verification Evidence`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...verifPaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} Verification Evidence path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
      if (changedPaths.size > 0 && [...verifPaths].every(p => changedPaths.has(p))) {
        issues.push(`Requirement ${requirementId} Verification Evidence must cite verification artifacts, review receipts, or evidence paths distinct from the changed files`)
      }
      if (implPaths.size > 0 && [...verifPaths].every(p => implPaths.has(p))) {
        issues.push(`Requirement ${requirementId} Verification Evidence cannot be satisfied by restating only the implementation evidence`)
      }
    }
  } else if (status === 'deferred') {
    const rationale = fields['Rationale'] ?? ''
    const deferredBy = fields['Deferred By'] ?? fields['Addendum'] ?? ''
    const deferredPaths = collectRequirementFieldPaths(fields, ['Deferred By', 'Addendum'])
    if (!isMeaningfulRequirementField(rationale)) issues.push(`Requirement ${requirementId} with Status deferred is missing Rationale`)
    if (!isMeaningfulRequirementField(deferredBy)) {
      issues.push(`Requirement ${requirementId} with Status deferred must cite Deferred By or Addendum`)
    } else if (deferredPaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status deferred must cite an approved deferral path`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...deferredPaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} deferral reference path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
    }
  } else if (status === 'out-of-scope') {
    const rationale = fields['Rationale'] ?? ''
    const scopeDecision = fields['Scope Decision'] ?? fields['Addendum'] ?? ''
    const scopePaths = collectRequirementFieldPaths(fields, ['Scope Decision', 'Addendum'])
    if (!isMeaningfulRequirementField(rationale)) issues.push(`Requirement ${requirementId} with Status out-of-scope is missing Rationale`)
    if (!isMeaningfulRequirementField(scopeDecision)) {
      issues.push(`Requirement ${requirementId} with Status out-of-scope must cite Scope Decision or Addendum`)
    } else if (scopePaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status out-of-scope must cite an approved scope decision path`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...scopePaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} scope decision path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
    }
  } else if (status === 'blocked') {
    const rationale = fields['Rationale'] ?? ''
    const blockingEvidence = fields['Blocking Evidence'] ?? ''
    const blockingPaths = collectRequirementFieldPaths(fields, ['Blocking Evidence'])
    if (!isMeaningfulRequirementField(rationale)) issues.push(`Requirement ${requirementId} with Status blocked is missing Rationale`)
    if (!isMeaningfulRequirementField(blockingEvidence)) {
      issues.push(`Requirement ${requirementId} with Status blocked must cite Blocking Evidence`)
    } else if (blockingPaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status blocked must cite file, artifact, or evidence paths in Blocking Evidence`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...blockingPaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} Blocking Evidence path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
    }
  } else if (status === 'superseded by approved addendum') {
    const addendumPath = normalizeRepoPath(fields['Addendum'] ?? '')
    if (!addendumPath) {
      issues.push(`Requirement ${requirementId} superseded by approved addendum must cite Addendum`)
    } else if (!addendumPath.startsWith(`.recursive/run/${basename(runDir)}/addenda/`)) {
      issues.push(`Requirement ${requirementId} addendum reference must live under the current run addenda/`)
    } else if (!existsSync(join(repoRoot, addendumPath))) {
      issues.push(`Requirement ${requirementId} addendum reference does not exist: ${addendumPath}`)
    }
  }

  if (FINAL_REQUIREMENT_DISPOSITION_FILES.has(fileName)) {
    if (status === 'implemented') issues.push(`Requirement ${requirementId} cannot remain implemented in ${fileName}; final closeout phases require verification`)
    if (status === 'blocked') issues.push(`Requirement ${requirementId} cannot remain blocked in ${fileName} while the phase is approaching closeout`)
  }
  return issues
}

/** lint_source_requirement_inventory: 01-as-is Source Requirement Inventory rules. */
export function lintSourceRequirementInventory(filePath: string, content: string, workflowProfile: string, runDir: string): string[] {
  if (workflowProfile !== CURRENT_WORKFLOW_PROFILE || basename(filePath) !== '01-as-is.md') return []
  const issues: string[] = []
  const requirementsPath = join(runDir, '00-requirements.md')
  const requirementsContent = existsSync(requirementsPath) ? readFileSync(requirementsPath, 'utf8') : ''
  const body = getHeadingBody(content, 'Source Requirement Inventory')
  if (!body) return ['Missing or empty section: ## Source Requirement Inventory']
  const [entries, entryIssues] = parseSourceRequirementInventoryEntries(body)
  issues.push(...entryIssues)
  if (Object.keys(entries).length === 0) {
    issues.push('Source Requirement Inventory must contain at least one requirement inventory entry')
    return [...new Set(issues)].sort()
  }
  const explicitIds = parseRequirementIds(requirementsContent)
  const missingExplicit = explicitIds.filter(id => !(id in entries))
  if (missingExplicit.length > 0) issues.push(`Source Requirement Inventory is missing explicit requirement IDs from 00-requirements.md: ${missingExplicit.join(', ')}`)
  for (const [requirementId, fields] of Object.entries(entries)) {
    const disposition = trimMdValue(fields['Disposition'] ?? '').toLowerCase()
    const sourceQuote = fields['Source Quote'] ?? ''
    const summary = fields['Summary'] ?? ''
    if (!INVENTORY_DISPOSITIONS.has(disposition)) issues.push(`Source Requirement Inventory for ${requirementId} has invalid Disposition '${fields['Disposition'] ?? ''}'`)
    if (!isMeaningfulRequirementField(sourceQuote)) {
      issues.push(`Source Requirement Inventory for ${requirementId} is missing Source Quote`)
    } else if (!sourceQuoteMatches(sourceQuote, requirementsContent)) {
      issues.push(`Source Requirement Inventory for ${requirementId} cites a Source Quote that does not appear in 00-requirements.md`)
    }
    if (!isMeaningfulRequirementField(summary)) issues.push(`Source Requirement Inventory for ${requirementId} is missing Summary`)
  }
  return [...new Set(issues)].sort()
}

/** lint_requirement_mapping: 02-to-be-plan Requirement Mapping rules. */
export function lintRequirementMapping(content: string, workflowProfile: string, runDir: string, repoRoot: string): string[] {
  if (workflowProfile !== CURRENT_WORKFLOW_PROFILE) return []
  const issues: string[] = []
  const phase1Path = join(runDir, '01-as-is.md')
  const requirementsPath = join(runDir, '00-requirements.md')
  if (!existsSync(phase1Path) || !existsSync(requirementsPath)) return ['Requirement Mapping requires existing 00-requirements.md and 01-as-is.md inputs']
  const inventoryBody = getHeadingBody(readFileSync(phase1Path, 'utf8'), 'Source Requirement Inventory')
  if (!inventoryBody) return ['Requirement Mapping requires 01-as-is.md to contain ## Source Requirement Inventory']
  const [inventoryEntries, inventoryIssues] = parseSourceRequirementInventoryEntries(inventoryBody)
  issues.push(...inventoryIssues)
  const body = getHeadingBody(content, 'Requirement Mapping')
  if (!body) {
    issues.push('Missing or empty section: ## Requirement Mapping')
    return [...new Set(issues)].sort()
  }
  const [mappingEntries, mappingIssues] = parseRequirementMappingEntries(body)
  issues.push(...mappingIssues)
  const missingEntries = Object.keys(inventoryEntries).filter(id => !(id in mappingEntries))
  if (missingEntries.length > 0) issues.push(`Requirement Mapping is missing source inventory items: ${missingEntries.join(', ')}`)
  const requirementsContent = readFileSync(requirementsPath, 'utf8')
  for (const [requirementId, fields] of Object.entries(mappingEntries)) {
    const coverage = trimMdValue(fields['Coverage'] ?? '').toLowerCase()
    const sourceQuote = fields['Source Quote'] ?? ''
    const implementationSurface = fields['Implementation Surface'] ?? ''
    const verificationSurface = fields['Verification Surface'] ?? ''
    const qaSurface = fields['QA Surface'] ?? ''
    const rationale = fields['Rationale'] ?? fields['Merge Rationale'] ?? ''
    if (!['direct', 'merged', 'indirect', 'deferred', 'out-of-scope', 'blocked'].includes(coverage)) {
      issues.push(`Requirement Mapping for ${requirementId} has invalid Coverage '${fields['Coverage'] ?? ''}'`)
      continue
    }
    if (!isMeaningfulRequirementField(sourceQuote)) {
      issues.push(`Requirement Mapping for ${requirementId} is missing Source Quote`)
    } else if (requirementId in inventoryEntries) {
      const inventoryQuote = inventoryEntries[requirementId]['Source Quote'] ?? ''
      if (normalizeSourceText(sourceQuote) !== normalizeSourceText(inventoryQuote)) {
        issues.push(`Requirement Mapping for ${requirementId} must preserve the Source Quote recorded in Source Requirement Inventory`)
      }
    } else if (!sourceQuoteMatches(sourceQuote, requirementsContent)) {
      issues.push(`Requirement Mapping for ${requirementId} cites a Source Quote that does not appear in 00-requirements.md`)
    }
    if (['direct', 'merged', 'indirect'].includes(coverage)) {
      if (!isMeaningfulRequirementField(implementationSurface)) {
        issues.push(`Requirement Mapping for ${requirementId} is missing Implementation Surface`)
      } else {
        issues.push(...validatePlannedSurfacePaths(requirementId, 'Implementation Surface', implementationSurface, repoRoot))
      }
      if (!isMeaningfulRequirementField(verificationSurface)) issues.push(`Requirement Mapping for ${requirementId} is missing Verification Surface`)
      if (!isMeaningfulRequirementField(qaSurface)) issues.push(`Requirement Mapping for ${requirementId} is missing QA Surface`)
    }
    if (coverage === 'merged' && !isMeaningfulRequirementField(rationale)) issues.push(`Requirement Mapping for ${requirementId} with Coverage merged must cite Merge Rationale or Rationale`)
    if (coverage === 'indirect' && !isMeaningfulRequirementField(rationale)) issues.push(`Requirement Mapping for ${requirementId} with Coverage indirect must cite Rationale`)
    if (['deferred', 'out-of-scope', 'blocked'].includes(coverage) && !isMeaningfulRequirementField(rationale)) issues.push(`Requirement Mapping for ${requirementId} with Coverage ${coverage} must cite Rationale`)
  }
  return [...new Set(issues)].sort()
}

/** lint_plan_drift_check: Plan Drift Check merge/rationale rule. */
export function lintPlanDriftCheck(content: string, workflowProfile: string): string[] {
  if (workflowProfile !== CURRENT_WORKFLOW_PROFILE) return []
  const body = getHeadingBody(content, 'Plan Drift Check')
  if (!body) return ['Missing or empty section: ## Plan Drift Check']
  if (/\bmerge\b/i.test(body) && !/\brationale\b/i.test(body)) {
    return ['Plan Drift Check mentions merged obligations without explaining why the merge is lossless']
  }
  return []
}

/** lint_phase2_requirement_disposition_fields: 02 phase-2 status rules. */
export function lintPhase2RequirementDispositionFields(
  requirementId: string,
  status: string,
  fields: Record<string, string>,
  runDir: string,
  repoRoot: string,
): string[] {
  const issues: string[] = []
  const allowedFieldsByStatus: Record<string, Set<string>> = {
    'planned': new Set(['Implementation Surface', 'Verification Surface', 'QA Surface', 'Audit Note']),
    'planned-via-merge': new Set(['Implementation Surface', 'Verification Surface', 'QA Surface', 'Rationale', 'Audit Note']),
    'planned-indirectly': new Set(['Implementation Surface', 'Verification Surface', 'QA Surface', 'Rationale', 'Audit Note']),
    'deferred': new Set(['Rationale', 'Deferred By', 'Addendum', 'Audit Note']),
    'out-of-scope': new Set(['Rationale', 'Scope Decision', 'Addendum', 'Audit Note']),
    'blocked': new Set(['Rationale', 'Blocking Evidence', 'Audit Note']),
    'superseded by approved addendum': new Set(['Addendum', 'Audit Note']),
  }
  const meaningfulFields = collectMeaningfulRequirementFields(fields)
  const unexpected = Object.keys(meaningfulFields).filter(k => !(allowedFieldsByStatus[status] ?? new Set()).has(k)).sort()
  if (unexpected.length > 0) {
    issues.push(`Requirement ${requirementId} with Status ${status} contains contradictory field(s): ${unexpected.join(', ')}`)
  }
  if (['planned', 'planned-via-merge', 'planned-indirectly'].includes(status)) {
    const implSurface = fields['Implementation Surface'] ?? ''
    const verifSurface = fields['Verification Surface'] ?? ''
    const qaSurface = fields['QA Surface'] ?? ''
    const rationale = fields['Rationale'] ?? ''
    if (!isMeaningfulRequirementField(implSurface)) {
      issues.push(`Requirement ${requirementId} with Status ${status} must cite Implementation Surface`)
    } else {
      issues.push(...validatePlannedSurfacePaths(requirementId, 'Implementation Surface', implSurface, repoRoot))
    }
    if (!isMeaningfulRequirementField(verifSurface)) issues.push(`Requirement ${requirementId} with Status ${status} must cite Verification Surface`)
    if (!isMeaningfulRequirementField(qaSurface)) issues.push(`Requirement ${requirementId} with Status ${status} must cite QA Surface`)
    if (['planned-via-merge', 'planned-indirectly'].includes(status) && !isMeaningfulRequirementField(rationale)) issues.push(`Requirement ${requirementId} with Status ${status} must cite Rationale`)
  } else if (status === 'deferred') {
    const deferredBy = fields['Deferred By'] ?? fields['Addendum'] ?? ''
    const deferredPaths = collectRequirementFieldPaths(fields, ['Deferred By', 'Addendum'])
    if (!isMeaningfulRequirementField(fields['Rationale'] ?? '')) issues.push(`Requirement ${requirementId} with Status deferred is missing Rationale`)
    if (!isMeaningfulRequirementField(deferredBy)) {
      issues.push(`Requirement ${requirementId} with Status deferred must cite Deferred By or Addendum`)
    } else if (deferredPaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status deferred must cite an approved deferral path`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...deferredPaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} deferral reference path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
    }
  } else if (status === 'out-of-scope') {
    const scopeDecision = fields['Scope Decision'] ?? fields['Addendum'] ?? ''
    const scopePaths = collectRequirementFieldPaths(fields, ['Scope Decision', 'Addendum'])
    if (!isMeaningfulRequirementField(fields['Rationale'] ?? '')) issues.push(`Requirement ${requirementId} with Status out-of-scope is missing Rationale`)
    if (!isMeaningfulRequirementField(scopeDecision)) {
      issues.push(`Requirement ${requirementId} with Status out-of-scope must cite Scope Decision or Addendum`)
    } else if (scopePaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status out-of-scope must cite an approved scope decision path`)
    } else {
      const missing = findMissingRepoPaths(repoRoot, [...scopePaths].sort())
      if (missing.length > 0) issues.push(`Requirement ${requirementId} scope decision path(s) do not exist: ${missing.slice(0, 5).join(', ')}`)
    }
  } else if (status === 'blocked') {
    const blockingEvidence = fields['Blocking Evidence'] ?? ''
    const blockingPaths = collectRequirementFieldPaths(fields, ['Blocking Evidence'])
    if (!isMeaningfulRequirementField(fields['Rationale'] ?? '')) issues.push(`Requirement ${requirementId} with Status blocked is missing Rationale`)
    if (!isMeaningfulRequirementField(blockingEvidence)) {
      issues.push(`Requirement ${requirementId} with Status blocked must cite Blocking Evidence`)
    } else if (blockingPaths.size === 0) {
      issues.push(`Requirement ${requirementId} with Status blocked must cite file, artifact, or evidence paths in Blocking Evidence`)
    }
  } else if (status === 'superseded by approved addendum') {
    const addendumPath = normalizeRepoPath(fields['Addendum'] ?? '')
    if (!addendumPath) {
      issues.push(`Requirement ${requirementId} superseded by approved addendum must cite Addendum`)
    } else if (!addendumPath.startsWith(`.recursive/run/${basename(runDir)}/addenda/`)) {
      issues.push(`Requirement ${requirementId} addendum reference must live under the current run addenda/`)
    } else if (!existsSync(join(repoRoot, addendumPath))) {
      issues.push(`Requirement ${requirementId} addendum reference does not exist: ${addendumPath}`)
    }
  }
  return issues
}

/** parse_source_requirement_inventory_entries: `- R1 | Disposition: ... | Source Quote: ... | Summary: ...` rows. */
export function parseSourceRequirementInventoryEntries(sectionBody: string): [Record<string, Record<string, string>>, string[]] {
  const entries: Record<string, Record<string, string>> = {}
  const issues: string[] = []
  for (const rawLine of sectionBody.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('-') && !line.startsWith('*')) continue
    const body = trimMdValue(line.slice(1).trim())
    const parts = body.split('|').map(p => trimMdValue(p.trim())).filter(Boolean)
    if (parts.length < 2) continue
    const requirementId = trimMdValue(parts[0])
    if (!REQUIREMENT_ID_RE.test(requirementId)) continue
    const fields: Record<string, string> = { 'Requirement ID': requirementId }
    for (const part of parts.slice(1)) {
      const idx = part.indexOf(':')
      if (idx < 0) continue
      fields[part.slice(0, idx).trim()] = trimMdValue(part.slice(idx + 1).trim())
    }
    if (requirementId in entries) {
      issues.push(`Source Requirement Inventory contains duplicate entries for ${requirementId}`)
      continue
    }
    entries[requirementId] = fields
  }
  return [entries, issues]
}

/** parse_requirement_mapping_entries: `- R1 | Source Quote: ... | Coverage: ... | ...` rows. */
export function parseRequirementMappingEntries(sectionBody: string): [Record<string, Record<string, string>>, string[]] {
  const entries: Record<string, Record<string, string>> = {}
  const issues: string[] = []
  for (const rawLine of sectionBody.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('-') && !line.startsWith('*')) continue
    const body = trimMdValue(line.slice(1).trim())
    const parts = body.split('|').map(p => trimMdValue(p.trim())).filter(Boolean)
    if (parts.length < 2) continue
    const requirementId = trimMdValue(parts[0])
    if (!REQUIREMENT_ID_RE.test(requirementId)) continue
    const fields: Record<string, string> = { 'Requirement ID': requirementId }
    for (const part of parts.slice(1)) {
      const idx = part.indexOf(':')
      if (idx < 0) continue
      fields[part.slice(0, idx).trim()] = trimMdValue(part.slice(idx + 1).trim())
    }
    if (requirementId in entries) {
      issues.push(`Requirement Mapping contains duplicate entries for ${requirementId}`)
      continue
    }
    entries[requirementId] = fields
  }
  return [entries, issues]
}

/** get_run_requirement_ids: R ids from 00-requirements or 01-as-is inventory (current profile). */
export function getRunRequirementIds(runDir: string, workflowProfile: string): string[] {
  const requirementsPath = join(runDir, '00-requirements.md')
  let explicitIds: string[] = []
  if (existsSync(requirementsPath)) explicitIds = parseRequirementIds(readFileSync(requirementsPath, 'utf8'))
  if (workflowProfile === CURRENT_WORKFLOW_PROFILE) {
    const phase1Path = join(runDir, '01-as-is.md')
    if (existsSync(phase1Path)) {
      const inventoryBody = getHeadingBody(readFileSync(phase1Path, 'utf8'), 'Source Requirement Inventory')
      if (inventoryBody) {
        const [entries] = parseSourceRequirementInventoryEntries(inventoryBody)
        if (Object.keys(entries).length > 0) return Object.keys(entries).sort((a, b) => {
          const [ka, va, sa] = requirementSortKey(a)
          const [kb, vb, sb] = requirementSortKey(b)
          return ka !== kb ? ka - kb : (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb)))
        })
      }
    }
  }
  return explicitIds
}

/** validate_planned_surface_paths: implementation-surface paths must resolve or have an existing parent. */
export function validatePlannedSurfacePaths(requirementId: string, fieldName: string, rawValue: string, repoRoot: string): string[] {
  const issues: string[] = []
  const extracted = collectRequirementFieldPaths({ [fieldName]: rawValue }, [fieldName])
  if (extracted.size === 0) {
    issues.push(`Requirement ${requirementId} ${fieldName} must cite concrete repo paths or file names`)
    return issues
  }
  const unresolved: string[] = []
  for (const path of [...extracted].sort()) {
    const candidate = join(repoRoot, path)
    if (existsSync(candidate)) continue
    if (existsSync(dirname(candidate))) continue
    unresolved.push(path)
  }
  if (unresolved.length > 0) {
    issues.push(`Requirement ${requirementId} ${fieldName} contains unresolved planned path(s): ${unresolved.slice(0, 5).join(', ')}`)
  }
  return issues
}

/** lint_effective_input_addenda: Inputs / Effective Inputs Re-read / Earlier Phase Reconciliation addenda citations. */
export function lintEffectiveInputAddenda(filePath: string, content: string, workflowProfile: string, runDir: string): string[] {
  if (![...STRICT_WORKFLOW_PROFILES, COMPAT_WORKFLOW_PROFILE].includes(workflowProfile)) return []
  if (isAddendumArtifact(basename(filePath))) return []
  const expectedAddenda = getExpectedEffectiveInputAddendaPaths(runDir, basename(filePath))
  if (expectedAddenda.length === 0) return []
  const issues: string[] = []
  const headerInputs = new Set([...getHeaderInputPaths(content)].map(normalizeRepoPath))
  const missingInputs = expectedAddenda.filter(p => !headerInputs.has(p))
  if (missingInputs.length > 0) issues.push(`Inputs is missing relevant addenda: ${missingInputs.slice(0, 5).join(', ')}`)
  if (STRICT_WORKFLOW_PROFILES.has(workflowProfile) && AUDITED_PHASE_FILES.has(basename(filePath))) {
    const rereadPaths = new Set([...extractPathsFromText(getHeadingBody(content, 'Effective Inputs Re-read'))].map(normalizeRepoPath))
    const missingReread = expectedAddenda.filter(p => !rereadPaths.has(p))
    if (missingReread.length > 0) issues.push(`Effective Inputs Re-read is missing relevant addenda: ${missingReread.slice(0, 5).join(', ')}`)
    const reconciliationPaths = new Set([...extractPathsFromText(getHeadingBody(content, 'Earlier Phase Reconciliation'))].map(normalizeRepoPath))
    const missingRecon = expectedAddenda.filter(p => !reconciliationPaths.has(p))
    if (missingRecon.length > 0) issues.push(`Earlier Phase Reconciliation is missing relevant addenda: ${missingRecon.slice(0, 5).join(', ')}`)
  }
  return issues
}

/** lint_requirement_completion_status: RCS section rules for audited phases. */
export function lintRequirementCompletionStatus(
  filePath: string,
  content: string,
  requirementIds: string[],
  runDir: string,
  workflowProfile: string,
  actualChangedFiles: string[] | null,
): string[] {
  if (!STRICT_WORKFLOW_PROFILES.has(workflowProfile) || !AUDITED_PHASE_FILES.has(basename(filePath))) return []
  const body = getHeadingBody(content, 'Requirement Completion Status')
  if (!body) return ['Missing or empty section: ## Requirement Completion Status']
  const [entries, issues] = parseRequirementCompletionEntries(body)
  const missing = requirementIds.filter(id => !(id in entries))
  if (missing.length > 0) issues.push(`Requirement Completion Status is missing in-scope requirements: ${missing.join(', ')}`)
  const repoRoot = dirname(dirname(dirname(runDir)))
  if (workflowProfile === CURRENT_WORKFLOW_PROFILE && basename(filePath) === '02-to-be-plan.md') {
    for (const [requirementId, fields] of Object.entries(entries)) {
      const status = trimMdValue(fields['Status'] ?? '').toLowerCase()
      if (!PHASE2_REQUIREMENT_DISPOSITION_STATUSES.has(status)) {
        issues.push(`Requirement Completion Status for ${requirementId} has invalid Phase 2 Status '${fields['Status'] ?? ''}'`)
        continue
      }
      issues.push(...lintPhase2RequirementDispositionFields(requirementId, status, fields, runDir, repoRoot))
    }
    return [...new Set(issues)].sort()
  }
  for (const [requirementId, fields] of Object.entries(entries)) {
    const status = trimMdValue(fields['Status'] ?? '').toLowerCase()
    if (!REQUIREMENT_DISPOSITION_STATUSES.has(status)) {
      issues.push(`Requirement Completion Status for ${requirementId} has invalid Status '${fields['Status'] ?? ''}'`)
      continue
    }
    issues.push(...lintRequirementDispositionFields(requirementId, status, fields, basename(filePath), runDir, repoRoot, actualChangedFiles))
  }
  if (REQUIREMENT_CHANGED_FILE_ACCOUNTING_FILES.has(basename(filePath))) {
    const expectedScope = new Set(getPhaseOwnedActualChangedFiles(basename(filePath), actualChangedFiles, repoRoot) ?? [])
    if (expectedScope.size > 0) {
      const claimedChangedFiles = new Set<string>()
      for (const fields of Object.values(entries)) {
        const status = trimMdValue(fields['Status'] ?? '').toLowerCase()
        if (['implemented', 'verified'].includes(status)) {
          for (const p of collectRequirementFieldPaths(fields, ['Changed Files'])) claimedChangedFiles.add(p)
        }
      }
      const missingClaims = [...expectedScope].filter(p => !claimedChangedFiles.has(p)).sort()
      if (missingClaims.length > 0) {
        issues.push('Requirement Completion Status leaves diff-owned changed file(s) unaccounted for: ' + missingClaims.slice(0, 5).join(', '))
      }
    }
  }
  return [...new Set(issues)].sort()
}

/** lint_prior_recursive_evidence: Prior Recursive Evidence Reviewed rules. */
export function lintPriorRecursiveEvidence(content: string, runDir: string, workflowProfile: string, repoRoot: string, fileName: string): string[] {
  if (!STRICT_WORKFLOW_PROFILES.has(workflowProfile) || !PRIOR_RECURSIVE_EVIDENCE_FILES.has(fileName)) return []
  const body = getHeadingBody(content, 'Prior Recursive Evidence Reviewed')
  if (!body) return ['Missing or empty section: ## Prior Recursive Evidence Reviewed']
  const referencedPaths = new Set<string>()
  for (const path of extractPathsFromText(body)) {
    const normalized = normalizeRepoPath(path)
    if (normalized.startsWith('.recursive/run/') || normalized.startsWith('.recursive/memory/')) referencedPaths.add(normalized)
  }
  if (referencedPaths.size > 0) {
    const missing = findMissingRepoPaths(repoRoot, [...referencedPaths].sort())
    if (missing.length > 0) return [`Prior Recursive Evidence Reviewed references missing path(s): ${missing.slice(0, 5).join(', ')}`]
    return []
  }
  if (/\bnone\b/i.test(body) && /\b(justification|reason|because)\b/i.test(body)) return []
  return ['Prior Recursive Evidence Reviewed must contain structured run/memory paths or an explicit no-relevant-evidence justification']
}

/** get_subagent_action_record_paths: subagents/ paths cited in Subagent Contribution Verification. */
export function getSubagentActionRecordPaths(content: string, runDir: string): string[] {
  const body = getHeadingBody(content, 'Subagent Contribution Verification')
  if (!body) return []
  const expectedPrefix = `.recursive/run/${basename(runDir)}/subagents/`
  return [...new Set([...extractPathsFromText(body)].map(normalizeRepoPath).filter(p => p.startsWith(expectedPrefix)))].sort()
}

/** get_all_subagent_action_record_paths: any run subagents/ path cited. */
export function getAllSubagentActionRecordPaths(content: string): string[] {
  const body = getHeadingBody(content, 'Subagent Contribution Verification')
  if (!body) return []
  return [...new Set([...extractPathsFromText(body)].map(normalizeRepoPath).filter(p => /^\.recursive\/run\/[^/]+\/subagents\/.+\.md$/.test(p)))].sort()
}

/** lint_subagent_action_record_file: validate a subagent action record file. */
export function lintSubagentActionRecordFile(filePath: string, repoRoot: string, runDir: string, actualChangedFiles: string[] | null): string[] {
  const content = readFileSync(filePath, 'utf8')
  const issues: string[] = []
  if (!content.includes('# Subagent Action Record')) issues.push('Missing title: # Subagent Action Record')
  for (const heading of SUBAGENT_ACTION_REQUIRED_HEADINGS) {
    if (!getHeadingBody(content, heading)) issues.push(`Missing or empty section: ## ${heading}`)
  }
  const metadata = getHeadingBody(content, 'Metadata')
  const inputs = getHeadingBody(content, 'Inputs Provided')
  const claimedActions = getHeadingBody(content, 'Claimed Actions Taken')
  const claimedFileImpact = getHeadingBody(content, 'Claimed File Impact')
  const claimedArtifactImpact = getHeadingBody(content, 'Claimed Artifact Impact')
  if (dirname(filePath) !== join(runDir, 'subagents')) issues.push(`Subagent action record must live under \`/.recursive/run/${basename(runDir)}/subagents/\``)
  for (const fieldName of ['Subagent ID', 'Run ID', 'Phase', 'Purpose', 'Execution Mode', 'Timestamp']) {
    if (!hasMeaningfulValue(getMdFieldValue(metadata, fieldName))) issues.push(`Metadata is missing ${fieldName}`)
  }
  const runId = getMdFieldValue(metadata, 'Run ID')
  if (runId && runId !== basename(runDir)) issues.push(`Run ID mismatch: ${runId} != ${basename(runDir)}`)
  const currentArtifact = normalizeRepoPath(getMdFieldValue(inputs, 'Current Artifact') ?? '')
  if (!currentArtifact) {
    issues.push('Inputs Provided is missing Current Artifact')
  } else if (!existsSync(join(repoRoot, currentArtifact))) {
    issues.push(`Current Artifact does not exist: ${currentArtifact}`)
  }
  const artifactHash = trimMdValue(getMdFieldValue(inputs, 'Artifact Content Hash') ?? '')
  if (currentArtifact && existsSync(join(repoRoot, currentArtifact))) {
    const currentHash = contentSha256(readFileSync(join(repoRoot, currentArtifact), 'utf8'))
    if (!artifactHash) issues.push('Inputs Provided is missing Artifact Content Hash')
    else if (artifactHash !== currentHash) issues.push('Inputs Provided Artifact Content Hash does not match the current artifact content')
  }
  const reviewBundle = normalizeRepoPath(getMdFieldValue(inputs, 'Review Bundle') ?? '')
  if (reviewBundle && !existsSync(join(repoRoot, reviewBundle))) issues.push(`Review Bundle does not exist: ${reviewBundle}`)
  const diffBasisText = getMdFieldValue(inputs, 'Diff Basis') ?? ''
  if (!diffBasisText.trim()) issues.push('Inputs Provided is missing Diff Basis')
  const upstreamArtifacts = new Set([...extractPathsFromNamedField(inputs, 'Upstream Artifacts')].filter(p => p.startsWith(`.recursive/run/${basename(runDir)}/`)))
  const codeRefs = extractPathsFromNamedField(inputs, 'Code Refs')
  const memoryRefs = new Set([...extractPathsFromNamedField(inputs, 'Memory Refs')].filter(p => p.startsWith('.recursive/memory/')))
  const auditQuestionText = getMdFieldValue(inputs, 'Audit / Task Questions') ?? inputs
  if (upstreamArtifacts.size === 0 && !reviewBundle) issues.push('Inputs Provided must cite upstream artifacts or the review bundle used for delegation')
  if (isPlaceholderOnly(auditQuestionText)) issues.push('Inputs Provided is missing concrete Audit / Task Questions')
  const claimedCreated = new Set([...extractPathsFromText(getSubheadingBody(claimedFileImpact, 'Created'))].map(normalizeRepoPath))
  const claimedModified = new Set([...extractPathsFromText(getSubheadingBody(claimedFileImpact, 'Modified'))].map(normalizeRepoPath))
  const claimedReviewed = new Set([...extractPathsFromText(getSubheadingBody(claimedFileImpact, 'Reviewed'))].map(normalizeRepoPath))
  const claimedRelevantUntouched = new Set([...extractPathsFromText(getSubheadingBody(claimedFileImpact, 'Relevant but Untouched'))].map(normalizeRepoPath))
  if (isPlaceholderOnly(claimedActions)) issues.push('Claimed Actions Taken must contain concrete delegated work details')
  const claimedFileRefs = new Set([...claimedCreated, ...claimedModified, ...claimedReviewed, ...claimedRelevantUntouched])
  if (claimedFileRefs.size === 0) issues.push('Claimed File Impact must cite at least one created, modified, reviewed, or relevant untouched file')
  for (const createdPath of [...claimedCreated].sort()) {
    if (!existsSync(join(repoRoot, createdPath))) issues.push(`Claimed created file does not exist: ${createdPath}`)
  }
  for (const reviewedPath of [...new Set([...claimedModified, ...claimedReviewed, ...claimedRelevantUntouched])].sort()) {
    if (!existsSync(join(repoRoot, reviewedPath))) issues.push(`Claimed file reference does not exist: ${reviewedPath}`)
  }
  if (actualChangedFiles !== null) {
    const actualChanged = new Set(actualChangedFiles)
    const missingChangedClaims = [...new Set([...claimedModified, ...claimedCreated])].filter(p => !actualChanged.has(p))
    if (missingChangedClaims.length > 0) issues.push(`Claimed modified/created files are not present in the current diff: ${[...new Set(missingChangedClaims)].sort().slice(0, 5).join(', ')}`)
  }
  if (reviewBundle && existsSync(join(repoRoot, reviewBundle))) {
    const bundleContent = readFileSync(join(repoRoot, reviewBundle), 'utf8')
    const bundleArtifactPath = normalizeRepoPath(getMdFieldValue(bundleContent, 'Artifact Path') ?? '')
    const bundleUpstream = new Set([...extractPathsFromText(getHeadingBody(bundleContent, 'Upstream Artifacts To Re-read'))].map(normalizeRepoPath).filter(Boolean))
    const bundleChanged = new Set([...extractPathsFromText(getHeadingBody(bundleContent, 'Changed Files Reviewed'))].map(normalizeRepoPath).filter(Boolean))
    const bundleCodeRefs = new Set([...extractPathsFromText(getHeadingBody(bundleContent, 'Targeted Code References'))].map(normalizeRepoPath).filter(Boolean))
    const allowedArtifacts = new Set([bundleArtifactPath, ...bundleUpstream].filter(Boolean))
    if (currentArtifact && allowedArtifacts.size > 0 && !allowedArtifacts.has(currentArtifact)) {
      issues.push(`Inputs Provided Current Artifact must match the review bundle Artifact Path or a cited upstream artifact: ${currentArtifact}`)
    }
    const missingBundleUpstream = [...bundleUpstream].filter(p => !upstreamArtifacts.has(p)).sort()
    if (missingBundleUpstream.length > 0) issues.push(`Inputs Provided Upstream Artifacts omit bundle upstream artifact(s): ${missingBundleUpstream.slice(0, 5).join(', ')}`)
    const requiredBundleFileScope = new Set([...bundleCodeRefs, ...bundleChanged])
    if (requiredBundleFileScope.size > 0) {
      const missingBundleScope = [...requiredBundleFileScope].filter(p => !claimedFileRefs.has(p)).sort()
      if (missingBundleScope.length > 0) issues.push(`Claimed File Impact omits targeted file scope present in the review bundle: ${missingBundleScope.slice(0, 5).join(', ')}`)
    }
  }
  const artifactRefs = new Set([...extractPathsFromText(claimedArtifactImpact)].map(normalizeRepoPath).filter(p => p.startsWith('.recursive/')))
  const evidenceRefs = new Set([...extractPathsFromText(claimedArtifactImpact)].map(normalizeRepoPath).filter(p => p.startsWith(`.recursive/run/${basename(runDir)}/evidence/`)))
  if (artifactRefs.size === 0 && evidenceRefs.size === 0) issues.push('Claimed Artifact Impact must cite recursive artifacts or evidence paths used by the subagent')
  const missingArtifactRefs = findMissingRepoPaths(repoRoot, [...artifactRefs].sort())
  if (missingArtifactRefs.length > 0) issues.push(`Claimed artifact references do not exist: ${missingArtifactRefs.slice(0, 5).join(', ')}`)
  const missingCodeRefs = findMissingRepoPaths(repoRoot, [...codeRefs].sort())
  if (missingCodeRefs.length > 0) issues.push(`Inputs Provided code refs do not exist: ${missingCodeRefs.slice(0, 5).join(', ')}`)
  const missingMemoryRefs = findMissingRepoPaths(repoRoot, [...memoryRefs].sort())
  if (missingMemoryRefs.length > 0) issues.push(`Inputs Provided memory refs do not exist: ${missingMemoryRefs.slice(0, 5).join(', ')}`)
  const verificationHandoff = getHeadingBody(content, 'Verification Handoff')
  if (verificationHandoff && extractPathsFromText(verificationHandoff).size === 0) issues.push('Verification Handoff must cite files, diffs, or artifacts to inspect')
  return [...new Set(issues)].sort()
}

/** parse_subagent_action_record_claims: extract claims from an action record. */
export function parseSubagentActionRecordClaims(actionContent: string): Record<string, Set<string> | string> {
  const inputs = getHeadingBody(actionContent, 'Inputs Provided')
  const claimedFileImpact = getHeadingBody(actionContent, 'Claimed File Impact')
  const claimedArtifactImpact = getHeadingBody(actionContent, 'Claimed Artifact Impact')
  const currentArtifact = normalizeRepoPath(getMdFieldValue(inputs, 'Current Artifact') ?? '')
  const reviewBundle = normalizeRepoPath(getMdFieldValue(inputs, 'Review Bundle') ?? '')
  const upstreamArtifacts = extractPathsFromNamedField(inputs, 'Upstream Artifacts')
  const created = new Set([...extractPathsFromText(getSubheadingBody(claimedFileImpact, 'Created'))].map(normalizeRepoPath).filter(Boolean))
  const modified = new Set([...extractPathsFromText(getSubheadingBody(claimedFileImpact, 'Modified'))].map(normalizeRepoPath).filter(Boolean))
  const reviewed = new Set([...extractPathsFromText(getSubheadingBody(claimedFileImpact, 'Reviewed'))].map(normalizeRepoPath).filter(Boolean))
  const relevantUntouched = new Set([...extractPathsFromText(getSubheadingBody(claimedFileImpact, 'Relevant but Untouched'))].map(normalizeRepoPath).filter(Boolean))
  const artifactRefs = new Set([...extractPathsFromText(claimedArtifactImpact)].map(normalizeRepoPath).filter(p => p.startsWith('.recursive/')))
  return { current_artifact: currentArtifact, review_bundle: reviewBundle, upstream_artifacts: upstreamArtifacts, created, modified, reviewed, relevant_untouched: relevantUntouched, artifact_refs: artifactRefs }
}

/** lint_subagent_contribution_verification: SCV section rules for audited phases. */
export function lintSubagentContributionVerification(
  filePath: string,
  content: string,
  workflowProfile: string,
  runDir: string,
  repoRoot: string,
  actualChangedFiles: string[] | null,
): string[] {
  if (!STRICT_WORKFLOW_PROFILES.has(workflowProfile) || !AUDITED_PHASE_FILES.has(basename(filePath))) return []
  const body = getHeadingBody(content, 'Subagent Contribution Verification')
  if (!body) return ['Missing or empty section: ## Subagent Contribution Verification']
  const issues: string[] = []
  const actionRecordPaths = getSubagentActionRecordPaths(content, runDir)
  const allActionRecordPaths = getAllSubagentActionRecordPaths(content)
  const auditContext = getHeadingBody(content, 'Audit Context')
  const auditMode = getMdFieldValue(auditContext, 'Audit Execution Mode') ?? ''
  const currentPhase = getMdFieldValue(content, 'Phase') ?? ''
  const reviewedActionRecordsField = getNamedFieldText(body, 'Reviewed Action Records') ?? ''
  const mainAgentVerification = getNamedFieldText(body, 'Main-Agent Verification Performed') ?? ''
  const acceptanceDecision = trimMdValue(getMdFieldValue(body, 'Acceptance Decision') ?? '').toLowerCase()
  const refreshHandling = getNamedFieldText(body, 'Refresh Handling') ?? ''
  const repairPerformed = getNamedFieldText(body, 'Repair Performed After Verification') ?? ''
  const verificationPaths = new Set([...extractPathsFromFieldValue(mainAgentVerification)].map(normalizeRepoPath).filter(Boolean))
  const repairPaths = new Set([...extractPathsFromFieldValue(repairPerformed)].map(normalizeRepoPath).filter(Boolean))
  const currentBundlePath = normalizeRepoPath(getMdFieldValue(getHeadingBody(content, 'Review Metadata'), 'Review Bundle Path') ?? getMdFieldValue(content, 'Review Bundle Path') ?? '')
  if (auditMode === 'subagent' && actionRecordPaths.length === 0) issues.push('Audit Execution Mode subagent requires at least one reviewed subagent action record')
  const outOfRunRecords = allActionRecordPaths.filter(p => !actionRecordPaths.includes(p)).sort()
  if (outOfRunRecords.length > 0) issues.push(`Subagent Contribution Verification may only reference action records under the current run subagents/: ${outOfRunRecords.slice(0, 5).join(', ')}`)
  if (actionRecordPaths.length > 0) {
    const reviewedRecordPaths = new Set([...extractPathsFromFieldValue(reviewedActionRecordsField)].map(normalizeRepoPath).filter(p => p.startsWith(`.recursive/run/${basename(runDir)}/subagents/`)))
    if (!reviewedActionRecordsField.trim()) {
      issues.push('Subagent Contribution Verification must record Reviewed Action Records')
    } else {
      const missingReviewed = actionRecordPaths.filter(p => !reviewedRecordPaths.has(p)).sort()
      if (missingReviewed.length > 0) issues.push(`Reviewed Action Records is missing referenced action record path(s): ${missingReviewed.slice(0, 5).join(', ')}`)
    }
    if (!hasMeaningfulValue(mainAgentVerification, new Set(['n/a', 'none']))) {
      issues.push('Subagent Contribution Verification must record Main-Agent Verification Performed')
    } else if (verificationPaths.size === 0) {
      issues.push('Main-Agent Verification Performed must cite files, artifacts, or diff-owned paths that were checked')
    } else {
      const missingVerification = findMissingRepoPaths(repoRoot, [...verificationPaths].sort())
      if (missingVerification.length > 0) issues.push(`Main-Agent Verification Performed references missing path(s): ${missingVerification.slice(0, 5).join(', ')}`)
    }
    if (!['accepted', 'partially accepted', 'rejected'].includes(acceptanceDecision)) issues.push('Subagent Contribution Verification must record Acceptance Decision: accepted|partially accepted|rejected')
    if (!hasMeaningfulValue(refreshHandling, new Set(['n/a', 'none']))) issues.push('Subagent Contribution Verification must record Refresh Handling')
    if (!trimMdValue(repairPerformed)) {
      issues.push('Subagent Contribution Verification must record Repair Performed After Verification')
    } else if (repairPaths.size > 0) {
      const missingRepair = findMissingRepoPaths(repoRoot, [...repairPaths].sort())
      if (missingRepair.length > 0) issues.push(`Repair Performed After Verification references missing path(s): ${missingRepair.slice(0, 5).join(', ')}`)
    }
  }
  for (const actionRecordPath of actionRecordPaths) {
    if (!existsSync(join(repoRoot, actionRecordPath))) {
      issues.push(`Referenced subagent action record does not exist: ${actionRecordPath}`)
      continue
    }
    const actionContent = readFileSync(join(repoRoot, actionRecordPath), 'utf8')
    const actionPhase = getMdFieldValue(getHeadingBody(actionContent, 'Metadata'), 'Phase') ?? ''
    const actionClaims = parseSubagentActionRecordClaims(actionContent)
    if (currentPhase && actionPhase && currentPhase !== actionPhase) issues.push(`Subagent action record phase mismatch: ${actionRecordPath} -> ${actionPhase}`)
    if (currentBundlePath) {
      const actionBundlePath = String(actionClaims['review_bundle'])
      if (actionBundlePath && actionBundlePath !== currentBundlePath) issues.push(`Subagent action record review bundle mismatch: ${actionRecordPath} -> ${actionBundlePath}`)
    }
    issues.push(...lintSubagentActionRecordFile(join(repoRoot, actionRecordPath), repoRoot, runDir, actualChangedFiles))
    if (['accepted', 'partially accepted'].includes(acceptanceDecision)) {
      const claimedDiffScope = new Set<string>(['created', 'modified', 'reviewed'].flatMap(k => [...(actionClaims[k] as Set<string>)]))
      let expectedVerifiedPaths = new Set(claimedDiffScope)
      if (actualChangedFiles !== null) expectedVerifiedPaths = new Set([...expectedVerifiedPaths].filter(p => actualChangedFiles.includes(p)))
      const missingVerified = [...expectedVerifiedPaths].filter(p => !verificationPaths.has(p) && !repairPaths.has(p)).sort()
      if (missingVerified.length > 0) issues.push(`Main-Agent Verification Performed does not reconcile delegated file-impact claims against the actual diff scope: ${missingVerified.slice(0, 5).join(', ')}`)
      const verificationArtifactScope = new Set<string>([String(actionClaims['current_artifact']), ...(actionClaims['upstream_artifacts'] as Set<string>), ...(actionClaims['artifact_refs'] as Set<string>)])
      if (actionClaims['review_bundle']) verificationArtifactScope.add(String(actionClaims['review_bundle']))
      verificationArtifactScope.delete('')
      if (verificationArtifactScope.size > 0 && ![...verificationArtifactScope].some(p => verificationPaths.has(p))) {
        issues.push('Main-Agent Verification Performed must cite the reviewed artifact, bundle, or upstream recursive artifacts used to verify the delegated work')
      }
    }
  }
  return [...new Set(issues)].sort()
}

/** collect_reviewed_paths: paths from Worktree Diff Audit + related addenda. */
export function collectReviewedPaths(runDir: string, artifactName: string, content: string): Set<string> {
  const reviewed = extractPathsFromText(getHeadingBody(content, 'Worktree Diff Audit'))
  for (const addendumPath of getRelatedAddendaPaths(runDir, artifactName)) {
    const full = join(runDir, 'addenda', addendumPath)
    if (existsSync(full)) for (const p of extractPathsFromText(readFileSync(full, 'utf8'))) reviewed.add(p)
  }
  return reviewed
}

/** lint_review_bundle_reference: 03.5 review-bundle validation. */
export function lintReviewBundleReference(content: string, runDir: string, repoRoot: string): string[] {
  const issues: string[] = []
  const reviewMetadata = getHeadingBody(content, 'Review Metadata')
  const bundlePath = (getMdFieldValue(reviewMetadata, 'Review Bundle Path') ?? getMdFieldValue(content, 'Review Bundle Path') ?? '').trim()
  const expectedPrefix = `.recursive/run/${basename(runDir)}/evidence/review-bundles/`
  if (!bundlePath) {
    issues.push('Review Metadata is missing Review Bundle Path')
    return issues
  }
  const normalizedBundlePath = normalizeRepoPath(bundlePath)
  if (!normalizedBundlePath.startsWith(expectedPrefix)) {
    issues.push(`Review Bundle Path must live under \`/${expectedPrefix}\``)
    return issues
  }
  if (!existsSync(join(repoRoot, normalizedBundlePath))) {
    issues.push(`Review Bundle Path does not exist: ${normalizedBundlePath}`)
    return issues
  }
  const bundleContent = readFileSync(join(repoRoot, normalizedBundlePath), 'utf8')
  const artifactPath = normalizeRepoPath(getMdFieldValue(bundleContent, 'Artifact Path') ?? '')
  const artifactHash = trimMdValue(getMdFieldValue(bundleContent, 'Artifact Content Hash') ?? '')
  if (!artifactPath) {
    issues.push('Review bundle is missing Artifact Path')
  } else if (!existsSync(join(repoRoot, artifactPath))) {
    issues.push(`Review bundle Artifact Path does not exist: ${artifactPath}`)
  }
  if (artifactPath) {
    const currentHash = existsSync(join(repoRoot, artifactPath)) ? contentSha256(readFileSync(join(repoRoot, artifactPath), 'utf8')) : null
    if (artifactHash && currentHash && artifactHash !== currentHash) issues.push('Review bundle is stale: Artifact Content Hash no longer matches the current artifact')
  }
  if (!artifactHash) issues.push('Review bundle is missing Artifact Content Hash')
  const missingHeadings: string[] = []
  for (const heading of ['Diff Basis', 'Changed Files Reviewed', 'Upstream Artifacts To Re-read', 'Relevant Addenda', 'Prior Recursive Evidence', 'Targeted Code References', 'Audit Questions', 'Required Output']) {
    if (!getHeadingBody(bundleContent, heading)) missingHeadings.push(heading)
  }
  if (missingHeadings.length > 0) issues.push(`Review bundle is missing required section(s): ${missingHeadings.join(', ')}`)
  const reviewNarrative = [getHeadingBody(content, 'Review Scope'), getHeadingBody(content, 'Requirement And Plan Reconciliation'), getHeadingBody(content, 'Plan Alignment Assessment'), getHeadingBody(content, 'Code Quality Assessment'), getHeadingBody(content, 'Issues Found'), getHeadingBody(content, 'Verdict')].join('\n')
  const citedPaths = new Set([...extractPathsFromText(content)].map(normalizeRepoPath))
  const citedReviewPaths = new Set([...extractPathsFromText(reviewNarrative)].map(normalizeRepoPath))
  const upstreamPaths = new Set([...extractPathsFromText(getHeadingBody(bundleContent, 'Upstream Artifacts To Re-read'))].map(normalizeRepoPath))
  const addendaPaths = new Set([...extractPathsFromText(getHeadingBody(bundleContent, 'Relevant Addenda'))].map(normalizeRepoPath))
  const priorPaths = new Set([...extractPathsFromText(getHeadingBody(bundleContent, 'Prior Recursive Evidence'))].map(normalizeRepoPath))
  const changedPaths = new Set([...extractPathsFromText(getHeadingBody(bundleContent, 'Changed Files Reviewed'))].map(normalizeRepoPath))
  const codeRefPaths = new Set([...extractPathsFromText(getHeadingBody(bundleContent, 'Targeted Code References'))].map(normalizeRepoPath))
  const auditQuestions = getHeadingBody(bundleContent, 'Audit Questions')
  if (isPlaceholderOnly(auditQuestions)) issues.push('Review bundle Audit Questions cannot be placeholder-only')
  const diffBasisBody = getHeadingBody(bundleContent, 'Diff Basis')
  for (const fieldName of DIFF_BASIS_FIELDS) {
    if (getMdFieldValue(diffBasisBody, fieldName) === null) issues.push(`Review bundle Diff Basis is missing ${fieldName}`)
  }
  if (changedPaths.size === 0) {
    issues.push('Review bundle Changed Files Reviewed cannot be empty')
  } else {
    const missingChanged = findMissingRepoPaths(repoRoot, [...changedPaths].sort())
    if (missingChanged.length > 0) issues.push(`Review bundle changed file path(s) do not exist: ${missingChanged.slice(0, 5).join(', ')}`)
  }
  if (codeRefPaths.size === 0) {
    issues.push('Review bundle Targeted Code References cannot be empty')
  } else {
    const missingCode = findMissingRepoPaths(repoRoot, [...codeRefPaths].sort())
    if (missingCode.length > 0) {
      issues.push(`Review bundle code ref path(s) do not exist: ${missingCode.slice(0, 5).join(', ')}`)
    } else if (changedPaths.size > 0 && ![...codeRefPaths].some(p => changedPaths.has(p))) {
      issues.push('Review bundle Targeted Code References do not overlap the changed-file scope')
    }
  }
  const expectedAddenda = new Set(getExpectedEffectiveInputAddendaPaths(runDir, '03.5-code-review.md'))
  const missingBundleAddenda = [...expectedAddenda].filter(p => !addendaPaths.has(p)).sort()
  if (missingBundleAddenda.length > 0) issues.push(`Review bundle is missing effective-input addenda: ${missingBundleAddenda.slice(0, 5).join(', ')}`)
  if (upstreamPaths.size > 0 && ![...upstreamPaths].some(p => citedReviewPaths.has(p))) issues.push('Code review narrative does not cite any upstream artifact from the review bundle')
  if (addendaPaths.size > 0 && ![...addendaPaths].some(p => citedReviewPaths.has(p))) issues.push('Code review narrative does not cite any relevant addendum from the review bundle')
  if (priorPaths.size > 0 && ![...priorPaths].some(p => citedReviewPaths.has(p))) issues.push('Code review narrative does not cite any prior recursive evidence from the review bundle')
  if ((changedPaths.size > 0 || codeRefPaths.size > 0) && ![...new Set([...changedPaths, ...codeRefPaths])].some(p => citedReviewPaths.has(p))) issues.push('Code review narrative does not cite any changed file or code reference from the review bundle')
  if (!citedPaths.has(normalizedBundlePath)) issues.push('Code review must cite the Review Bundle Path in its written review artifact')
  const verdictBody = getHeadingBody(content, 'Verdict')
  if (!verdictBody || isPlaceholderOnly(verdictBody)) issues.push('Verdict section must contain a concrete review verdict grounded in the review bundle')
  return issues
}

/** lint_phase8_skill_usage_capture: 08 Run-Local Skill Usage Capture rules. */
export function lintPhase8SkillUsageCapture(content: string): string[] {
  const issues: string[] = []
  const usageBody = getHeadingBody(content, 'Run-Local Skill Usage Capture')
  if (!usageBody) return ['Missing or empty section: ## Run-Local Skill Usage Capture']
  for (const fieldName of ['Skill Usage Relevance', 'Available Skills', 'Skills Sought', 'Skills Attempted', 'Skills Used', 'Worked Well', 'Issues Encountered', 'Future Guidance', 'Promotion Candidates']) {
    if (getMdFieldValue(usageBody, fieldName) === null) issues.push(`Run-Local Skill Usage Capture is missing ${fieldName}`)
  }
  const relevance = normalizeSkillUsageRelevance(getMdFieldValue(usageBody, 'Skill Usage Relevance'))
  if (!SKILL_USAGE_RELEVANCE_STATUSES.has(relevance)) {
    issues.push('Run-Local Skill Usage Capture must declare Skill Usage Relevance: relevant|not-relevant')
    return issues
  }
  if (['relevant', 'yes'].includes(relevance)) {
    for (const fieldName of ['Available Skills', 'Skills Attempted', 'Skills Used', 'Future Guidance']) {
      if (!isMeaningfulRequirementField(getMdFieldValue(usageBody, fieldName))) issues.push(`Run-Local Skill Usage Capture must record ${fieldName} when skill usage is relevant`)
    }
    const attempted = trimMdValue(getMdFieldValue(usageBody, 'Skills Attempted') ?? '').toLowerCase()
    const used = trimMdValue(getMdFieldValue(usageBody, 'Skills Used') ?? '').toLowerCase()
    if (['none', 'n/a'].includes(attempted) && ['none', 'n/a'].includes(used)) issues.push('Run-Local Skill Usage Capture cannot mark skill usage relevant while claiming no attempted or used skills')
  }
  const promotionBody = getHeadingBody(content, 'Skill Memory Promotion Review')
  if (!promotionBody) {
    issues.push('Missing or empty section: ## Skill Memory Promotion Review')
    return issues
  }
  for (const fieldName of ['Durable Skill Lessons Promoted', 'Generalized Guidance Updated', 'Run-Local Observations Left Unpromoted', 'Promotion Decision Rationale']) {
    if (getMdFieldValue(promotionBody, fieldName) === null) issues.push(`Skill Memory Promotion Review is missing ${fieldName}`)
  }
  if (['relevant', 'yes'].includes(relevance) && !isMeaningfulRequirementField(getMdFieldValue(promotionBody, 'Promotion Decision Rationale'))) {
    issues.push('Skill Memory Promotion Review must explain why relevant run-local observations were or were not promoted')
  }
  return issues
}

/** lint_phase_specific_rules: per-phase rules dispatched from the artifact file. */
export function lintPhaseSpecificRules(
  filePath: string,
  content: string,
  workflowProfile: string,
  runDir: string,
  repoRoot: string,
  requirementIds: string[],
  actualChangedFiles: string[] | null,
): string[] {
  const issues: string[] = []
  const fileName = basename(filePath)
  issues.push(...lintEffectiveInputAddenda(filePath, content, workflowProfile, runDir))
  issues.push(...lintSourceRequirementInventory(filePath, content, workflowProfile, runDir))
  if (fileName === '02-to-be-plan.md') {
    issues.push(...lintRequirementMapping(content, workflowProfile, runDir, repoRoot))
    issues.push(...lintPlanDriftCheck(content, workflowProfile))
  }
  issues.push(...lintRequirementCompletionStatus(filePath, content, requirementIds, runDir, workflowProfile, actualChangedFiles))
  issues.push(...lintPriorRecursiveEvidence(content, runDir, workflowProfile, repoRoot, fileName))
  issues.push(...lintSubagentContributionVerification(filePath, content, workflowProfile, runDir, repoRoot, actualChangedFiles))
  if (!STRICT_WORKFLOW_PROFILES.has(workflowProfile)) return issues
  if (fileName === '00-worktree.md') {
    const [diffBasis, diffBasisError] = normalizeDiffBasis(repoRoot, getRunDiffBasis(runDir))
    if (diffBasisError) issues.push(`Phase 0 diff basis is not executable: ${diffBasisError}`)
    else if (diffBasis === null) issues.push('Phase 0 diff basis could not be normalized')
  }
  if (fileName === '03-implementation-summary.md') {
    const tddBody = getHeadingBody(content, 'TDD Compliance Log')
    const tddMode = (getMdFieldValue(tddBody, 'TDD Mode') ?? getMdFieldValue(content, 'TDD Mode') ?? '').toLowerCase()
    if (!hasGateLine(content, 'TDD Compliance')) issues.push('Missing required gate line: TDD Compliance: PASS|FAIL')
    if (!TDD_MODES.has(tddMode)) {
      issues.push('TDD Compliance Log is missing TDD Mode: strict|pragmatic')
    } else if (tddMode === 'strict') {
      if (!tddBody.includes('RED Evidence:')) issues.push('Strict TDD is missing RED Evidence in ## TDD Compliance Log')
      if (!tddBody.includes('GREEN Evidence:')) issues.push('Strict TDD is missing GREEN Evidence in ## TDD Compliance Log')
      const redPrefix = `.recursive/run/${basename(runDir)}/evidence/logs/red/`
      const greenPrefix = `.recursive/run/${basename(runDir)}/evidence/logs/green/`
      const redPaths = collectPathsUnderPrefix(tddBody, redPrefix)
      const greenPaths = collectPathsUnderPrefix(tddBody, greenPrefix)
      if (redPaths.length === 0) {
        issues.push(`Strict TDD requires at least one RED evidence path under \`/${redPrefix}\``)
      } else {
        const missingRed = findMissingRepoPaths(repoRoot, redPaths)
        if (missingRed.length > 0) issues.push(`Strict TDD RED evidence path(s) do not exist: ${missingRed.slice(0, 5).join(', ')}`)
      }
      if (greenPaths.length === 0) {
        issues.push(`Strict TDD requires at least one GREEN evidence path under \`/${greenPrefix}\``)
      } else {
        const missingGreen = findMissingRepoPaths(repoRoot, greenPaths)
        if (missingGreen.length > 0) issues.push(`Strict TDD GREEN evidence path(s) do not exist: ${missingGreen.slice(0, 5).join(', ')}`)
      }
    } else {
      const exceptionBody = getHeadingBody(content, 'Pragmatic TDD Exception')
      if (!exceptionBody) {
        issues.push('TDD Mode pragmatic requires ## Pragmatic TDD Exception')
      } else {
        if (!hasMeaningfulValue(getMdFieldValue(exceptionBody, 'Exception reason'), new Set(['n/a', 'none']))) issues.push('Pragmatic TDD Exception is missing Exception reason')
        if (!hasMeaningfulValue(getMdFieldValue(exceptionBody, 'Compensating validation'), new Set(['n/a', 'none']))) issues.push('Pragmatic TDD Exception is missing Compensating validation')
        const pragmaticPaths = collectPathsUnderPrefix(exceptionBody, `.recursive/run/${basename(runDir)}/evidence/`)
        if (pragmaticPaths.length === 0) {
          issues.push(`Pragmatic TDD Exception requires compensating evidence paths under \`/.recursive/run/${basename(runDir)}/evidence/\``)
        } else {
          const missingPragmatic = findMissingRepoPaths(repoRoot, pragmaticPaths)
          if (missingPragmatic.length > 0) issues.push(`Pragmatic TDD compensating evidence path(s) do not exist: ${missingPragmatic.slice(0, 5).join(', ')}`)
        }
      }
    }
  }
  if (fileName === '05-manual-qa.md') {
    const qaRecord = getHeadingBody(content, 'QA Execution Record')
    const evidenceBody = getHeadingBody(content, 'Evidence and Artifacts')
    const signoffBody = getHeadingBody(content, 'User Sign-Off')
    const qaMode = (getMdFieldValue(qaRecord, 'QA Execution Mode') ?? getMdFieldValue(content, 'QA Execution Mode') ?? '').toLowerCase()
    if (!qaRecord) issues.push('Missing or empty section: ## QA Execution Record')
    if (!QA_EXECUTION_MODES.has(qaMode)) {
      issues.push('QA Execution Record is missing QA Execution Mode: human|agent-operated|hybrid')
    } else {
      if (['human', 'hybrid'].includes(qaMode)) {
        if (!hasMeaningfulValue(getMdFieldValue(signoffBody, 'Approved by'), new Set(['n/a', 'not required', 'none']))) issues.push(`QA Execution Mode ${qaMode} requires User Sign-Off -> Approved by`)
        if (!hasMeaningfulValue(getMdFieldValue(signoffBody, 'Date'), new Set(['n/a', 'not required', 'none']))) issues.push(`QA Execution Mode ${qaMode} requires User Sign-Off -> Date`)
      }
      if (['agent-operated', 'hybrid'].includes(qaMode)) {
        if (!hasMeaningfulValue(getMdFieldValue(qaRecord, 'Agent Executor'), new Set(['n/a', 'none']))) issues.push(`QA Execution Mode ${qaMode} requires QA Execution Record -> Agent Executor`)
        if (!hasMeaningfulValue(getMdFieldValue(qaRecord, 'Tools Used'), new Set(['n/a', 'none']))) issues.push(`QA Execution Mode ${qaMode} requires QA Execution Record -> Tools Used`)
        const qaPaths = collectPathsUnderPrefix(`${qaRecord}\n${evidenceBody}`, `.recursive/run/${basename(runDir)}/evidence/`)
        if (qaPaths.length === 0) {
          issues.push(`QA Execution Mode ${qaMode} requires evidence paths under \`/.recursive/run/${basename(runDir)}/evidence/\``)
        } else {
          const missingQa = findMissingRepoPaths(repoRoot, qaPaths)
          if (missingQa.length > 0) issues.push(`QA evidence path(s) do not exist: ${missingQa.slice(0, 5).join(', ')}`)
        }
      }
    }
  }
  if (fileName === '03.5-code-review.md') issues.push(...lintReviewBundleReference(content, runDir, repoRoot))
  if (fileName === '08-memory-impact.md') issues.push(...lintPhase8SkillUsageCapture(content))
  return [...new Set(issues)].sort()
}

/** get_header_remediation_lines: copy/paste lines for missing header fields. */
export function getHeaderRemediationLines(missingFields: string[]): string[] {
  const out: string[] = []
  for (const field of missingFields) {
    if (field === 'Run') out.push('Run: `/.recursive/run/<run-id>/`')
    else if (field === 'Phase') out.push('Phase: `<phase name>`')
    else if (field === 'Status') out.push('Status: `DRAFT`')
    else if (field === 'Inputs') { out.push('Inputs:'); out.push('- `<path>`') }
    else if (field === 'Outputs') { out.push('Outputs:'); out.push('- `<path>`') }
    else if (field === 'Scope note') out.push('Scope note: <one sentence describing what this artifact decides/enables>.')
    else if (field === 'LockedAt') out.push('LockedAt: `YYYY-MM-DDTHH:mm:ssZ`')
    else if (field === 'LockHash') out.push('LockHash: `<sha256-hex>`')
  }
  return out
}

/** lint_traceability: Traceability section coverage of requirement IDs. */
export function lintTraceability(filePath: string, content: string, requirementIds: string[]): string[] {
  const issues: string[] = []
  if (!TRACEABILITY_REQUIRED_FILES.has(basename(filePath))) return issues
  const traceabilityBody = getHeadingBody(content, 'Traceability')
  if (!traceabilityBody) {
    issues.push('Missing Traceability section content')
    return issues
  }
  const missingIds = requirementIds.filter(id => !traceabilityBody.includes(id))
  if (missingIds.length > 0) issues.push(`Traceability is missing explicit coverage for: ${missingIds.join(', ')}`)
  if (requirementIds.length > 0 && !/\bR\d+\b/.test(traceabilityBody)) issues.push('Traceability is vague and does not mention any requirement IDs')
  return issues
}

/** lint_audit_sections: audited-phase audit section rules. */
export function lintAuditSections(
  filePath: string,
  content: string,
  workflowProfile: string,
  actualChangedFiles: string[] | null,
  diffBasisError: string | null,
  runId: string,
  runDir: string,
): string[] {
  const issues: string[] = []
  if (!STRICT_WORKFLOW_PROFILES.has(workflowProfile) || !AUDITED_PHASE_FILES.has(basename(filePath))) return issues
  const auditStatus = getGateStatus(content, 'Audit')
  const coverageStatus = getGateStatus(content, 'Coverage')
  const approvalStatus = getGateStatus(content, 'Approval')
  if (auditStatus === 'MISSING') issues.push('Missing required audit verdict line: Audit: PASS|FAIL')
  if (coverageStatus === 'PASS' && auditStatus !== 'PASS') issues.push('Coverage: PASS is invalid without Audit: PASS')
  if (approvalStatus === 'PASS' && auditStatus !== 'PASS') issues.push('Approval: PASS is invalid without Audit: PASS')
  const auditContext = getHeadingBody(content, 'Audit Context')
  if (!auditContext) {
    issues.push('Audit Context section is empty')
  } else {
    if (!['subagent', 'self-audit'].includes(getMdFieldValue(auditContext, 'Audit Execution Mode') ?? '')) issues.push('Audit Context is missing a valid Audit Execution Mode: subagent|self-audit')
    if (!['available', 'unavailable'].includes(getMdFieldValue(auditContext, 'Subagent Availability') ?? '')) issues.push('Audit Context is missing a valid Subagent Availability: available|unavailable')
    if (!hasMeaningfulValue(getMdFieldValue(auditContext, 'Subagent Capability Probe'), new Set(['n/a', 'none']))) issues.push('Audit Context is missing Subagent Capability Probe')
    if (!hasMeaningfulValue(getMdFieldValue(auditContext, 'Delegation Decision Basis'), new Set(['n/a', 'none']))) issues.push('Audit Context is missing Delegation Decision Basis')
    if (getMdFieldValue(auditContext, 'Audit Inputs Provided') === null && !auditContext.includes('Audit Inputs Provided:')) issues.push('Audit Context is missing Audit Inputs Provided')
    issues.push(...collectSubagentDelegationIssues(auditContext))
  }
  for (const heading of AUDIT_REQUIRED_HEADINGS) {
    const sectionBody = getHeadingBody(content, heading)
    if (!sectionBody) issues.push(`Missing or empty audited-phase section: ## ${heading}`)
    else if (isPlaceholderOnly(sectionBody)) issues.push(`Audited-phase section still contains placeholder-only content: ## ${heading}`)
  }
  const diffAuditBody = getHeadingBody(content, 'Worktree Diff Audit')
  for (const field of DIFF_BASIS_FIELDS) {
    if (getMdFieldValue(diffAuditBody, field) === null) issues.push(`Worktree Diff Audit is missing: ${field}:`)
  }
  const gapsBody = getHeadingBody(content, 'Gaps Found')
  if (auditStatus === 'PASS' && gapsBody && !/\bnone\b/i.test(gapsBody)) issues.push('Audit: PASS is invalid while Gaps Found still lists unresolved in-scope gaps')
  const expectedChangedFiles = getPhaseOwnedActualChangedFiles(basename(filePath), actualChangedFiles, dirname(dirname(dirname(runDir))))
  if (DIFF_AUDITED_FILES.has(basename(filePath)) && expectedChangedFiles !== null) {
    if (diffBasisError) {
      issues.push(`Cannot verify git diff basis: ${diffBasisError}`)
    } else {
      const reviewedPaths = collectReviewedPaths(runDir, basename(filePath), content)
      const missingPaths = expectedChangedFiles.filter(p => !reviewedPaths.has(p))
      if (missingPaths.length > 0) {
        const preview = missingPaths.slice(0, 5).join(', ')
        const suffix = missingPaths.length > 5 ? ' ...' : ''
        issues.push(`Worktree Diff Audit does not account for actual changed files from git diff: ${preview}${suffix}`)
      }
    }
  }
  return issues
}

/** lint_artifact_file: full per-artifact lint (canonical lint_artifact_file parity). */
export function lintArtifactFile(
  filePath: string,
  runDir: string,
  repoRoot: string,
  workflowProfile: string,
  requirementIds: string[],
  actualChangedFiles: string[] | null,
  diffBasisError: string | null,
): [number, number] {
  const content = readFileSync(filePath, 'utf8')
  const fileName = basename(filePath)
  const status = getMdFieldValue(content, 'Status') ?? 'UNKNOWN'
  const missingHeaderFields = ['Run', 'Phase', 'Status', 'Inputs', 'Outputs', 'Scope note'].filter(f => !hasHeaderField(content, f))
  if (missingHeaderFields.length > 0) {
    writeIssue('FAIL', filePath, `Missing required header field(s): ${missingHeaderFields.join(', ')}`, getHeaderRemediationLines(missingHeaderFields))
    return [1, 0]
  }
  let failCount = 0
  let warnCount = 0
  if (!['DRAFT', 'LOCKED'].includes(status)) {
    failCount += 1
    writeIssue('FAIL', filePath, `Invalid Status value '${status}' (expected DRAFT or LOCKED)`, ['Status: `DRAFT`'])
  }
  if (status === 'LOCKED') {
    const lockMissing = ['LockedAt', 'LockHash'].filter(f => !hasHeaderField(content, f))
    if (lockMissing.length > 0) {
      failCount += 1
      writeIssue('FAIL', filePath, `Status is LOCKED but missing: ${lockMissing.join(', ')}`, getHeaderRemediationLines(lockMissing))
    }
  }
  const [hasTodo, , , unchecked] = getTodoStats(content)
  if (!hasTodo) {
    failCount += 1
    writeIssue('FAIL', filePath, 'Missing required section: ## TODO', ['## TODO', '', '- [ ] <task 1>', '- [ ] <task 2>'])
  } else if (status === 'LOCKED' && unchecked > 0) {
    failCount += 1
    writeIssue('FAIL', filePath, `LOCKED artifact has unchecked TODO items: ${unchecked}`, ['# Option A: check all TODO boxes under ## TODO', '# Option B: set Status back to `DRAFT` until TODOs are complete'])
  }
  for (const heading of getArtifactRequiredSections(fileName, workflowProfile)) {
    if (!hasHeading(content, heading)) {
      failCount += 1
      writeIssue('FAIL', filePath, `Missing required section heading: ## ${heading}`, [`## ${heading}`, '', '<content>'])
    }
  }
  for (const gate of ['Coverage', 'Approval']) {
    if (!hasGateLine(content, gate)) {
      failCount += 1
      writeIssue('FAIL', filePath, `Missing required gate line: ${gate}: PASS|FAIL`, [`${gate}: FAIL`])
    }
  }
  for (const issue of lintTraceability(filePath, content, requirementIds)) {
    failCount += 1
    writeIssue('FAIL', filePath, issue)
  }
  for (const issue of lintAuditSections(filePath, content, workflowProfile, actualChangedFiles, diffBasisError, basename(runDir), runDir)) {
    failCount += 1
    writeIssue('FAIL', filePath, issue)
  }
  for (const issue of lintPhaseSpecificRules(filePath, content, workflowProfile, runDir, repoRoot, requirementIds, actualChangedFiles)) {
    failCount += 1
    writeIssue('FAIL', filePath, issue)
  }
  if (['04-test-summary.md', '05-manual-qa.md'].includes(fileName)) {
    const evidenceDir = join(runDir, 'evidence')
    const requiredSubdirs = ['screenshots', 'logs', 'perf', 'traces']
    if (!existsSync(evidenceDir)) {
      warnCount += 1
      writeIssue('WARN', filePath, `Evidence directory missing at ${evidenceDir}`, [
        `mkdir -p "${join(evidenceDir, 'screenshots')}"`,
        `mkdir -p "${join(evidenceDir, 'logs')}"`,
        `mkdir -p "${join(evidenceDir, 'perf')}"`,
        `mkdir -p "${join(evidenceDir, 'traces')}"`,
        `mkdir -p "${join(evidenceDir, 'other')}"`,
      ])
    } else {
      const missingSubdirs = requiredSubdirs.filter(s => !existsSync(join(evidenceDir, s)))
      if (missingSubdirs.length > 0) {
        warnCount += 1
        writeIssue('WARN', filePath, `Evidence subfolder(s) missing under ${evidenceDir}: ${missingSubdirs.join(', ')}`, missingSubdirs.map(s => `mkdir -p "${join(evidenceDir, s)}"`))
      }
    }
  }
  return [failCount, warnCount]
}

/** is_lock_valid_for_lint: canonical lock-validity check (used for late-phase sequencing). */
export function isLockValidForLint(filePath: string, workflowProfile: string): boolean {
  if (!existsSync(filePath)) return false
  const content = readFileSync(filePath, 'utf8')
  const status = getMdFieldValue(content, 'Status') ?? ''
  const [hasTodo, , , unchecked] = getTodoStats(content)
  const auditRequired = STRICT_WORKFLOW_PROFILES.has(workflowProfile) && AUDITED_PHASE_FILES.has(basename(filePath))
  const auditOk = !auditRequired || getGateStatus(content, 'Audit') === 'PASS'
  const runDir = dirname(filePath)
  const repoRoot = dirname(dirname(dirname(runDir)))
  const requirementIds = existsSync(join(runDir, '00-requirements.md')) ? getRunRequirementIds(runDir, workflowProfile) : []
  let actualChangedFiles: string[] | null = null
  if (STRICT_WORKFLOW_PROFILES.has(workflowProfile)) {
    const diffBasis = getRunDiffBasis(runDir)
    const [rawChanged, ] = getGitChangedFiles(repoRoot, diffBasis)
    if (rawChanged !== null) actualChangedFiles = filterRuntimeChangedFiles(rawChanged, basename(runDir))
  }
  const phaseSpecificIssues = lintPhaseSpecificRules(filePath, content, workflowProfile, runDir, repoRoot, requirementIds, actualChangedFiles)
  const tddGateOk = basename(filePath) !== '03-implementation-summary.md' || getGateStatus(content, 'TDD Compliance') === 'PASS'
  return status === 'LOCKED' && hasHeaderField(content, 'LockedAt') && hasHeaderField(content, 'LockHash') && getGateStatus(content, 'Coverage') === 'PASS' && getGateStatus(content, 'Approval') === 'PASS' && auditOk && tddGateOk && hasTodo && unchecked === 0 && phaseSpecificIssues.length === 0
}

/** lint_memory_doc: validate a memory shard's metadata frontmatter. */
export function lintMemoryDoc(filePath: string): [number, number] {
  const content = readFileSync(filePath, 'utf8')
  let failCount = 0
  let warnCount = 0
  const missingFields = MEMORY_REQUIRED_FIELDS.filter(f => !hasHeaderField(content, f))
  if (missingFields.length > 0) {
    failCount += 1
    writeIssue('FAIL', filePath, `Missing required memory metadata field(s): ${missingFields.join(', ')}`)
    return [failCount, warnCount]
  }
  const memoryType = (getMdFieldValue(content, 'Type') ?? '').toLowerCase()
  if (!MEMORY_ALLOWED_TYPES.has(memoryType)) {
    failCount += 1
    writeIssue('FAIL', filePath, `Invalid memory Type '${memoryType}' (expected one of: ${[...MEMORY_ALLOWED_TYPES].sort().join(', ')})`)
  }
  const memoryStatus = (getMdFieldValue(content, 'Status') ?? '').toUpperCase()
  if (!MEMORY_ALLOWED_STATUSES.has(memoryStatus)) {
    failCount += 1
    writeIssue('FAIL', filePath, `Invalid memory Status '${memoryStatus}' (expected one of: ${[...MEMORY_ALLOWED_STATUSES].sort().join(', ')})`)
  }
  if (hasHeaderField(content, 'Parent') && !getMdFieldValue(content, 'Parent')) {
    warnCount += 1
    writeIssue('WARN', filePath, 'Parent metadata field is present but empty')
  }
  if (hasHeaderField(content, 'Superseded-By') && !getMdFieldValue(content, 'Superseded-By')) {
    warnCount += 1
    writeIssue('WARN', filePath, 'Superseded-By metadata field is present but empty')
  }
  return [failCount, warnCount]
}

/** lint_memory_plane: validate the .recursive/memory/ plane. */
export function lintMemoryPlane(repoRoot: string): [number, number] {
  let failCount = 0
  let warnCount = 0
  const memoryRoot = join(repoRoot, '.recursive', 'memory')
  const routerPath = join(memoryRoot, 'MEMORY.md')
  if (!existsSync(memoryRoot)) {
    writeIssue('FAIL', memoryRoot, 'Memory plane directory is missing')
    return [1, 0]
  }
  if (!existsSync(routerPath)) {
    failCount += 1
    writeIssue('FAIL', routerPath, 'Memory router file is missing')
  }
  for (const subdir of ['domains', 'patterns', 'incidents', 'episodes', 'archive', 'skills']) {
    const full = join(memoryRoot, subdir)
    if (!existsSync(full)) {
      warnCount += 1
      writeIssue('WARN', full, 'Memory subdirectory is missing')
    }
  }
  const skillRouterPath = join(memoryRoot, 'skills', 'SKILLS.md')
  if (!existsSync(skillRouterPath)) {
    warnCount += 1
    writeIssue('WARN', skillRouterPath, 'Skill memory router file is missing')
  } else {
    for (const subdir of ['availability', 'usage', 'issues', 'patterns']) {
      const full = join(memoryRoot, 'skills', subdir)
      if (!existsSync(full)) {
        warnCount += 1
        writeIssue('WARN', full, 'Skill memory subdirectory is missing')
      }
    }
  }
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) out.push(...walk(full))
      else if (e.name.endsWith('.md')) out.push(full)
    }
    return out
  }
  let docs: string[] = []
  try { docs = walk(memoryRoot).sort() } catch { docs = [] }
  for (const doc of docs) {
    if (SKILL_MEMORY_ROUTER_NAMES.has(basename(doc))) continue
    const [docFail, docWarn] = lintMemoryDoc(doc)
    failCount += docFail
    warnCount += docWarn
  }
  return [failCount, warnCount]
}

/** get_prerequisite_blockers: reuse lock.ts chain validation for phase-sequence checks. */
import { getPrerequisiteBlockers as getPrereqBlockers, getLockStatus } from './lock.ts'

/**
 * lintRun(repoRoot, runId): FULL canonical lint of a recursive run (in-process).
 * Mirrors lint-recursive-run.py main():
 *   - resolve run dir (runId or latest), derive workflow profile + requirement ids
 *   - validate the diff basis + collect actual changed files (git)
 *   - lint each artifact in RUN_ARTIFACT_SEQUENCE order (WARN if missing),
 *     then addenda, then subagent action records
 *   - phase-sequence prerequisite checks + late-phase requirement checks
 *   - lint the memory plane
 *   - print Summary + return verdict
 */
export function lintRun(repoRoot: string, runId: string): LintResult {
  issues.length = 0
  const root = repoRoot
  const runRoot = join(root, '.recursive', 'run')
  if (!existsSync(runRoot)) {
    const msg = `recursive run directory not found at: ${runRoot}\n       Is this the project repo root? (Expected .recursive/run/)`
    console.log(`[FAIL] ${msg}`)
    return { errors: [msg], warnings: [], failCount: 1, warnCount: 0, passed: false, summary: 'Summary\n- FAIL: 1\n- WARN: 0' }
  }
  const runDirs = readdirSync(runRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
  const selectedRuns = runId ? [runId] : (runDirs.length > 0 ? [runDirs[runDirs.length - 1]] : [])
  if (selectedRuns.length === 0) {
    const msg = 'no recursive runs found under .recursive/run/'
    console.log(`[FAIL] ${msg}`)
    return { errors: [msg], warnings: [], failCount: 1, warnCount: 0, passed: false, summary: 'Summary\n- FAIL: 1\n- WARN: 0' }
  }
  let totalFail = 0
  let totalWarn = 0
  for (const selectedRun of selectedRuns) {
    const runDir = join(runRoot, selectedRun)
    if (!existsSync(runDir)) {
      totalFail += 1
      writeIssue('FAIL', runDir, `recursive run directory not found: ${runDir}`)
      continue
    }
    console.log(`Linting run: ${selectedRun}`)
    console.log(`Path: ${runDir}`)
    const workflowProfile = getWorkflowProfile(runDir)
    console.log(`Workflow Profile: ${workflowProfile}`)
    console.log()
    const requirementIds = getRunRequirementIds(runDir, workflowProfile)
    let actualChangedFiles: string[] | null = null
    let diffBasisError: string | null = null
    if (STRICT_WORKFLOW_PROFILES.has(workflowProfile)) {
      const diffBasis = getRunDiffBasis(runDir)
      // Worktree + branch awareness: verify the recorded base/worktree branch
      // context against live git before trusting the diff basis. Emits FAIL when
      // the run's recorded checkout/branch no longer matches reality (e.g. lint
      // running from the main checkout instead of the run's worktree, or the
      // worktree branch changed after Phase 0 locked).
      const branchFails = verifyRecordedBranches(root, diffBasis, runDir)
      for (const message of branchFails) {
        totalFail += 1
        writeIssue('FAIL', runDir, message)
      }
      if (diffBasis.baseline_reference || diffBasis.normalized_baseline) {
        const [rawChanged, gitError] = getGitChangedFiles(root, diffBasis)
        if (gitError) {
          diffBasisError = gitError
          totalFail += 1
          writeIssue('FAIL', runDir, `Unable to verify git diff basis: ${gitError}`)
        } else if (rawChanged !== null) {
          actualChangedFiles = filterRuntimeChangedFiles(rawChanged, selectedRun)
        }
      }
    }
    const expectedArtifacts = RUN_ARTIFACT_SEQUENCE
    for (const artifact of expectedArtifacts) {
      const artifactPath = join(runDir, artifact)
      if (!existsSync(artifactPath)) {
        const status = getLockStatus(artifactPath)
        if (status === 'MISSING') {
          // Canonical emits: [WARN] Missing artifact (ok if not reached yet): <path>
          // The path is part of the MESSAGE, not the filePath, to mirror the CLI line.
          issues.push({ severity: 'WARN', filePath: '', message: `Missing artifact (ok if not reached yet): ${artifactPath}` })
          console.log(`[WARN] Missing artifact (ok if not reached yet): ${artifactPath}`)
          totalWarn += 1
          continue
        }
        totalFail += 1
        writeIssue('FAIL', artifactPath, `Artifact exists but cannot be read: ${artifact}`)
        continue
      }
      const [failCount, warnCount] = lintArtifactFile(artifactPath, runDir, root, workflowProfile, requirementIds, actualChangedFiles, diffBasisError)
      totalFail += failCount
      totalWarn += warnCount
    }
    const addendaDir = join(runDir, 'addenda')
    if (existsSync(addendaDir)) {
      const addenda = readdirSync(addendaDir).filter(n => n.endsWith('.md')).sort()
      for (const addendum of addenda) {
        const [failCount, warnCount] = lintArtifactFile(join(addendaDir, addendum), runDir, root, workflowProfile, requirementIds, actualChangedFiles, diffBasisError)
        totalFail += failCount
        totalWarn += warnCount
      }
    }
    const subagentsDir = join(runDir, 'subagents')
    if (existsSync(subagentsDir)) {
      const actionRecords = readdirSync(subagentsDir).filter(n => n.endsWith('.md')).sort()
      for (const actionRecord of actionRecords) {
        const issuesFound = lintSubagentActionRecordFile(join(subagentsDir, actionRecord), root, runDir, actualChangedFiles)
        for (const issue of issuesFound) {
          totalFail += 1
          writeIssue('FAIL', join(subagentsDir, actionRecord), issue)
        }
      }
    }
    // Phase-sequence prerequisite check: later artifacts require earlier LOCKED phases.
    for (const artifact of expectedArtifacts) {
      const artifactPath = join(runDir, artifact)
      if (!existsSync(artifactPath)) continue
      const blockers = getPrereqBlockers(runDir, artifact)
      for (const blocker of blockers) {
        totalFail += 1
        writeIssue('FAIL', artifactPath, `Phase-sequence violation: '${artifact}' exists but prerequisite '${blocker.artifact}' is ${blocker.status} (must be LOCKED first)`)
      }
    }
    if (STRICT_WORKFLOW_PROFILES.has(workflowProfile) || workflowProfile === COMPAT_WORKFLOW_PROFILE) {
      const lateRequirements: Array<[string, string]> = [
        ['05-manual-qa.md', '06-decisions-update.md'],
        ['06-decisions-update.md', '07-state-update.md'],
        ['07-state-update.md', '08-memory-impact.md'],
      ]
      for (const [priorArtifact, nextArtifact] of lateRequirements) {
        if (isLockValidForLint(join(runDir, priorArtifact), workflowProfile) && !existsSync(join(runDir, nextArtifact))) {
          totalFail += 1
          writeIssue('FAIL', join(runDir, nextArtifact), `Run profile ${workflowProfile} requires ${nextArtifact} after ${priorArtifact} locks`)
        }
      }
      const [memoryFail, memoryWarn] = lintMemoryPlane(root)
      totalFail += memoryFail
      totalWarn += memoryWarn
    }
    console.log('----')
    console.log()
  }
  console.log('Summary')
  console.log(`- FAIL: ${totalFail}`)
  console.log(`- WARN: ${totalWarn}`)
  console.log()
  if (totalFail > 0) console.log('[FAIL] Lint failed')
  else console.log('[OK] Lint passed')
  const errors: string[] = []
  const warnings: string[] = []
  for (const issue of issues) {
    if (issue.severity === 'FAIL') errors.push(`[FAIL] ${issue.filePath}: ${issue.message}`)
    else {
      // Missing-artifact warns carry the path in the message with empty filePath.
      if (issue.filePath === '') warnings.push(`[WARN] ${issue.message}`)
      else warnings.push(`[WARN] ${issue.filePath}: ${issue.message}`)
    }
  }
  const summary = `Summary\n- FAIL: ${totalFail}\n- WARN: ${totalWarn}`
  return { errors, warnings, failCount: totalFail, warnCount: totalWarn, passed: totalFail === 0, summary }
}

