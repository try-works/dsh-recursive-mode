/**
 * FU-17 step 5 — THE WORK RECORD MUST BE CITABLE *IN THE RUN*.
 *
 * The phase contract is unchanged by work delegation: the main agent verifies what a child produced and records
 * that in `## Subagent Contribution Verification`. What the linter enforces, and what this test pins, is the word
 * IN THE RUN: a citation is only attributed when it points at `.recursive/run/<this run>/subagents/…`, and any
 * other run's path is collected separately and rejected. So a delegation that files its evidence somewhere else —
 * or nowhere — cannot satisfy the contract, which is the technical reason the adoption path and the action record
 * matter at all.
 *
 * ⚠ CITATIONS ARE BACKTICKED, and that is not cosmetic: the linter's extractor reads paths the way the artifacts
 * themselves write them, so an unbracketed path is not seen at all. My first version of this test failed exactly
 * that way — the extractor returned nothing and the failure looked like a broken rule rather than a mis-formatted
 * fixture. The fixture now mirrors the real artifact format.
 *
 * Deliberately mechanism-level rather than a full lint run: these are the two exported readers the linter itself
 * uses, so asserting on them asserts the rule rather than a copy of it.
 */
import { describe, expect, it } from 'vitest'
import { getAllSubagentActionRecordPaths, getSubagentActionRecordPaths } from '../src/ts-lint.ts'

describe('FU-17: the work record is citable in the run', () => {
  const runDir = '/repo/.recursive/run/work-run'
  const artifact = (citation: string): string => [
    'Run: `work-run`',
    'Status: `DRAFT`',
    '',
    '## Subagent Contribution Verification',
    '',
    'Reviewed Action Records: ' + citation,
    'Main-Agent Verification Performed: `.recursive/run/work-run/03-implementation-summary.md`',
    'Acceptance Decision: accepted',
    'Refresh Handling: the child re-ran after the feedback and the artifact was refreshed',
    'Repair Performed After Verification: `.recursive/run/work-run/03-implementation-summary.md`',
    '',
  ].join('\n')

  it('attributes an action record filed under THIS run', () => {
    const inRun = '.recursive/run/work-run/subagents/03-work/1791-abc-action.md'
    expect(getSubagentActionRecordPaths(artifact('`' + inRun + '`'), runDir)).toEqual([inRun])
    expect(getAllSubagentActionRecordPaths(artifact('`' + inRun + '`'))).toEqual([inRun])
  })

  it('does NOT attribute a record from another run - which is what makes the linter reject it', () => {
    const elsewhere = '.recursive/run/other-run/subagents/03-work/1791-abc-action.md'
    expect(getSubagentActionRecordPaths(artifact('`' + elsewhere + '`'), runDir), 'not this run, so not attributed').toEqual([])
    expect(getAllSubagentActionRecordPaths(artifact('`' + elsewhere + '`')), 'but collected, so the linter can refuse it').toEqual([elsewhere])
  })

  it('attributes only the local one when both are cited', () => {
    const local = '.recursive/run/work-run/subagents/03-work/1791-local-action.md'
    const foreign = '.recursive/run/other-run/subagents/03-work/1792-foreign-action.md'
    const both = artifact('`' + local + '` and `' + foreign + '`')
    expect(getSubagentActionRecordPaths(both, runDir)).toEqual([local])
    expect(getAllSubagentActionRecordPaths(both).sort()).toEqual([foreign, local].sort())
  })

  it('finds nothing when the section is absent, so an artifact cannot claim verification it does not carry', () => {
    expect(getSubagentActionRecordPaths('Run: `x`\n', runDir)).toEqual([])
    expect(getAllSubagentActionRecordPaths('Run: `x`\n')).toEqual([])
  })
})
