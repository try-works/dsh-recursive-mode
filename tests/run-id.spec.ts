/**
 * A RUN ID IS A NAME, NOT A PATH — the rule's table.
 *
 * `recursive_init` joined a path-shaped id onto the run layer and created it:
 * the live diagnostic passed `E:\tmp\rm-live-diagnostics\01-calculator-lib` as a
 * runId and got `mkdir '…\.recursive\run\E:\tmp\…'` (RM5501 ENOENT), and a
 * separator-shaped id is worse than a failure — measured on this host,
 * `nested/child-run` CREATES `.recursive/run/nested/child-run` and
 * `..\escaped-run` CREATES `.recursive/escaped-run`.
 *
 * This spec pins BOTH halves of the fix: the shapes that must be refused, and —
 * just as important — the shapes this repository actually uses, which must keep
 * working. The tool-boundary behaviour (refused before anything is written) is
 * pinned in `tests/tools.spec.ts`; this file pins the rule itself.
 */
import { describe, it, expect } from 'vitest'
import { RUN_ID_EXAMPLES, RUN_ID_MAX_LENGTH, RUN_ID_RULE, isValidRunId, runIdProblem } from '../src/run-id.ts'

/**
 * Ids this repository really uses. Every one MUST stay accepted, or the rule has
 * broken the scaffold's own convention. Sources: `tests/fixtures/repo/.recursive/
 * run/` (fixture-run, older-run), `tests/fixtures/lint-golden/` (g-run),
 * `tests/*.spec.ts` (`initRun('t38-run')`, 'e2e-run', 'fu7b-run', 'T25-record',
 * '03-tool-run', '05-feature'), the tool descriptions' documented example
 * ('03-something'), and the run ids named in PROPOSAL.md / README.md.
 */
const LEGITIMATE_RUN_IDS: readonly string[] = [
  '01-calculator-lib',
  '01-calculator',
  'fixture-run',
  'older-run',
  'g-run',
  '03-something',
  '03-tool-run',
  '05-feature',
  '07-demo',
  '10-deleg',
  'e2e-run',
  'fu7b-run',
  'guard-run',
  'ph-run',
  'review-run',
  'settle-run',
  'strict-run',
  't38-run',
  'tmp-run',
  'r1',
  'r9',
  'run-1',
  '_underscore-run',
  'T25-record', // tests/docs-contract.spec.ts — uppercase tags are used in this repo
  '01.5-root-cause', // dots INSIDE a name are fine (the phase file names are dotted too)
]

/** Refused ids, each paired with the reason the refusal must state. */
const REFUSED_RUN_IDS: ReadonlyArray<readonly [string, string]> = [
  ['E:\\tmp\\rm-live-diagnostics\\01-calculator-lib', 'drive-qualified path'], // the live diagnostic's id
  ['/tmp/rm-live-diagnostics/01-calculator-lib', 'path separator'],
  ['nested/child-run', 'path separator'],
  ['..\\escaped-run', 'path separator'],
  ['../../escaped-again', 'path separator'],
  ['C:relative-drive-run', 'drive-qualified path'],
  ['03-run:ads', 'colon'],
  ['..', '".." segment'],
  ['...', '".." segment'],
  ['.', 'relative path segment'],
  ['.hidden-run', 'hidden name'],
  ['03-trailing-dot.', 'ends with'],
  ['03 interior space', 'whitespace'],
  ['03\ttab', 'whitespace'],
  ['03/04-embedded.md', 'path separator'],
  ['résumé-run', 'character'],
  ['03-run*', 'character'],
  ['', 'empty'],
  ['a'.repeat(RUN_ID_MAX_LENGTH + 1), 'characters'],
]

describe('the run-id rule — a name, never a path', () => {
  it('accepts every run id this repository uses (the rule is not over-restrictive)', () => {
    for (const runId of LEGITIMATE_RUN_IDS) {
      expect(runIdProblem(runId), runId + ' was wrongly refused').toBeNull()
      expect(isValidRunId(runId), runId).toBe(true)
    }
    // The examples the refusals quote must themselves be valid, or the advice is a trap.
    for (const example of RUN_ID_EXAMPLES.split(',').map((s) => s.trim())) {
      expect(isValidRunId(example), example + ' is quoted as an example but is refused').toBe(true)
    }
  })

  it('accepts the boundary length and refuses the first length over it', () => {
    expect(isValidRunId('a'.repeat(RUN_ID_MAX_LENGTH))).toBe(true)
    expect(isValidRunId('a'.repeat(RUN_ID_MAX_LENGTH + 1))).toBe(false)
  })

  it('refuses every path-shaped id, and says which rule it broke', () => {
    for (const [runId, expected] of REFUSED_RUN_IDS) {
      const problem = runIdProblem(runId)
      expect(problem, JSON.stringify(runId) + ' was accepted').not.toBeNull()
      expect(problem, JSON.stringify(runId) + ' reason').toContain(expected)
      expect(isValidRunId(runId)).toBe(false)
    }
  })

  it('reports a Windows drive-qualified path AS a drive path, not as a separator complaint', () => {
    // The message has to name what the caller actually passed.
    expect(runIdProblem('E:\\tmp\\x')).toContain('"E:"')
    expect(runIdProblem('E:\\tmp\\x')).not.toContain('"\\"')
    expect(runIdProblem('/tmp/x')).toContain('"/"')
  })

  it('the rule statement covers every property the checks enforce', () => {
    // Rendered in the tool's parameter description and in every refusal, so it
    // cannot drift from what `runIdProblem` actually does.
    expect(RUN_ID_RULE).toContain('no path separator')
    expect(RUN_ID_RULE).toContain('no drive specifier')
    expect(RUN_ID_RULE).toContain('".."')
    expect(RUN_ID_RULE).toContain('trailing dot')
    expect(problemPunctuationFree()).toEqual([])
  })
})

/** The rule is embedded in a sentence the renderer punctuates, so it carries none of its own. */
function problemPunctuationFree(): string[] {
  const offences: string[] = []
  if (/[.!]$/.test(RUN_ID_RULE)) offences.push('RUN_ID_RULE ends with punctuation')
  if (/[.!]$/.test(RUN_ID_EXAMPLES)) offences.push('RUN_ID_EXAMPLES ends with punctuation')
  for (const [runId] of REFUSED_RUN_IDS) {
    const problem = runIdProblem(runId) ?? ''
    if (/[.!]$/.test(problem)) offences.push(JSON.stringify(runId) + ' problem ends with punctuation')
  }
  return offences
}
