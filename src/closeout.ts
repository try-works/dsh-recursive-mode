/**
 * Closeout receipt scaffolding (R2) — TS port of recursive-closeout.py.
 * Creates/updates Phase 4/5/6/7/8 delta-receipt stubs with canonical headers
 * and required sections, gated on prerequisite phases being LOCKED.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPrerequisiteBlockers } from './lock.ts'

export interface CloseoutPhaseConfig {
  file: string
  label: string
  scopeNote: string
  todoItems: string[]
}

export const PHASE_CONFIG: Record<string, CloseoutPhaseConfig> = {
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
}

export interface CloseoutOptions {
  /** Enforce prerequisite-lock gating (default true). */
  strict?: boolean
}

/**
 * Create or update a closeout receipt stub for the given phase.
 * Returns the file + created/existing lists. When strict, refuses phases whose
 * prerequisite artifacts are not all LOCKED (reuses lock.ts chain validation).
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

  const runId = runDir.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown-run'
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
  }
}
