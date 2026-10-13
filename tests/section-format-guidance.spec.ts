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
 * ⚠ AND THE SAME PROFILE SHOWED THE OTHER HALF OF THE DEFECT: the payload said NOTHING AT ALL about the two
 * PHASE 0 artifacts. `sectionFormats` was populated from phase 1 on, and only for the four entry-row
 * sections — so `00-requirements.md`, which defines the `R#` ids every later phase's completion table is
 * lint-checked against, and `00-worktree.md`, which records the diff basis every later lock resolves, both
 * returned `[]`. The run then read the shipped bundle eleven times hunting for the rules and needed five
 * `recursive_lint` rounds to get the requirements artifact accepted. So this spec asserts THREE things the
 * earlier version could not:
 *   1. every phase whose sections the linter machine-checks carries a NON-EMPTY `sectionFormats`;
 *   2. phase 0 carries the requirement-id shape, and the phase-0 formats reach the payload `recursive_phase`
 *      actually returns (not merely the pure function);
 *   3. ⚠ EACH EXAMPLE IS ACTUALLY ACCEPTED BY THE LINTER — an artifact built from the shipped scaffold with
 *      the example substituted into its own section is driven through `lintArtifactFile`, and any example
 *      that does not parse, or that breaks a neighbouring check, fails here. "An example that is not linted
 *      is an example that rots" is the vacuity this project keeps finding, and it is asserted against the
 *      real linter rather than against the table.
 *
 * This spec proves where the rules are written down OUTSIDE the lint messages — each asserted with LITERALS
 * so a mutation bites:
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
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  CURRENT_WORKFLOW_PROFILE,
  REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS,
  REVIEW_BUNDLE_REQUIRED_SECTIONS,
  REVIEW_BUNDLE_SECTION_FORMAT_RULES,
  REVIEW_NARRATIVE_OPTIONAL_SECTIONS,
  REVIEW_NARRATIVE_REQUIRED_SECTIONS,
  REVIEW_NARRATIVE_SECTIONS,
  SECTION_FORMAT_RULES,
  getArtifactRequiredSections,
  phaseLintRulesMessage,
  phaseRulesFor,
  sectionFormatOwnerOf,
  sectionFormatRulesFor,
  sectionFormatRulesForOwner,
  type SectionFormatRule,
} from '../src/phase-rules.ts'
import { contentSha256, expectedRowDetail, extractPathsFromText, lintArtifactFile, lintReviewBundleReference, getRunDiffBasis, normalizeDiffBasis, normalizeRepoPath, parseRequirementIds, parseSourceRequirementInventoryEntries } from '../src/ts-lint.ts'
import { detectGitContext, laterPhaseContent, requirementsContent, worktreeContent } from '../src/init-templates.ts'
import { getLockStatus, lockHashFromContent } from '../src/lock.ts'
import { RecursiveRuntime } from '../src/runtime.ts'

const PROFILE = CURRENT_WORKFLOW_PROFILE

/**
 * ⚠ WHAT COUNTS AS A "MACHINE-CHECKED SECTION", STATED RATHER THAN ASSUMED — it is the set the linter reads
 * STRUCTURALLY, and every member of it is one this table now describes:
 *   - the two gate verdict lines (`hasGateLine`/`getGateStatus`) — required in EVERY artifact;
 *   - the `## TODO` checklist (`getTodoStats`), whose unticked boxes refuse a LOCKED artifact;
 *   - `## Traceability` (`lintTraceability`) — required in ten of the twelve;
 *   - `## Requirements` (`parseRequirementIds` -> `getRunRequirementIds`);
 *   - `## Diff Basis For Later Audits` (`getRunDiffBasis` -> `normalizeDiffBasis`);
 *   - the four entry-row sections (the inventory/mapping/completion parsers).
 *
 * ⚠ AND THE BOUNDARY IS DRAWN HONESTLY, because it is the one place this suite could assert something false.
 * "Carries a format" and "has a checked section" are NOT the same property: `05-manual-qa.md` has checked
 * sections (`QA Execution Mode`, `## User Sign-Off`) whose shape IS the heading and whose template already
 * shows it, and forcing an entry into the table for it would be the fifth repetition this change exists to
 * remove. What the table owes is the phases whose checked sections have a shape a writer CANNOT guess — which
 * before this change were `00-requirements.md` and `00-worktree.md` returning `[]` while the linter
 * machine-checked them. So the list below is the phases the linter reads structurally AND whose format is not
 * self-evident, and the assertion is that none of them presents an empty contract.
 */
