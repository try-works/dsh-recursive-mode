/**
 * COMPLIANT PHASE ARTIFACTS — authored content a spec needs when it must LOCK.
 *
 * WHY THIS FILE EXISTS. `lockArtifact` now consults the same linter the
 * `recursive_lint` tool calls (README §4.1: "refuses if the artifact does not meet
 * the standard"), so a spec whose real subject is reopen identity, quiescence,
 * guard paths, receipt chaining or the end-to-end workflow can no longer lock a
 * skeleton. Those specs never needed an UNFINISHED artifact — they locked one only
 * because nothing stopped them — so this helper gives them artifacts that meet the
 * standard, and the standards they exercise stay untouched.
 *
 * ⚠ WHAT THIS IS NOT. `requirementsContent` / `laterPhaseContent`
 * (`src/init-templates.ts`) are SCAFFOLD generators, not compliant writers: their
 * output is 19 FAILs under `lintRun` (missing traceability to requirement IDs, a
 * missing audit verdict line, an invalid Audit Execution Mode, six Worktree Diff
 * Audit fields, requirement completion status, and a phase-sequence violation).
 * Reaching for them here was tried and does not work. The content below is
 * AUTHORED against the rules in `src/ts-lint.ts`, which is the authority.
 *
 * THE WORKFLOW PROFILE IS THE CURRENT (STRICT) ONE, deliberately. A fixture could
 * dodge the strict profile's rules by declaring `Workflow version: memory-phase8`
 * instead — the profile is read from `00-requirements.md` — but that is a laxer
 * standard than the plugin's own runs use, and a fixture that reaches `passed`
 * by lowering the bar proves nothing about the gate. These artifacts meet
 * `recursive-mode-audit-v2`.
 *
 * TWO RUN-LEVEL FACTS THE LINTER REPORTS AGAINST THE RUN, NOT AN ARTIFACT, and
 * which therefore decide whether ANY lock in the run can pass:
 *
 *   1. THE MEMORY PLANE. `lintMemoryPlane` FAILs on a missing
 *      `.recursive/memory/`, and that FAIL line carries no artifact path, so
 *      `lintArtifact` attributes it to whatever artifact was asked about. A run
 *      with no memory plane therefore refuses EVERY lock — hence
 *      `ensureMemoryPlane`, which writes the router file (`MEMORY.md` is exempt
 *      from `lintMemoryDoc`; the missing subdirectories are WARN-only and do not
 *      block a lock).
 *   2. THE DIFF BASIS. A strict run whose `00-worktree.md` still holds the
 *      scaffold's `<resolve-before-locking>` placeholder produces
 *      `Unable to verify git diff basis` at run level — again attributed to every
 *      artifact, so the placeholder must be REPLACED by a real, executable basis
 *      (`ensureGitBaseline` + the worktree artifact below). A run left holding the
 *      scaffolded worktree artifact cannot lock anything at all.
 *
 * =====================================================================================
 * THE FIXTURE RUN — what `prepareCompliantRun` + `authorCompliantPhase` build, and why
 * =====================================================================================
 *
 * The FU-1 harness drives a WHOLE workflow, so every one of the twelve phase
 * artifacts has to meet its standard — including the `Worktree Diff Audit` of the
 * audited phases, which must reconcile with the run's ACTUAL diff. A fixture that
 * "reconciled" with an invented file list, or with an empty one, would satisfy the
 * linter while proving nothing, so this module builds a real change and reconciles
 * against it:
 *
 *   - the SCRATCH REPO carries `src/lock-chain.ts` at a recorded baseline commit,
 *     in the form where an out-of-order lock is ACCEPTED (the defect);
 *   - the RUN's change — applied AFTER the baseline commit, so git reports it — is
 *     that guard repaired, plus the test that pins the refusal;
 *   - `prepareCompliantRun` THROWS if git does not report both paths, which is the
 *     anti-vacuity guard: an empty diff would make every reconciliation check, and
 *     every `Changed Files` row, pass over nothing;
 *   - RED/GREEN evidence, review bundle, test and QA evidence are all written under
 *     the run directory, so every path an artifact cites EXISTS in the fixture;
 *   - the review bundle's `Artifact Content Hash` is computed from the artifact on
 *     disk and the bundle is only written once that artifact is LOCKED, because the
 *     linter checks the hash against the CURRENT content and a stale bundle is a
 *     real FAIL, not a technicality.
 *
 * NOT a `.spec.ts`, on purpose: `vitest.config.ts` collects
 * `tests/**\/*.spec.ts`, so this module is never run as a suite of its own.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  contentSha256,
  filterRuntimeChangedFiles,
  getGitChangedFiles,
  getRunDiffBasis,
} from '../src/ts-lint.ts'

/** The workflow profile these artifacts are authored for — the plugin's own. */
export const COMPLIANT_WORKFLOW_PROFILE = 'recursive-mode-audit-v2'

/** Every phase `recursive_init` scaffolds, in the order the workflow locks them. */
export const COMPLIANT_PHASES = [
  '00-requirements.md',
  '00-worktree.md',
  '01-as-is.md',
  '01.5-root-cause.md',
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '05-manual-qa.md',
  '06-decisions-update.md',
  '07-state-update.md',
  '08-memory-impact.md',
] as const
export type CompliantPhase = (typeof COMPLIANT_PHASES)[number]

/** True for phases whose standard includes an executable, live-verified diff basis. */
export function needsDiffBasis(phase: string): boolean {
  return phase === '00-worktree.md'
}

/* -------------------------------------------------------------------------- */
/* The fixture run's STORY, as paths: one repair, one test, both really changed */
/* -------------------------------------------------------------------------- */

/** The product file the run repairs. Present at the baseline, modified by the run. */
export const FIXTURE_PRODUCT_FILE = 'src/lock-chain.ts'
/** The test the run adds. Absent at the baseline, so git reports it as an added file. */
export const FIXTURE_TEST_FILE = 'tests/lock-chain.test.ts'

/** Run-relative evidence paths every phase that needs evidence cites. */
export const FIXTURE_EVIDENCE = {
  red: 'evidence/logs/red/lock-chain-red.txt',
  green: 'evidence/logs/green/lock-chain-green.txt',
  tests: 'evidence/logs/test-run.txt',
  qa: 'evidence/qa/manual-qa-scenario-1.txt',
  reviewBundle: 'evidence/review-bundles/lock-chain-review.md',
} as const

/** The two requirements the fixture run is about. Their quotes appear in 00-requirements.md. */
export const FIXTURE_REQUIREMENTS = [
  {
    id: 'R1',
    quote: 'a lock whose prerequisite is still DRAFT is refused',
    summary: 'the guard must refuse a lock while an earlier phase is still DRAFT',
  },
  {
    id: 'R2',
    quote: 'the refusal payload carries the ask with its options',
    summary: 'a refusal must carry the structured decision that unblocks it',
  },
] as const

export interface CompliantOptions {
  /** Repo root the artifact lives in — paths and git state resolve against it. */
  repoRoot: string
  /**
   * HEAD commit of the executable diff basis. Required by phases that record one
   * (`needsDiffBasis`), because a recorded basis is verified against live git.
   */
  baselineCommit?: string
  /**
   * Extra AUTHORED prose, appended as a final `## Notes` section. Two variants of
   * one phase then differ by content — which is what makes a re-lock after a
   * repair a genuinely different state rather than a byte-identical retry.
   */
  note?: string
  /**
   * The run's ACTUAL changed files, as the linter computes them. Audited phases
   * reconcile their `Worktree Diff Audit` against this list, so a caller that
   * supplies nothing gets an artifact whose audit section cites no changed path —
   * acceptable only for a run that genuinely has no diff.
   */
  facts?: CompliantFacts
  /** sha256 of the artifact a review bundle cites; required by `03.5-code-review.md`. */
  reviewedArtifactHash?: string
}

/** What the linter will see when it reconciles an audited phase against live git. */
export interface CompliantFacts {
  changedFiles: readonly string[]
}

/** A prepared fixture run: the baseline it records and the paths the artifacts may cite. */
export interface CompliantRun {
  root: string
  runId: string
  runDir: string
  /** HEAD of the executable diff basis the run records; every audited phase reconciles against it. */
  baselineCommit: string
}

/* -------------------------------------------------------------------------- */
/* Run-level prerequisites                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create `.recursive/memory/MEMORY.md` when absent.
 *
 * Only the router file: it is what `lintMemoryPlane` FAILs on. The empty
 * subdirectories are WARN-only, and any OTHER `.md` under the plane is validated
 * by `lintMemoryDoc`, so writing a fuller plane here would add FAIL surface for
 * no benefit to a fixture that exists to be locked.
 */
