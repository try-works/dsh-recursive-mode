/**
 * ⚠ THE DELEGATION GATE CHECKS PROVENANCE, NOT FILE LAYOUT.
 *
 * THE DEFECT, from a finished real run (`01-threejs-scientific-calculator` in a scratch workspace): the run
 * obtained SIX of its eight reviews OUTSIDE the plugin, HAND-WROTE the `## Subagent Action Record` files and the
 * `## Subagent Contribution Verification` section that cites them, and locked — while its own
 * `operations/operations.jsonl` held only the plugin's TWO real dispatches. The gate could see WHERE a cited
 * file lived (a `subagents/` path-prefix filter) and HOW it was written (the action-record shape), and a
 * well-formed document in the trusted directory answers both of those perfectly. Nothing compared the citation
 * with the run's own record of what it dispatched, so a reader reconciling the operation log against
 * `subagents/` found verdicts with no matching operation.
 *
 * WHAT THESE CASES PIN, and both halves are required:
 *   (a) a cited record whose delegation has NO recorded operation is REPORTED — asserted in the two shapes the
 *       real run produced (a record that names no delegation at all, and one naming a delegation the run never
 *       dispatched); and
 *   (b) a record whose delegation HAS one is NOT reported.
 *
 * ⚠ BOTH HALVES ARE ASSERTED ON WHAT THE PLUGIN ITSELF WROTE. The positive case drives the real
 * `delegateReview` — the method `recursive_review` and `recursive_delegate` both call — with a stubbed subagents
 * seam, so the action record and the operation line under test are the ones the production writers produced. A
 * fixture that wrote both files itself would still pass if `delegateReview` stopped passing the delegation to
 * either writer, which is exactly the wiring that has to hold.
 *
 * The gate is asserted through `lintPhaseSpecificRules` — the function whose issues `lintArtifactFile` counts as
 * FAILs and that the lock standard gate refuses a phase on — so the rule is checked where it blocks, not on a
 * copy of it.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { readOperations } from '../src/identity.ts'
import { lintPhaseSpecificRules } from '../src/ts-lint.ts'
import { CURRENT_WORKFLOW_PROFILE } from '../src/phase-rules.ts'
import type { SubagentsRuntimeLike, SubagentParentHandle, SubagentResultLike } from '../src/delegation.ts'

const RUN = 'prov-run'
const PHASE = '01'
const DELEGATION = '01-review'
const CHILD = 'c1'
const ARTIFACT = '01-as-is.md'
const SUBAGENTS_REL = '.recursive/run/' + RUN + '/subagents/'

const POLICY = {
  version: 1,
  role_routes: {
    'code-reviewer': { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
  },
  cli_overrides: {},
  custom_clis: [],
}

const APPROVED: SubagentResultLike = {
  output: '{"verdict":"APPROVE"}',
  stopReason: 'completed',
  success: true,
  structured: { verdict: 'APPROVE' },
} as SubagentResultLike

/** A continuable subagents seam that settles at once, so the delegation completes rather than parking. */
function fakeSubagents(): SubagentsRuntimeLike {
  const runtime: Record<string, unknown> = {
    start: async () => APPROVED,
    startContinuable: async (spec: { childId?: string }) => ({ childId: spec.childId ?? CHILD, messageId: 'm1' }),
    followup: async () => ({ messageId: 'm2' }),
  }
  return runtime as unknown as SubagentsRuntimeLike
}

/** A temp workspace with a router policy and one DRAFT artifact, scaffolded like the sibling specs. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-provenance-'))
  const cfg = join(root, '.recursive', 'config')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'recursive-router.json'), JSON.stringify(POLICY), 'utf8')
  const runDir = join(root, '.recursive', 'run', RUN)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, ARTIFACT), '# AS-IS\n\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n', 'utf8')
  return root
}

/**
 * ONE REAL DISPATCH, through the method both delegation tools call.
 *
 * The record and the operation line this leaves behind are the artifacts the gate reads, so a case that cites
 * this record is a case about the PLUGIN's own delegation rather than about a hand-built fixture.
 */