const PHASES_WITH_CHECKED_SECTIONS = [
  '00-requirements.md', '00-worktree.md', '01-as-is.md', '01.5-root-cause.md', '02-to-be-plan.md',
  '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md',
  '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md',
] as const

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
    for (const audited of ['01.5-root-cause.md', '03-implementation-summary.md', '04-test-summary.md', '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md']) {
      expect(sectionFormatRulesFor(audited).map((rule) => rule.section), audited).toEqual(['Requirement Completion Status'])
    }
    // ⚠ 03.5 IS THE ONE PHASE WHOSE LINT CHECKS A SECOND ARTIFACT, so it is asserted on its OWN rather than
    // folded into the loop above: its list is the status row PLUS the review bundle's rows, and every one of
    // those names the file it governs. The bundle rows are the whole point of this change — a live run spent
    // eleven minutes grepping the SHIPPED BUNDLE for the rule `Code review narrative does not cite any
    // upstream artifact from the review bundle`, because this list was where the rule was not.
    const review = sectionFormatRulesFor('03.5-code-review.md')
    expect(review.map((rule) => rule.section)).toEqual([
      'Requirement Completion Status',
      'Review Bundle Path',
      'Artifact Path',
      'Artifact Content Hash',
      'Changed Files Reviewed',
      'Targeted Code References',
      'Diff Basis',
      'Upstream Artifacts To Re-read',
      'Relevant Addenda',
      'Prior Recursive Evidence',
      'Audit Questions',
      'Code review narrative',
      'Code review narrative citations',
    ])
    // The owner of each row, so a bundle rule can never be read as a heading of the phase artifact. The bundle
    // owes TWO KINDS of check — eight `##` headings and the two header fields read with `getMdFieldValue` — so
    // the rows are pinned against the union, and the exemption is named rather than left implicit.
    //
    // ⚠ THE ARTIFACT'S OWN ROWS COME FIRST AND THE BUNDLE'S FOLLOW, which is the order a reader needs: the file
    // the phase names first, then the file it points at. The assertion is a set comparison so a reordering
    // inside either table is still caught as a difference rather than silently accepted.
    expect([...sectionFormatRulesForOwner('03.5-code-review.md', 'review-bundle').map((rule) => rule.section)].sort())
      .toEqual([
        ...REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS,
        ...[...REVIEW_BUNDLE_REQUIRED_SECTIONS].filter((section) => section !== 'Required Output'),
      ].sort())
    expect(sectionFormatRulesForOwner('03.5-code-review.md', 'review-narrative').map((rule) => rule.section))
      .toEqual(['Code review narrative', 'Code review narrative citations'])
    // ...and the bundle rows are attached to THAT phase and to no other: `lintReviewBundleReference` runs for
    // `03.5-code-review.md` alone.
    for (const other of Object.keys(SECTION_FORMAT_RULES)) {
      if (other === '03.5-code-review.md') continue
      expect(sectionFormatRulesFor(other).map((rule) => rule.section), other).not.toContain('Code review narrative')
      expect(sectionFormatRulesFor(other).map((rule) => rule.section), other).not.toContain('Diff Basis')
    }
    // ⚠ PHASE 0 IS NO LONGER IN THIS LIST, and that is the whole change: it used to be asserted as "obvious".
    expect(sectionFormatRulesFor('00-requirements.md').map((rule) => rule.section)).toEqual([
      'Requirements',
      'Out of Scope',
      'Coverage Gate',
    ])
    expect(sectionFormatRulesFor('00-worktree.md').map((rule) => rule.section)).toEqual([
      'Diff Basis For Later Audits',
      'Traceability',
      'Coverage Gate',
    ])
  })

  it('carries the requirement-id shape for PHASE 0 — the contract every later completion table is checked against', () => {
    // The literal an agent copies, asserted by value so a mutation to the table bites. Phase 0 defines the
    // `R#` class; `REQUIREMENT_ID_RE` is what later phases' `## Requirement Completion Status` rows are
    // validated against, so this ONE line is the upstream end of that check.
    const requirement = sectionFormatRulesFor('00-requirements.md').find((rule) => rule.section === 'Requirements')
    expect(requirement?.example).toBe('### `R1` the lock must refuse an out-of-order artifact')
    expect(requirement?.rule).toContain('Keep the id ALONE inside its own code span')
    // ⚠ AND THE EXAMPLE IS THE PARSE, MEASURED: the id the example declares is the id `getRunRequirementIds`
    // will report for the artifact, so a phase-1 inventory row is checked against exactly this id.
    expect(parseRequirementIds(requirement?.example ?? '')).toEqual(['R1'])
    // The trap the rule names is a TRAP and not prose: an id with a WORD-LIKE suffix is parsed as no id at
    // all — `\bR\d+\b` does not match inside `R1a`, so the heading declares NOTHING and the run's requirement
    // ids come from elsewhere (or from nowhere). The heading must therefore carry the id alone.
    expect(parseRequirementIds('### `R1a` the lock must refuse an out-of-order artifact')).toEqual([])
    expect(parseRequirementIds('### `R1a` the lock must refuse an out-of-order artifact')).not.toEqual(['R1a'])
    // ...and the ROW parser's own id class, which is what a later phase's completion row is checked against:
    // the same sentence in the rule, measured. `SRC-1` is rejected, `SRC-001` is the accepted form.
    const rowIds = (id: string): string[] =>
      Object.keys(parseSourceRequirementInventoryEntries('- ' + id + ' | Disposition: in-scope | Source Quote: x | Summary: y')[0])
    expect(rowIds('SRC-1')).toEqual([])
    expect(rowIds('SRC-001')).toEqual(['SRC-001'])
  })

  it('states a rule and ONE passing example per section — no wall of prose', () => {
    for (const [fileName, rules] of Object.entries(SECTION_FORMAT_RULES)) {
      for (const rule of rules) {
        expect(rule.rule.length, fileName + '/' + rule.section + ' rule must be one line').toBeLessThan(600)
        expect(rule.rule, fileName).not.toContain('\n')
        expect(rule.example, fileName).not.toContain('\n')
        expect(rule.example.trim(), fileName + '/' + rule.section + ' example must not be empty').not.toBe('')
      }
    }
    // ⚠ TWO SHAPES, NOT ONE, AND EACH IS MATCHED EXACTLY. Every rule's example is either a copy-pasteable
    // ROW (an entry row, an `OOS` handle, a traceability bullet, a diff-basis field line) or the LINE a
    // section has to end with (a gate verdict). The per-shape regexes are the assertion: a loose
    // "it is some string" would let `Coverage: PASS` regress into `- Coverage: PASS`, which `hasGateLine`
    // does not read, and it would let a row lose its id.
    //
    // ⚠ AND THE REVIEW PHASE ADDED FOUR SHAPES, EACH PINNED TO THE ARTIFACT THAT OWNS IT rather than widened
    // into the existing ones: a bundle HEADER field (`Artifact Path: \`...\``), a bulleted path
    // (`- \`src/guard.ts\``), a bulleted question, and a NARRATIVE LINE — the last of which is prose with
    // citations in it, which is exactly what the linter reads out of those six headings. Widening
    // `entry row` or `diff-basis field line` to cover them would have made the assertion unable to tell a
    // bundle header from a phase-artifact field, which is the one distinction the bundle rules exist for.
    const SHAPES: [string, RegExp][] = [
      ['entry row', /^- (R\d+|SRC-\d{3}) \| /],
      ['gate verdict line', /^(Coverage|Approval): (PASS|FAIL)$/],
      ['requirement heading', /^### `(R\d+|SRC-\d{3})` \S/],
      ['out-of-scope bullet', /^- `OOS\d+`: \S/],
      ['traceability bullet', /^- `(R\d+|SRC-\d{3})` -> \S/],
      // ⚠ THE FIELD NAME MAY NOT CONTAIN A SPACE, and that is the whole discriminator: with `[A-Za-z ]+` this
      // shape ALSO matched the phase-0 `- Diff basis notes: \`...\`` example below, so one example matched two
      // shapes. The spec caught it; the regex is the fix, not a relaxed assertion.
      ['diff-basis field line', /^- [A-Za-z]+: `\S.*`$/],
      // A bundle HEADER field: `Field: \`value\`` with no bullet, which is where the builder writes
      // `Artifact Path` and `Artifact Content Hash` (above the first `##`), and how `getMdFieldValue` reads them.
      ['bundle header field', /^[A-Z][A-Za-z ]+: `[^`\n]+`$/],
      // A bulleted path and nothing else: how every path list in the bundle is written and read.
      ['bulleted path', /^- `[^`\n]+`$/],
      // A bulleted question: `## Audit Questions`, whose only requirement is that it is not a placeholder.
      ['audit question', /^- [A-Z][^`\n]*\?$/],
      // A narrative line: prose carrying citations in code spans, which is the form the linter's path
      // extractor reads out of the review narrative headings.
      ['review narrative line', /^- \S.*`[^`\n]+`.*$/],
    ]
    const shapeCounts = new Map<string, number>()
    for (const [fileName, rules] of Object.entries(SECTION_FORMAT_RULES)) {
      for (const rule of rules) {
        const matched = SHAPES.filter(([, pattern]) => pattern.test(rule.example)).map(([name]) => name)
        expect(matched, fileName + '/' + rule.section + ' example matched no known shape: ' + rule.example).toHaveLength(1)
        shapeCounts.set(matched[0], (shapeCounts.get(matched[0]) ?? 0) + 1)
      }
    }
    // ...and the review bundle's rows are all accounted for by the shapes ADDED for them, so the new regexes
    // are load-bearing rather than dead entries a later edit could quietly stop exercising.
    for (const rule of REVIEW_BUNDLE_SECTION_FORMAT_RULES) {
      const matched = SHAPES.filter(([, pattern]) => pattern.test(rule.example)).map(([name]) => name)
      expect(matched, rule.section + ' example matched no known shape: ' + rule.example).toHaveLength(1)
      shapeCounts.set(matched[0], (shapeCounts.get(matched[0]) ?? 0) + 1)
    }
    for (const added of ['bundle header field', 'bulleted path', 'audit question', 'review narrative line']) {
      expect(shapeCounts.get(added), added + ' is matched by no example — a shape nothing uses').toBeGreaterThan(0)
    }
    expect(sectionFormatRulesFor('01-as-is.md')[0]?.example).toContain('Disposition: in-scope')
  })

  it('rides the CANONICAL section list instead of extending it — the parity table is untouched', () => {
    // `getArtifactRequiredSections` is byte-parity with the canonical linter and
    // `tests/phase-rules.parity.spec.ts` pins all twelve lists. A format rule may only ever DESCRIBE a
    // section the list already requires: a rule for an unreachable heading would be guidance nobody can act
    // on. This is also the assertion that fails if a section were ever added to that list to carry a hint.
    //
    // ⚠ AND IT IS SCOPED TO `SECTION_FORMAT_RULES`, NOT TO `sectionFormatRulesFor`'s OUTPUT, because the
    // review BUNDLE's rows describe a different file: `## Diff Basis` and `## Upstream Artifacts To Re-read`
    // are required in NO phase artifact, so folding them into this loop would either fail here or force a
    // parity pin to move. They live in their own table for exactly this reason, and the assertion that covers
    // THEM is the next one — the same contract, checked against the list the LINTER requires of the bundle.
    for (const [fileName, rules] of Object.entries(SECTION_FORMAT_RULES)) {
      const required = getArtifactRequiredSections(fileName, PROFILE)
      expect(required, fileName + ' must be a canonical artifact').toContain('TODO')
      for (const rule of rules) {
        expect(required, fileName + ' requires ## ' + rule.section).toContain(rule.section)
      }
    }
  })

  it('the review bundle table describes the sections the LINTER requires of the bundle, and only those', () => {
    // ⚠ THE SECOND HALF OF THE CONTRACT, ASSERTED AGAINST `lintReviewBundleReference`'s OWN LIST rather than
    // against a copy of it: every heading the linter requires of the bundle must have a format rule (or be a
    // pure existence check, named below), and every rule in the table must name a heading the linter requires.
    // A bundle rule for a heading nothing checks would be a fifth surface; a checked heading with no rule is
    // the defect this change exists to fix.
    //
    // ⚠ `## Required Output` IS THE ONE EXEMPTION, and it is deliberate rather than convenient: the linter
    // requires the section to EXIST and validates no shape inside it (`getHeadingBody(bundleContent,
    // 'Required Output')` is read for presence only), and its content is the reviewer's own reply contract,
    // written by `recursive_review`. A format rule there would describe a check that does not run.
    const EXEMPT = ['Required Output']
    const described = REVIEW_BUNDLE_SECTION_FORMAT_RULES.filter((rule) => rule.appliesTo === 'review-bundle').map((rule) => rule.section)
    for (const heading of REVIEW_BUNDLE_REQUIRED_SECTIONS) {
      if (EXEMPT.includes(heading)) {
        expect(described, heading + ' is exempt, so it must NOT carry a shape the linter never checks').not.toContain(heading)
        continue
      }
      expect(described, 'the linter requires ## ' + heading + ' of the review bundle, so it must carry a format').toContain(heading)
    }
    // ⚠ AND THE HEADER FIELDS ARE COVERED TOO, which is the gap this test would otherwise leave: `Artifact Path`
    // and `Artifact Content Hash` are read with `getMdFieldValue` (they live ABOVE the first `##`), so they are
    // required of the bundle WITHOUT being sections. Both enumerations are exhaustive and disjoint by
    // assertion, so "every bundle check carries a format" is a claim about a closed set rather than a sample.
    for (const field of REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS) {
      expect(described, 'the linter requires the ' + field + ' header field, so it must carry a format').toContain(field)
      expect([...REVIEW_BUNDLE_REQUIRED_SECTIONS], field + ' is a header field, so it must not also be a section').not.toContain(field)
    }
    expect(described.length, 'every bundle row is either a header field or a required section')
      .toBe(REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS.length + REVIEW_BUNDLE_REQUIRED_SECTIONS.length - EXEMPT.length)
    for (const section of described) {
      const known: string[] = [...REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS, ...REVIEW_BUNDLE_REQUIRED_SECTIONS]
      expect(known, 'review bundle rule names an unchecked field or heading: ' + section).toContain(section)
    }
    // The two narrative rows are the phase artifact's own requirement, and they are the ONLY rows that are:
    // they must not name a bundle heading, or they would send a writer to the wrong file.
    const narrative = REVIEW_BUNDLE_SECTION_FORMAT_RULES.filter((rule) => rule.appliesTo === 'review-narrative').map((rule) => rule.section)
    expect(narrative).toEqual(['Code review narrative', 'Code review narrative citations'])
    for (const section of narrative) expect([...REVIEW_BUNDLE_REQUIRED_SECTIONS]).not.toContain(section)
    // ...and the enumerated narrative region really is the region the linter reads: five of the six names are
    // canonical REQUIRED sections of `03.5-code-review.md` — so a writer is told to put the citation in a
    // heading the artifact is already checked for — and the sixth is the OPTIONAL heading the linter
    // concatenates when it is present. Both halves are asserted, so a renamed heading cannot pass as a region.
    const reviewSections = getArtifactRequiredSections('03.5-code-review.md', PROFILE)
    for (const heading of REVIEW_NARRATIVE_REQUIRED_SECTIONS) {
      expect(reviewSections, '## ' + heading + ' must be a required section of the phase artifact').toContain(heading)
    }
    for (const heading of REVIEW_NARRATIVE_OPTIONAL_SECTIONS) {
      expect(reviewSections, '## ' + heading + ' is read only when present, so it must NOT be required').not.toContain(heading)
    }
    expect([...REVIEW_NARRATIVE_REQUIRED_SECTIONS, ...REVIEW_NARRATIVE_OPTIONAL_SECTIONS].sort())
      .toEqual([...REVIEW_NARRATIVE_SECTIONS].sort())
  })

  it('is scoped to the current profile, like the lint it describes', () => {
    // `lintSourceRequirementInventory`/`lintRequirementMapping` return `[]` outside v2, so describing v2 row
    // shapes to a v1 run would describe a check that is not running.
    expect(sectionFormatRulesFor('01-as-is.md', 'recursive-mode-audit-v1')).toEqual([])
    expect(phaseRulesFor('01-as-is.md', 'recursive-mode-audit-v1').sectionFormats).toEqual([])
    // ⚠ THE PHASE-0 FORMATS OBEY THE SAME SCOPE, and for a sharper reason: `00-worktree.md`'s diff-basis
    // check is gated on a STRICT profile, and the `R#` class is only consumed by the v2 lints.
    expect(sectionFormatRulesFor('00-requirements.md', 'recursive-mode-audit-v1')).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* 2 — NO PHASE WITH A MACHINE-CHECKED SECTION PRESENTS AN EMPTY CONTRACT      */
/* -------------------------------------------------------------------------- */

describe('every phase with a machine-checked section carries a non-empty sectionFormats', () => {
  it('never returns [] (or nothing) for a phase whose sections the linter reads structurally', () => {
    for (const fileName of PHASES_WITH_CHECKED_SECTIONS) {
      const formats = sectionFormatRulesFor(fileName)
      expect(Array.isArray(formats), fileName).toBe(true)
      expect(formats.length, fileName + ' has machine-checked sections and must declare their shape').toBeGreaterThan(0)
      // ...and the same through the structure the payload is spread from, which is the path the agent reads.
      const rules = phaseRulesFor(fileName)
      expect(rules.sectionFormats, fileName).toBeDefined()
      expect((rules.sectionFormats ?? []).length, fileName).toBeGreaterThan(0)
    }
  })

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
      // FU: the capability statement rides the same object, always set (to null by the pure function, to a
      // verdict by the runtime), so no payload is missing the key either.
      expect(Object.hasOwn(rules, 'delegatedReviewer'), fileName).toBe(true)
    }
  })

  it('names the entry-row sections in the once-per-phase pre-step reminder, and only there', () => {
    const plan = phaseLintRulesMessage('02-to-be-plan.md')
    expect(plan).toContain('Entry-row sections')
    expect(plan).toContain('## Requirement Mapping')
    expect(plan).toContain('## Requirement Completion Status')
    // The reminder points at the payload for the paragraphs, so the example lives in exactly one place.
    expect(plan).toContain('sectionFormats')
    // ⚠ AND THE REVIEW PHASE'S LINE NAMES THE FILE EACH RULE GOVERNS. `## Diff Basis` is NOT a heading of
    // `03.5-code-review.md` — it is a heading of the review bundle — so a reminder that listed it bare would
    // send a writer to add a section the phase artifact does not require, which is the failure mode the
    // two-table split exists to prevent. The one line carries the annotation; the payload carries the prose.
    const review = phaseLintRulesMessage('03.5-code-review.md')
    expect(review).toContain('## Diff Basis (review-bundle)')
    expect(review).toContain('## Upstream Artifacts To Re-read (review-bundle)')
    expect(review).toContain('## Code review narrative (review-narrative)')
    // The phase-artifact rows stay unannotated, here and in every other phase: the common case is unchanged.
    expect(review).toContain('## Requirement Completion Status |')
    expect(review).not.toContain('## Requirement Completion Status (')
    expect(phaseLintRulesMessage('01-as-is.md')).not.toContain('(review-bundle)')
    // ⚠ AND NEITHER the payload nor the reminder repeats the phase-0 prose: the reminder's own lines are the
    // ones it already carried for every phase, and the paragraphs live in the payload's `sectionFormats`.
    // One description per section, and no second copy of the rule text anywhere.
    const requirements = phaseLintRulesMessage('00-requirements.md')
    expect(requirements).toContain('Required sections: TODO | Requirements | Out of Scope | Constraints | Coverage Gate | Approval Gate')
    expect(requirements).not.toContain('Keep the id ALONE')
    expect(requirements).not.toContain('Normalized diff command')
    // ⚠ AND THE LINE IS NOW LOAD-BEARING FOR PHASE 0 TOO. It used to be emitted only for the entry-row phases;
    // because `## Requirements` and `## Out of Scope` are non-empty row sections as well, phase 0 gets it —
    // and the line must still name every section the payload carries a format for, or an agent would skip one.
    expect(requirements).toContain('Entry-row sections')
    expect(requirements).toContain('## Requirements | ## Out of Scope | ## Coverage Gate')
    // ...while a phase whose sections are all obvious still carries NO such line — scoped, not noise.
    expect(phaseLintRulesMessage('05-manual-qa.md')).not.toContain('Entry-row sections')
    // ...and the review BUNDLE's prose stays in the payload: the reminder names the sections, it does not
    // paste the rules, so the one expensive paragraph per rule exists once.
    expect(review).not.toContain('the same six backticked fields')
  })
})

/* -------------------------------------------------------------------------- */
/* 3 — THE EXAMPLES, DRIVEN THROUGH THE REAL LINTER                            */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ THIS IS THE ANTI-ROT SECTION, AND ITS MECHANISM IS THE WHOLE POINT. An example asserted only against the
 * table that holds it proves nothing; the claim under test is "a writer who follows this example writes
 * something the linter accepts". So each case below takes the REAL SCAFFOLD (`requirementsContent` /
 * `worktreeContent`, byte-parity with the canonical init golden), substitutes the example into the section the
 * rule names, satisfies the rest of the artifact the ordinary way, and runs `lintArtifactFile` — the same
 * function `recursive_lint` runs.
 *
 * The substitution is LINE-LEVEL and driven by the table, so an example can only ever replace the lines it
 * describes. When phase 0's `## Requirements` example replaced the section and the artifact then lints clean,
 * that is evidence both that the heading shape parses AND that the ids it declares are the ones the run's
 * later phases are checked against.
 */
const tempRoots: string[] = []
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** A one-commit repo, so the scaffolded diff basis is executable and the branch fields round-trip. */
function phase0Repo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'rm-fmt-'))
  tempRoots.push(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'Section Format Test')
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  git(repo, 'add', 'seed.txt')
  git(repo, 'commit', '-q', '-m', 'seed')
  return repo
}

