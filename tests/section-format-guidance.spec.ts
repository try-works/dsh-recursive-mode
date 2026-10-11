/**
 * THE NON-OBVIOUS SECTION FORMATS, MADE EXPLICIT WHERE THE AGENT IS WHEN IT WRITES.
 *
 * ⚠ WHY THIS FILE EXISTS, AND WHAT IT IS PROVING. A live run's own transcript records an agent spending a
 * very large number of turns reverse-engineering the entry-row format from the linter's failures — *"the lint
 * logic is a black box"*, *"it might strip a code span from the line using a regex"*, *"unless the parser regex
 * is GREEDY"* — testing its entries one by one for the substring `with`, and ending with a workaround it called
 * a hack (*"ensure EVERY inventory entry contains at least one backtick pair IN THE QUOTE"*). The rule it was
 * fighting was a phase-1 `## Source Requirement Inventory` and the phase's `## Requirement Completion Status`.
 * The format was never secret; it was simply never WRITTEN DOWN anywhere the agent reads while writing.
 *
 * This spec proves where it is now written down OUTSIDE the lint messages — each asserted with LITERALS so a
 * mutation bites:
 *   1. the `recursive_phase` payload (`phaseRulesFor` -> `sectionFormats`, which `runtime.phaseRules` spreads)
 *      and the real payload a mounted runtime returns for a run at phase 1 (`tests/r5-parity.spec.ts`);
 *   2. the once-per-phase pre-step reminder (`phaseLintRulesMessage`, which names the sections);
 *   3. the scaffolded artifact (`laterPhaseContent`), which carries the hint under its own heading.
 * The FAILURE MESSAGES themselves are asserted in `tests/lint-parity.spec.ts`, beside the canonical parity pins
 * they must not disturb.
 *
 * ⚠ AND THE PARSER TRAP IS PINNED AS A TRAP, NOT AS THE FORMAT. `trimMdValue` unwraps one matching quote pair
 * and refuses when the inner text contains that character, so a row wrapped in backticks parses only while no
 * field value contains a backtick — which is exactly the shape `references/artifact-template.md` shows. That is
 * a BUG (no diagnostic: the row simply vanishes), it is reported rather than fixed here, and the tests below
 * measure it so the claim is not a story. If the parser is fixed, those tests flip and THAT IS THE FIX.
 */
import { describe, it, expect } from 'vitest'
import {
  CURRENT_WORKFLOW_PROFILE,
  SECTION_FORMAT_RULES,
  getArtifactRequiredSections,
  phaseLintRulesMessage,
  phaseRulesFor,
  sectionFormatRulesFor,
} from '../src/phase-rules.ts'
import { parseSourceRequirementInventoryEntries } from '../src/ts-lint.ts'
import { laterPhaseContent, requirementsContent } from '../src/init-templates.ts'

const PROFILE = CURRENT_WORKFLOW_PROFILE

/* -------------------------------------------------------------------------- */
/* 1 — the rules are attached to the artifacts that owe them, and nowhere else */
/* -------------------------------------------------------------------------- */