async function dispatchReview(): Promise<{ root: string; runDir: string; recordRel: string }> {
  const root = makeRoot()
  const runDir = join(root, '.recursive', 'run', RUN)
  const ctx = new Context()
  await ctx.plugin(RecursiveRuntime, { repoRoot: root })
  await ctx.recursive.delegateReview({
    root,
    runId: RUN,
    phase: PHASE,
    role: 'code-reviewer',
    delegationId: DELEGATION,
    childId: CHILD,
    artifactPath: join(runDir, ARTIFACT),
    upstreamArtifacts: [],
    auditQuestions: ['does the artifact hold up?'],
    requiredOutput: 'verdict',
    providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
    subagents: fakeSubagents(),
    parent: {} as SubagentParentHandle,
    awaitRoundResult: async () => APPROVED,
  } as never)
  await ctx.fiber.dispose()
  const name = readdirSync(join(runDir, 'subagents')).find((entry) => entry.endsWith('-action.md'))
  if (name === undefined) throw new Error('the delegation wrote no action record; the fixture is broken')
  return { root, runDir, recordRel: SUBAGENTS_REL + name }
}

/**
 * A HAND-WRITTEN record in the shape the finished run left behind: a flat file under `subagents/` with a
 * synthetic round-number stamp, carrying whatever `## Metadata` the forger chose.
 */
function writeHandWrittenRecord(runDir: string, fileName: string, metadataLines: string[]): string {
  const dir = join(runDir, 'subagents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), [
    '# Subagent Action Record',
    '',
    '## Metadata',
    '- Subagent ID: independent-review-01',
    '- Run ID: ' + RUN,
    '- Phase: ' + PHASE,
    '- Purpose: independent adversarial review of the phase artifact',
    '- Execution Mode: native (subagent tool, fresh child, no shared conversation context)',
    '- Status: completed',
    ...metadataLines,
    '- Stop Reason: verdict delivered as `REVISE` with 6 findings',
    '- Timestamp: 2026-10-13T08:08:00+08:00',
    '',
    '## Inputs Provided',
    '- Current Artifact: `' + '.recursive/run/' + RUN + '/' + ARTIFACT + '`',
    '- Diff Basis: `local commit` versus `working-tree`',
    '- Audit / Task Questions: does the artifact hold up?',
    '',
  ].join('\n'), 'utf8')
  return SUBAGENTS_REL + fileName
}

/** The SCV section under test: the same fields a real artifact carries, citing the given records. */
function artifactCiting(citations: string[]): string {
  return [
    'Run: `' + RUN + '`',
    'Phase: `' + PHASE + '`',
    'Status: `DRAFT`',
    '',
    '## Subagent Contribution Verification',
    '',
    '- Reviewed Action Records: ' + citations.map((c) => '`' + c + '`').join(', '),
    '- Main-Agent Verification Performed: the controller re-read `' + '.recursive/run/' + RUN + '/' + ARTIFACT + '` against the diff.',
    '- Acceptance Decision: accepted',
    '- Refresh Handling: not applicable; the delegation consumed no external context to refresh.',
    '- Repair Performed After Verification: the delegated findings were checked against the artifact and repaired where they held.',
    '',
  ].join('\n')
}

/**
 * The provenance findings the gate produces — the ONE question this spec asks.
 *
 * Filtered on `operations.jsonl` because every provenance message names the log it reconciled against, and the
 * minimal artifact in these cases fails plenty of unrelated rules that have nothing to do with provenance.
 */
function provenanceFindings(root: string, runDir: string, content: string): string[] {
  return lintPhaseSpecificRules(
    join(runDir, ARTIFACT), content, CURRENT_WORKFLOW_PROFILE, runDir, root, [], null,
  ).filter((issue) => issue.includes('operations.jsonl'))
}