export function ensureMemoryPlane(root: string): void {
  const memoryRoot = join(root, '.recursive', 'memory')
  mkdirSync(memoryRoot, { recursive: true })
  const router = join(memoryRoot, 'MEMORY.md')
  if (!existsSync(router)) writeFileSync(router, '# MEMORY.md\n', 'utf8')
}

/**
 * Establish a real git repository with one commit holding everything currently on
 * disk, and return that commit's SHA — the only thing that makes a recorded diff
 * basis executable.
 *
 * The commit is cut AFTER the artifacts already written, so the tree is clean at
 * that point and later artifact writes show up as changes under the run's own
 * directory, which `filterRuntimeChangedFiles` drops.
 *
 * Identity is ensured on EVERY call, not only on init: several callers `git init`
 * themselves before handing the root over, and a commit without an identity fails
 * with exit 128 — which would surface as "the fixture's diff basis is
 * unexecutable" rather than as "git was never told who is committing".
 */
export function ensureGitBaseline(root: string): string {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  if (!existsSync(join(root, '.git'))) git('init', '-q', '-b', 'main')
  const configured = (key: string): boolean => {
    try {
      git('config', '--get', key)
      return true
    } catch {
      return false
    }
  }
  if (!configured('user.email')) git('config', 'user.email', 'fixture@example.invalid')
  if (!configured('user.name')) git('config', 'user.name', 'compliant-artifact fixture')
  git('add', '-A')
  // `--allow-empty` keeps this idempotent: a second call on an unchanged tree
  // still yields a commit to point the diff basis at, instead of failing.
  git('commit', '-q', '--allow-empty', '-m', 'compliant-artifact fixture baseline')
  return git('rev-parse', 'HEAD')
}

/** The diff-basis record a caller supplies when the run has no `00-worktree.md` yet. */
function explicitBasis(baselineCommit: string): Record<string, string | null> {
  return {
    baseline_type: 'local commit',
    baseline_reference: baselineCommit,
    comparison_reference: 'working-tree',
    normalized_baseline: baselineCommit,
    normalized_comparison: 'working-tree',
    normalized_diff_command: 'git diff --name-only ' + baselineCommit,
  }
}

/**
 * The run's ACTUAL changed files, computed with the LINTER'S OWN git helpers.
 *
 * Why not a private `git status` call: the reconciliation check that consumes this
 * list (`lintAuditSections`) drops the run's own directory and transient paths, and
 * a fixture computing the list differently would pass by disagreeing with the
 * checker instead of by being right.
 *
 * The run's recorded basis wins once `00-worktree.md` holds one; before that (and
 * for a run whose basis is still the scaffold's placeholder) the caller's prepared
 * baseline is used.
 */
export function runChangedFiles(root: string, runId: string, fallbackBaseline?: string): string[] {
  const runDir = join(root, '.recursive', 'run', runId)
  const recorded = getRunDiffBasis(runDir)
  const recordedBaseline = recorded.normalized_baseline ?? recorded.baseline_reference
  const usable = typeof recordedBaseline === 'string' && recordedBaseline !== '' && !recordedBaseline.startsWith('<')
  const basis = usable ? recorded : fallbackBaseline === undefined ? recorded : explicitBasis(fallbackBaseline)
  const [raw] = getGitChangedFiles(root, basis)
  return raw === null ? [] : filterRuntimeChangedFiles(raw, runId)
}

/* -------------------------------------------------------------------------- */
/* The fixture's product change                                                */
/* -------------------------------------------------------------------------- */

/** The baseline guard: it checks that the artifact is not itself locked, and nothing else. */
function baselineProductSource(): string {
  return [
    '/**',
    ' * Monotonic lock-order guard, AS THE BASELINE RECORDS IT.',
    ' *',
    ' * ⚠ THE DEFECT THIS FIXTURE RUN REPAIRS: the guard asks whether the artifact has',
    ' * already been locked and never asks whether an EARLIER phase is still DRAFT, so an',
    ' * out-of-order lock is accepted.',
    ' */',
    "export const LOCK_SEQUENCE = ['00-requirements.md', '00-worktree.md', '01-as-is.md'] as const",
    '',
    'export interface LockOrderVerdict {',
    '  ok: boolean',
    '  blockers: string[]',
    '}',
    '',
    'export function assertLockOrder(artifact: string, locked: readonly string[]): LockOrderVerdict {',
    '  if (locked.includes(artifact)) return { ok: false, blockers: [artifact] }',
    '  return { ok: true, blockers: [] }',
    '}',
    '',
  ].join('\n')
}

/** The repaired guard: every earlier phase in the sequence must already be LOCKED. */
function repairedProductSource(): string {
  return [
    '/**',
    ' * Monotonic lock-order guard, AS THE RUN REPAIRS IT.',
    ' *',
    ' * The guard now refuses a lock whose PREREQUISITE is not locked yet, and names each',
    ' * blocking artifact, which is what `R1` and `R2` ask for.',
    ' */',
    "export const LOCK_SEQUENCE = ['00-requirements.md', '00-worktree.md', '01-as-is.md'] as const",
    '',
    'export interface LockOrderVerdict {',
    '  ok: boolean',
    '  blockers: string[]',
    '}',
    '',
    'export function assertLockOrder(',
    '  artifact: string,',
    '  locked: readonly string[],',
    '  sequence: readonly string[] = LOCK_SEQUENCE,',
    '): LockOrderVerdict {',
    '  if (locked.includes(artifact)) return { ok: false, blockers: [artifact] }',
    '  const index = sequence.indexOf(artifact)',
    '  if (index < 0) return { ok: false, blockers: [] }',
    '  const blockers = sequence.slice(0, index).filter((phase) => !locked.includes(phase))',
    '  return { ok: blockers.length === 0, blockers }',
    '}',
    '',
  ].join('\n')
}

/** The test the run adds — it fails against the baseline guard and passes against the repair. */
function fixtureTestSource(): string {
  return [
    "import { assertLockOrder } from '../src/lock-chain.ts'",
    '',
    "describe('assertLockOrder', () => {",
    "  it('accepts a lock whose prerequisites are locked', () => {",
    "    expect(assertLockOrder('00-worktree.md', ['00-requirements.md'])).toEqual({ ok: true, blockers: [] })",
    '  })',
    '',
    "  it('refuses a lock while an earlier phase is DRAFT, and names it', () => {",
    "    const verdict = assertLockOrder('00-worktree.md', [])",
    '    expect(verdict.ok).toBe(false)',
    "    expect(verdict.blockers).toEqual(['00-requirements.md'])",
    '  })',
    '})',
    '',
  ].join('\n')
}

/** `.recursive/DECISIONS.md` and `.recursive/STATE.md`, so 06 and 07 cite files that exist. */
function fixturePlaneDocs(): Array<[string, string]> {
  return [
    ['.recursive/DECISIONS.md', ['# DECISIONS.md', '', '## D1 — monotonic lock order is a prerequisite rule', '',
      'A lock is refused while an earlier artifact in the phase sequence is still DRAFT.', ''].join('\n')],
    ['.recursive/STATE.md', ['# STATE.md', '', '## Phase sequence', '',
      'The run executes the canonical phase order and locks one artifact at a time.', ''].join('\n')],
  ]
}

/**
 * Write the fixture's recording of what a runner would have printed.
 *
 * ⚠ THESE ARE LABELLED FIXTURE RECORDS, not output of a suite executed in the
 * scratch repo — that repo has no test runner installed, and a file claiming
 * otherwise would be exactly the kind of evidence this repo has been burned by.
 * What they record is the RED/GREEN pair the phase-3 artifact must cite, in the
 * shape a real run's log has, with the guard each was recorded against named.
 */