describe('section formats — attached where a writer cannot guess the shape', () => {
  it('names the ROW sections of the phases that have them, and nothing for the obvious phases', () => {
    expect(sectionFormatRulesFor('01-as-is.md').map((rule) => rule.section)).toEqual([
      'Source Requirement Inventory',
      'Requirement Completion Status',
    ])
    expect(sectionFormatRulesFor('02-to-be-plan.md').map((rule) => rule.section)).toEqual([
      'Requirement Mapping',
      'Requirement Completion Status',
    ])
    // The audited phases all owe the same status rows; the unaudited/obvious ones owe nothing.
    for (const audited of ['01.5-root-cause.md', '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md', '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md']) {
      expect(sectionFormatRulesFor(audited).map((rule) => rule.section), audited).toEqual(['Requirement Completion Status'])
    }
    for (const obvious of ['00-requirements.md', '00-worktree.md', '05-manual-qa.md']) {
      expect(sectionFormatRulesFor(obvious), obvious + ' has no non-obvious row section').toEqual([])
    }
  })

  it('rides the CANONICAL section list instead of extending it — the parity table is untouched', () => {
    // `getArtifactRequiredSections` is byte-parity with the canonical linter and
    // `tests/phase-rules.parity.spec.ts` pins all twelve lists. A format rule may only ever DESCRIBE a
    // section the list already requires: a rule for an unreachable heading would be guidance nobody can act
    // on. This is also the assertion that fails if a section were ever added to that list to carry a hint.
    for (const [fileName, rules] of Object.entries(SECTION_FORMAT_RULES)) {
      const required = getArtifactRequiredSections(fileName, PROFILE)
      expect(required, fileName + ' must be a canonical artifact').toContain('TODO')
      for (const rule of rules) {
        expect(required, fileName + ' requires ## ' + rule.section).toContain(rule.section)
      }
    }
  })

  it('states a rule and ONE passing example per section — no wall of prose', () => {
    for (const [fileName, rules] of Object.entries(SECTION_FORMAT_RULES)) {
      for (const rule of rules) {
        expect(rule.rule.length, fileName + '/' + rule.section + ' rule must be one line').toBeLessThan(600)
        expect(rule.rule, fileName).not.toContain('\n')
        expect(rule.example, fileName).not.toContain('\n')
        // The example is a ROW, not prose about a row: copy-pasteable is the whole point.
        expect(rule.example, fileName + '/' + rule.section + ' example must be a bullet row').toMatch(/^- (R\d+|SRC-\d{3}) \| /)
      }
    }
    expect(sectionFormatRulesFor('01-as-is.md')[0]?.example).toContain('Disposition: in-scope')
  })

  it('is scoped to the current profile, like the lint it describes', () => {
    // `lintSourceRequirementInventory`/`lintRequirementMapping` return `[]` outside v2, so describing v2 row
    // shapes to a v1 run would describe a check that is not running.
    expect(sectionFormatRulesFor('01-as-is.md', 'recursive-mode-audit-v1')).toEqual([])
    expect(phaseRulesFor('01-as-is.md', 'recursive-mode-audit-v1').sectionFormats).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* 2 — the payload the agent already reads                                     */
/* -------------------------------------------------------------------------- */

describe('section formats — in the payload `recursive_phase` returns', () => {
  it('reaches the agent through PhaseRules, the object runtime.phaseRules spreads into its payload', () => {
    const rules = phaseRulesFor('01-as-is.md')
    expect(rules.sectionFormats).toEqual(sectionFormatRulesFor('01-as-is.md'))
    expect(rules.sectionFormats?.length).toBe(2)
    // The example is the FORMAT, not a description of it — this is the line an agent copies.
    expect(rules.sectionFormats?.[0]?.example).toBe(
      '- R1 | Disposition: in-scope | Source Quote: the lock must refuse an out-of-order artifact | Summary: an artifact with an unlocked prerequisite is refused',
    )
  })

  it('is ALWAYS present on a phaseRulesFor result, empty rather than undefined', () => {
    // Optional in the TYPE (hand-built fixtures outside this change's ownership) but never absent at runtime:
    // a payload that sometimes omits the field is a payload an agent has to check before trusting.
    for (const fileName of ['05-manual-qa.md', '00-requirements.md', '01-as-is.md', '08-memory-impact.md']) {
      const rules = phaseRulesFor(fileName)
      expect(Object.hasOwn(rules, 'sectionFormats'), fileName).toBe(true)
      expect(Array.isArray(rules.sectionFormats), fileName).toBe(true)
    }
  })

  it('names the entry-row sections in the once-per-phase pre-step reminder, and only there', () => {
    const plan = phaseLintRulesMessage('02-to-be-plan.md')
    expect(plan).toContain('Entry-row sections')
    expect(plan).toContain('## Requirement Mapping')
    expect(plan).toContain('## Requirement Completion Status')
    // The reminder points at the payload for the paragraphs, so the example lives in exactly one place.
    expect(plan).toContain('sectionFormats')
    // A phase with no non-obvious row section carries NO such line — the requirement is scoped, not noise.
    for (const obvious of ['00-requirements.md', '05-manual-qa.md']) {
      expect(phaseLintRulesMessage(obvious), obvious).not.toContain('Entry-row sections')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 3 — the trap the guidance warns about, measured                             */
/* -------------------------------------------------------------------------- */

describe('the entry-row parser — what it accepts, and the trap it drops silently', () => {
  const ids = (line: string): string[] => Object.keys(parseSourceRequirementInventoryEntries(line)[0])

  it('accepts a plain bullet row and an indented one', () => {
    expect(ids('- R1 | Disposition: in-scope | Source Quote: x | Summary: y')).toEqual(['R1'])
    expect(ids('  * SRC-001 | Disposition: in-scope | Source Quote: x | Summary: y')).toEqual(['SRC-001'])
  })

  it('drops a row whose id is not ALONE in the first field', () => {
    // Bold, a trailing colon, and a non-zero-padded SRC id are all rejected SILENTLY — this is why the rule
    // text says "the id ALONE as the first `|` field" rather than describing a parser.
    expect(ids('- **R1** | Disposition: in-scope | Source Quote: x | Summary: y')).toEqual([])
    expect(ids('- R1: | Disposition: in-scope | Source Quote: x | Summary: y')).toEqual([])
    expect(ids('- SRC-1 | Disposition: in-scope | Source Quote: x | Summary: y')).toEqual([])
    // A row with no pipe at all is not an entry either.
    expect(ids('- R1: Disposition in-scope; Source Quote x')).toEqual([])
  })

  it('BUG PIN: a backtick-wrapped row parses only while no field value contains a backtick', () => {
    // ⚠ THIS ASSERTS A DEFECT, on purpose, so the claim in `phase-rules.ts` is measured rather than asserted in
    // prose. `trimMdValue` unwraps ONE matching quote pair and refuses when the inner text contains that same
    // character: the first line below unwraps, the second does not — its first pipe field reads `` `R1 ``, which
    // `REQUIREMENT_ID_RE` rejects, so the row VANISHES with no diagnostic. If the parser is fixed to report or
    // accept this, these two lines flip, and flipping them is the fix.
    expect(ids('- `R1 | Disposition: in-scope | Source Quote: plain quote | Summary: plain`')).toEqual(['R1'])
    expect(ids('- `R1 | Disposition: in-scope | Source Quote: a quote with `code` in it | Summary: y`')).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* 4 — the scaffold carries the hint under its own heading                     */
/* -------------------------------------------------------------------------- */
describe('the scaffolded artifact shows the expected form where the agent is editing', () => {
  it('puts the rule and the passing example under the section they belong to', () => {
    const doc = laterPhaseContent('r1', '01-as-is.md')
    // Under ITS OWN heading, not in a preamble an agent skims past.
    expect(doc).toMatch(/## Source Requirement Inventory\n\n<!-- lint format: /)
    expect(doc).toContain('<!-- passing example: - R1 | Disposition: in-scope')
    expect(doc).toContain('the id ALONE as the first')
    // The hint is a COMMENT: the section is still a scaffold the writer fills, and every required heading
    // the linter checks is still present.
    for (const section of getArtifactRequiredSections('01-as-is.md', PROFILE)) {
      expect(doc, 'scaffold lacks ## ' + section).toContain('## ' + section)
    }
    expect(doc).toMatch(/Coverage: FAIL/)
    expect(doc).toMatch(/Approval: FAIL/)
  })

  it('adds nothing to a phase whose sections are obvious — no bloat', () => {
    const doc = laterPhaseContent('r1', '05-manual-qa.md')
    expect(doc).not.toContain('<!-- lint format:')
    expect(doc).toContain('- (fill)')
  })

  it('leaves the byte-parity phase-0 templates ALONE', () => {
    // `requirementsContent`/`worktreeContent` are byte-identical to the canonical recursive-init golden
    // (`tests/init-templates.parity.spec.ts`), so no hint may ever be added there.
    expect(requirementsContent('r1')).not.toContain('<!--')
  })
})