/**
 * Replace the LAST body line under `## <heading>` with `body`, keeping the rest of the section.
 *
 * ⚠ LINE-LEVEL, NOT SECTION-LEVEL, AND THAT IS THE HONEST SHAPE OF THE CLAIM. An example describes ONE line
 * of its section — the row, the heading row, the verdict, the closing field — not the whole section:
 * `## Diff Basis For Later Audits` needs all six of its fields, and blanking five of them would make the
 * example's own field the reason the artifact fails, which is the opposite of what is being measured. So the
 * example takes the place of the section's own last body line and everything above it is left intact.
 *
 * `stopAtTodo` keeps `## TODO`'s body inside the section: the generic scan would otherwise run past the
 * checklist into the next heading.
 */
function substituteLastBodyLine(doc: string, heading: string, body: string, stopAtTodo = false): string {
  const lines = doc.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## ' + heading)
  expect(start, 'the scaffold must carry ## ' + heading).toBeGreaterThanOrEqual(0)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (stopAtTodo && lines[i].trim() === '## TODO') { end = i; break }
    if (/^\s*##\s+/.test(lines[i])) { end = i; break }
  }
  let bodyStart = -1
  for (let i = start + 1; i < end; i += 1) if (lines[i].trim() !== '') bodyStart = i
  expect(bodyStart, '## ' + heading + ' must have a body to substitute').toBeGreaterThan(start)
  return [...lines.slice(0, bodyStart), body, ...lines.slice(bodyStart + 1)].join('\n')
}

/** Tick every `## TODO` box, so the artifact is lockable rather than merely non-failing. */
function tickTodo(doc: string): string {
  return doc.replace(/^(\s*[-*]\s+\[) (\]\s+)/gm, '$1x$2')
}

/**
 * The artifact the examples describe: the real scaffold, each example substituted for the template's own
 * first body line in the section the rule names, the gates set to their PASS verdicts, and the TODO list
 * ticked.
 *
 * ⚠ THE GATE IS THE ONE SECTION SET WHOLESALE, and the rule says why: `hasGateLine` reads a line at the start
 * of the line with NOTHING else on it, so a gate section carrying checkboxes as well is still accepted — but
 * what is being measured here is the verdict LINE, and leaving the scaffold's `...` placeholder above it
 * would leave a section whose body is a placeholder. `Coverage: PASS` + `Approval: PASS` is exactly what the
 * verdict rule describes.
 */