/**
 * Rewrite the run's operation log exactly as a build BEFORE this change wrote it: the same records, with the
 * delegation fields absent. Used by the legacy-log cases, which is where the version guard is decided.
 */
function stripDelegationFields(runDir: string): void {
  const logPath = join(runDir, 'operations', 'operations.jsonl')
  const legacy = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>
      delete entry.delegationId
      delete entry.childId
      return JSON.stringify(entry)
    })
    .join('\n') + '\n'
  writeFileSync(logPath, legacy, 'utf8')
}

describe('the delegation gate reads provenance from the run operation log', () => {
  it('(b) a review DISPATCHED by the plugin satisfies it — record and log agree, and nothing is reported', async () => {
    const { root, runDir, recordRel } = await dispatchReview()
    try {
      // The two artifacts the gate reconciles, written by the PRODUCTION writers. If `delegateReview` stopped
      // carrying the delegation into either of them, the case below would report a real review as unproven.
      const record = readFileSync(join(root, recordRel), 'utf8')
      expect(record, 'the action record names the delegation it came from').toContain('- Delegation: ' + DELEGATION)
      const dispatched = readOperations(runDir).filter((entry) => entry.act === 'delegate-review')
      expect(dispatched.map((entry) => [entry.delegationId, entry.childId])).toEqual([[DELEGATION, CHILD]])

      expect(provenanceFindings(root, runDir, artifactCiting([recordRel]))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('(a1) the REAL forgery shape is reported: a hand-written record that names no delegation', async () => {
    const { root, runDir } = await dispatchReview()
    try {
      // The run DID dispatch a delegation — exactly as the real run had two recorded dispatches — and the cited
      // record belongs to none of them. That is the case the old gate passed.
      const forged = writeHandWrittenRecord(runDir, '1791849000000-independent-review-action.md', [])
      expect(provenanceFindings(root, runDir, artifactCiting([forged]))).toEqual([
        'Subagent Contribution Verification cites a record that names no delegation, so its provenance cannot be checked against operations.jsonl: ' + forged,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('(a2) a record naming a delegation the run never dispatched is reported', async () => {
    const { root, runDir } = await dispatchReview()
    try {
      const forged = writeHandWrittenRecord(runDir, '1791849500000-plan-review-action.md', ['- Delegation: 02-review'])
      expect(provenanceFindings(root, runDir, artifactCiting([forged]))).toEqual([
        "Subagent Contribution Verification cites delegation '02-review', which operations.jsonl records no delegate-review for: " + forged,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a nested citation of the child the run DID start is not reported', async () => {
    const { root, runDir } = await dispatchReview()
    try {
      const dir = join(runDir, 'subagents', DELEGATION, 'child-' + CHILD)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'reply.md'), '# reply\n\nthe delegated verdict\n', 'utf8')
      const cited = SUBAGENTS_REL + DELEGATION + '/child-' + CHILD + '/reply.md'
      expect(provenanceFindings(root, runDir, artifactCiting([cited]))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a nested citation of a child the delegation never started is reported', async () => {
    const { root, runDir } = await dispatchReview()
    try {
      const dir = join(runDir, 'subagents', DELEGATION, 'child-forged')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'reply.md'), '# reply\n\na verdict from nowhere\n', 'utf8')
      const cited = SUBAGENTS_REL + DELEGATION + '/child-forged/reply.md'
      expect(provenanceFindings(root, runDir, artifactCiting([cited]))).toEqual([
        "Subagent Contribution Verification cites child 'forged' of delegation '01-review', which operations.jsonl records no dispatch of: " + cited,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a run with NO operation log degrades to the previous behaviour rather than failing the phase', () => {
    const root = makeRoot()
    try {
      const runDir = join(root, '.recursive', 'run', RUN)
      const forged = writeHandWrittenRecord(runDir, '1791850000000-implementation-review-action.md', [])
      expect(existsSync(join(runDir, 'operations', 'operations.jsonl')), 'the fixture must have no log').toBe(false)
      // Nothing to reconcile against is not evidence of forgery: the check does not run at all.
      expect(provenanceFindings(root, runDir, artifactCiting([forged]))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an UNREADABLE operation log degrades the same way', () => {
    const root = makeRoot()
    try {
      const runDir = join(root, '.recursive', 'run', RUN)
      const forged = writeHandWrittenRecord(runDir, '1791851000000-test-review-action.md', [])
      // A directory where the log file belongs: `readFileSync` throws, so the ledger cannot be read.
      mkdirSync(join(runDir, 'operations', 'operations.jsonl'), { recursive: true })
      expect(provenanceFindings(root, runDir, artifactCiting([forged]))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a run whose log PREDATES the delegation field is NOT refused — a false refusal is its own defect', async () => {
    // ⚠ THE CASE THAT WOULD HAVE REFUSED A LEGITIMATE RUN. `OperationRecord.delegationId` was ADDED with this
    // gate, so every `delegate-review` record written by an earlier build carries none. Without the guard in
    // `lintSubagentDelegationProvenance`, a run started under 0.9.x and locking under this build resolves a
    // citation's delegation from its PATH, finds no record naming it, and FAILS — refusing a phase whose
    // review THIS PLUGIN ITSELF DISPATCHED. By this project's own rule a refusal must be TRUE.
    const { root, runDir } = await dispatchReview()
    try {
      // Rewrite the log exactly as a pre-change build wrote it: the same records, minus the new fields.
      stripDelegationFields(runDir)

      // The SAME nested citation the case above reports as a forgery — indistinguishable from it by path
      // alone, which is exactly why the version guard has to exist.
      const dir = join(runDir, 'subagents', DELEGATION, 'child-' + CHILD)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'reply.md'), '# reply\n\nthe delegated verdict\n', 'utf8')
      const cited = SUBAGENTS_REL + DELEGATION + '/child-' + CHILD + '/reply.md'
      expect(provenanceFindings(root, runDir, artifactCiting([cited]))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the version guard is NARROW: one record carrying the field puts provenance back in force', async () => {
    // Otherwise the guard would be a forgery path: strip the field from the log and every citation passes.
    const { root, runDir } = await dispatchReview()
    try {
      // The dispatched record still names its delegation, so the field IS in use; the cited child is not one
      // it started, and that must still be reported.
      const dir = join(runDir, 'subagents', DELEGATION, 'child-forged')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'reply.md'), '# reply\n\na verdict from nowhere\n', 'utf8')
      const cited = SUBAGENTS_REL + DELEGATION + '/child-forged/reply.md'
      expect(provenanceFindings(root, runDir, artifactCiting([cited]))).toEqual([
        "Subagent Contribution Verification cites child 'forged' of delegation '01-review', which operations.jsonl records no dispatch of: " + cited,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the version guard is SCOPED, not a no-op: a legacy log still reports a record that names NO delegation', async () => {
    // ⚠ THE MEASURED CASE, and the reason this case exists at all. A version of this guard that exempted the
    // WHOLE check on a log predating `delegationId` passed every test in this file while making the gate inert
    // on the run it was built from: `01-threejs-scientific-calculator`'s log holds TWO `delegate-review`
    // records, BOTH legacy — so a whole-check exemption reported 0 of that run's six hand-written verdicts,
    // which is the defect itself. The exemption may cover only the branch a legacy log genuinely cannot
    // answer (a delegation no record in it could have named). A record that identifies NO delegation is
    // decidable in every run that has a log, and must stay reported.
    const { root, runDir } = await dispatchReview()
    try {
      stripDelegationFields(runDir)
      const forged = writeHandWrittenRecord(runDir, '1791849000000-independent-review-action.md', [])
      expect(provenanceFindings(root, runDir, artifactCiting([forged]))).toEqual([
        'Subagent Contribution Verification cites a record that names no delegation, so its provenance cannot be checked against operations.jsonl: ' + forged,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
