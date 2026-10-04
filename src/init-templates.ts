/**
 * Init templates (R5): canonical-parity port of recursive-init.py's
 * requirements_content / worktree_content / detect_git_context, plus full
 * per-phase templates derived from the canonical artifact-template sections
 * (get_artifact_required_sections) + TODO + Coverage/Approval FAIL gates.
 *
 * 00-requirements.md + 00-worktree.md are byte-identical to canonical
 * recursive-init.py output (LF, no BOM). Later phases are structural: every
 * required section heading + the two FAIL gates, so lint fails honestly until
 * the phase is actually worked.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { getArtifactRequiredSections } from './phase-rules.ts'
import { gitFacts, resolveBaseBranch, type GitRepoFacts } from './git-context.ts'

export interface GitContext {
  baselineType: string
  baselineReference: string
  comparisonReference: string
  normalizedBaseline: string
  normalizedComparison: string
  normalizedDiffCommand: string
  baseBranch: string
  worktreeBranch: string
  baseCommit: string
  /** True when the init cwd is a linked git worktree (git-dir != git-common-dir). */
  isWorktree: boolean
  /** Upstream branch with the remote prefix stripped (origin/dev -> dev), null when none/detached. */
  upstreamBranch: string | null
  notes: string
}

/**
 * detect_git_context(): canonical parity. Returns {context, error} — never
 * throws on missing git; error is surfaced in the worktree template note.
 */
