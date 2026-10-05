/**
 * Closeout receipt scaffolding (R2) — TS port of recursive-closeout.py.
 * Creates/updates Phase 0-8 receipt stubs with canonical headers
 * and required sections, gated on prerequisite phases being LOCKED.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getLockStatus, getPrerequisiteBlockers } from './lock.ts'
import { getRunTreeAddenda } from './ts-lint.ts'

export interface CloseoutPhaseConfig {
  file: string
  label: string
  scopeNote: string
  todoItems: string[]
}

export const PHASE_CONFIG: Record<string, CloseoutPhaseConfig> = {
  // ⚠ 00–03 WERE ADDED ON REQUEST. They are the phases the closeout deliberately did NOT cover when this was
  // ported (`recursive-closeout.py` scaffolded 4–8 only), which left the EARLY artifacts — the ones every
  // later receipt leans on — as the only phases with no receipt stub. The KEYS are the ones `status.ts`
  // already publishes in its phase table (`00R`/`00W` for the two artifacts sharing the `00-` prefix), so the
  // vocabulary a model reads in `recursive_status` and the vocabulary accepted here are the same. That table
  // is pinned byte-for-byte by `status.parity.spec.ts` against the Python golden, so it is NOT touched.
  '00R': {
    file: '00-requirements.md',
    label: 'Phase 0 (Requirements)',
    scopeNote: 'Scaffolds the requirements receipt: the problem, the acceptance criteria and the scope boundary this run is judged against.',
    todoItems: ['State the problem in one sentence', 'List acceptance criteria as checkable items', 'Name what is out of scope'],
  },
  '00W': {
    file: '00-worktree.md',
    label: 'Phase 0 (Worktree)',
    scopeNote: 'Scaffolds the worktree ground receipt: what the tree held, and what was already in flight, before the run touched it.',
    todoItems: ['Record the tree state before the run', 'Name in-flight work that must not be disturbed'],
  },
  '01': {
    file: '01-as-is.md',
    label: 'Phase 1 (AS-IS)',
    scopeNote: 'Scaffolds the as-is receipt: the behaviour observed before the change, with the evidence that established it.',
    todoItems: ['Describe observed behaviour only', 'Cite the evidence for each observation'],
  },
  '01.5': {
    file: '01.5-root-cause.md',
    label: 'Phase 1.5 (Root Cause)',
    scopeNote: 'Scaffolds the root-cause receipt: the mechanism behind the observed behaviour, and why the competing explanations were rejected.',
    todoItems: ['Name the mechanism', 'Say why the competing explanations were rejected'],
  },
  '02': {
    file: '02-to-be-plan.md',
    label: 'Phase 2 (TO-BE Plan)',
    scopeNote: 'Scaffolds the to-be plan receipt: the intended change, its slices, and the verification each slice will need.',
    todoItems: ['List slices in delivery order', 'Give each slice its verification'],
  },
  '03': {
    file: '03-implementation-summary.md',
    label: 'Phase 3 (Implementation)',
    scopeNote: 'Scaffolds the implementation receipt: what was actually built, against what was planned, with its declared TDD mode.',
    todoItems: ['Declare the TDD mode', 'List the files changed', 'Record any deviation from the plan'],
  },
  '04': {
    file: '04-test-summary.md',
    label: '04 Test Summary',
    scopeNote: 'Scaffolds the audited test-summary receipt from the existing implementation, review, and evidence context.',
    todoItems: [
      'Record the pre-test implementation audit and execution environment',
      'Capture exact commands, evidence, and final results',
      'Complete the audited test-summary gates before locking',
    ],
  },
  '05': {
    file: '05-manual-qa.md',
    label: '05 Manual QA',
    scopeNote: 'Scaffolds the manual-QA receipt and captures any preview URL evidence that should appear in the QA record.',
    todoItems: [
      'Declare the QA execution mode and supporting evidence',
      'Record the manual QA scenarios and observed results',
      'Complete Coverage and Approval gates before locking',
    ],
  },
  '06': {
    file: '06-decisions-update.md',
    label: '06 Decisions Update',
    scopeNote: 'Scaffolds the compact decision-ledger delta receipt for the completed run closeout.',
    todoItems: [
      'Record the exact decisions delta applied during closeout',
      'Reference the updated decision ledger entry',
      'Complete the audited decision-update gates before locking',
    ],
  },
  '07': {
    file: '07-state-update.md',
    label: '07 State Update',
    scopeNote: 'Scaffolds the compact state-ledger delta receipt for the validated final repository state.',
    todoItems: [
      'Record the exact state delta applied during closeout',
      'Reference the updated state ledger summary',
      'Complete the audited state-update gates before locking',
    ],
  },
  '08': {
    file: '08-memory-impact.md',
    label: '08 Memory Impact',
    scopeNote: 'Scaffolds the compact memory-plane delta receipt for the final validated run impact.',
    todoItems: [
      'Review affected memory docs and freshness outcomes',
      'Document uncovered paths and router/parent refresh work',
      'Complete the audited memory-impact gates before locking',
    ],
  },
}

const REQUIRED_SECTIONS: Record<string, string[]> = {
  // The early phases keep the artifact's own canonical headings, which `recursive_init` templates and
  // `recursive_lint` both know; these are the stub's minimum, not a replacement for them.
  '00R': ['TODO', 'Problem Statement', 'Acceptance Criteria', 'Scope Boundary', 'Out of Scope'],
  '00W': ['TODO', 'Worktree State', 'In-Flight Work', 'Baseline Expectations'],
  '01': ['TODO', 'Observed Behaviour', 'Evidence', 'Surprises'],
  '01.5': ['TODO', 'Root Cause', 'Rejected Explanations', 'Confidence'],
  '02': ['TODO', 'Intended Change', 'Slices', 'Verification Plan', 'Risks'],
  '03': ['TODO', 'TDD Mode', 'Files Changed', 'Deviations From Plan'],
  '04': ['TODO', 'Pre-Test Implementation Audit', 'Environment', 'Execution Mode', 'Commands Executed (Exact)', 'Results Summary', 'Evidence and Artifacts', 'Failures and Diagnostics (if any)', 'Flake/Rerun Notes', 'Requirement Completion Status', 'Traceability', 'Coverage Gate', 'Approval Gate'],
  '05': ['TODO', 'Execution Mode', 'QA Execution Record', 'QA Scenarios and Results', 'User Sign-Off', 'Requirement Completion Status', 'Traceability', 'Coverage Gate', 'Approval Gate'],
  '06': ['TODO', 'Decisions Changes Applied', 'Rationale', 'Resulting Decision Entry', 'Traceability', 'Coverage Gate', 'Approval Gate'],
  '07': ['TODO', 'State Changes Applied', 'Rationale', 'Resulting State Summary', 'Traceability', 'Coverage Gate', 'Approval Gate'],
  '08': ['TODO', 'Diff Basis', 'Changed Paths Review', 'Affected Memory Docs', 'Uncovered Paths', 'Router and Parent Refresh', 'Run-Local Skill Usage Capture', 'Skill Memory Promotion Review', 'Final Status Summary', 'Traceability', 'Coverage Gate', 'Approval Gate'],
}

const SECTION_BODIES: Record<string, string> = {
  'Pre-Test Implementation Audit': '- Re-read the implementation summary, code review, addenda, and owned diff before finalizing this test receipt.',
  'Environment': '- Record the actual runtime, tool versions, and any disposable-repo constraints here before locking.',
  'Execution Mode': '- Record whether test execution was local, CI-backed, or hybrid before locking.',
  'Commands Executed (Exact)': '- Record the exact commands run for this test summary, one command per bullet.',
  'Results Summary': '- Summarize the final pass/fail outcomes and any reruns here before locking.',
  'Evidence and Artifacts': '- List concrete evidence paths under `/.recursive/run/<run-id>/evidence/` that support this phase.',
  'Failures and Diagnostics (if any)': '- Record expected failures and any final diagnostics here; use `None.` only when no diagnostics were needed.',
  'Flake/Rerun Notes': '- Record any reruns or explicitly state that none were required.',
  'QA Execution Record': '- QA Execution Mode: agent-operated\n- Agent Executor: populate the actual executor before locking\n- Tools Used: populate the actual tools used before locking\n- Evidence Path: populate the concrete QA evidence path before locking',
  'QA Scenarios and Results': '- Record each manual QA scenario and observed result here before locking.',
  'User Sign-Off': '- Approved by: N/A (set a real approver when QA mode requires human sign-off)\n- Date: N/A (set a real approval date when required)',
  'Decisions Changes Applied': '- Record the exact `.recursive/DECISIONS.md` delta applied during closeout.',
  'Resulting Decision Entry': '- Point to the final ledger entry heading or path after updating `.recursive/DECISIONS.md`.',
  'State Changes Applied': '- Record the exact `.recursive/STATE.md` delta applied during closeout.',
  'Resulting State Summary': '- Summarize the final state line or section that now reflects the completed run.',
  'Rationale': '- Record why this closeout delta was necessary and how it aligns with the completed run.',
  'Traceability': '- Map the closeout evidence back to the in-scope requirements before locking.',
  'Diff Basis': '- Reconfirm the final memory review against the executable Phase 0 diff basis before locking.',
  'Changed Paths Review': '- Record the final changed product/control-plane paths reviewed for memory impact.',
  'Affected Memory Docs': '- List the affected memory docs under `/.recursive/memory/`, including any skill-memory router or shard docs reviewed or updated before locking.',
  'Uncovered Paths': '- Record uncovered paths or replace with `None.` only after the memory review is complete.',
  'Router and Parent Refresh': '- Record any router, parent, freshness, or skill-memory updates made in the memory plane.',
  'Run-Local Skill Usage Capture': [
    '- Skill Usage Relevance: not-relevant',
    '- Available Skills: record the skills available in the run environment, or `none`',
    '- Skills Sought: record any skills the run tried to discover, or `none`',
    '- Skills Attempted: record any skills attempted, or `none`',
    '- Skills Used: record any skills actually used, or `none`',
    '- Worked Well: record what helped, or `none`',
    '- Issues Encountered: record any skill issues or `none`',
    '- Future Guidance: record prefer/caution/avoid guidance, or `none`',
    '- Promotion Candidates: record candidate durable lessons, or `none`',
  ].join('\n'),
  'Skill Memory Promotion Review': [
    '- Durable Skill Lessons Promoted: record any generalized skill-memory shards updated, or `none`',
    '- Generalized Guidance Updated: record router/index or reusable guidance updates, or `none`',
    '- Run-Local Observations Left Unpromoted: record transient observations kept run-local, or `none`',
    '- Promotion Decision Rationale: explain why observations were or were not promoted into durable skill memory',
  ].join('\n'),
  'Final Status Summary': '- Summarize the resulting memory freshness, uncovered paths outcome, and any durable skill-memory lessons captured here before locking.',
  'Requirement Completion Status': '- Add machine-checkable requirement completion lines before locking.',
  'Coverage Gate': '- Replace these checklist items with phase-specific proof before locking.\nCoverage: FAIL',
  'Approval Gate': '- Replace these checklist items with phase-specific approval proof before locking.\nApproval: FAIL',
}

export interface CloseoutResult {
  phase: string
  file: string
  created: string[]
  existing: string[]
  /**
   * Every addendum found anywhere in the run tree, as run-relative paths — and cited in the scaffolded
   * receipt. Optional on the TYPE so a caller that builds its own result literal still compiles; the
   * closeout itself always populates it.
   */
  addenda?: string[]
}