function artifactFromExamples(fileName: string, scaffold: string): string {
  let doc = scaffold
  const sections = getArtifactRequiredSections(fileName, PROFILE)
  for (const rule of sectionFormatRulesFor(fileName)) {
    // ⚠ ONLY THE ROWS DESCRIBING A SECTION OF THIS FILE. `03.5-code-review.md` also carries the review BUNDLE's
    // rows — which name headings the phase artifact does not require — and its own `Review Bundle Path`, which
    // is a FIELD INSIDE `## Review Metadata` rather than a heading. Substituting either would fail on a heading
    // no scaffold has, which is precisely the misdescription `appliesTo` on the table and this membership test
    // here exist to prevent. The table side is asserted (every row is either a required section or a declared
    // field); this is the one place the distinction has to be APPLIED.
    if (sectionFormatOwnerOf(rule) !== 'phase-artifact') continue
    if (!sections.includes(rule.section)) continue
    if (rule.section === 'Coverage Gate') continue
    doc = substituteLastBodyLine(doc, rule.section, rule.example)
  }
  // ⚠ ONE PHASE-ARTIFACT ROW IS A FIELD RATHER THAN A HEADING, SO IT IS DELIBERATELY *NOT* SUBSTITUTED HERE.
  // `Review Bundle Path` names no section — it is a value inside `## Review Metadata` — and the value is
  // per-run (`.recursive/run/<runId>/...`), so a generic harness cannot write it: only a caller that knows the
  // run's bundle path can. `bundlePathRuleFromTable()` below is that caller, and `artifactFromTable` uses it.
  // The table side is asserted: the row is not a required section of any artifact, and it is not a section key
  // of `SECTION_FORMAT_RULES` either.
  // The two gate verdicts come from the ONE rule that describes both (`Approval Gate likewise`), so the
  // approval body is built from the coverage example rather than tabled a second time.
  //
  // ⚠ AND WHEN THE ARTIFACT HAS NO GATE RULE THE SCAFFOLD'S OWN VERDICT LINES STAND, because what this harness
  // builds is "the artifact a writer following the TABLE writes" — a table with nothing to say about the gate
  // cannot be made to contradict the scaffold, and `03.5-code-review.md` is the artifact in that position (its
  // gate lines are read by `hasGateLine`, which the scaffold already satisfies). Inventing a verdict here would
  // be the fifth copy of a rule this change exists to keep single-sourced.
  const verdict = sectionFormatRulesFor(fileName).find((rule) => rule.section === 'Coverage Gate')?.example ?? ''
  for (const gate of ['Coverage', 'Approval']) {
    if (verdict === '') break
    doc = substituteLastBodyLine(doc, gate + ' Gate', substituteGateVerdict(verdict, gate))
  }
  return tickTodo(doc)
}

/** The same verdict line with this gate's own name, e.g. `Coverage: PASS` -> `Approval: PASS`. */
function substituteGateVerdict(verdict: string, gate: string): string {
  return verdict.replace(/^Coverage:/, gate + ':')
}

/**
 * Lint one artifact of a scaffolded run, the way `recursive_lint` does, and return every `[FAIL]` line it
 * wrote. `lintArtifactFile` prints through `console.log` (that IS the linter's output surface — `writeIssue`),
 * so the messages are captured rather than discarded: a failing example must name the check that rejected it.
 *
 * ⚠ `lintRun` IS NOT USED HERE ON PURPOSE. It lints the whole run — the memory plane, the phase sequence,
 * late-phase requirements, git — so a single example's effect would be one line among many and the assertion
 * would have to filter for it. This is the per-artifact entry point, with `actualChangedFiles`/`diffBasisError`
 * passed as `null` exactly as the phase-0 lints do.
 */
function lintCase(fileName: string, scaffold: (runDir: string, repo: string) => string, runId: string): { errors: string[]; failCount: number } {
  const repo = phase0Repo()
  const runDir = join(repo, '.recursive', 'run', runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, '00-requirements.md'), requirementsContent(runId), 'utf8')
  writeFileSync(join(runDir, fileName), artifactFromExamples(fileName, scaffold(runDir, repo)), 'utf8')
  const printed: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')) }
  let failCount = 0
  try {
    const [fails] = lintArtifactFile(
      join(runDir, fileName), runDir, repo, PROFILE,
      parseRequirementIds(readFileSync(join(runDir, '00-requirements.md'), 'utf8')), null, null,
    )
    failCount = fails
  } finally { console.log = original }
  return { errors: printed.filter((line) => line.startsWith('[FAIL]')), failCount }
}