export function detectGitContext(repoRoot: string): { context: Partial<GitContext>; error: string | null } {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  const headSha = run(['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!headSha) {
    return { context: {}, error: 'Unable to resolve HEAD commit for Phase 0 diff basis prefill: git rev-parse returned no output' }
  }
  const facts: GitRepoFacts = gitFacts(repoRoot)
  const branch = facts.branch ?? '(detached HEAD)'
  // Distinct base branch: in a linked worktree the work is based on the branch
  // whose upstream target is the promotion source (dev/stage/main). When no
  // upstream is configured, fall back to the current branch so the recorded
  // base is always a resolvable ref.
  const baseBranch = resolveBaseBranch(facts) ?? branch
  const diffCommand = 'git diff --name-only ' + headSha
  return {
    context: {
      baselineType: 'local commit',
      baselineReference: headSha,
      comparisonReference: 'working-tree',
      normalizedBaseline: headSha,
      normalizedComparison: 'working-tree',
      normalizedDiffCommand: diffCommand,
      baseBranch,
      worktreeBranch: branch,
      baseCommit: headSha,
      isWorktree: facts.isWorktree,
      upstreamBranch: facts.upstreamBranch,
      notes: 'recursive-init prefilled this executable diff basis from the current HEAD commit. If Phase 0 later changes the chosen baseline, update every diff-basis field and rerun lint before locking.',
    },
    error: null,
  }
}

/**
 * requirements_content(run_id, template, from_issue): byte-identical to the
 * canonical recursive-init.py function (LF, template flavor in Scope note).
 */
export function requirementsContent(runId: string, template = 'feature', fromIssue = ''): string {
  const inputs = ['- [chat summary or source notes if captured in repo]']
  if (fromIssue.trim()) inputs.push('- Source: ' + fromIssue.trim())
  const inputsBlock = inputs.join('\n')
  return [
    'Run: `/.recursive/run/' + runId + '/`',
    'Phase: `00 Requirements`',
    'Status: `DRAFT`',
    'Workflow version: `recursive-mode-audit-v2`',
    'Inputs:',
    inputsBlock,
    'Outputs:',
    '- `/.recursive/run/' + runId + '/00-requirements.md`',
    'Scope note: This document defines stable requirement identifiers and acceptance criteria. (Template: ' + template + ')',
    '',
    '## TODO',
    '',
    '- [ ] Elicit requirements from user/context',
    '- [ ] Define requirement identifiers (R1, R2, ...)',
    '- [ ] Write acceptance criteria for each requirement',
    '- [ ] Document out of scope items (OOS1, OOS2, ...)',
    '- [ ] List constraints and assumptions',
    '- [ ] Complete Coverage Gate checklist',
    '- [ ] Complete Approval Gate checklist',
    '',
    '## Requirements',
    '',
    '### `R1` <short title>',
    '',
    'Description:',
    'Acceptance criteria:',
    '- [observable condition 1]',
    '- [observable condition 2]',
    '',
    '## Out of Scope',
    '',
    '- `OOS1`: ...',
    '',
    '## Constraints',
    '',
    '- ...',
    '',
    '## Coverage Gate',
    '...',
    'Coverage: FAIL',
    '',
    '## Approval Gate',
    '...',
    'Approval: FAIL',
  ].join('\n') + '\n'
}

/**
 * worktree_content(run_id, repo_root, git_context, prefill_error): byte-identical
 * to the canonical recursive-init.py function.
 */
export function worktreeContent(runId: string, repoRoot: string, git: Partial<GitContext>, prefillError: string | null): string {
  const baseBranch = git.baseBranch ?? '(resolve during Phase 0)'
  const worktreeBranch = git.worktreeBranch ?? '(resolve during Phase 0)'
  const baseCommit = git.baseCommit ?? '<resolve-before-locking>'
  const baselineType = git.baselineType ?? 'local commit'
  const baselineReference = git.baselineReference ?? '<resolve-before-locking>'
  const comparisonReference = git.comparisonReference ?? 'working-tree'
  const normalizedBaseline = git.normalizedBaseline ?? '<resolve-before-locking>'
  const normalizedComparison = git.normalizedComparison ?? 'working-tree'
  const normalizedDiffCommand = git.normalizedDiffCommand ?? 'git diff --name-only <resolve-before-locking>'
  const notes = git.notes ?? 'Populate an executable diff basis before locking Phase 0. Lint and lock will fail until the normalized basis matches live git state.'
  const setupNote = prefillError
    ? 'recursive-init could not prefill the Phase 0 diff basis automatically: ' + prefillError
    : 'recursive-init detected the current repository context and prefilled the Phase 0 diff basis.'
  return [
    'Run: `/.recursive/run/' + runId + '/`',
    'Phase: `00 Worktree`',
    'Status: `DRAFT`',
    'Inputs:',
    '- `/.recursive/run/' + runId + '/00-requirements.md`',
    '- Current git repository state',
    'Outputs:',
    '- `/.recursive/run/' + runId + '/00-worktree.md`',
    'Scope note: This document records the Phase 0 worktree context and the executable diff basis that all later audited phases must reuse.',
    '',
    '## TODO',
    '',
    '- [ ] Confirm the selected worktree location and isolation approach',
    '- [ ] Confirm the base branch and worktree branch values',
    '- [ ] Run setup and verify the clean test baseline',
    '- [ ] Confirm the diff basis fields still match live git state',
    '- [ ] Complete Coverage Gate checklist',
    '- [ ] Complete Approval Gate checklist',
    '',
    '## Directory Selection',
    '',
    '- Repository root: `' + repoRoot + '`',
    '- Preferred worktree location: `.worktrees/' + runId + '/`',
    '- Update this section with the actual selected location before locking Phase 0.',
    '',
    '## Safety Verification',
    '',
    '- Original branch / repo state observed at init time: `' + baseBranch + '`',
    '- Isolation still must be confirmed after the actual worktree is created.',
    '',
    '## Worktree Creation',
    '',
    '- Intended worktree branch: `' + worktreeBranch + '`',
    '- Record the actual worktree creation command and output before locking.',
    '',
    '## Main Branch Protection',
    '',
    '- Base branch source of truth at init time: `' + baseBranch + '`',
    '- Explicitly document any deviation from isolated worktree execution before locking.',
    '',
    '## Project Setup',
    '',
    '- Init-time note: ' + setupNote,
    '- Replace this section with the actual setup commands and results during Phase 0.',
    '',
    '## Test Baseline Verification',
    '',
    '- Record the baseline commands and results after setup completes.',
    '',
    '## Worktree Context',
    '',
    '- Base branch: `' + baseBranch + '`',
    '- Worktree branch: `' + worktreeBranch + '`',
    '- Base commit: `' + baseCommit + '`',
    '',
    '## Diff Basis For Later Audits',
    '',
    '- Baseline type: `' + baselineType + '`',
    '- Baseline reference: `' + baselineReference + '`',
    '- Comparison reference: `' + comparisonReference + '`',
    '- Normalized baseline: `' + normalizedBaseline + '`',
    '- Normalized comparison: `' + normalizedComparison + '`',
    '- Normalized diff command: `' + normalizedDiffCommand + '`',
    '- Base branch: `' + baseBranch + '`',
    '- Worktree branch: `' + worktreeBranch + '`',
    '- Diff basis notes: `' + notes + '`',
    '',
    '## Traceability',
    '',
    '- Recursive workflow safety -> Phase 0 records a reusable executable diff basis before audited phases begin.',
    '',
    '## Coverage Gate',
    '',
    '- [ ] Worktree location and branch context are recorded',
    '- [ ] Setup and clean baseline verification are recorded',
    '- [ ] Diff basis fields are executable against live git state',
    '',
    'Coverage: FAIL',
    '',
    '## Approval Gate',
    '',
    '- [ ] Phase 0 context is ready for downstream audited phases',
    '- [ ] No unresolved setup or diff-basis inconsistencies remain',
    '',
    'Approval: FAIL',
  ].join('\n') + '\n'
}

/**
 * Later-phase template: required sections (canonical get_artifact_required_
 * sections) as ## headings + TODO + FAIL gates. Structural scaffold: the phase
 * author fills each section; lint stays FAIL until Coverage/Approval are set.
 */
export function laterPhaseContent(runId: string, fileName: string, workflowProfile = 'recursive-mode-audit-v2'): string {
  const sections = getArtifactRequiredSections(fileName, workflowProfile)
  const lines = [
    'Run: `/.recursive/run/' + runId + '/`',
    'Phase: `' + fileName.replace(/\.md$/, '').replace(/^0?/, '') + '`',
    'Status: `DRAFT`',
    'Workflow version: `' + workflowProfile + '`',
    'Inputs:',
    '- (list upstream artifacts re-read for this phase)',
    'Outputs:',
    '- `/.recursive/run/' + runId + '/' + fileName + '`',
    'Scope note: Scaffold generated by the recursive-mode plugin (R5). Fill every required section before lint.',
    '',
    '## TODO',
    '',
    '- [ ] Work through every required section below',
    '- [ ] Record evidence and traceability',
    '- [ ] Complete Coverage Gate checklist',
    '- [ ] Complete Approval Gate checklist',
  ];
  for (const section of sections) {
    if (section === 'TODO') continue
    lines.push('', '## ' + section, '', '- (fill)')
  }
  lines.push('', '## Coverage Gate', '', 'Coverage: FAIL', '', '## Approval Gate', '', 'Approval: FAIL', '')
  return lines.join('\n')
}

/**
 * Scaffold dirs under a run (addenda/subagents/router-prompts/evidence + subs).
 * Mirrors canonical recursive-init.py's ensure_directory sequence.
 */
export const RUN_SCAFFOLD_DIRS = [
  'addenda',
  'subagents',
  'router-prompts',
  'evidence',
  'evidence/screenshots',
  'evidence/logs',
  'evidence/perf',
  'evidence/traces',
  'evidence/review-bundles',
  'evidence/router',
  'evidence/other',
]