export interface CloseoutOptions {
  /** Enforce prerequisite-lock gating (default true). */
  strict?: boolean
}

/**
 * Create or update a closeout receipt stub for the given phase.
 * Returns the file + created/existing lists. When strict, refuses phases whose
 * prerequisite artifacts are not all LOCKED (reuses lock.ts chain validation).
 *
 * ⚠ ADDENDA ARE PART OF THE CLOSEOUT WORK, and they are CITED, never written. An addendum closes a gap in
 * an artifact that is already locked, which is precisely the kind of thing a receipt must account for — and
 * they are not always in `addenda/`: the real ones sit beside the artifact they close, in the run ROOT. So
 * the receipt lists every addendum in the run tree (see {@link getRunTreeAddenda}), and says so explicitly
 * when there are none, because "we looked and found none" and "we never looked" must not read alike.
 */
export function closeoutPhase(runDir: string, phase: string, opts: CloseoutOptions = {}): CloseoutResult {
  const config = PHASE_CONFIG[phase]
  if (!config) throw new Error('Unsupported closeout phase: ' + phase)

  const strict = opts.strict ?? true
  if (strict) {
    const blockers = getPrerequisiteBlockers(runDir, config.file)
    if (blockers.length > 0) {
      throw new Error(
        'Prerequisite blockers: ' + blockers.map(b => b.artifact + ' (' + b.status + ')').join(', '),
      )
    }
  }

  mkdirSync(runDir, { recursive: true })
  const filePath = join(runDir, config.file)
  const existed = existsSync(filePath)

  // ⚠ FU-8 — A CLOSEOUT MUST NOT SILENTLY UNLOCK ITS OWN ARTIFACT. Found by the FU-1 harness: a
  // closeout run after the phase had locked rewrote the file to `Status: \`DRAFT\`` while its RECEIPT
  // still said LOCKED, leaving a run whose file and receipt disagree. The plugin publishes the rule this
  // breaks, in the policy section a model reads every turn: *"Writes to a Status: LOCKED phase doc are
  // denied/asked; reopen explicitly to edit."* The prerequisite check above guards EARLIER phases; this
  // guards the artifact the closeout actually writes.
  //
  // ⚠ IT REFUSES RATHER THAN SKIPPING QUIETLY, and it names the remedy, because the caller's next move
  // differs: a refusal means "reopen it first if you really mean to", while a silent skip would look
  // like a successful closeout that changed nothing.
  if (getLockStatus(filePath) === 'LOCKED') {
    throw new Error(
      'Artifact is LOCKED: ' + config.file + ' — the contract denies a write to a LOCKED phase doc; '
      + 'reopen it explicitly (recursive_lock with reopen) before scaffolding its receipt',
    )
  }

  const runId = runDir.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown-run'
  const addenda = getRunTreeAddenda(runDir)
  const lines: string[] = [
    'Run: `/.recursive/run/' + runId + '/`',
    'Phase: `' + config.label + '`',
    'Status: `DRAFT`',
    'Workflow version: `recursive-mode-audit-v2`',
    'Inputs:',
    '- `/.recursive/run/' + runId + '/00-requirements.md` (locked)',
    'Outputs:',
    '- `/.recursive/run/' + runId + '/' + config.file + '`',
    'Scope note: ' + config.scopeNote,
    'Addenda:',
    ...(addenda.length > 0
      ? addenda.map(a => '- `/.recursive/run/' + runId + '/' + a + '`')
      : ['- none found in the run tree']),
    '',
  ]
  for (const heading of REQUIRED_SECTIONS[phase]) {
    lines.push('## ' + heading, '', SECTION_BODIES[heading] ?? '- Populate this section before locking.', '')
  }
  writeFileSync(filePath, lines.join('\n').replace(/\n/g, '\n').trimEnd() + '\n', 'utf8')

  return {
    phase,
    file: config.file,
    created: existed ? [] : [config.file],
    existing: existed ? [config.file] : [],
    addenda,
  }
}