function fixtureEvidence(runId: string): Array<[string, string]> {
  const red = [
    '# RED evidence — fixture record',
    '',
    'What this is: the FU-1 harness fixture recording the guard test run against the',
    'BASELINE `src/lock-chain.ts`, where an out-of-order lock is accepted. The scratch',
    'repo has no test runner installed, so this is a written record of the RED state',
    'rather than the captured stdout of a suite: the fixture says which command it',
    'stands for, and against which source.',
    '',
    '$ npx vitest run tests/lock-chain.test.ts',
    ' FAIL  tests/lock-chain.test.ts > assertLockOrder > refuses a lock while an earlier phase is DRAFT, and names it',
    " AssertionError: expected { ok: true, blockers: [] } to deeply equal { ok: false, blockers: [ '00-requirements.md' ] }",
    ' Test Files  1 failed (1)',
    '      Tests  1 failed | 1 passed (2)',
    '',
    'Source under test: `src/lock-chain.ts` at the run baseline commit.',
    '',
  ].join('\n')
  const green = [
    '# GREEN evidence — fixture record',
    '',
    'What this is: the same guard test against the REPAIRED `src/lock-chain.ts`, whose',
    'diff is the changed file named in the Worktree Diff Audit of every audited phase.',
    '',
    '$ npx vitest run tests/lock-chain.test.ts',
    ' ✓ tests/lock-chain.test.ts (2 tests)',
    ' Test Files  1 passed (1)',
    '      Tests  2 passed (2)',
    '',
    'Source under test: the repaired `src/lock-chain.ts` in the run diff.',
    '',
  ].join('\n')
  const tests = [
    '# Test run — fixture record',
    '',
    'What this is: the recorded outcome of the run the test-summary phase reports on,',
    'for the same reason as the RED/GREEN records above: the scratch repo has no test',
    'runner installed, and the fixture states what it stands for.',
    '',
    '$ npx vitest run',
    ' ✓ tests/lock-chain.test.ts (2 tests)',
    ' Test Files  1 passed (1)',
    '      Tests  2 passed (2)',
    '   Duration  0.41s',
    '',
  ].join('\n')
  const qa = [
    '# Manual QA scenario 1 — fixture record',
    '',
    'Scenario: lock an artifact whose prerequisite is still DRAFT.',
    'Expected: the call is refused, the refusal names the prerequisite and its status,',
    'and the artifact on disk is unchanged.',
    'Observed: the refusal names `00-requirements.md (DRAFT)`; `git status --short` shows',
    'no lock fields written.',
    '',
  ].join('\n')
  return [
    [FIXTURE_EVIDENCE.red, red],
    [FIXTURE_EVIDENCE.green, green],
    [FIXTURE_EVIDENCE.tests, tests],
    [FIXTURE_EVIDENCE.qa, qa],
  ]
}

/** Write every evidence path the artifacts cite, under the run directory. */
function writeFixtureEvidence(root: string, runId: string): void {
  const runDir = join(root, '.recursive', 'run', runId)
  for (const [relative, content] of fixtureEvidence(runId)) {
    const path = join(runDir, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
}

/**
 * Prepare a run for a workflow that will author each phase in order.
 *
 * Order matters and is the whole point: the MEMORY PLANE and the BASELINE PRODUCT
 * SOURCE are committed (so they are not part of the run's diff), and only then is
 * the run's CHANGE applied, so git reports exactly two paths and every audited
 * phase reconciles against a real change rather than an invented one.
 */
export function prepareCompliantRun(root: string, runId: string): CompliantRun {
  ensureMemoryPlane(root)
  for (const [relative, content] of fixturePlaneDocs()) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) writeFileSync(path, content, 'utf8')
  }
  const productPath = join(root, FIXTURE_PRODUCT_FILE)
  mkdirSync(dirname(productPath), { recursive: true })
  writeFileSync(productPath, baselineProductSource(), 'utf8')
  const baselineCommit = ensureGitBaseline(root)

  // THE RUN'S CHANGE — after the commit, so it IS the run's diff.
  writeFileSync(productPath, repairedProductSource(), 'utf8')
  const testPath = join(root, FIXTURE_TEST_FILE)
  mkdirSync(dirname(testPath), { recursive: true })
  writeFileSync(testPath, fixtureTestSource(), 'utf8')

  const changed = runChangedFiles(root, runId, baselineCommit)
  // ⚠ THE ANTI-VACUITY GUARD. An empty (or partial) diff would make every
  // `Worktree Diff Audit does not account for actual changed files` check AND every
  // `Changed Files` row pass over nothing, so a fixture that lost its change must
  // fail loudly here rather than quietly become a set of artifacts that reconcile
  // with the void.
  for (const expected of [FIXTURE_PRODUCT_FILE, FIXTURE_TEST_FILE]) {
    if (!changed.includes(expected)) {
      throw new Error(
        'the fixture run has no real change at ' + expected + ', so every diff audit would reconcile with an'
        + ' invented or empty diff. git reports: ' + JSON.stringify(changed),
      )
    }
  }
  const run: CompliantRun = { root, runId, runDir: join(root, '.recursive', 'run', runId), baselineCommit }
  // ⚠ THE WORKTREE ARTIFACT IS PART OF PREPARATION, NOT OF PHASE 2's STEP, and this
  // was measured rather than assumed: while `00-worktree.md` still holds the
  // scaffold's `<resolve-before-locking>`, `lintRun` emits
  // `Unable to verify git diff basis` against the RUN DIRECTORY — a FAIL line that
  // names no artifact, so `parseLintOutput` attributes it to whatever artifact was
  // asked about. The measured consequence is that the FIRST lock of the run
  // (`00-requirements.md`, one step before phase 2 is authored) is refused for a
  // reason that belongs to phase 2. Writing the basis here makes the run lockable
  // from its first step; the phase-2 step rewrites the identical content.
  authorCompliantPhase(run, '00-worktree.md')
  return run
}

/**
 * Write the review bundle `03.5-code-review.md` cites, and return its content.
 *
 * ⚠ THE HASH IS THE TRAP THIS AVOIDS. `lintReviewBundleReference` compares the
 * bundle's `Artifact Content Hash` with the CURRENT content of its `Artifact Path`,
 * and a LOCK rewrites that content (it adds `LockedAt`/`LockHash`). So the bundle is
 * hashed from the artifact AS IT STANDS when the bundle is written, which in the
 * harness is after that artifact has locked and will not change again.
 *
 * ⚠ AND A NOT-YET-LOCKED SUBJECT IS A DELIBERATE NON-ERROR. This used to throw, and
 * a mutation test showed why that was wrong: when a phase fails to lock, the THROW
 * fired before the harness could report it, so the run failed with this module's
 * message instead of the harness's own `first unlocked: <phase>` — the diagnostic the
 * harness exists to produce. A DRAFT subject still yields a bundle whose hash matches
 * the file on disk, and the linter remains the backstop for the real risk: if the
 * subject locks AFTER the bundle is written, `Review bundle is stale` is a FAIL.
 */
export function reviewBundleContent(run: CompliantRun, facts: CompliantFacts): string {
  const reviewed = '03-implementation-summary.md'
  const reviewedPath = join(run.runDir, reviewed)
  if (!existsSync(reviewedPath)) {
    throw new Error('03.5-code-review.md needs ' + reviewed + ' to exist before its review bundle can be authored')
  }
  const changed = facts.changedFiles.length > 0 ? facts.changedFiles : [FIXTURE_PRODUCT_FILE, FIXTURE_TEST_FILE]
  const rel = (name: string): string => '.recursive/run/' + run.runId + '/' + name
  return [
    'Artifact Path: `' + rel(reviewed) + '`',
    'Artifact Content Hash: `' + contentSha256(readFileSync(reviewedPath, 'utf8')) + '`',
    '',
    '## Diff Basis',
    '',
    '- Baseline type: `local commit`',
    '- Baseline reference: `' + run.baselineCommit + '`',
    '- Comparison reference: `working-tree`',
    '- Normalized baseline: `' + run.baselineCommit + '`',
    '- Normalized comparison: `working-tree`',
    '- Normalized diff command: `git diff --name-only ' + run.baselineCommit + '`',
    '',
    '## Changed Files Reviewed',
    '',
    ...changed.map((path) => '- `' + path + '`'),
    '',
    '## Upstream Artifacts To Re-read',
    '',
    '- `' + rel('02-to-be-plan.md') + '`',
    '- `' + rel(reviewed) + '`',
    '',
    '## Relevant Addenda',
    '',
    'None: the run tree contains no addendum for this phase.',
    '',
    '## Prior Recursive Evidence',
    '',
    'None: this run has no earlier recursive evidence that bears on the guard.',
    '',
    '## Targeted Code References',
    '',
    ...changed.map((path) => '- `' + path + '`'),
    '',
    '## Audit Questions',
    '',
    '- Does the repaired guard refuse a lock while an earlier phase is still DRAFT?',
    '- Does the refusal name the blocking artifact together with its status?',
    '',
    '## Required Output',
    '',
    'Verdict, per-requirement reconciliation, issues found, and a review bundle path that resolves.',
    '',
  ].join('\n')
}

/**
 * Author one phase artifact into a prepared run, and return the path written.
 *
 * Everything a phase needs beyond its own text is resolved HERE, from live state:
 * the run's actual changed files for the audit sections, and — for the code review
 * — the locked content hash its bundle must match.
 */
export function authorCompliantPhase(run: CompliantRun, phase: string): string {
  writeFixtureEvidence(run.root, run.runId)
  const changedFiles = runChangedFiles(run.root, run.runId, run.baselineCommit)
  if (phase === '03.5-code-review.md') {
    const bundlePath = join(run.runDir, FIXTURE_EVIDENCE.reviewBundle)
    mkdirSync(dirname(bundlePath), { recursive: true })
    writeFileSync(bundlePath, reviewBundleContent(run, { changedFiles }), 'utf8')
  }
  const content = compliantArtifact(phase, run.runId, {
    repoRoot: run.root,
    baselineCommit: run.baselineCommit,
    facts: { changedFiles },
  })
  const path = join(run.runDir, phase)
  writeFileSync(path, content, 'utf8')
  return path
}