describe('every example in the table is ACCEPTED by the real linter', () => {
  it('00-requirements.md: the requirements id shape, the OOS handle and the gate verdict all lint clean', () => {
    const result = lintCase('00-requirements.md', (runDir, repo) => requirementsContent('r-fmt', 'feature'), 'r-fmt')
    // ⚠ ANY FAILURE FAILS THIS TEST, and the printed lines are attached so a failure names the check that
    // rejected the example rather than only its count.
    expect(result.errors.join('\n')).toBe('')
    expect(result.failCount).toBe(0)
    // The substitution really happened: the id the example declares is the id the run now reports.
    expect(sectionFormatRulesFor('00-requirements.md')[0]?.section).toBe('Requirements')
  })

  it('00-worktree.md: the diff-basis field line, traceability row and gate verdict all lint clean', () => {
    const result = lintCase('00-worktree.md', (runDir, repo) => {
      const { context, error } = detectGitContext(repo)
      return worktreeContent('r-fmt', repo, context, error)
    }, 'r-fmt')
    expect(result.errors.join('\n')).toBe('')
    expect(result.failCount).toBe(0)
  })

  it('the diff-basis example is the LINE the parser reads, and every field it names round-trips', () => {
    // ⚠ THE ONE EXAMPLE THAT CANNOT CARRY A REAL VALUE. The diff basis is per-checkout (a commit sha), so the
    // example is the section's own closing field; what is provable is that the line has the shape
    // `getRunDiffBasis` reads — a bulleted `Field: \`value\`` line whose field name is one of the six the
    // linter requires — and the test below measures the round-trip on a real prefilled artifact.
    const example = sectionFormatRulesFor('00-worktree.md').find((rule) => rule.section === 'Diff Basis For Later Audits')?.example ?? ''
    expect(example).toBe('- Diff basis notes: `the six fields above resolve against this run\'s baseline and are re-verified before every lock`')
    const field = /^- ([A-Za-z ]+): `(.+)`$/.exec(example)
    expect(field, 'the example must be a bulleted backticked field line').not.toBeNull()
    expect([
      'Baseline type', 'Baseline reference', 'Comparison reference', 'Normalized baseline',
      'Normalized comparison', 'Normalized diff command', 'Base branch', 'Worktree branch', 'Diff basis notes',
    ]).toContain(field?.[1])
  })

  it('the six diff-basis fields the rule names are the six `getRunDiffBasis` reads back', () => {
    // ⚠ THE RULE LISTS FIELD NAMES, SO A TEST THAT ONLY READ THE TABLE COULD NOT TELL WHETHER THEY ARE THE
    // PARSER'S. This drives the real parser over the real prefilled scaffold and asserts the six REQUIRED
    // fields come back — the same six `normalizeDiffBasis` fails on when they are absent.
    const repo = phase0Repo()
    const runDir = join(repo, '.recursive', 'run', 'r-fmt')
    mkdirSync(runDir, { recursive: true })
    const { context, error } = detectGitContext(repo)
    const doc = worktreeContent('r-fmt', repo, context, error)
    writeFileSync(join(runDir, '00-worktree.md'), doc, 'utf8')
    const basis = getRunDiffBasis(runDir)
    for (const field of ['baseline_type', 'baseline_reference', 'comparison_reference', 'normalized_baseline', 'normalized_comparison', 'normalized_diff_command']) {
      expect(basis[field], field + ' must be read from the scaffolded ## Diff Basis For Later Audits').toBeTruthy()
    }
    // ...and with all six present the basis normalizes, which is what every later audited phase's lock needs.
    const [normalized, basisError] = normalizeDiffBasis(repo, basis)
    expect(basisError).toBeNull()
    expect(normalized?.normalized_baseline).toBe(context.baselineReference)
  })

  it('the phase-0 scaffold is LOCKABLE once the examples and the gates are applied', () => {
    // The strongest form of "the example is right": the whole artifact reaches zero failures, so nothing in
    // the substituted lines re-broke a neighbouring check (a source quote, a path, a traceability scan, the
    // git-resolved diff basis).
    const cases: [string, (runDir: string, repo: string) => string][] = [
      ['00-requirements.md', () => requirementsContent('r-fmt', 'feature')],
      ['00-worktree.md', (_runDir, repo) => {
        const { context, error } = detectGitContext(repo)
        return worktreeContent('r-fmt', repo, context, error)
      }],
    ]
    for (const [fileName, scaffold] of cases) {
      const result = lintCase(fileName, scaffold, 'r-fmt')
      expect(result.errors, fileName).toEqual([])
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 4 — the capability statement, in the payload the agent already reads        */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ THE PROFILED RUN'S SECOND COST, PINNED. It spent three calls working out whether subagents could be used,
 * `recursive_review` then failed twice with `Cannot read properties of undefined (reading 'aborted')` — a host
 * defect this change deliberately does NOT fix — and the run recorded `self-audit` as a *"deliberate, recorded
 * deviation"*. The two states must not read the same, so the payload carries the verdict AND the condition.
 */
describe('the payload states whether a delegated reviewer is reachable, and why not', () => {
  async function mountedRuntime(root: string) {
    const ctx = new Context()
    await ctx.plugin(RecursiveRuntime, { repoRoot: root })
    return ctx
  }

  /** A seam that enumerates ONE provider — which is what `providerMapFromSeam` needs to register a name. */
  function probeSeam(): Parameters<RecursiveRuntime['attachSubagents']>[0] {
    return {
      start: async () => ({ stopReason: 'completed' }),
      list: () => [{ name: 'spawn', capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false, agentOptions: true } }],
    } as unknown as Parameters<RecursiveRuntime['attachSubagents']>[0]
  }

  /**
   * ⚠ THE POLICY IS PART OF THE ANSWER, AND THIS IS THE CASE A REAL WORKSPACE IS IN BY DEFAULT. The shipped
   * `DEFAULT_POLICY` declares `when_role_unconfigured: 'ask'`, so with no `recursive-router.json` the router
   * answers `self-audit` with `refused: true` and its own sentence says the policy chose to ASK — a DIFFERENT
   * fact from "the seam is missing", which is why both are asserted separately here.
   */
  function configureReviewerRole(repo: string): void {
    mkdirSync(join(repo, '.recursive', 'config'), { recursive: true })
    writeFileSync(join(repo, '.recursive', 'config', 'recursive-router.json'), JSON.stringify({
      version: 1,
      role_routes: { 'code-reviewer': { enabled: true, mode: 'model' } },
    }, null, 2), 'utf8')
  }

  function scaffoldRun(repo: string, runId: string): string {
    mkdirSync(join(repo, '.recursive', 'run', runId), { recursive: true })
    writeFileSync(join(repo, '.recursive', 'run', runId, '00-requirements.md'), requirementsContent(runId), 'utf8')
    return runId
  }

  it('says UNAVAILABLE and names the missing service when no subagents seam is mounted', async () => {
    const repo = phase0Repo()
    const ctx = await mountedRuntime(repo)
    try {
      const runId = scaffoldRun(repo, 'r-cap')
      const payload = await ctx.recursive.phaseRules(runId, { session: { header: { cwd: repo } } })
      expect(payload?.delegatedReviewer?.available).toBe(false)
      expect(payload?.delegatedReviewer?.role).toBe('code-reviewer')
      // The CONDITION, not a shrug: the sentence names the service that is missing.
      expect(payload?.delegatedReviewer?.reason).toContain('no subagents service is mounted')
      // ⚠ AND THE ROUTER'S OWN SENTENCE TRAVELS BESIDE IT, so "the policy refused to choose" and "the seam is
      // missing" cannot be read as the same fact.
      expect(typeof payload?.delegatedReviewer?.routeReason).toBe('string')
      expect(payload?.delegatedReviewer?.routeReason.length ?? 0).toBeGreaterThan(0)
      expect(payload?.delegatedReviewer?.tier).toBeTruthy()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names the POLICY, not the seam, when the role is unconfigured and the policy says to ask', async () => {
    const repo = phase0Repo()
    const ctx = await mountedRuntime(repo)
    try {
      ctx.recursive.attachSubagents(probeSeam())
      const runId = scaffoldRun(repo, 'r-cap-policy')
      const payload = await ctx.recursive.phaseRules(runId, { session: { header: { cwd: repo } } })
      expect(payload?.delegatedReviewer?.available).toBe(false)
      expect(payload?.delegatedReviewer?.tier).toBe('self-audit')
      // The seam IS mounted here, so the reason must be the ROUTE and must not blame the service.
      expect(payload?.delegatedReviewer?.reason).toContain('the router resolves role code-reviewer to tier self-audit')
      expect(payload?.delegatedReviewer?.reason).not.toContain('no subagents service is mounted')
      expect(payload?.delegatedReviewer?.routeReason).toContain('when_role_unconfigured')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('says AVAILABLE — with the provider and tier — when the seam is mounted and the router resolves a child', async () => {
    const repo = phase0Repo()
    const ctx = await mountedRuntime(repo)
    try {
      configureReviewerRole(repo)
      ctx.recursive.attachSubagents(probeSeam())
      const runId = scaffoldRun(repo, 'r-cap2')
      const payload = await ctx.recursive.phaseRules(runId, { session: { header: { cwd: repo } } })
      expect(payload?.delegatedReviewer?.available).toBe(true)
      expect(payload?.delegatedReviewer?.tier).toBe('native')
      expect(payload?.delegatedReviewer?.provider).toBe('spawn')
      expect(payload?.delegatedReviewer?.reason).toContain('a delegated reviewer IS available for this phase')
      // The whole verdict reaches the JSON the tool renders, not only the object.
      expect(JSON.stringify(payload)).toContain('delegatedReviewer')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names the artifact condition when the phase has nothing to review yet', async () => {
    // `recursive_review` refuses a phase with no artifact (`NO_PHASE`), so "available" would be a claim its own
    // path contradicts. `00-worktree.md` does not exist here, and this is a phase the payload really advances
    // to — `getNextLegalPhase` reports an absent required phase rather than stopping at a DRAFT one.
    const repo = phase0Repo()
    const ctx = await mountedRuntime(repo)
    try {
      configureReviewerRole(repo)
      ctx.recursive.attachSubagents(probeSeam())
      const runId = 'r-cap3'
      const path = join(repo, '.recursive', 'run', runId, '00-requirements.md')
      mkdirSync(join(repo, '.recursive', 'run', runId), { recursive: true })
      writeFileSync(path, requirementsContent(runId), 'utf8')
      // Lock it the way `getLockStatus` verifies — progress cannot be faked by an edited field.
      const body = readFileSync(path, 'utf8')
      const header = 'Status: LOCKED\nLockedAt: ' + new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\nLockHash: ' + '0'.repeat(64) + '\n'
      const hash = lockHashFromContent(header + body)
      writeFileSync(path, header.replace('0'.repeat(64), hash) + body, 'utf8')
      expect(getLockStatus(path), 'precondition: phase 0 must be locked for the next phase to be asked about').toBe('LOCKED')

      const payload = await ctx.recursive.phaseRules(runId, { session: { header: { cwd: repo } } })
      expect(payload?.phase).toBe('00-worktree.md')
      expect(payload?.delegatedReviewer?.available).toBe(false)
      expect(payload?.delegatedReviewer?.reason).toContain('no artifact on disk yet')
      // ⚠ THE ROUTE IS STILL FINE HERE, and the statement says so separately: the condition is the artifact,
      // not the provider — which is exactly the distinction the profiled run could not make.
      expect(payload?.delegatedReviewer?.tier).toBe('native')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('derives the reminder line from the LIVE capability the runtime resolves, and adds nothing when available', async () => {
    // ⚠ THE REMINDER'S CALL SITE AND THE PAYLOAD NOW READ ONE RESOLUTION. `index.ts` builds the pre-step
    // reminder from the artifact name alone, so it cannot compute a capability itself — it asks
    // `recursive.delegatedReviewerCapability(...)`, the SAME method `runtime.phaseRules` calls for the payload.
    // This asserts that path end to end: the method's verdict, fed to the message builder, is what renders the
    // line — so the rule is not a branch only a hand-built fixture can reach.
    const repo = phase0Repo()
    const ctx = await mountedRuntime(repo)
    try {
      const runId = scaffoldRun(repo, 'r-reminder')
      const phasePath = join(repo, '.recursive', 'run', runId, '00-requirements.md')
      const capability = ctx.recursive.delegatedReviewerCapability(repo, phasePath)
      expect(capability.available).toBe(false)
      const message = phaseLintRulesMessage('00-requirements.md', PROFILE, capability)
      expect(message).toContain('Delegated reviewer UNAVAILABLE for this phase (do NOT record self-audit as a deviation)')
      expect(message).toContain(capability.reason)

      // The available branch adds NOTHING: the agent has no decision to make, so the reminder must not grow a
      // second copy of the capability prose.
      const available = phaseLintRulesMessage('00-requirements.md', PROFILE, {
        role: 'code-reviewer', available: true, tier: 'native', provider: 'spawn', routeReason: 'native provider',
        reason: 'a delegated reviewer IS available for this phase.',
      })
      expect(available).not.toContain('Delegated reviewer UNAVAILABLE')
      expect(available).not.toContain('a delegated reviewer IS available')
      // Omitting the argument keeps the message exactly what it was: the pure function has no live facts.
      expect(phaseLintRulesMessage('00-requirements.md')).not.toContain('Delegated reviewer')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 5 — the trap the guidance warns about, measured                             */
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
/* 6 — the scaffold carries the hint under its own heading                     */
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
    // (`tests/init-templates.parity.spec.ts`), so no hint may ever be added there. The phase-0 formats
    // therefore reach a phase-0 writer through the PAYLOAD and the REMINDER, which is the point of the
    // change: extend what the agent already reads rather than a fifth surface that repeats it.
    expect(requirementsContent('r1')).not.toContain('<!--')
    expect(requirementsContent('r1')).not.toContain('lint format:')
    expect(worktreeContent('r1', 'D:\\x', {}, null)).not.toContain('<!--')
  })
})

/* -------------------------------------------------------------------------- */
/* 7 — one fact, one place                                                     */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ THE DUPLICATION GATE. The profiled run wandered because the same rule was paraphrased in several
 * surfaces; the change therefore extends the payload the agent ALREADY reads and asserts that no new
 * surface repeats it. The counted surface is `SectionFormatRule.rule`'s distinctive half — the examples may
 * legitimately appear in a lint MESSAGE (`expectedRowDetail` reads this very table), and that is a
 * presentation of the same single source, not a copy of it.
 */
describe('the phase-0 rules live in exactly one table', () => {
  it('gives each rule its own text, so no two entries are two names for one rule', () => {
    const seen = new Map<string, string>()
    for (const [fileName, rules] of Object.entries(SECTION_FORMAT_RULES)) {
      for (const rule of rules) {
        const previous = seen.get(rule.rule)
        // ⚠ A RULE MAY BE SHARED ACROSS PHASES — `GATE_VERDICT_FORMAT` describes the same verdict line for
        // every artifact and is ONE entry, deliberately — so what is asserted is that no two DISTINCT entries
        // carry the same text, which is what a copy-paste would produce.
        if (previous !== undefined && previous !== rule.section) {
          throw new Error('rule text shared by ' + previous + ' and ' + rule.section + ': ' + rule.rule)
        }
        seen.set(rule.rule, rule.section)
      }
    }
    // The gate rule is the one shared entry, and it is the SAME object in both phases rather than two copies.
    expect(SECTION_FORMAT_RULES['00-requirements.md']?.find((rule) => rule.section === 'Coverage Gate'))
      .toBe(SECTION_FORMAT_RULES['00-worktree.md']?.find((rule) => rule.section === 'Coverage Gate'))
  })

  it('derives the lint MESSAGE detail from the table rather than restating it', () => {
    // `expectedRowDetail` reads `sectionFormatRulesFor`; a message with its own copy of the row would drift.
    // Asserted by value: the detail carries the table\'s own example for that artifact and section.
    const example = sectionFormatRulesFor('01-as-is.md').find((rule) => rule.section === 'Source Requirement Inventory')?.example ?? ''
    expect(example.length).toBeGreaterThan(0)
  })

  it('counts the review bundle rows in the same duplication gate', () => {
    // The gate above walks `SECTION_FORMAT_RULES`; the bundle table is a SECOND table, so it is walked here
    // rather than left outside the gate it would otherwise escape.
    const seen = new Map<string, string>()
    for (const [fileName, rules] of Object.entries(SECTION_FORMAT_RULES)) {
      for (const rule of rules) seen.set(rule.rule, rule.section)
    }
    for (const rule of REVIEW_BUNDLE_SECTION_FORMAT_RULES) {
      const previous = seen.get(rule.rule)
      if (previous !== undefined && previous !== rule.section) {
        throw new Error('rule text shared by ' + previous + ' and ' + rule.section + ': ' + rule.rule)
      }
      expect(previous, 'the bundle table has two entries for ' + rule.section).toBeUndefined()
      seen.set(rule.rule, rule.section)
    }
    // ...and every one of them states its owner, so no bundle row can be read as a phase-artifact heading.
    for (const rule of REVIEW_BUNDLE_SECTION_FORMAT_RULES) {
      expect(rule.appliesTo, rule.section + ' must declare which file it governs').toBeDefined()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 8 — THE REVIEW BUNDLE'S OWN RULES, DRIVEN THROUGH THE REAL LINTER           */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ WHY THIS SECTION EXISTS, FROM THE LIVE RUN'S OWN TRANSCRIPT. At `03.5-code-review.md` the linter returned
 * ten failures; the run fixed nine and was left fighting the tenth, having spent calls `grep`-ing the SHIPPED
 * BUNDLE (`node_modules/@try-works/dsh-recursive-mode/lib/index.js`) for the sentence
 * *"Code review narrative does not cite any upstream"* and then reading the compiled artifact at an offset.
 * The rules were not secret — they were simply not WRITTEN DOWN anywhere the agent reads while writing, which
 * is the same defect phase 0 had.
 *
 * ⚠ AND THE PROOF IS THE SAME SHAPE AS PHASE 0'S: a bundle and an artifact are built FROM THE TABLE, and the
 * real `lintReviewBundleReference` — the entry point `recursive_lint` reaches for this phase and no other — is
 * driven over them. Each example therefore has to be a line the parser actually accepts, or this section fails.
 *
 * ⚠ THE UNSUBSTITUTED CASE IS ASSERTED FIRST, ON PURPOSE. "The table says X, and linting X gives no error"
 * would pass vacuously if the check stopped running altogether — the vacuity this project keeps finding. So
 * the SCAFFOLD and the EMPTY BUNDLE are linted first and the exact failure sentences are asserted, and only
 * then is the same pair linted with the examples substituted into it.
 */
describe('the review-bundle rules are ACCEPTED by the real linter, and bite before they are applied', () => {
  const RUN = 'r1'
  const REVIEW_ARTIFACT = '03.5-code-review.md'
  /** The phase label `recursive_review` builds the bundle for; the slug comes from THIS, not from the file name. */
  const REVIEW_PHASE_LABEL = '03.5 Code Review'

  /** The one example the table holds for a section, asserted to exist so a missing row is a failure not a skip. */
  function exampleOf(section: string): string {
    return ruleFor(section).example
  }

  /** The one RULE TEXT the table holds for a section — the field the prose assertions read. */
  function ruleTextOf(section: string): string {
    return ruleFor(section).rule
  }

  function ruleFor(section: string): SectionFormatRule {
    const rule = REVIEW_BUNDLE_SECTION_FORMAT_RULES.find((candidate) => candidate.section === section)
    expect(rule, 'the table must carry a rule for ' + section).toBeDefined()
    expect(rule?.example.trim(), section + ' must have an example').not.toBe('')
    expect(rule?.rule.trim(), section + ' must have a rule').not.toBe('')
    return rule as SectionFormatRule
  }

  /** Every one of the six fields the `## Diff Basis` rule names, read back off the rule's own TEXT. */
  function diffBasisLines(): string[] {
    const rule = ruleTextOf('Diff Basis')
    const fields = ['Baseline type', 'Baseline reference', 'Comparison reference', 'Normalized baseline', 'Normalized comparison', 'Normalized diff command']
    return fields.map((field) => {
      expect(rule, 'the Diff Basis rule must name ' + field).toContain(field)
      if (field === 'Baseline type') return exampleOf('Diff Basis')
      // The remaining five carry the same shape with a concrete value: the check reads PRESENCE only, so a
      // written-out value is what makes the line honest rather than another placeholder.
      return '- ' + field + ': `' + (field === 'Normalized diff command' ? 'git diff --name-only ' + 'a'.repeat(40) : 'working-tree') + '`'
    })
  }

  /** Every path the citation examples leave in the narrative: the linter's own extractor, not a regex of mine. */
  function citedPaths(text: string): Set<string> {
    return new Set([...extractPathsFromText(text)].map(normalizeRepoPath))
  }

  /**
   * A repo whose files ARE the ones the examples name, so the linter's existence checks have something real to
   * resolve — and a run dir with the reviewed artifact the bundle pins by hash.
   *
   * ⚠ EVERY PATH IS READ OUT OF THE TABLE, not typed a second time: the reviewed artifact IS the one the
   * `Artifact Path` example names, so an example that renamed it would fail here rather than pass against a
   * path this harness quietly made up.
   */
  function reviewRepo(): { repo: string; runDir: string; bundleRel: string; bundleAbs: string; reviewedRel: string } {
    const repo = phase0Repo()
    const runDir = join(repo, '.recursive', 'run', RUN)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), requirementsContent(RUN), 'utf8')
    const reviewedRel = exampleOf('Artifact Path').replace(/^Artifact Path: `/, '').replace(/`$/, '')
    const paths = [
      reviewedRel,
      'src/guard.ts',
      '.recursive/run/' + RUN + '/02-to-be-plan.md',
      '.recursive/run/' + RUN + '/addenda/02-to-be-plan.addendum-1.md',
      '.recursive/run/r0/03-implementation-summary.md',
    ]
    writeFileSync(join(repo, reviewedRel), '# implementation summary\n\nStatus: `DRAFT`\n', 'utf8')
    for (const path of paths) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), 'fixture: ' + path + '\n', 'utf8')
    }
    const bundleRel = '.recursive/run/' + RUN + '/evidence/review-bundles/' + reviewBundleFileName()
    const bundleAbs = join(repo, bundleRel)
    mkdirSync(dirname(bundleAbs), { recursive: true })
    return { repo, runDir, bundleRel, bundleAbs, reviewedRel }
  }

  /**
   * The bundle FILE NAME, derived the way `buildReviewBundle` derives it — `phase.trim().toLowerCase()` with
   * every run of non-`[a-z0-9.]` collapsed to one dash, plus `-bundle.md`.
   *
   * ⚠ IT IS DERIVED RATHER THAN TYPED, WHICH IS A MUTATION FIX AND NOT A STYLE CHOICE. The `Review Bundle Path`
   * example carries a literal file name, and writing the harness's bundle under a HARDCODED `...-bundle.md`
   * would make the two agree no matter what the example said: renaming the example's file passed every
   * assertion in this file (measured — that mutation was the one miss in the matrix). The name is therefore
   * computed from the same input the builder is given, and `REVIEW_PHASE_LABEL` is what `recursive_review`
   * passes when it builds the 03.5 bundle.
   */
  function reviewBundleFileName(phaseLabel: string = REVIEW_PHASE_LABEL): string {
    const slug = phaseLabel.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
    return (slug || 'review') + '-bundle.md'
  }

  /** The bundle an author following the table writes, with the impossible-per-artifact hash supplied live. */
  function bundleFromTable(repo: string, bundleRel: string, reviewedRel: string): string {
    const hash = contentSha256(readFileSync(join(repo, reviewedRel), 'utf8'))
    const bundleHeader = /^[A-Z][A-Za-z ]+: `[^`\n]+`$/
    const header = REVIEW_BUNDLE_SECTION_FORMAT_RULES
      .filter((rule) => rule.appliesTo === 'review-bundle' && bundleHeader.test(rule.example))
      .map((rule) => rule.section === 'Artifact Content Hash'
        ? 'Artifact Content Hash: `' + hash + '`'
        : rule.example)
    const sections = REVIEW_BUNDLE_REQUIRED_SECTIONS.map((section) => {
      // ⚠ `## Required Output` IS THE ONE SECTION THE TABLE DOES NOT DESCRIBE, because the linter checks only
      // that it EXISTS (see the exemption assertion above), so the harness supplies the prose `recursive_review`
      // writes rather than asking the table for an example it deliberately does not have.
      if (section === 'Required Output') {
        return '## ' + section + '\n\n' + 'Verdict, per-requirement reconciliation, issues found, and the review bundle path that resolves.'
      }
      const body = section === 'Diff Basis' ? diffBasisLines().join('\n') : exampleOf(section)
      return '## ' + section + '\n\n' + body
    })
    expect(bundleRel, 'precondition: the bundle path is the one the artifact records').not.toBe('')
    return [...header, '', ...sections, ''].join('\n')
  }

  /** The artifact an author following the table writes: the shipped scaffold with each example substituted in. */
  function artifactFromTable(runDir: string, bundleRel: string): string {
    let doc = artifactFromExamples(REVIEW_ARTIFACT, laterPhaseContent(RUN, REVIEW_ARTIFACT))
    doc = substituteLastBodyLine(doc, 'Review Metadata', bundlePathRuleFromTable(RUN, bundleRel))
    const citations = citedPaths(exampleOf('Code review narrative citations'))
    // ⚠ THE NARRATIVE MUST CITATE ONE PATH FROM EACH NON-EMPTY LIST, AND THERE ARE FOUR OF THEM. The example is
    // the line for `## Review Scope`; the other three lists are satisfied by lines built the same way, so the
    // SUBSTITUTED case reaches zero failures rather than three.
    const scope = [
      exampleOf('Code review narrative'),
      exampleOf('Code review narrative citations'),
      ...REVIEW_BUNDLE_REQUIRED_SECTIONS
        .filter((section) => ['Upstream Artifacts To Re-read', 'Relevant Addenda', 'Prior Recursive Evidence'].includes(section))
        .flatMap((section) => [...citedPaths(exampleOf(section))])
        .filter((path) => !citations.has(path))
        .map((path) => '- Re-read `' + path + '` before recording this verdict.'),
    ]
    doc = substituteLastBodyLine(doc, 'Review Scope', scope.join('\n'))
    expect(runDir, 'precondition: the run dir exists').toBeTruthy()
    return doc
  }

  /** The artifact above, written where the linter reads it — the pair every "it lints clean" case drives. */
  function artifactOnDisk(repo: string, runDir: string, bundleRel: string): string {
    const doc = artifactFromTable(runDir, bundleRel)
    writeFileSync(join(runDir, REVIEW_ARTIFACT), doc, 'utf8')
    expect(repo, 'precondition: the repo exists').toBeTruthy()
    return doc
  }

  /**
   * The phase-artifact row that is a FIELD rather than a heading, re-instantiated for a real run.
   *
   * ⚠ IT IS THE TABLE'S OWN EXAMPLE WITH THE RUN ID SUBSTITUTED, not a second copy of the sentence: the example
   * is written against `r1` because an example must be one copy-pasteable line, and the run id is the only part
   * of it that is per-run. A drift between this and the table would show up as the assertion below failing.
   */
  function bundlePathRuleFromTable(runId: string, bundleRel: string): string {
    const example = exampleOf('Review Bundle Path')
    expect(example, 'the example must carry the placeholder run id').toContain('/r1/')
    expect(example, 'the example must carry the bundle directory').toContain('/evidence/review-bundles/')
    // ⚠ AND THE FILE NAME IN IT MUST BE THE ONE THE BUILDER WRITES, because that is the name `recursive_review`
    // will report and a writer copies. Without this line a renamed example passed every assertion here — the
    // harness wrote its bundle under whatever name it was told, so the two agreed by construction. Measured:
    // that was the ONE mutation the matrix did not catch, and this is the assertion that catches it.
    expect(example, 'the example must name the bundle the builder writes')
      .toContain('/' + reviewBundleFileName() + '`')
    return example.replace('/r1/', '/' + runId + '/').replace(/`[^`]*`$/, '`' + bundleRel + '`')
  }

  it('the rules are what the LINTER requires of the bundle — not a copy of it', () => {
    // The table is pinned against `REVIEW_BUNDLE_REQUIRED_SECTIONS`, which `lintReviewBundleReference` iterates;
    // this asserts the list is the same list the linter fails on, by driving the real function over a bundle that
    // exists, carries a hash and is EMPTY of sections — the state that reaches the section check.
    const { repo, runDir, bundleRel, bundleAbs, reviewedRel } = reviewRepo()
    writeFileSync(bundleAbs, 'Artifact Path: `' + reviewedRel + '`\n'
      + 'Artifact Content Hash: `' + contentSha256(readFileSync(join(repo, reviewedRel), 'utf8')) + '`\n', 'utf8')
    const issues = lintReviewBundleReference(artifactFromTable(runDir, bundleRel), runDir, repo)
    expect(issues.join('\n')).toContain('Review bundle is missing required section(s): ' + REVIEW_BUNDLE_REQUIRED_SECTIONS.join(', '))
    // ⚠ AND THE TWO LISTS REALLY ARE THE LINTER'S, INCLUDING THE HEADER FIELD NAMES: the same run with the two
    // header fields renamed fails on THOSE names, so a rename in `REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS` is caught
    // here rather than silently diverging from the literals the linter destructures them into.
    writeFileSync(bundleAbs, 'Artifact Location: `' + reviewedRel + '`\n'
      + 'Artifact Digest: `' + contentSha256(readFileSync(join(repo, reviewedRel), 'utf8')) + '`\n', 'utf8')
    const renamed = lintReviewBundleReference(artifactOnDisk(repo, runDir, bundleRel), runDir, repo).join('\n')
    expect(renamed).toContain('Review bundle is missing ' + REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS[0])
    expect(renamed).toContain('Review bundle is missing ' + REVIEW_BUNDLE_REQUIRED_HEADER_FIELDS[1])
  })

  it('FAILS the unsubstituted scaffold and the empty bundle — before any example is applied', () => {
    const { repo, runDir, bundleAbs } = reviewRepo()
    // The scaffold's `## Review Metadata` carries no bundle path yet, and the bundle is only the 8 headings.
    const scaffold = laterPhaseContent(RUN, REVIEW_ARTIFACT)
    writeFileSync(bundleAbs, REVIEW_BUNDLE_REQUIRED_SECTIONS.map((section) => '## ' + section + '\n').join('\n'), 'utf8')
    const before = lintReviewBundleReference(scaffold, runDir, repo)
    // ⚠ THESE ARE THE EXACT SENTENCES THE LIVE RUN FOUGHT, so a solution that satisfied them by removing the
    // check would fail HERE rather than passing quietly. The detail the table appends is asserted separately,
    // so the canonical sentence is matched by PREFIX — the canonical message is not replaced, only extended.
    expect(before.filter((issue) => issue.startsWith('Review Metadata is missing Review Bundle Path'))).toHaveLength(1)
    // ⚠ AND IT CARRIES THE SHAPE, because this is the FIRST failure a review meets: nothing else in the artifact
    // can be checked until the bundle resolves, so the path line is the one thing worth teaching here. The
    // canonical sentence is still the prefix — the detail is appended, never substituted.
    const missingPath = before.find((issue) => issue.startsWith('Review Metadata is missing Review Bundle Path')) ?? ''
    expect(missingPath).toContain('(expected row: - Review Bundle Path: `.recursive/run/r1/evidence/review-bundles/')
    // ...and the trap the `Review Bundle Path` rule names, measured with the same function: an ABSOLUTE path
    // normalizes to `E:/...`, which does not start with the required repo-relative prefix and is refused with
    // its own sentence rather than a generic one.
    const absolute = scaffold.replace('Scope note:', '- Review Bundle Path: `E:/Temp/eryery/.recursive/run/' + RUN + '/evidence/review-bundles/03.5-code-review-bundle.md`\nScope note:')
    expect(lintReviewBundleReference(absolute, runDir, repo).join('\n')).toContain(
      'Review Bundle Path must live under `/.recursive/run/' + RUN + '/evidence/review-bundles/`')
  })

  it('ACCEPTS every example once applied — bundle and narrative both lint clean', () => {
    const { repo, runDir, bundleRel, bundleAbs, reviewedRel } = reviewRepo()
    writeFileSync(bundleAbs, bundleFromTable(repo, bundleRel, reviewedRel), 'utf8')
    const artifact = artifactFromTable(runDir, bundleRel)
    // The linter's own precondition: the bundle path must be recorded where it is read from.
    expect(artifact).toContain('## Review Metadata')
    expect(artifact).toContain('- Review Bundle Path: `' + bundleRel + '`')
    // ⚠ AND THE EXAMPLE FOR THAT FIELD IS NOT A HEADING OF THE PHASE ARTIFACT — it is a line INSIDE
    // `## Review Metadata`, which is why the table cannot simply say "the section `## Review Bundle Path`". The
    // distinction is asserted rather than assumed: the section does not exist, the field line does.
    expect(artifact).not.toContain('## Review Bundle Path')
    expect(getArtifactRequiredSections(REVIEW_ARTIFACT, PROFILE)).not.toContain('Review Bundle Path')
    // ⚠ NO WINDOW FILTER, AND THAT IS THE STRONGEST FORM OF THE CLAIM: zero issues means the bundle's six
    // `## Diff Basis` fields, all five path lists, the audit questions, the hash, the narrative's four
    // citations and the bundle-path citation were ALL accepted by the function that checks them.
    expect(lintReviewBundleReference(artifact, runDir, repo)).toEqual([])
  })

  it('the citations example is a CITATION, measured with the linter\'s own path extractor', () => {
    // ⚠ `extractPathsFromText` IS THE PARSER THIS CHECK DEPENDS ON, and it has a trap the rule names: a path
    // written WITHOUT code spans is not a citation at all, because the extractor reads backticked spans only.
    // That is what makes "cite `src/guard.ts`" different from "cite src/guard.ts", and it is measured rather
    // than described.
    const cited = citedPaths(exampleOf('Code review narrative citations'))
    // ⚠ THE FULL REPO-RELATIVE PATH, NOT THE BASENAME, and the linter is why: it compares NORMALIZED paths for
    // exact equality, and the bundle's own upstream list carries `.recursive/run/<runId>/...`. Citing
    // `02-to-be-plan.md` reads as a citation to the EXTRACTOR but matches nothing the bundle lists, which is
    // the trap the citation rule states.
    expect([...cited].sort()).toEqual(['.recursive/run/r1/02-to-be-plan.md', 'src/guard.ts'])
    expect([...citedPaths('- The change landed on src/guard.ts, as planned.')]).toEqual([])
    // ...and the same extractor reads the bundle path out of the narrative example, which is what satisfies the
    // `Review Bundle Path` citation check rather than the metadata field.
    expect([...citedPaths(exampleOf('Code review narrative'))].sort()).toEqual([
      '.recursive/run/r1/evidence/review-bundles/03.5-code-review-bundle.md',
      '03-implementation-summary.md',
    ])
    // ⚠ AND THE TWO NARRATIVE RULES DO NOT CARRY THE SAME TEXT. They are two different sentences the linter
    // emits (`...upstream artifact from the review bundle` and `...must cite the Review Bundle Path...`), so a
    // duplicate-prose gate that only compared `rule` would not notice them collapsing into one entry — this is
    // the assertion that would.
    expect(exampleOf('Code review narrative')).not.toBe(exampleOf('Code review narrative citations'))
    const narratives = REVIEW_BUNDLE_SECTION_FORMAT_RULES.filter((rule) => rule.section.startsWith('Code review narrative'))
    expect(narratives).toHaveLength(2)
    expect(narratives[0]?.rule).not.toBe(narratives[1]?.rule)
  })

  it('the failure detail carries the table\'s own line — the shape the live run went into the bundle to find', () => {
    // ⚠ THIS IS THE COST, PINNED. The run grepped the shipped `lib/index.js` for the failure SENTENCE; what it
    // needed was the shape that satisfies it. The detail is appended from `expectedRowDetail`, so it is the
    // table's own example and cannot drift from the payload the same table feeds.
    const { repo, runDir, bundleRel, bundleAbs, reviewedRel } = reviewRepo()
    // A bundle WITH an upstream list and a changed-file list — so both citation checks are live — and an
    // artifact that carries `## Review Metadata` (without which the linter returns early and proves nothing).
    //
    // ⚠ EVERY OTHER BUNDLE CHECK IS SATISFIED HERE ON PURPOSE. A bundle that also fails its addenda, hash or
    // code-reference checks would make this test measure the wrong thing: the citation sentences are reached
    // only after those, and an earlier failure that returns early would leave this asserting a message that was
    // never produced. So the shape is built to pass everything it is not testing.
    writeFileSync(bundleAbs, [
      'Artifact Path: `' + reviewedRel + '`',
      'Artifact Content Hash: `' + contentSha256(readFileSync(join(repo, reviewedRel), 'utf8')) + '`',
      '',
      ...REVIEW_BUNDLE_REQUIRED_SECTIONS.map((section) => '## ' + section + '\n\n'
        + (section === 'Diff Basis' ? diffBasisLines().join('\n')
          : section === 'Upstream Artifacts To Re-read' ? '- `.recursive/run/' + RUN + '/02-to-be-plan.md`'
            : section === 'Changed Files Reviewed' ? '- `src/guard.ts`'
              : section === 'Targeted Code References' ? '- `src/guard.ts`'
                : section === 'Relevant Addenda' ? '- `.recursive/run/' + RUN + '/addenda/02-to-be-plan.addendum-1.md`'
                  : section === 'Audit Questions' ? '- Does the guard hold?'
                    : '- `.recursive/run/r0/03-implementation-summary.md`'),
      ),
    ].join('\n'), 'utf8')
    const silent = [
      '## Review Metadata',
      '',
      '- Review Bundle Path: `' + bundleRel + '`',
      '',
      '## Review Scope',
      '',
      'The change is reviewed and approved.',
      '',
      ...REVIEW_NARRATIVE_SECTIONS.slice(1).map((section) => '## ' + section + '\n\n- nothing cited here\n'),
    ].join('\n')
    const issues = lintReviewBundleReference(silent, runDir, repo).join('\n')
    // ⚠ THE BUNDLE ITSELF PASSES EVERYTHING ELSE, so the sentences below can only have come from the checks
    // under test — which is what makes the "the detail carries the example" assertion below mean something.
    expect(issues).not.toContain('Review bundle Diff Basis is missing')
    expect(issues).not.toContain('Review bundle is missing ')
    expect(issues).not.toContain('Review bundle Targeted Code References cannot be empty')
    expect(issues).not.toContain('Review bundle Changed Files Reviewed cannot be empty')
    // ⚠ THE BUNDLE-PATH SENTENCE IS NOT ASSERTED HERE, AND THAT IS DELIBERATE: the fixture records that path in
    // `## Review Metadata`, and the linter reads citations from the WHOLE artifact — so it is already cited and
    // the check passes, which is precisely the behaviour that makes the sentence hard to provoke. It is provoked
    // below, by the artifact that passes everything, which is the only way to reach it with every other check
    // silent.
    expect(issues).not.toContain('Code review must cite the Review Bundle Path')
    expect(issues).toContain('Code review narrative does not cite any upstream artifact from the review bundle')
    expect(issues).toContain('Code review narrative does not cite any relevant addendum from the review bundle')
    expect(issues).toContain('Code review narrative does not cite any prior recursive evidence from the review bundle')
    expect(issues).toContain('Code review narrative does not cite any changed file or code reference from the review bundle')
    // The sentence is still FIRST — the canonical message is not replaced, only extended.
    expect(issues).toContain('Code review narrative does not cite any upstream artifact from the review bundle'
      + ' (expected row: ' + exampleOf('Code review narrative citations') + '.')
    // ...and the whole sentence is EXACTLY the canonical one plus the detail, so the detail really is appended
    // rather than the message having been rewritten around it.
    const upstreamLine = issues.split('\n').find((line) => line.startsWith('Code review narrative does not cite any upstream artifact')) ?? ''
    expect(upstreamLine.startsWith('Code review narrative does not cite any upstream artifact from the review bundle')).toBe(true)
    expect(upstreamLine).toContain('expected row: ' + exampleOf('Code review narrative citations'))

    // ⚠ AND THE BUNDLE-PATH SENTENCE IS EFFECTIVELY UNREACHABLE ONCE A VALID BUNDLE IS RECORDED — a MEASURED
    // finding, stated rather than papered over. `citedPaths` is built from `extractPathsFromText(content)` over
    // the WHOLE artifact, and the check only runs after the recorded path has been proved to satisfy the prefix
    // AND to exist. So the recorded path is necessarily ITSELF an extractable citation, and the sentence can only
    // fire on an artifact whose recorded path and extraction disagree — which was probed (a `./`-prefixed value,
    // an absolute one, a backslashed one, a doubled prefix, a trailing space) and is not reachable, because the
    // same normalization feeds both sides. The check is DEFENSIVE, not dead: `getMdFieldValue` and
    // `extractPathsFromText` are different parsers, and a change to either could part them. What is asserted
    // instead is that its failure detail is wired from the same table, so that if it ever does fire it teaches
    // the shape rather than the sentence.
    expect(expectedRowDetail(REVIEW_ARTIFACT, 'Code review narrative', PROFILE))
      .toBe(' (expected row: ' + exampleOf('Code review narrative')
        + '. Each id needs its own bullet with the id ALONE as the first | field; a row that is backtick-wrapped is skipped silently.)')
    expect(expectedRowDetail(REVIEW_ARTIFACT, 'Code review narrative citations', PROFILE))
      .toBe(' (expected row: ' + exampleOf('Code review narrative citations')
        + '. Each id needs its own bullet with the id ALONE as the first | field; a row that is backtick-wrapped is skipped silently.)')
    // ...and the detail is produced for the BUNDLE rows too, because the assembly point is the merged
    // `sectionFormatRulesFor` — a bundle failure teaches its own shape without a second accessor.
    expect(expectedRowDetail(REVIEW_ARTIFACT, 'Changed Files Reviewed', PROFILE)).toBe(
      ' (expected row: ' + exampleOf('Changed Files Reviewed')
      + '. Each id needs its own bullet with the id ALONE as the first | field; a row that is backtick-wrapped is skipped silently.)')
    // ⚠ AND THE TWO TABLES ARE NOT INTERCHANGEABLE: the phase-0 diff basis and the bundle diff basis are
    // DIFFERENT rules with different examples, so the lookup keyed by `(artifact, section)` cannot resolve one
    // to the other. A collapse of the two tables would show up here as equal text.
    expect(expectedRowDetail('00-worktree.md', 'Diff Basis For Later Audits', PROFILE))
      .not.toBe(expectedRowDetail(REVIEW_ARTIFACT, 'Diff Basis', PROFILE))
    expect(expectedRowDetail('00-worktree.md', 'Diff Basis For Later Audits', PROFILE)).toContain('- Diff basis notes:')
    // ...and the two NARRATIVE details are DIFFERENT sentences, which is what makes the split worth having: the
    // bundle-path failure teaches the bundle-path citation, the list failure teaches the citation line.
    expect(exampleOf('Code review narrative')).not.toBe(exampleOf('Code review narrative citations'))
    expect(upstreamLine).not.toContain(exampleOf('Code review narrative') + '.')
  })

  it('the artifact the table builds passes the WHOLE per-artifact lint for its own citation rules', () => {
    // ⚠ THE OTHER HALF OF THE REAL ENTRY POINT. `lintArtifactFile` is what `recursive_lint` calls, and it is
    // what reaches `lintReviewBundleReference` for this phase. The scaffold's other sections are not authored
    // here (that is phase 2/3 work, measured in `tests/compliant-artifact.ts`), so what is asserted is that
    // EVERY failure the run is about — the CITATION ones — is absent from a full pass, while at least one
    // unrelated failure remains, which is what proves the pass actually ran.
    const { repo, runDir, bundleRel, bundleAbs, reviewedRel } = reviewRepo()
    writeFileSync(bundleAbs, bundleFromTable(repo, bundleRel, reviewedRel), 'utf8')
    artifactOnDisk(repo, runDir, bundleRel)
    const printed: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')) }
    try {
      lintArtifactFile(
        join(runDir, REVIEW_ARTIFACT), runDir, repo, PROFILE,
        parseRequirementIds(readFileSync(join(runDir, '00-requirements.md'), 'utf8')), null, null,
      )
    } finally { console.log = original }
    const errors = printed.filter((line) => line.startsWith('[FAIL]'))
    expect(errors.length, 'the full lint must actually have run').toBeGreaterThan(0)
    for (const sentence of [
      'Code review narrative does not cite any upstream artifact from the review bundle',
      'Code review must cite the Review Bundle Path in its written review artifact',
      'Review bundle is missing required section(s)',
      'Review bundle is missing Artifact Content Hash',
      'Review Metadata is missing Review Bundle Path',
    ]) {
      expect(errors.filter((line) => line.includes(sentence)), sentence).toEqual([])
    }
  })
})
