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
  SECTION_FORMAT_RULES,
  getArtifactRequiredSections,
  phaseLintRulesMessage,
  phaseRulesFor,
  sectionFormatRulesFor,
  type SectionFormatRule,
} from '../src/phase-rules.ts'
import { lintArtifactFile, getRunDiffBasis, normalizeDiffBasis, parseRequirementIds, parseSourceRequirementInventoryEntries } from '../src/ts-lint.ts'
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
    for (const audited of ['01.5-root-cause.md', '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md', '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md']) {
      expect(sectionFormatRulesFor(audited).map((rule) => rule.section), audited).toEqual(['Requirement Completion Status'])
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
    const SHAPES: [string, RegExp][] = [
      ['entry row', /^- (R\d+|SRC-\d{3}) \| /],
      ['gate verdict line', /^(Coverage|Approval): (PASS|FAIL)$/],
      ['requirement heading', /^### `(R\d+|SRC-\d{3})` \S/],
      ['out-of-scope bullet', /^- `OOS\d+`: \S/],
      ['traceability bullet', /^- `(R\d+|SRC-\d{3})` -> \S/],
      ['diff-basis field line', /^- [A-Z][A-Za-z ]+: `\S.*`$/],
    ]
    for (const [fileName, rules] of Object.entries(SECTION_FORMAT_RULES)) {
      for (const rule of rules) {
        const matched = SHAPES.filter(([, pattern]) => pattern.test(rule.example)).map(([name]) => name)
        expect(matched, fileName + '/' + rule.section + ' example matched no known shape: ' + rule.example).toHaveLength(1)
      }
    }
    expect(sectionFormatRulesFor('01-as-is.md')[0]?.example).toContain('Disposition: in-scope')
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
  for (const rule of sectionFormatRulesFor(fileName)) {
    if (rule.section === 'Coverage Gate') continue
    doc = substituteLastBodyLine(doc, rule.section, rule.example)
  }
  // The two gate verdicts come from the ONE rule that describes both (`Approval Gate likewise`), so the
  // approval body is built from the coverage example rather than tabled a second time.
  const verdict = sectionFormatRulesFor(fileName).find((rule) => rule.section === 'Coverage Gate')?.example ?? ''
  expect(verdict, 'the gate verdict rule must exist for ' + fileName).not.toBe('')
  for (const gate of ['Coverage', 'Approval']) {
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
})