/* -------------------------------------------------------------------------- */
/* Authored artifact text                                                      */
/* -------------------------------------------------------------------------- */

interface Row {
  id: string
  fields: ReadonlyArray<readonly [string, string]>
}

/** One `- R1 | Status: ... | Field: value` row, in the shape the linter parses. */
function rows(entries: readonly Row[]): string {
  return entries.map((entry) => '- ' + entry.id + ' | ' + entry.fields.map(([key, value]) => key + ': ' + value).join(' | ')).join('\n')
}

const rel = (runId: string, name: string): string => '.recursive/run/' + runId + '/' + name
const runPath = (runId: string): string => '/.recursive/run/' + runId + '/'

/** The upstream artifacts a phase re-reads, in the canonical sequence. */
function upstreams(runId: string, names: readonly string[]): string[] {
  return names.map((name) => rel(runId, name))
}

function header(runId: string, phase: string, label: string, inputs: readonly string[], scopeNote: string): string[] {
  return [
    'Run: `' + runPath(runId) + '`',
    'Phase: `' + label + '`',
    'Status: `DRAFT`',
    'Workflow version: `' + COMPLIANT_WORKFLOW_PROFILE + '`',
    'Inputs:',
    ...inputs.map((input) => '- `' + input + '`'),
    'Outputs:',
    '- `' + rel(runId, phase) + '`',
    'Scope note: ' + scopeNote,
    '',
  ]
}

function todo(items: readonly string[]): string[] {
  return ['## TODO', '', ...items.map((item) => '- [x] ' + item), '']
}

function coverageGate(items: readonly string[]): string[] {
  return ['## Coverage Gate', '', ...items.map((item) => '- [x] ' + item), '', 'Coverage: PASS', '']
}

function approvalGate(items: readonly string[]): string[] {
  return ['## Approval Gate', '', ...items.map((item) => '- [x] ' + item), '', 'Approval: PASS', '']
}

function traceability(runId: string, lines: readonly string[]): string[] {
  return ['## Traceability', '', ...lines, '']
}

/**
 * The nine audited-phase sections, all present and all non-placeholder.
 *
 * `Gaps Found` says `None.` deliberately: `lintAuditSections` refuses
 * `Audit: PASS` while that section still lists unresolved in-scope gaps, so an
 * artifact that passes must either have no gaps or say so.
 */
function auditedBlock(
  runId: string,
  inputs: readonly string[],
  facts: CompliantFacts,
  baselineCommit: string,
  completion: string,
  verdict: string,
): string[] {
  return [
    '## Audit Context',
    '',
    '- Audit Execution Mode: self-audit',
    '- Subagent Availability: unavailable',
    '- Subagent Capability Probe: this fixture mounts no subagents runtime, so the probe reports no provider',
    '- Delegation Decision Basis: with no delegation seam mounted, the main agent performed and recorded the audit itself',
    '- Audit Inputs Provided: `' + rel(runId, '00-worktree.md') + '` for the diff basis, the run diff itself, and the upstream artifacts listed above',
    '- Delegation Override Reason: not applicable: self-audit was chosen because no subagent was available',
    '',
    '## Effective Inputs Re-read',
    '',
    'Re-read in full before this audit:',
    ...inputs.map((input) => '- `' + input + '`'),
    '',
    '## Earlier Phase Reconciliation',
    '',
    'No contradiction was found between this artifact and the phases it re-read:',
    ...inputs.map((input) => '- `' + input + '` states the same scope, the same diff basis and the same requirement set as recorded here.'),
    '',
    '## Subagent Contribution Verification',
    '',
    '- Reviewed Action Records: none — no subagent delegation was used for this phase.',
    '- Main-Agent Verification Performed: the main agent held every claim below against the run diff and the artifacts above.',
    '- Acceptance Decision: accepted',
    '- Refresh Handling: not applicable; nothing delegated needed refreshing.',
    '- Repair Performed After Verification: nothing to repair; no delegated claim was contradicted by the diff.',
    '',
    '## Worktree Diff Audit',
    '',
    '- Baseline type: `local commit`',
    '- Baseline reference: `' + baselineCommit + '`',
    '- Comparison reference: `working-tree`',
    '- Normalized baseline: `' + baselineCommit + '`',
    '- Normalized comparison: `working-tree`',
    '- Normalized diff command: `git diff --name-only ' + baselineCommit + '`',
    '',
    'Changed files in the ACTUAL run diff, as `git diff --name-only ' + baselineCommit + '` plus untracked files report them:',
    ...(facts.changedFiles.length > 0 ? facts.changedFiles.map((path) => '- `' + path + '`') : ['- none: this run changes no file outside its own run directory']),
    '',
    'Every path above was compared against the diff itself; no path outside the diff is claimed, and no path in the diff is left unexplained.',
    '',
    '## Gaps Found',
    '',
    'None. Every requirement in scope is dispositioned below and every changed path is accounted for above.',
    '',
    '## Repair Work Performed',
    '',
    'Nothing was repaired inside this phase: the diff below is the whole change the run made, and the audit found no gap to close.',
    '',
    '## Requirement Completion Status',
    '',
    completion,
    '',
    '## Audit Verdict',
    '',
    verdict,
    '',
    'Audit: PASS',
    '',
  ]
}

/** The `Prior Recursive Evidence Reviewed` section, citing a path that EXISTS. */
function priorEvidence(runId: string): string[] {
  return [
    '## Prior Recursive Evidence Reviewed',
    '',
    '- `' + rel(runId, '00-requirements.md') + '` and `' + rel(runId, '00-worktree.md') + '` were re-read for the same scope and the same recorded diff basis.',
    '- `.recursive/memory/MEMORY.md` is the memory router this run reads; it carries no shard that contradicts this phase.',
    '',
  ]
}

/** `05-manual-qa.md` and the two evidence sections it needs. */
function qaEvidenceSections(runId: string): string[] {
  return [
    '## QA Execution Record',
    '',
    '- QA Execution Mode: agent-operated',
    '- Agent Executor: the run agent, driving the fixture repository through its own tools',
    '- Tools Used: `recursive_lock`, `recursive_lint` and the fixture repository shell',
    '- Evidence Path: `' + rel(runId, FIXTURE_EVIDENCE.qa) + '`',
    '',
    '## QA Scenarios and Results',
    '',
    '- Scenario: lock an artifact whose prerequisite is still DRAFT. Result: refused, and the refusal names `00-requirements.md (DRAFT)`.',
    '- Scenario: lock the same artifact after the prerequisite locks. Result: accepted, and the receipt records the lock hash.',
    '',
    '## Evidence and Artifacts',
    '',
    '- `' + rel(runId, FIXTURE_EVIDENCE.qa) + '`',
    '- `' + rel(runId, FIXTURE_EVIDENCE.tests) + '`',
    '',
    '## User Sign-Off',
    '',
    '- Not required: QA Execution Mode is agent-operated, so no human sign-off is owed for this phase.',
    '',
  ]
}

function body(phase: CompliantPhase, runId: string, options: CompliantOptions): string {
  const facts = options.facts ?? { changedFiles: [] }
  const changed = facts.changedFiles
  const baseline = options.baselineCommit
  const note = options.note === undefined ? '' : '\n\n## Notes\n\n' + options.note + '\n'
  const requireBaseline = (): string => {
    if (baseline === undefined) throw new Error('compliant ' + phase + ' needs the baseline commit its diff basis records')
    return baseline
  }

  if (phase === '00-requirements.md') {
    return [
      ...header(runId, phase, '00 Requirements',
        ['[the operator brief for this run, captured before the phase began]'],
        'Authored requirement set for a run whose lock gate holds it to the phase standard.'),
      ...todo([
        'Elicit requirements from the operator',
        'Define requirement identifiers',
        'Write acceptance criteria for each requirement',
        'Record out-of-scope items',
        'Record constraints and assumptions',
        'Complete the Coverage and Approval gates',
      ]),
      '## Requirements',
      '',
      '### `R1` A lock whose prerequisite is not locked is refused',
      '',
      'Description:',
      '`recursive_lock` refuses a lock whose prerequisites are not LOCKED, and names each blocking artifact together with its status.',
      'Acceptance criteria:',
      '- a lock whose prerequisite is still DRAFT is refused',
      '- the refusal names the blocking artifact and its status',
      '',
      '### `R2` A refusal carries the decision that unblocks it',
      '',
      'Description:',
      'A refused lock carries the structured decision (fix, reopen or abandon) that resolves the block, instead of prose alone.',
      'Acceptance criteria:',
      '- the refusal payload carries the ask with its options',
      '- the refused call leaves the artifact untouched',
      '',
      '## Out of Scope',
      '',
      '- `OOS1`: changing the phase sequence or the lock-order rule itself',
      '',
      '## Constraints',
      '',
      '- the linter (`src/ts-lint.ts`) is the authority on the phase standard',
      '',
      ...coverageGate([
        'Every requirement carries an identifier and acceptance criteria',
        'Out-of-scope items are recorded',
      ]),
      ...approvalGate([
        'The operator approved the requirement set',
      ]),
    ].join('\n') + note + '\n'
  }

  if (phase === '00-worktree.md') {
    const commit = requireBaseline()
    return [
      ...header(runId, phase, '00 Worktree', [rel(runId, '00-requirements.md')],
        'Worktree and diff-basis record for the run; the diff basis below is executable against live git.'),
      ...todo([
        'Confirm the selected worktree location and isolation approach',
        'Confirm the baseline the later audited phases will diff against',
        'Run setup and verify the clean test baseline',
        'Confirm the diff basis fields still match live git state',
      ]),
      '## Directory Selection',
      '',
      '- Repository root: `' + options.repoRoot.replace(/\\/g, '/') + '`',
      '- Selected location: the repository root; this run creates no linked worktree.',
      '',
      '## Safety Verification',
      '',
      '- The checkout is the run root itself, so no other working tree shares it.',
      '',
      '## Worktree Creation',
      '',
      '- No linked worktree is created: the run executes in the repository root and records that choice here.',
      '',
      '## Main Branch Protection',
      '',
      '- No branch is promoted or merged by this run, so the protected branches are untouched.',
      '',
      '## Project Setup',
      '',
      '- Setup is limited to repository initialization; this run installs nothing into the checkout.',
      '',
      '## Test Baseline Verification',
      '',
      '- The baseline is the committed tree at the recorded diff basis, which the test-summary phase reports against: `' + rel(runId, FIXTURE_EVIDENCE.tests) + '`.',
      '',
      '## Worktree Context',
      '',
      '- Phase 0 executes in the repository root with the executable diff basis recorded below.',
      '',
      '## Diff Basis For Later Audits',
      '',
      '- Baseline type: `local commit`',
      '- Baseline reference: `' + commit + '`',
      '- Comparison reference: `working-tree`',
      '- Normalized baseline: `' + commit + '`',
      '- Normalized comparison: `working-tree`',
      '- Normalized diff command: `git diff --name-only ' + commit + '`',
      '- Diff basis notes: verified against live git; no branch fields are recorded, so no branch verification is implied.',
      '',
      ...traceability(runId, [
        '- `R1` and `R2` are traced to the Phase 0 context recorded here: the diff basis below is what the later audited phases compare against.',
      ]),
      ...coverageGate([
        'The selected location, isolation and diff basis are recorded',
        'The diff basis resolves against live git',
      ]),
      ...approvalGate([
        'The operator approved the Phase 0 context',
      ]),
    ].join('\n') + note + '\n'
  }

  if (phase === '01-as-is.md') {
    const inputs = upstreams(runId, ['00-requirements.md', '00-worktree.md'])
    return [
      ...header(runId, phase, '01 As Is', inputs,
        'As-is characterization of the guard the run is about, with the source requirement inventory the plan maps against.'),
      ...todo([
        'Reproduce the defect from the fixture repository',
        'Record the current behavior for every requirement',
        'Inventory the source requirements and their dispositions',
        'Record code pointers, known unknowns and evidence',
      ]),
      '## Reproduction Steps (Novice-Runnable)',
      '',
      '1. `git -C <repo-root> status --short` to see the run\'s own diff.',
      '2. Read `' + FIXTURE_PRODUCT_FILE + '` at the baseline commit and call `assertLockOrder(\'00-worktree.md\', [])`.',
      '3. Observe that the call answers `{ ok: true, blockers: [] }` while `00-requirements.md` is still DRAFT.',
      '',
      '## Current Behavior by Requirement',
      '',
      '- `R1`: the baseline guard accepts an out-of-order lock, so the requirement is unmet in the as-is state.',
      '- `R2`: the baseline has no refusal payload at all, so no decision travels with a refusal.',
      '',
      '## Source Requirement Inventory',
      '',
      ...FIXTURE_REQUIREMENTS.map((requirement) => '- ' + requirement.id + ' | Disposition: in-scope | Source Quote: ' + requirement.quote + ' | Summary: ' + requirement.summary + '.'),
      '',
      '## Relevant Code Pointers',
      '',
      '- `' + FIXTURE_PRODUCT_FILE + '` — the guard that decides whether a lock is in order.',
      '- `' + FIXTURE_TEST_FILE + '` — the test the run adds to pin the refusal.',
      '',
      '## Known Unknowns',
      '',
      '- None: the fixture repository is the whole surface, and every path named here exists at the recorded baseline.',
      '',
      '## Evidence',
      '',
      '- `' + rel(runId, FIXTURE_EVIDENCE.red) + '` records the guard test failing against the baseline source.',
      '',
      ...traceability(runId, [
        '- `R1` is characterized by the reproduction steps above.',
        '- `R2` is characterized by the absence of any refusal payload in the baseline.',
      ]),
      ...priorEvidence(runId),
      ...coverageGate([
        'Every requirement has an as-is behavior recorded',
        'Every inventory entry carries a disposition, a source quote and a summary',
      ]),
      ...approvalGate([
        'The operator accepted the as-is characterization',
      ]),
      ...auditedBlock(runId, inputs, facts, requireBaseline(),
        rows([
          { id: 'R1', fields: [['Status', 'blocked'], ['Rationale', 'the guard in the as-is state accepts an out-of-order lock, so the requirement is not met yet'], ['Blocking Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Audit Note', 'confirmed by the reproduction steps above']] },
          { id: 'R2', fields: [['Status', 'blocked'], ['Rationale', 'the as-is state carries no refusal payload, so no decision can travel with one'], ['Blocking Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Audit Note', 'the plan maps this to the same guard']] },
        ]),
        'PASS — the as-is state is characterized, the inventory is complete, and the defect is reproduced against the baseline source.'),
    ].join('\n') + note + '\n'
  }

  if (phase === '01.5-root-cause.md') {
    const inputs = upstreams(runId, ['01-as-is.md'])
    return [
      ...header(runId, phase, '01.5 Root Cause', inputs,
        'Root-cause analysis of why the baseline guard accepts an out-of-order lock.'),
      ...todo([
        'Analyse the failure and verify the reproduction',
        'Trace the data flow through the guard',
        'Test the hypothesis against the baseline source',
        'Record the root cause and its evidence',
      ]),
      '## Error Analysis',
      '',
      '- The guard answers `ok: true` for an artifact whose prerequisite is DRAFT, because the only condition it evaluates is whether the artifact is already locked itself.',
      '',
      '## Reproduction Verification',
      '',
      '- Reproduced from `' + rel(runId, '01-as-is.md') + '`: `assertLockOrder(\'00-worktree.md\', [])` returns `{ ok: true, blockers: [] }`.',
      '',
      '## Recent Changes Analysis',
      '',
      '- The recorded baseline commit is the only reference point: nothing in the run changes the guard before this analysis.',
      '',
      '## Evidence Gathering (Multi-Layer if applicable)',
      '',
      '- Layer 1, source: `' + FIXTURE_PRODUCT_FILE + '` at the baseline commit.',
      '- Layer 2, test: `' + rel(runId, FIXTURE_EVIDENCE.red) + '` records the failing assertion.',
      '',
      '## Data Flow Trace',
      '',
      '- `locked` enters the guard, the artifact is tested for membership in it, and the sequence position of the artifact is never consulted — which is where the prerequisite knowledge is lost.',
      '',
      '## Pattern Analysis',
      '',
      '- The pattern is a missing prerequisite scan, not a race or an ordering bug: the guard has the information it needs and does not read it.',
      '',
      '## Hypothesis Testing',
      '',
      '- Hypothesis: adding the prerequisite scan makes the failing test pass. Confirmed against the repaired source in `' + rel(runId, FIXTURE_EVIDENCE.green) + '`.',
      '',
      '## Root Cause Summary',
      '',
      '- The guard never compares the artifact position against the locked set, so an artifact with an unlocked prerequisite is accepted.',
      '',
      ...traceability(runId, [
        '- `R1` fails for the reason recorded in the Root Cause Summary.',
        '- `R2` fails because a guard that never refuses has no refusal to carry.',
      ]),
      ...coverageGate([
        'The failure is analysed and reproduced',
        'The root cause is stated and its hypothesis tested',
      ]),
      ...approvalGate([
        'The operator accepted the root cause',
      ]),
      ...auditedBlock(runId, inputs, facts, requireBaseline(),
        rows([
          { id: 'R1', fields: [['Status', 'blocked'], ['Rationale', 'the root cause is identified but not yet repaired in this phase'], ['Blocking Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Audit Note', 'the plan phase maps the repair to this same file']] },
          { id: 'R2', fields: [['Status', 'blocked'], ['Rationale', 'no refusal exists in the baseline for a decision to travel with'], ['Blocking Evidence', '`' + rel(runId, FIXTURE_EVIDENCE.red) + '`'], ['Audit Note', 'the refusal payload is added by the same repair']] },
        ]),
        'PASS — the root cause is identified, reproduced and tested against both the baseline and the repaired guard.'),
    ].join('\n') + note + '\n'
  }

  if (phase === '02-to-be-plan.md') {
    const inputs = upstreams(runId, ['00-requirements.md', '01-as-is.md', '01.5-root-cause.md'])
    return [
      ...header(runId, phase, '02 To Be Plan', inputs,
        'Plan for the repair, mapping every inventoried requirement onto a concrete implementation, verification and QA surface.'),
      ...todo([
        'Plan the change per file',
        'Map every source inventory item to a coverage disposition',
        'Record the testing strategy and QA scenarios',
        'Check the plan for drift and complete the gates',
      ]),
      '## Planned Changes by File',
      '',
      '- `' + FIXTURE_PRODUCT_FILE + '`: add the prerequisite scan to `assertLockOrder` so an artifact with an unlocked prerequisite is refused by name.',
      '- `' + FIXTURE_TEST_FILE + '`: add the test that pins the refusal and the name of the blocking artifact.',
      '',
      '## Requirement Mapping',
      '',
      ...FIXTURE_REQUIREMENTS.map((requirement) => '- ' + requirement.id + ' | Source Quote: ' + requirement.quote + ' | Coverage: direct | Implementation Surface: `' + FIXTURE_PRODUCT_FILE + '` | Verification Surface: `' + FIXTURE_TEST_FILE + '` | QA Surface: manual QA scenario 1 in `' + rel(runId, '05-manual-qa.md') + '`'),
      '',
      '## Implementation Steps',
      '',
      '1. Read the baseline guard and confirm the missing prerequisite scan.',
      '2. Add the scan and refuse with the blocking artifact names.',
      '3. Add the test and run it red against the baseline, then green against the repair.',
      '',
      '## Testing Strategy',
      '',
      '- RED: the new test against the baseline guard, recorded at `' + rel(runId, FIXTURE_EVIDENCE.red) + '`.',
      '- GREEN: the same test against the repair, recorded at `' + rel(runId, FIXTURE_EVIDENCE.green) + '`.',
      '',
      '## Playwright Plan (if applicable)',
      '',
      '- Not applicable: this run changes a library guard, and no browser surface is involved.',
      '',
      '## Manual QA Scenarios',
      '',
      '- Scenario 1: attempt a lock whose prerequisite is DRAFT and confirm the refusal names it.',
      '',
      '## Idempotence and Recovery',
      '',
      '- The guard is a pure function of the artifact, the locked set and the sequence, so re-running it is idempotent and a refused lock leaves the artifact untouched.',
      '',
      '## Implementation Sub-phases',
      '',
      '- Single sub-phase: the repair and its test land together, because a guard without its test is what the run is repairing.',
      '',
      '## Plan Drift Check',
      '',
      '- No obligations were merged: one inventoried requirement maps to one implementation surface, so no lossless-merge rationale is needed.',
      '',
      ...traceability(runId, [
        '- `R1` is planned on `' + FIXTURE_PRODUCT_FILE + '` with `' + FIXTURE_TEST_FILE + '` as its verification surface.',
        '- `R2` rides the same repair: the refusal payload is what the guard returns once it can refuse.',
      ]),
      ...priorEvidence(runId),
      ...coverageGate([
        'Every planned file is named with the change it carries',
        'Every inventory item has a mapping entry',
      ]),
      ...approvalGate([
        'The operator approved the plan',
      ]),
      ...auditedBlock(runId, inputs, facts, requireBaseline(),
        rows([
          { id: 'R1', fields: [['Status', 'planned'], ['Implementation Surface', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Surface', '`' + FIXTURE_TEST_FILE + '`'], ['QA Surface', 'manual QA scenario 1'], ['Audit Note', 'the plan names the file the diff actually changes']] },
          { id: 'R2', fields: [['Status', 'planned'], ['Implementation Surface', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Surface', '`' + FIXTURE_TEST_FILE + '`'], ['QA Surface', 'manual QA scenario 1'], ['Audit Note', 'the refusal shape is the same return value the guard already produces']] },
        ]),
        'PASS — the plan maps every inventoried requirement onto a file that exists, and the sequence it assumes is the sequence the run locks in.'),
    ].join('\n') + note + '\n'
  }

  if (phase === '03-implementation-summary.md') {
    const inputs = upstreams(runId, ['02-to-be-plan.md'])
    const changedFields = changed.map((path) => '`' + path + '`').join(', ')
    return [
      ...header(runId, phase, '03 Implementation Summary', inputs,
        'Record of the change the run made, its TDD evidence, and the per-requirement completion state.'),
      ...todo([
        'Record every change applied, per file',
        'Record the TDD RED and GREEN evidence',
        'Record plan deviations',
        'Reconcile the change against the actual diff',
      ]),
      '## Changes Applied',
      '',
      '- `' + FIXTURE_PRODUCT_FILE + '`: `assertLockOrder` now scans the phase sequence and refuses with the artifacts that are not locked yet.',
      '- `' + FIXTURE_TEST_FILE + '`: added, pinning the refusal and the blocking artifact name.',
      '',
      '## TDD Compliance Log',
      '',
      '- TDD Mode: strict',
      '- RED Evidence: `' + rel(runId, FIXTURE_EVIDENCE.red) + '`',
      '- GREEN Evidence: `' + rel(runId, FIXTURE_EVIDENCE.green) + '`',
      '- Refactor step: after GREEN the guard was reduced to the sequence scan alone, and the test was rerun unchanged.',
      '',
      'TDD Compliance: PASS',
      '',
      '## Plan Deviations',
      '',
      '- None: the change landed on the two files the plan named, and no obligation moved.',
      '',
      '## Implementation Evidence',
      '',
      '- The diff itself: `' + FIXTURE_PRODUCT_FILE + '` and `' + FIXTURE_TEST_FILE + '`, as reported by the recorded diff basis.',
      '- GREEN record: `' + rel(runId, FIXTURE_EVIDENCE.green) + '`.',
      '',
      ...traceability(runId, [
        '- `R1` is implemented in `' + FIXTURE_PRODUCT_FILE + '` and pinned by `' + FIXTURE_TEST_FILE + '`.',
        '- `R2` is implemented by the same refusal path, which returns the blocking artifact names.',
      ]),
      ...coverageGate([
        'Every change applied is recorded per file',
        'TDD evidence exists for the RED and GREEN states',
      ]),
      ...approvalGate([
        'The operator approved the implementation summary',
      ]),
      ...auditedBlock(runId, inputs, facts, requireBaseline(),
        rows([
          { id: 'R1', fields: [['Status', 'implemented'], ['Changed Files', changedFields || '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Audit Note', 'the guard now refuses and names the blocking artifact']] },
          { id: 'R2', fields: [['Status', 'implemented'], ['Changed Files', changedFields || '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Audit Note', 'the refusal carries the blocking artifact and its status']] },
        ]),
        'PASS — the change is on disk, its TDD evidence exists, and every changed file is accounted for by a requirement row above.'),
    ].join('\n') + note + '\n'
  }

  if (phase === '03.5-code-review.md') {
    const inputs = upstreams(runId, ['02-to-be-plan.md', '03-implementation-summary.md'])
    const changedFields = changed.map((path) => '`' + path + '`').join(', ')
    const bundlePath = rel(runId, FIXTURE_EVIDENCE.reviewBundle)
    return [
      ...header(runId, phase, '03.5 Code Review', inputs,
        'Independent review of the implementation against the plan, grounded in the review bundle recorded under the run evidence.'),
      ...todo([
        'Assemble the review bundle from the locked implementation summary',
        'Review the change against the plan',
        'Assess code quality and record issues',
        'Record the verdict and its evidence',
      ]),
      '## Review Scope',
      '',
      'Reviewed `' + rel(runId, '03-implementation-summary.md') + '` against `' + rel(runId, '02-to-be-plan.md') + '`, using the review bundle at `' + bundlePath + '`.',
      'The bundle pins the reviewed content by hash and names the changed files: `' + (changed.join('`, `') || FIXTURE_PRODUCT_FILE) + '`.',
      '',
      '## Plan Alignment Assessment',
      '',
      '- The change landed on exactly the files `' + rel(runId, '02-to-be-plan.md') + ' planned, and the diff named in the bundle matches the plan one-to-one.',
      '',
      '## Code Quality Assessment',
      '',
      '- The guard is a pure function of its inputs, refuses with the blocking artifact names, and leaves the caller\'s artifact untouched on refusal.',
      '',
      '## Issues Found',
      '',
      '- None in scope. The reviewed change is the two files the bundle lists, and no path outside them is touched.',
      '',
      '## Verdict',
      '',
      'APPROVED — the implementation matches the plan, the refusal names the blocking artifact, and the bundle supports every claim above.',
      '',
      '## Review Metadata',
      '',
      '- Review Bundle Path: `' + bundlePath + '`',
      '- Reviewed Artifact: `' + rel(runId, '03-implementation-summary.md') + '`',
      '',
      ...traceability(runId, [
        '- `R1` is reviewed against `' + FIXTURE_PRODUCT_FILE + '` and approved.',
        '- `R2` is reviewed against the same refusal path and approved.',
      ]),
      ...coverageGate([
        'The review bundle exists and is cited',
        'Every reviewed file is named in the bundle',
      ]),
      ...approvalGate([
        'The operator approved the review verdict',
      ]),
      ...auditedBlock(runId, inputs, facts, requireBaseline(),
        rows([
          { id: 'R1', fields: [['Status', 'implemented'], ['Changed Files', changedFields || '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Audit Note', 'reviewed and approved; verification follows in phase 04']] },
          { id: 'R2', fields: [['Status', 'implemented'], ['Changed Files', changedFields || '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Audit Note', 'reviewed and approved; verification follows in phase 04']] },
        ]),
        'PASS — the review is grounded in a bundle that resolves, whose hash matches the reviewed artifact, and the verdict follows from the diff.'),
    ].join('\n') + note + '\n'
  }

  if (phase === '04-test-summary.md') {
    const inputs = upstreams(runId, ['02-to-be-plan.md', '03-implementation-summary.md', '03.5-code-review.md'])
    const changedFields = changed.map((path) => '`' + path + '`').join(', ')
    return [
      ...header(runId, phase, '04 Test Summary', inputs,
        'Test summary for the change, with the exact commands, the evidence paths and the verification that closes each requirement.'),
      ...todo([
        'Audit the implementation before testing',
        'Record the environment and the exact commands',
        'Record the results and the evidence paths',
        'Verify every requirement against the run',
      ]),
      '## Pre-Test Implementation Audit',
      '',
      '- Re-read the implementation summary, the code review and the recorded diff basis before executing anything.',
      '',
      '## Environment',
      '',
      '- The fixture repository at the recorded diff basis, with the run\'s change applied to `' + FIXTURE_PRODUCT_FILE + '`.',
      '',
      '## Execution Mode',
      '',
      '- Local execution by the run agent against the fixture checkout.',
      '',
      '## Commands Executed (Exact)',
      '',
      '- `npx vitest run tests/lock-chain.test.ts`',
      '- `git diff --name-only ' + requireBaseline() + '`',
      '',
      '## Results Summary',
      '',
      '- 2 passed, 0 failed: the guard refuses an out-of-order lock and names the blocking artifact.',
      '',
      '## Evidence and Artifacts',
      '',
      '- `' + rel(runId, FIXTURE_EVIDENCE.tests) + '`',
      '- `' + rel(runId, FIXTURE_EVIDENCE.green) + '`',
      '',
      '## Failures and Diagnostics (if any)',
      '',
      '- None in the final run; the RED state is recorded separately at `' + rel(runId, FIXTURE_EVIDENCE.red) + '`.',
      '',
      '## Flake/Rerun Notes',
      '',
      '- No reruns were needed: the guard is pure, so the result does not depend on ordering or timing.',
      '',
      ...traceability(runId, [
        '- `R1` is verified by the passing test and the GREEN record.',
        '- `R2` is verified by the refusal assertion that names the blocking artifact.',
      ]),
      ...priorEvidence(runId),
      ...coverageGate([
        'The exact commands and their outcomes are recorded',
        'Every requirement is verified against a recorded evidence path',
      ]),
      ...approvalGate([
        'The operator approved the test summary',
      ]),
      ...auditedBlock(runId, inputs, facts, requireBaseline(),
        rows([
          { id: 'R1', fields: [['Status', 'verified'], ['Changed Files', changedFields || '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Evidence', '`' + rel(runId, FIXTURE_EVIDENCE.green) + '`'], ['Audit Note', 'the GREEN record is the passing run of the added test']] },
          { id: 'R2', fields: [['Status', 'verified'], ['Changed Files', changedFields || '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Evidence', '`' + rel(runId, FIXTURE_EVIDENCE.tests) + '`'], ['Audit Note', 'the refusal assertion names the blocking artifact, which is the recorded outcome']] },
        ]),
        'PASS — the commands, their outcomes and the evidence paths all resolve, and every requirement has verification distinct from its implementation.'),
    ].join('\n') + note + '\n'
  }

  if (phase === '05-manual-qa.md') {
    return [
      ...header(runId, phase, '05 Manual QA', upstreams(runId, ['02-to-be-plan.md', '03-implementation-summary.md']),
        'Manual QA record for the run, executed by the agent and grounded in evidence under the run directory.'),
      ...todo([
        'Declare the QA execution mode',
        'Record each QA scenario and its observed result',
        'Cite the evidence paths',
        'Complete the Coverage and Approval gates',
      ]),
      ...qaEvidenceSections(runId),
      ...traceability(runId, [
        '- `R1` is exercised by QA scenario 1: the refusal names the blocking artifact.',
        '- `R2` is exercised by the same scenario: the refusal is the decision point.',
      ]),
      ...coverageGate([
        'The QA execution mode is declared and supported',
        'Every scenario records an observed result and an evidence path',
      ]),
      ...approvalGate([
        'The operator accepted the QA record',
      ]),
    ].join('\n') + note + '\n'
  }

  if (phase === '06-decisions-update.md') {
    const inputs = upstreams(runId, ['00-requirements.md', '00-worktree.md', '01-as-is.md', '01.5-root-cause.md', '02-to-be-plan.md', '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md', '05-manual-qa.md'])
    return [
      ...header(runId, phase, '06 Decisions Update', inputs,
        'Decision-ledger delta for the run: what was decided, why, and where the entry now lives.'),
      ...todo([
        'Record the decisions delta applied by this run',
        'Record the rationale for the decision',
        'Reference the resulting ledger entry',
      ]),
      '## Decisions Changes Applied',
      '',
      '- Added `D1` to `.recursive/DECISIONS.md`: a lock is refused while an earlier artifact in the phase sequence is still DRAFT.',
      '',
      '## Rationale',
      '',
      '- The baseline guard accepted an out-of-order lock, which is what `R1` and `R2` are about; the decision records the rule the repair enforces.',
      '',
      '## Resulting Decision Entry',
      '',
      '- `.recursive/DECISIONS.md` section `D1 — monotonic lock order is a prerequisite rule`.',
      '',
      ...traceability(runId, [
        '- `R1` is what the recorded decision makes true.',
        '- `R2` is the shape the refusal takes once the decision is enforced.',
      ]),
      ...coverageGate([
        'The decisions delta and its rationale are recorded',
        'The resulting ledger entry is named',
      ]),
      ...approvalGate([
        'The operator approved the decisions delta',
      ]),
      ...auditedBlock(runId, inputs, facts, requireBaseline(),
        rows([
          { id: 'R1', fields: [['Status', 'verified'], ['Changed Files', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Evidence', '`' + rel(runId, FIXTURE_EVIDENCE.green) + '`'], ['Audit Note', 'the decision records the rule the guard now enforces']] },
          { id: 'R2', fields: [['Status', 'verified'], ['Changed Files', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Evidence', '`' + rel(runId, FIXTURE_EVIDENCE.tests) + '`'], ['Audit Note', 'the decision names the refusal shape recorded in the test run']] },
        ]),
        'PASS — the decision is recorded where the ledger keeps it, and the entry it names exists in the run\'s control plane.'),
    ].join('\n') + note + '\n'
  }

  if (phase === '07-state-update.md') {
    const inputs = upstreams(runId, ['06-decisions-update.md'])
    return [
      ...header(runId, phase, '07 State Update', inputs,
        'State-ledger delta for the run: the repository state that now reflects the completed work.'),
      ...todo([
        'Record the state delta applied by this run',
        'Record the rationale for the state change',
        'Summarize the resulting state',
      ]),
      '## State Changes Applied',
      '',
      '- `.recursive/STATE.md` now records that the phase sequence is enforced by the guard rather than by convention alone.',
      '',
      '## Rationale',
      '',
      '- The state entry follows the decision recorded in `' + rel(runId, '06-decisions-update.md') + '`, so the ledger and the code agree.',
      '',
      '## Resulting State Summary',
      '',
      '- `' + FIXTURE_PRODUCT_FILE + '` refuses an out-of-order lock, and `' + FIXTURE_TEST_FILE + '` pins that refusal.',
      '',
      ...traceability(runId, [
        '- `R1` is reflected in the resulting state summary.',
        '- `R2` is reflected by the refusal the state summary names.',
      ]),
      ...priorEvidence(runId),
      ...coverageGate([
        'The state delta and its rationale are recorded',
        'The resulting state summary names the changed files',
      ]),
      ...approvalGate([
        'The operator approved the state delta',
      ]),
      ...auditedBlock(runId, inputs, facts, requireBaseline(),
        rows([
          { id: 'R1', fields: [['Status', 'verified'], ['Changed Files', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Evidence', '`' + rel(runId, FIXTURE_EVIDENCE.green) + '`'], ['Audit Note', 'the state summary names the file the diff changes']] },
          { id: 'R2', fields: [['Status', 'verified'], ['Changed Files', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Evidence', '`' + rel(runId, FIXTURE_EVIDENCE.tests) + '`'], ['Audit Note', 'the state summary names the refusal the test records']] },
        ]),
        'PASS — the state delta matches the decision it follows, and the summary names the diff that produced it.'),
    ].join('\n') + note + '\n'
  }

  // 08-memory-impact.md
  const inputs = upstreams(runId, ['00-requirements.md', '00-worktree.md', '01-as-is.md', '01.5-root-cause.md', '02-to-be-plan.md', '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md', '05-manual-qa.md', '06-decisions-update.md', '07-state-update.md'])
  const commit = requireBaseline()
  return [
    ...header(runId, phase, '08 Memory Impact', inputs,
      'Memory-plane impact of the run: which paths changed, which memory docs are affected, and what was promoted.'),
    ...todo([
      'Reconfirm the diff basis and review the changed paths',
      'Record the affected memory docs',
      'Record the skill usage and promotion review',
      'Record uncovered paths and the router refresh',
    ]),
    '## Diff Basis',
    '',
    '- Baseline type: `local commit`',
    '- Baseline reference: `' + commit + '`',
    '- Comparison reference: `working-tree`',
    '- Normalized baseline: `' + commit + '`',
    '- Normalized comparison: `working-tree`',
    '- Normalized diff command: `git diff --name-only ' + commit + '`',
    '',
    '## Changed Paths Review',
    '',
    ...(changed.length > 0 ? changed.map((path) => '- `' + path + '`: reviewed for memory impact; the guard it changes is already described by `' + rel(runId, '03-implementation-summary.md') + '`.') : ['- No path outside the run directory changed, so there is no memory impact to review.']),
    '',
    '## Affected Memory Docs',
    '',
    '- `.recursive/memory/MEMORY.md` — the router: reviewed, and no shard needed a change for this run.',
    '',
    '## Run-Local Skill Usage Capture',
    '',
    '- Skill Usage Relevance: not-relevant',
    '- Available Skills: none were mounted in this run environment',
    '- Skills Sought: none',
    '- Skills Attempted: none',
    '- Skills Used: none',
    '- Worked Well: the phase rules and the linter message were enough to author each artifact',
    '- Issues Encountered: none',
    '- Future Guidance: keep citing the linter as the standard rather than restating it',
    '- Promotion Candidates: none',
    '',
    '## Skill Memory Promotion Review',
    '',
    '- Durable Skill Lessons Promoted: none',
    '- Generalized Guidance Updated: none',
    '- Run-Local Observations Left Unpromoted: the run-local authoring notes above, kept out of the durable plane',
    '- Promotion Decision Rationale: skill usage was not relevant to this run, so there is nothing to promote and nothing was.',
    '',
    '## Uncovered Paths',
    '',
    '- None: every changed path is listed under Changed Paths Review and has a memory disposition.',
    '',
    '## Router and Parent Refresh',
    '',
    '- `.recursive/memory/MEMORY.md` was re-read and needs no entry for this run.',
    '',
    '## Final Status Summary',
    '',
    '- The run changed `' + (changed.join('`, `') || FIXTURE_PRODUCT_FILE) + '`; no memory shard became stale, and no durable skill lesson was earned.',
    '',
    ...traceability(runId, [
      '- `R1` is reflected in the memory review: the guard is the behaviour the memory plane would describe.',
      '- `R2` is reflected in the same review as the refusal shape.',
    ]),
    ...priorEvidence(runId),
    ...coverageGate([
      'The diff basis is reconfirmed and every changed path is reviewed',
      'Affected memory docs, uncovered paths and the router refresh are recorded',
    ]),
    ...approvalGate([
      'The operator approved the memory impact record',
    ]),
    ...auditedBlock(runId, inputs, facts, commit,
      rows([
        { id: 'R1', fields: [['Status', 'verified'], ['Changed Files', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Evidence', '`' + rel(runId, FIXTURE_EVIDENCE.green) + '`'], ['Audit Note', 'the memory review cites the same diff the earlier phases audited']] },
        { id: 'R2', fields: [['Status', 'verified'], ['Changed Files', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Implementation Evidence', '`' + FIXTURE_PRODUCT_FILE + '`'], ['Verification Evidence', '`' + rel(runId, FIXTURE_EVIDENCE.tests) + '`'], ['Audit Note', 'the memory review cites the refusal recorded by the test run']] },
      ]),
      'PASS — the run\'s diff is reviewed against the memory plane, the router is refreshed, and no path is left uncovered.'),
  ].join('\n') + note + '\n'
}

/**
 * The authored, lint-satisfying content of one phase artifact. Pure with respect to
 * the RUN (nothing under it is written), but it does read git for the changed files
 * a caller did not supply — because a diff audit that cites an invented list is
 * exactly the kind of fixture this repo has been burned by.
 */
export function compliantArtifact(phase: string, runId: string, options: CompliantOptions): string {
  if (!(COMPLIANT_PHASES as readonly string[]).includes(phase)) {
    throw new Error(
      'compliantArtifact does not author ' + phase + '; supported: ' + COMPLIANT_PHASES.join(', ')
      + '. Add authored content that satisfies src/ts-lint.ts rather than falling back to the scaffold generators.',
    )
  }
  const resolved: CompliantOptions = options.facts === undefined
    ? { ...options, facts: { changedFiles: runChangedFiles(options.repoRoot, runId, options.baselineCommit) } }
    : options
  return body(phase as CompliantPhase, runId, resolved)
}

/**
 * Write one compliant artifact into the run. Phases that record a diff basis
 * establish the git baseline first, so the recorded basis is executable.
 * Returns the absolute path written.
 */
export function writeCompliantArtifact(
  root: string,
  runId: string,
  phase: string,
  options: { note?: string } = {},
): string {
  const runDir = join(root, '.recursive', 'run', runId)
  mkdirSync(runDir, { recursive: true })
  const baselineCommit = needsDiffBasis(phase) ? ensureGitBaseline(root) : undefined
  const path = join(runDir, phase)
  writeFileSync(path, compliantArtifact(phase, runId, { repoRoot: root, baselineCommit, note: options.note }), 'utf8')
  return path
}

/**
 * Prepare a run so that LOCKING any of `phases` is possible: the memory plane
 * exists, every named phase holds authored content, and any diff-basis phase is
 * written LAST so the baseline commit it records already contains the rest.
 *
 * `00-worktree.md` IS ALWAYS REPLACED, whether or not the caller means to lock it,
 * because the scaffold's copy is a RUN-LEVEL obstacle rather than a phase-local
 * one: while it holds `<resolve-before-locking>` and `(resolve during Phase 0)`,
 * `lintRun` reports `Unable to verify git diff basis` and `HEAD is detached;
 * expected branch (resolve during Phase 0)` against the RUN, and `lintArtifact`
 * attributes both to whatever artifact was asked about. A run left holding it
 * therefore refuses EVERY lock — measured, see the spec's own note — so it is not
 * optional fixture dressing.
 */
export function writeCompliantRun(root: string, runId: string, phases: readonly string[]): void {
  ensureMemoryPlane(root)
  const authored = [...new Set([...phases, '00-worktree.md'])]
  const ordered = authored.sort((a, b) => Number(needsDiffBasis(a)) - Number(needsDiffBasis(b)))
  for (const phase of ordered) writeCompliantArtifact(root, runId, phase)
}
