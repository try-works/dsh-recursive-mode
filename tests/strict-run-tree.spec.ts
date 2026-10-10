/**
 * strict-run-tree.spec.ts — the regression spec for the two STRICT-ENFORCEMENT fixes
 * (the pair that made a live pass record 5 denials out of 5 while a model tried to
 * author its own phase artifacts), plus the `locked-write` RELATIVE-PATH gap that the
 * first of them exposed (see TEETH below).
 *
 * WHAT THIS PROVES, and through which entry point. Every verdict below comes from the
 * guard's real entry points — `resolveToolPolicyForGuard(worktreeRoot, runId)` for the
 * policy in force and `evaluateToolGuard(exec, worktreeRoot, activeRunId, 'strict')` for
 * the decision — plus one case driven through the mounted plugin's live
 * `tools/pre-execute` listener. No predicate is re-implemented here.
 *
 *   FIX 1 — `src/phase-rules.ts` `resolveFrom`: only `./` is a relative-path prefix.
 *     The regex used to be `/^\.?\/?/`, so `.recursive/run/<id>/01-as-is.md` lost its
 *     leading DOT and resolved to `<root>/recursive/run/<id>/01-as-is.md` — a sibling of
 *     `.recursive/`, i.e. OUTSIDE the run tree. Under a phase-8 baseline (writes outside
 *     the run tree are denied) a model could not write the very artifacts the workflow is
 *     about. Asserted here: the relative dotfile path resolves inside the run tree, and
 *     under strict enforcement a write to the run's OWN artifact is ALLOWED.
 *   FIX 2 — `src/enforcement.ts` `currentPhaseArtifact`: the phase in force is the
 *     LOWEST-numbered artifact that is NOT locked (falling back to the highest when all
 *     are locked), not the HIGHEST-numbered artifact present. `recursive_init` scaffolds
 *     ALL TWELVE artifacts, `08-memory-impact.md` included, so "highest present" made the
 *     phase-8 documentation baseline govern from turn 0 and denied phase-3 source edits.
 *     Asserted here: a scaffold-only run is at phase 0, and the phase in force ADVANCES as
 *     phases lock, with the guard's verdict following it.
 *   TEETH — the fixes did not disarm the guard: a write OUTSIDE the run tree is still
 *     DENIED while the phase-8 baseline is in force, and a write to a LOCKED artifact is
 *     still denied — named ABSOLUTELY and named REPO-RELATIVELY. The relative form used to
 *     slip past the `locked-write` rule, which admitted a target only when the string it was
 *     handed contained `/.recursive/run/`; a repo-relative path has no separator before
 *     `.recursive`, so the rule ABSTAINED, and the phase-8 baseline then saw a write INSIDE
 *     the run tree, which it allows by design. `src/policy-globs.ts` `lockedWriteRule` now
 *     matches the RESOLVED path as well, so both spellings of one file get one verdict.
 *   (d) PHASE ORDER ON WRITES — the hole found by a LIVE run rather than by this spec: a real
 *     run (`.recursive/run/02-scientific-calculator`) produced twelve artifacts ALL still
 *     `Status: DRAFT`, written out of order (08 at 05:55, 01.5 at 05:57), with a single line in
 *     `operations/operations.jsonl` and no lock operation ever recorded. The monotonic rule
 *     existed — on `recursive_lock` ONLY — so nothing bound the model's ordinary `write`. The
 *     rule those assertions pin: ORDERING IS ENFORCED ON WRITES. A write to the ACTIVE phase's
 *     artifact (the lowest-numbered artifact that is not LOCKED, from `currentPhaseArtifact`)
 *     is ALLOWED at every phase; a write to a LATER phase's artifact is REFUSED; a LOCKED one
 *     stays refused; run support files are not phases and stay allowed. ⚠ The ALLOW half is the
 *     half that has already been broken once in this area (strict enforcement once denied the
 *     run's OWN artifacts in every phase, making the workflow unusable), which is why (d)
 *     WALKS EVERY PHASE instead of asserting one case, and why the two artifacts that share a
 *     phase number (00/00, 01/01.5) are asserted explicitly.
 *
 * WHAT THIS DOES **NOT** PROVE — read this before trusting a green run:
 *   - IT IS NOT A LIVE SESSION. There is no model, no host and no turn loop here: the
 *     "live path" case mounts the plugin over a temporary repo and executes a tool call
 *     in-process. A live pass is what FOUND the bugs; this spec is only what keeps them
 *     from coming back unnoticed.
 *   - Locks are MATERIALISED as content, not produced by `recursive_lock`. The fields and
 *     the digest are the ones `lockArtifact` writes (Status -> LockedAt -> a provisional
 *     64-zero LockHash -> the real `lockHashFromContent` digest), and every lock is
 *     verified with `getLockStatus` before it is asserted on, because a hand-written hash
 *     resolves to STALE_LOCK and is correctly treated as UNLOCKED. (The three lines are
 *     PREPENDED here rather than substituted in place as the tool does; `getLockStatus`
 *     reads the first Status/LockedAt/LockHash match, so either form is a valid lock.)
 *     Not exercised: lock receipts, the quiescence check, the pre-step gate, `foldRun`.
 *   - `recursive_init` itself is not run: the twelve artifacts are written from the shipped
 *     templates (`requirementsContent`, `laterPhaseContent`) so the run tree has the shape
 *     a real scaffold produces. The claim under test is about the GUARD reading that tree.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  coerceAskToDecision, currentPhaseArtifact, evaluateToolGuard, resolveToolPolicyForGuard, type ToolGuardDecision,
} from '../src/enforcement.ts'
import { phaseNumberForArtifact, resolveFrom, withPhaseBaseline } from '../src/phase-rules.ts'
import { evaluateToolPolicy, loadToolPolicyFile, toolPolicyPath } from '../src/policy-globs.ts'
import { PHASE_SEQUENCE, getLockStatus, lockHashFromContent } from '../src/lock.ts'
import { resolveRunDir } from '../src/run.ts'
import { readGuardDecisions } from '../src/guard-log.ts'
import { laterPhaseContent, requirementsContent } from '../src/init-templates.ts'
import * as plugin from '../src/index.ts'

const signal = new AbortController().signal
const RUN_ID = 'strict-run'

/** The phase artifact this spec is about — scaffolded by `recursive_init` from turn 0. */
const PHASE_EIGHT = '08-memory-impact.md'

/**
 * The two artifacts that share phase number 0, so the phase-0 answer is a member of this
 * SET rather than one name: `readdirSync` order decides which of the two is reported, and
 * asserting one of them exactly would make this spec pass or fail on filesystem ordering.
 */
const PHASE_ZERO = ['00-requirements.md', '00-worktree.md']

/** The two artifacts that share phase number 1 (`01.5` is phase `1`, not phase `1.5`). */
const PHASE_ONE = ['01-as-is.md', '01.5-root-cause.md']

/** Temp repos made by this spec, removed after each test. */
const tempRoots: string[] = []
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Run {
  root: string
  runDir: string
  runId: string
}

/**
 * A run tree with ALL TWELVE artifacts on disk, as `recursive_init` scaffolds them:
 * `00-requirements.md` from `requirementsContent`, every other phase from
 * `laterPhaseContent`, all of them DRAFT.
 */
function scaffoldRun(): Run {
  const root = mkdtempSync(join(tmpdir(), 'rm-strict-run-tree-'))
  tempRoots.push(root)
  const runDir = join(root, '.recursive', 'run', RUN_ID)
  mkdirSync(runDir, { recursive: true })
  for (const name of PHASE_SEQUENCE) {
    const content = name === '00-requirements.md' ? requirementsContent(RUN_ID) : laterPhaseContent(RUN_ID, name)
    writeFileSync(join(runDir, name), content, 'utf8')
  }
  return { root, runDir, runId: RUN_ID }
}

/**
 * Materialise a REAL lock — the content sequence `lockArtifact` performs
 * (`src/runtime.ts`: Status -> LockedAt -> provisional LockHash -> real LockHash),
 * then VERIFY it with `getLockStatus` before anything is asserted on top of it.
 * The verification is not decoration: `getLockStatus` re-derives the hash from the
 * content, so a hand-written digest resolves to STALE_LOCK and is correctly treated
 * as UNLOCKED — which would silently leave the phase in force unmoved.
 */
function lockOnDisk(run: Run, name: string): string {
  const path = join(run.runDir, name)
  const body = readFileSync(path, 'utf8')
  const header =
    'Status: LOCKED\n' +
    'LockedAt: ' + new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n' +
    'LockHash: ' + '0'.repeat(64) + '\n'
  const hash = lockHashFromContent(header + body)
  writeFileSync(path, header.replace('0'.repeat(64), hash) + body, 'utf8')
  expect(getLockStatus(path), 'precondition: ' + name + ' must be lock-valid before this spec asserts on it').toBe('LOCKED')
  return hash
}

/**
 * A run sitting at phase 8 by the ORDINARY route: `00`-`07` locked, and
 * `08-memory-impact.md` still DRAFT — so the phase-8 documentation baseline is in
 * force because phase 8 is the lowest UNLOCKED artifact, not because everything is
 * locked and the highest-numbered one had to be used as a fallback.
 */
function phaseEightRun(): Run {
  const run = scaffoldRun()
  for (const name of PHASE_SEQUENCE) {
    if (name === PHASE_EIGHT) continue
    lockOnDisk(run, name)
  }
  expect(currentPhaseArtifact(run.root, run.runId), 'precondition: the phase-8 baseline is in force').toBe(PHASE_EIGHT)
  return run
}

/** The path form a model actually writes: a repo-relative dotfile path (POSIX separators). */
function relativeArtifact(run: Run, name: string): string {
  return '.recursive/run/' + run.runId + '/' + name
}

/** The guard's verdict for one `write` call, under STRICT enforcement. */
function writeGuard(run: Run, target: string): ToolGuardDecision {
  return evaluateToolGuard({ name: 'write', arguments: { file_path: target, content: 'x' } }, run.root, run.runId, 'strict')
}

/** The phase artifact currently in force, through the guard's own reader. */
function inForce(run: Run): string {
  return currentPhaseArtifact(run.root, run.runId)
}

/** A refusal's reason, or a legible non-refusal so a failure names what it got. */
function reasonOf(decision: ToolGuardDecision): string {
  return decision.kind === 'deny' ? decision.reason : 'NOT DENIED (kind: ' + decision.kind + ')'
}

/** The absolute path a target names, per the rules module the guard itself resolves with. */
function absTarget(run: Run, target: string): string {
  const abs = resolveFrom(run.root, target)
  if (abs === null) throw new Error('target is not a path at all: ' + target)
  return abs
}

describe('FIX 1 — resolveFrom keeps a leading dot: the dotfile name IS the path', () => {
  it('resolves a relative dotfile path INSIDE the run tree it spells', () => {
    const run = scaffoldRun()
    const relative = relativeArtifact(run, '01-as-is.md')
    expect(resolveFrom(run.root, relative)).toBe(join(run.root, '.recursive', 'run', RUN_ID, '01-as-is.md'))
    // The pre-fix result, named explicitly so the regression cannot return quietly:
    // `/^\.?\/?/` produced this path, a SIBLING of `.recursive/`.
    expect(resolveFrom(run.root, relative)).not.toBe(join(run.root, 'recursive', 'run', RUN_ID, '01-as-is.md'))
  })

  it('strips `./`, and only `./`, before resolving', () => {
    const run = scaffoldRun()
    const relative = relativeArtifact(run, '01-as-is.md')
    expect(resolveFrom(run.root, './' + relative)).toBe(resolveFrom(run.root, relative))
    // A dot that is not followed by a slash belongs to the name: `.recursive` != `recursive`.
    expect(resolveFrom(run.root, '.recursive')).toBe(join(run.root, '.recursive'))
    // An ordinary relative path is unaffected by either rule.
    expect(resolveFrom(run.root, 'src/something.ts')).toBe(join(run.root, 'src', 'something.ts'))
  })

  it('the PRE-FIX transform resolved outside the run tree, which is why this fix matters', () => {
    const run = scaffoldRun()
    const relative = relativeArtifact(run, '01-as-is.md')
    // The old replacement, applied here so the regression it caused is stated in the
    // spec rather than only in a comment: `/^\.?\/?/` took the DOT off the name.
    const preFixRelative = relative.replace(/^\.?\/?/, '')
    expect(preFixRelative).toBe('recursive/run/' + RUN_ID + '/01-as-is.md')
    const preFixAbs = join(run.root, ...preFixRelative.split('/'))
    expect(preFixAbs).not.toBe(resolveFrom(run.root, relative))
    expect(preFixAbs.startsWith(run.runDir)).toBe(false)
  })
})

describe('FIX 2 — the phase in force is the lowest UNLOCKED artifact, not the highest present', () => {
  it('a scaffold-only run (all twelve present, none locked) is at phase 0', () => {
    const run = scaffoldRun()
    expect(PHASE_SEQUENCE.filter((name) => existsSync(join(run.runDir, name)))).toHaveLength(12)
    // `recursive_init` scaffolded 08-memory-impact.md too — which is exactly why
    // "highest present" was the wrong answer, and why this assertion is the regression.
    expect(existsSync(join(run.runDir, PHASE_EIGHT))).toBe(true)
    expect(PHASE_ZERO).toContain(inForce(run))
  })

  it('applies NO phase baseline at phase 0, so an ordinary source write is allowed', () => {
    const run = scaffoldRun()
    // The phase-8 baseline rule is `write*` -> deny. At phase 0 it must not be in the
    // policy at all: before the fix, `currentPhaseArtifact` returned the phase-8
    // artifact here and this rule denied every source write from turn 0.
    expect(resolveToolPolicyForGuard(run.root, run.runId).rules.filter((rule) => rule.pattern === 'write*')).toHaveLength(0)
    expect(writeGuard(run, 'src/something.ts').kind).toBe('allow')
  })

  it('once every artifact is locked, the highest one governs again (the documented fallback)', () => {
    const run = scaffoldRun()
    for (const name of PHASE_SEQUENCE) lockOnDisk(run, name)
    expect(inForce(run)).toBe(PHASE_EIGHT)
  })

  it('the artifact it picks is DECISIVE: phase 0 allows the call phase 8 denies', () => {
    const run = scaffoldRun()
    const args = { file_path: 'src/something.ts', content: 'x' }
    const context = { args, runDir: run.runDir, runId: run.runId, worktreeRoot: run.root }
    const loaded = loadToolPolicyFile(run.root)
    // Counterfactual, in-file and without editing the source: the SAME policy with each
    // candidate answer applied by hand. This is what makes the allow below meaningful —
    // a regression to "highest present" would land on the second verdict.
    const atPhaseZero = evaluateToolPolicy(withPhaseBaseline(loaded.policy, '00-requirements.md'), 'write', args, context)
    const atPhaseEight = evaluateToolPolicy(withPhaseBaseline(loaded.policy, PHASE_EIGHT), 'write', args, context)
    expect(atPhaseZero.kind).toBe('allow')
    expect(atPhaseEight.kind).toBe('deny')
    // The run on disk is at phase 0, so the guard must produce the FIRST of those.
    expect(inForce(run)).toMatch(/^00-/)
    expect(writeGuard(run, 'src/something.ts').kind).toBe('allow')
  })
})

describe('(a) with the phase-8 baseline in force, writing INSIDE the run tree is ALLOWED', () => {
  it("allows the run's own unlocked artifact named by its RELATIVE dotfile path", () => {
    const run = phaseEightRun()
    const decision = writeGuard(run, relativeArtifact(run, PHASE_EIGHT))
    expect(decision.kind, 'a run must be able to author its own phase artifact: ' + reasonOf(decision)).toBe('allow')
  })

  it('allows the same target named absolutely — the two forms must agree', () => {
    const run = phaseEightRun()
    expect(absTarget(run, relativeArtifact(run, PHASE_EIGHT))).toBe(join(run.runDir, PHASE_EIGHT))
    expect(writeGuard(run, join(run.runDir, PHASE_EIGHT)).kind).toBe('allow')
  })

  it('is an allow THROUGH the phase-8 rules, not an allow because they are absent', () => {
    const run = phaseEightRun()
    const policy = resolveToolPolicyForGuard(run.root, run.runId)
    const baseline = policy.rules.find((rule) => rule.pattern === 'write*' && rule.reason.includes('documentation phase'))
    // Without this, "allow" could mean the baseline never applied at all — the very
    // failure mode FIX 2 is about, only in the opposite direction.
    expect(baseline).toBeDefined()
    expect(baseline!.verdict).toBe('deny')
    expect(typeof baseline!.predicate).toBe('function')
  })
})

describe('(b) writing OUTSIDE the run tree is still DENIED — the guard keeps its teeth', () => {
  it('denies a source write, named relatively and absolutely, naming the documentation phase', () => {
    const run = phaseEightRun()
    const targets = ['src/something.ts', join(run.root, 'src', 'something.ts'), join(run.root, 'README.md')]
    for (const target of targets) {
      const decision = writeGuard(run, target)
      expect(decision.kind, 'target ' + target + ' must be denied').toBe('deny')
      expect(reasonOf(decision), 'target ' + target).toContain('documentation phase')
      expect(reasonOf(decision), 'target ' + target).toContain('outside the run tree')
      // ⚠ OBSERVED, deliberately not asserted: this refusal carries `rule: 'none'`, because
      // `phaseBaselineRules` gives its rules no `label` — so a phase-baseline denial is the
      // one refusal the guard-decision log cannot attribute to a named rule (`GuardRule`
      // has no member for it). Asserting `'none'` here would enshrine that blind spot.
    }
  })

  it('denies a write to a LOCKED artifact, named absolutely AND repo-relatively', () => {
    const run = phaseEightRun()
    const absolute = writeGuard(run, join(run.runDir, '00-requirements.md'))
    expect(absolute.kind).toBe('deny')
    expect(reasonOf(absolute)).toContain('locked-artifact write denial')
    expect(absolute.rule).toBe('locked-write')

    // THE SAME FILE, SPELLED THE WAY A MODEL SPELLS IT — and the spelling this spec exists to
    // protect. This used to be `{ kind: 'allow', rule: 'none' }`: `lockedWriteRule` admitted a
    // target only when the string carried `/.recursive/run/`, a repo-relative path has no
    // separator before `.recursive`, so the rule abstained, the phase-8 baseline then saw a
    // write INSIDE the run tree (allowed by design) and the catch-all allowed it. The RULE
    // LABEL is asserted, not only the verdict: a denial produced by the phase baseline for
    // some other reason would not prove the locked-artifact rule fired.
    const relative = writeGuard(run, relativeArtifact(run, '00-requirements.md'))
    expect(relative.kind).toBe('deny')
    expect(reasonOf(relative)).toContain('locked-artifact write denial')
    expect(relative.rule).toBe('locked-write')
  })

  it('leaves non-write tools alone: the narrowing is scoped to the write-tool family', () => {
    const run = phaseEightRun()
    const decision = evaluateToolGuard({ name: 'recursive_status', arguments: { runId: RUN_ID } }, run.root, run.runId, 'strict')
    expect(decision.kind).toBe('allow')
  })
})

describe('(c) the phase in force ADVANCES as phases lock, and the guard verdict follows it', () => {
  it('walks the lock chain from phase 0 to phase 8', () => {
    const run = scaffoldRun()

    // Phase 0 — nothing locked, so nothing narrows the policy.
    expect(PHASE_ZERO).toContain(inForce(run))
    expect(writeGuard(run, 'src/something.ts').kind, 'phase 0 must not deny a source write').toBe('allow')

    // Locking both `00` artifacts moves the run to phase 1, and the phase-1 baseline
    // (no memory-plane writes yet) becomes the guard's verdict — proof the move is real
    // and not a rename.
    lockOnDisk(run, '00-requirements.md')
    lockOnDisk(run, '00-worktree.md')
    expect(PHASE_ONE).toContain(inForce(run))
    expect(writeGuard(run, 'src/something.ts').kind, 'phase 1 allows a source write').toBe('allow')
    const memoryPlane = writeGuard(run, '.recursive/memory/harness.md')
    expect(memoryPlane.kind).toBe('deny')
    expect(reasonOf(memoryPlane)).toContain('phase 1 writes no memory plane')

    // `01-as-is.md` and `01.5-root-cause.md` are both phase 1, so the phase only moves
    // once the pair is locked.
    lockOnDisk(run, '01-as-is.md')
    expect(inForce(run)).toBe('01.5-root-cause.md')
    lockOnDisk(run, '01.5-root-cause.md')
    lockOnDisk(run, '02-to-be-plan.md')
    expect(inForce(run)).toBe('03-implementation-summary.md')
    expect(writeGuard(run, 'src/something.ts').kind, 'phase 3 is the implementation phase').toBe('allow')

    // Lock phases 3 through 7 and the documentation baseline takes over — this is the
    // exact state in which the live pass had its source edits denied at phase 3.
    for (const name of [
      '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md',
      '05-manual-qa.md', '06-decisions-update.md', '07-state-update.md',
    ]) lockOnDisk(run, name)
    expect(inForce(run)).toBe(PHASE_EIGHT)
    const outside = writeGuard(run, 'src/something.ts')
    expect(outside.kind).toBe('deny')
    expect(reasonOf(outside)).toContain('documentation phase')
    // …and the artifact this phase is ABOUT writing stays writable.
    expect(writeGuard(run, relativeArtifact(run, PHASE_EIGHT)).kind).toBe('allow')

    // The last lock completes the run: the all-locked fallback governs, and the artifact
    // is now closed to writes like every other locked one.
    lockOnDisk(run, PHASE_EIGHT)
    expect(inForce(run)).toBe(PHASE_EIGHT)
    const afterLock = writeGuard(run, join(run.runDir, PHASE_EIGHT))
    expect(afterLock.kind).toBe('deny')
    expect(reasonOf(afterLock)).toContain('locked-artifact write denial')
  })
})

describe('(d) PHASE ORDER IS ENFORCED ON WRITES: only the ACTIVE phase may be written', () => {
  /**
   * The phase an artifact belongs to, through the module's own mapper — so `01.5-root-cause.md`
   * is phase **1**, not 1.5, and `00-requirements.md`/`00-worktree.md` are both phase 0. Using
   * the production mapper rather than a second reading of the name is the point: a rule that
   * parsed `01.5` as a fractional phase would refuse the second half of phase 1, and this
   * helper would not be able to tell the story the assertions below tell.
   */
  function phaseOf(name: string): number {
    const phase = phaseNumberForArtifact(name)
    if (phase === '') throw new Error('not a phase artifact: ' + name)
    return Number(phase)
  }

  /** The guard's verdict for one `write` call under ADVISORY enforcement. */
  function advisoryGuard(run: Run, target: string): ToolGuardDecision {
    return evaluateToolGuard({ name: 'write', arguments: { file_path: target, content: 'x' } }, run.root, run.runId, 'advisory')
  }

  /**
   * Files a run legitimately writes that are NOT phases: the scaffolded support dirs
   * (`RUN_SCAFFOLD_DIRS` plus `scratch/`, `operations/` and `locks/`) and a plain note that is
   * a DIRECT child of the run dir. `evidence/01-as-is.md` is in the list on purpose — its NAME
   * carries a phase number while its directory says it is evidence, which is exactly the
   * confusion a name-only rule would fall into.
   */
  const SUPPORT_FILES = [
    'evidence/01-as-is.md',
    'evidence/logs/T01-run.txt',
    'evidence/review-bundles/bundle.md',
    'scratch/scratch.md',
    'scratch/child-1.md',
    'addenda/r1.addendum-01.md',
    'subagents/child-1/03-brief.md',
    'router-prompts/implementer.md',
    'operations/operations.jsonl',
    'locks/00-requirements.receipt.json',
    'notes.md',
  ]

  it('walks EVERY phase: the active artifact stays writable, every later one is refused', () => {
    const run = scaffoldRun()
    // The walk visits all twelve artifacts, so it covers every phase the sequence has —
    // including the two phases that own TWO artifacts each. One case would not do: the
    // false-positive class this must not reintroduce (a rule that denies the run's own
    // artifacts) is invisible in a single-phase check.
    const walked: string[] = []

    for (const name of PHASE_SEQUENCE) {
      const active = inForce(run)
      // PRECONDITIONS, asserted rather than assumed, so no assertion below can pass
      // because the fixture was not in the state the case claims.
      expect(active, 'with ' + name + ' still unlocked the run must have an active phase').not.toBe('')
      expect(getLockStatus(join(run.runDir, active)), 'the active artifact is the lowest UNLOCKED one').not.toBe('LOCKED')
      const activePhase = phaseOf(active)
      walked.push(active)

      for (const other of PHASE_SEQUENCE) {
        const decision = writeGuard(run, relativeArtifact(run, other))
        const otherPhase = phaseOf(other)
        if (otherPhase > activePhase) {
          // WORKING AHEAD — the defect a live run measured. The RULE LABEL is asserted, not
          // only the verdict: a refusal produced for some other reason would not prove the
          // phase-order rule fired.
          expect(decision.kind, other + ' is phase ' + otherPhase + ' while the active phase is ' + active + ' (phase ' + activePhase + ')').toBe('deny')
          expect(reasonOf(decision), other).toContain('phase order')
          expect(decision.rule, other).toBe('phase-order')
        } else if (otherPhase === activePhase && getLockStatus(join(run.runDir, other)) !== 'LOCKED') {
          // ⚠ THE FALSE POSITIVE THIS MUST NEVER REINTRODUCE. An artifact sharing the active
          // phase's NUMBER is part of the phase being worked on, so it is writable: the run
          // authors `00-requirements.md` and `00-worktree.md` together, and `01-as-is.md` and
          // `01.5-root-cause.md` together.
          expect(decision.kind, other + ' shares the active phase ' + activePhase + ' (' + active + ') and must stay writable').toBe('allow')
        } else {
          // An artifact of THIS phase that is already LOCKED, or one of an EARLIER phase —
          // which the active-phase selector guarantees is locked. The pre-existing refusal
          // must still be the one that fires, so its label is asserted here too: the new
          // rule may not steal a refusal the locked-artifact rule owns.
          expect(decision.kind, other + ' is LOCKED and must stay refused').toBe('deny')
          expect(reasonOf(decision), other).toContain('locked-artifact write denial')
          expect(decision.rule, other).toBe('locked-write')
        }
      }

      // ADVANCE by the run's own route: lock the artifact of this phase. (For the two-artifact
      // phases the walk locks them one at a time, which is how the phase is left.)
      lockOnDisk(run, name)
    }

    // The walk really walked every phase and ended where a completed run ends.
    expect(walked).toHaveLength(PHASE_SEQUENCE.length)
    expect(inForce(run)).toBe(PHASE_EIGHT)
  })

  it('treats the artifacts that SHARE a phase number as one phase', () => {
    const run = scaffoldRun()
    const active = inForce(run)
    expect(PHASE_ZERO, 'the run starts in phase 0').toContain(active)
    // Phase 0 is two artifacts; both must be writable whichever one the selector reports.
    for (const name of PHASE_ZERO) {
      expect(writeGuard(run, relativeArtifact(run, name)).kind, name + ' is phase 0').toBe('allow')
    }
    // Phase 1 is two artifacts too, and `01.5` is phase 1 — not phase 1.5. A rule that read the
    // name as a decimal would refuse `01.5-root-cause.md` while the run sits at phase 1, which
    // is the second half of the phase it is in.
    lockOnDisk(run, '00-requirements.md')
    lockOnDisk(run, '00-worktree.md')
    expect(PHASE_ONE).toContain(inForce(run))
    for (const name of PHASE_ONE) {
      expect(writeGuard(run, relativeArtifact(run, name)).kind, name + ' is phase 1').toBe('allow')
    }
    // …and the FIRST later phase is refused in the same state, so the allows above are not a
    // blanket allow of everything in the run tree.
    const later = writeGuard(run, relativeArtifact(run, '02-to-be-plan.md'))
    expect(later.kind).toBe('deny')
    expect(later.rule).toBe('phase-order')
  })

  it('leaves the run\'s SUPPORT files writable — they are not phases', () => {
    // At phase 0, where the biggest number of LATER phases exists and the rule has the most
    // to refuse, and again at phase 8, where the documentation baseline is the narrowing in
    // force. Both states must leave every support file alone.
    for (const run of [scaffoldRun(), phaseEightRun()]) {
      for (const target of SUPPORT_FILES) {
        const decision = writeGuard(run, relativeArtifact(run, target))
        expect(decision.kind, target + ' is not a phase artifact and must stay writable: ' + reasonOf(decision)).toBe('allow')
      }
    }
  })

  it('ADVISORY warns and allows where STRICT refuses — the same call, both modes', () => {
    const run = scaffoldRun()
    const target = relativeArtifact(run, PHASE_EIGHT)

    const strict = writeGuard(run, target)
    expect(strict.kind, 'strict BLOCKS a write ahead of the active phase').toBe('deny')
    expect(strict.rule).toBe('phase-order')

    // The documented contract, unchanged by this rule: a policy `deny` becomes `ask` under
    // advisory (`verdictFor`), and the live path coerces the ask to an ALLOW that carries a
    // WARN (`coerceAskToDecision`) — never a silent allow, and never a block.
    const advisory = advisoryGuard(run, target)
    expect(advisory.kind, 'advisory does not block; it asks').toBe('ask')
    expect(advisory.rule).toBe('phase-order')
    expect((advisory as { reason?: string }).reason ?? '').toContain('phase order')

    const coercedAdvisory = coerceAskToDecision(advisory, 'advisory')
    expect(coercedAdvisory.kind).toBe('allow')
    expect((coercedAdvisory as { warn?: string }).warn ?? '').toContain('phase order')

    // The same ask under strict is a refusal, so the mode really is the difference.
    expect(coerceAskToDecision(advisory, 'strict').kind).toBe('deny')

    // The ACTIVE artifact is allowed in BOTH modes — the rule cannot make a run unwritable.
    const active = inForce(run)
    expect(writeGuard(run, relativeArtifact(run, active)).kind).toBe('allow')
    expect(advisoryGuard(run, relativeArtifact(run, active)).kind).toBe('allow')
  })

  it('the refusal comes from the rule READING THE RUN, not from a blanket denial', () => {
    const run = scaffoldRun()
    const target = relativeArtifact(run, PHASE_EIGHT)
    const args = { file_path: target, content: 'x' }
    const loaded = loadToolPolicyFile(run.root)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    // The counterfactual, in-file and without editing the source: the SAME policy with and
    // without the active phase in the context. The rule compares against the value the guard's
    // own selector produced, so a guard call that forgot to carry it would land on the SECOND
    // verdict — which is how the deny below proves `evaluateToolGuard` populates the field.
    // (At phase 0 no phase baseline is added — `phaseBaselineRules('00-…')` is empty — so the
    // loaded policy IS the policy the guard is evaluating here.)
    const withActive = evaluateToolPolicy(loaded.policy, 'write', args, {
      args, runDir: run.runDir, runId: run.runId, worktreeRoot: run.root, activePhaseArtifact: inForce(run),
    })
    const withoutActive = evaluateToolPolicy(loaded.policy, 'write', args, {
      args, runDir: run.runDir, runId: run.runId, worktreeRoot: run.root,
    })
    expect(withActive.kind).toBe('deny')
    expect(withActive.rule).toBe('phase-order')
    // ⚠ STATED PLAINLY, because it is the rule's one deliberate abstention: with no active
    // phase to compare against, the rule does NOT guess — it abstains and the catch-all allow
    // stands. That keeps a caller with no run context (and every pre-existing pure policy
    // test) behaving exactly as before.
    expect(withoutActive.kind, 'no active phase in the context -> the rule abstains').toBe('allow')
    // And the guard's own call is the FIRST of those two.
    expect(writeGuard(run, target).kind).toBe('deny')
  })

  it('enforces the same rule when the SHIPPED POLICY FILE is the one in force', () => {
    // The mirror case in `policy-globs.spec.ts` proves the FILE and the built-in LIST declare
    // the same patterns and verdicts. What that cannot prove is that the loader attaches the
    // PHASE-ORDER CONDITION to the file's rule: two rules share every write-tool pattern, and
    // a pattern-only selection would give both of them the locked-artifact condition — the
    // shipped-file path (i.e. this repo's own runs) would then never enforce phase order.
    const run = scaffoldRun()
    const source = join(import.meta.dirname, '..', '.recursive', 'config', 'recursive-permissions.json')
    const dest = toolPolicyPath(run.root)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(source, 'utf8'), 'utf8')

    const loaded = loadToolPolicyFile(run.root)
    expect(loaded.source, 'the file, not the built-in fallback').toBe('file')
    expect(loaded.ok).toBe(true)
    const policy = resolveToolPolicyForGuard(run.root, run.runId)
    expect(policy.rules.filter((rule) => rule.label === 'phase-order')).toHaveLength(8)
    for (const rule of policy.rules.filter((r) => r.label === 'phase-order')) {
      expect(typeof rule.predicate, 'a phase-order rule must carry a condition, not a bare verdict').toBe('function')
    }

    const later = writeGuard(run, relativeArtifact(run, PHASE_EIGHT))
    expect(later.kind).toBe('deny')
    expect(later.rule).toBe('phase-order')
    expect(reasonOf(later)).toContain('phase order')
    // CONTROL — the active artifact is allowed through the SAME file policy, so the deny above
    // is conditional on the phase and not a denial of everything the file's rules match.
    expect(writeGuard(run, relativeArtifact(run, inForce(run))).kind).toBe('allow')
    // …and the locked-artifact rule still owns its own refusal under this policy: a locked
    // artifact is denied by `locked-write`, whichever write rule the loader attached where.
    lockOnDisk(run, '00-requirements.md')
    lockOnDisk(run, '00-worktree.md')
    const lockedEarlier = writeGuard(run, relativeArtifact(run, '00-requirements.md'))
    expect(lockedEarlier.kind).toBe('deny')
    expect(lockedEarlier.rule).toBe('locked-write')
  })
})

describe('live path — the same two verdicts through the mounted plugin', () => {
  /** A stub standing in for the host's fs write tool, as guard-path.spec.ts uses. */
  function stubWriteTool() {
    return defineTool({
      name: 'write',
      description: 'test stub standing in for the host fs write tool',
      parameters: { file_path: { type: 'string' }, content: { type: 'string' } },
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() {
        return { wrote: true } as never
      },
    })
  }

  it('lets a strict guard write to the run tree and refuses a source write for the same run', async () => {
    const run = phaseEightRun()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { repoRoot: run.root })
    try {
      ctx.tools.register(stubWriteTool())
      ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const actor = { agent: { session: { header: { cwd: run.root } } } }

      // Inside the run tree, named the way a model names it: the write must REACH the tool.
      const allowed = await ctx.tools.execute({
        signal,
        callId: ToolCallId('strict-1'),
        name: 'write',
        arguments: { file_path: relativeArtifact(run, PHASE_EIGHT), content: 'x' },
        ...actor,
      } as never)
      expect(allowed.isError).toBe(false)
      expect((allowed.value as { wrote?: boolean }).wrote).toBe(true)

      // Outside the run tree the SAME listener refuses — which also proves the live path
      // resolved the active run and its phase, rather than guarding against nothing.
      const denied = await ctx.tools.execute({
        signal,
        callId: ToolCallId('strict-2'),
        name: 'write',
        arguments: { file_path: 'src/something.ts', content: 'x' },
        ...actor,
      } as never)
      expect(denied.isError).toBe(true)
      expect((denied as { error?: { message?: string } }).error?.message ?? '').toContain('documentation phase')

      // …and a LOCKED artifact in the RELATIVE form is refused by this SAME listener: the gap
      // was measured on the pure guard, and this is the call a live session actually makes.
      const locked = await ctx.tools.execute({
        signal,
        callId: ToolCallId('strict-3'),
        name: 'write',
        arguments: { file_path: relativeArtifact(run, '00-requirements.md'), content: 'x' },
        ...actor,
      } as never)
      expect(locked.isError).toBe(true)
      expect((locked as { error?: { message?: string } }).error?.message ?? '').toContain('locked-artifact write denial')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a LATER phase artifact through the listener, and lets the active one through', async () => {
    // A scaffold-only run: all twelve artifacts on disk, none locked, so the active phase is 0
    // and everything after `00-…` is a later phase. This is the state the live run was in.
    const run = scaffoldRun()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { repoRoot: run.root })
    try {
      ctx.tools.register(stubWriteTool())
      ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const actor = { agent: { session: { header: { cwd: run.root } } } }
      const active = currentPhaseArtifact(run.root, run.runId)
      expect(PHASE_ZERO, 'precondition: the run really is at phase 0').toContain(active)

      // The ACTIVE artifact reaches the tool — the rule may not make a run unwritable.
      const allowed = await ctx.tools.execute({
        signal,
        callId: ToolCallId('phase-order-1'),
        name: 'write',
        arguments: { file_path: relativeArtifact(run, active), content: 'x' },
        ...actor,
      } as never)
      expect(allowed.isError).toBe(false)
      expect((allowed.value as { wrote?: boolean }).wrote).toBe(true)

      // The LAST phase's artifact does not: refused BEFORE dispatch, with the guard's wording.
      const ahead = await ctx.tools.execute({
        signal,
        callId: ToolCallId('phase-order-2'),
        name: 'write',
        arguments: { file_path: relativeArtifact(run, PHASE_EIGHT), content: 'x' },
        ...actor,
      } as never)
      expect(ahead.isError).toBe(true)
      const message = (ahead as { error?: { message?: string } }).error?.message ?? ''
      expect(message).toContain('phase order')
      expect(message).toContain('ACTIVE phase')

      // …and the decision was logged with its rule, so the trace says which ordering rule fired.
      const logged = readGuardDecisions(run.root, 10).filter((record) => record.tool === 'write')
      expect(logged.some((record) => record.kind === 'deny' && record.rule === 'phase-order')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/**
 * ISSUE 2 — THE GUARD JUDGED THE WRONG RUN.
 *
 * MEASURED before this fix, with two runs on disk: run-b had `00-requirements.md` LOCKED and `01-as-is.md`
 * DRAFT, so locking it in run-b was LEGAL; run-a was the mtime-newest run with `00-requirements.md` DRAFT.
 * `recursive_lock {runId: 'run-b', artifact: '01-as-is.md'}` was REFUSED with run-A's blocker
 * (`monotonic lock-order: … 00-requirements.md (DRAFT)`), and the guard-decision record said `runId: run-a`
 * while the gate-block ask said `artifact: 01-as-is.md` — one refusal naming two runs.
 *
 * WHY: the guard resolved the run from the FILESYSTEM (`resolveRunDir` — the active/newest run) while the
 * TOOL resolves it from `args.runId`. Under `advisory` the deny was coerced to an allow-with-warning and the
 * tool refused on its own terms, which is why the strict default is what made it bite.
 *
 * WHAT IS PINNED HERE, per rule, deliberately:
 *   - `lock-order` (`recursive_lock*`): the run the CALL NAMES wins. It is the run the tool acts on, so the
 *     guard must not answer for another run's prerequisites.
 *   - `locked-write`: no run is resolved at all — the rule reads the TARGET's own `Status:` — so no run id
 *     can move it. Asserted, so a future "resolve the run" change there has to argue with a test.
 *   - `phase-order`: the ACTIVE run keeps winning, and a `runId` argument cannot re-point it. A write tool
 *     declares no run id, so honouring one would hand a caller a way to escape the active run's ordering;
 *     the rule's cross-run abstention is asserted as the deliberate behaviour it is documented to be.
 *
 * A caller-supplied id is a NAME, validated through the same `runIdProblem` gate the run-id-shaped tools
 * use, and the last case proves an unusable one cannot move the guard's read: the escape target WOULD
 * allow the lock, and the guard still refuses from the active run's tree.
 *
 * WHAT WOULD MAKE THESE CASES PASS VACUOUSLY: a fixture where run-a and run-b are the same directory, or
 * where the two runs' `00-requirements.md` have the SAME status (so "judged the named run" and "judged the
 * active run" produce one verdict). Both are guarded against explicitly: the runs are asserted distinct,
 * the filesystem's own resolver is asserted to name run-a, and each allow/deny is paired with a
 * counterfactual on the OTHER run that lands on the opposite verdict.
 */
describe('ISSUE 2 — the run the CALL names wins for lock tools, and only for lock tools', () => {
  const ACTIVE_RUN = 'run-a'
  const OTHER_RUN = 'run-b'

  /** A minimal DRAFT artifact: enough for `getLockStatus` to classify it DRAFT. */
  function draftArtifact(runId: string): string {
    return 'Run: `/.recursive/run/' + runId + '/`\nPhase: `00 Requirements`\nStatus: `DRAFT`\n\n## TODO\n\n- [ ] x\n'
  }

  /** One run tree under a shared root, with the named files written. */
  function runTree(root: string, runId: string, files: Record<string, string>): Run {
    const runDir = join(root, '.recursive', 'run', runId)
    mkdirSync(runDir, { recursive: true })
    for (const [name, content] of Object.entries(files)) writeFileSync(join(runDir, name), content, 'utf8')
    return { root, runDir, runId }
  }

  /**
   * ISSUE 2's fixture: TWO runs, and run-a is the one the FILESYSTEM calls active. The ordering is STAMPED
   * (`utimesSync`) and then read back through `resolveRunDir` — the very resolver `index.ts` uses — because
   * an unstamped pair ties and the winner would depend on unspecified directory order.
   */
  function twoRuns(): { root: string; active: Run; other: Run } {
    const root = mkdtempSync(join(tmpdir(), 'rm-two-runs-'))
    tempRoots.push(root)
    // run-b is created first so run-a is newer even before the stamp; both hold a DRAFT `00-requirements.md`
    // (the ILLEGAL case), and each case locks the one it needs.
    const other = runTree(root, OTHER_RUN, {
      '00-requirements.md': draftArtifact(OTHER_RUN),
      '01-as-is.md': draftArtifact(OTHER_RUN),
      '08-memory-impact.md': draftArtifact(OTHER_RUN),
    })
    const active = runTree(root, ACTIVE_RUN, {
      '00-requirements.md': draftArtifact(ACTIVE_RUN),
      '01-as-is.md': draftArtifact(ACTIVE_RUN),
      '08-memory-impact.md': draftArtifact(ACTIVE_RUN),
    })
    const future = new Date(Date.now() + 60_000)
    utimesSync(active.runDir, future, future)
    expect(resolveRunDir(root)?.runId, 'precondition: the filesystem names run-a as the active run').toBe(ACTIVE_RUN)
    // The two runs must be different directories, or "judged the named run" would be unfalsifiable.
    expect(active.runDir).not.toBe(other.runDir)
    return { root, active, other }
  }

  /** The guard's verdict for one `recursive_lock` call, from the guard's own entry point. */
  function lockGuard(root: string, activeRunId: string, args: Record<string, unknown>): ToolGuardDecision {
    return evaluateToolGuard({ name: 'recursive_lock', arguments: args }, root, activeRunId, 'strict')
  }

  it('(a) a LEGAL lock on a NON-ACTIVE run is ALLOWED — the guard judges the run the call names', () => {
    const { root, other } = twoRuns()
    // run-b's `00-requirements.md` LOCKED: with `01-as-is.md` the only other artifact present, its
    // prerequisite set is exactly that one artifact, so locking `01-as-is.md` in run-b is legal.
    lockOnDisk(other, '00-requirements.md')

    const legal = lockGuard(root, ACTIVE_RUN, { runId: OTHER_RUN, artifact: '01-as-is.md' })
    expect(legal.kind, 'a legal lock in run-b was refused: ' + reasonOf(legal)).toBe('allow')
    expect(legal.runId, 'the decision must name the run it judged').toBe(OTHER_RUN)

    // THE COUNTERFACTUAL on the same tree, so the allow above cannot be a guard that stopped refusing
    // out-of-order locks: the identical call aimed at the ACTIVE run IS refused, with run-a's blocker.
    const ontoActive = lockGuard(root, ACTIVE_RUN, { runId: ACTIVE_RUN, artifact: '01-as-is.md' })
    expect(ontoActive.kind).toBe('deny')
    expect(ontoActive.rule).toBe('lock-order')
    expect(reasonOf(ontoActive)).toContain('00-requirements.md (DRAFT)')
    expect(ontoActive.runId).toBe(ACTIVE_RUN)
  })

  it('(b) an ILLEGAL lock on a NON-ACTIVE run is refused, and the refusal NAMES THAT RUN', () => {
    const { root } = twoRuns()
    const denied = lockGuard(root, ACTIVE_RUN, { runId: OTHER_RUN, artifact: '01-as-is.md' })
    expect(denied.kind).toBe('deny')
    expect(denied.rule).toBe('lock-order')
    const reason = reasonOf(denied)
    expect(reason).toContain('monotonic lock-order')
    // run-b's blocker, from run-b's tree.
    expect(reason).toContain('00-requirements.md (DRAFT)')
    // ⚠ THE ASSERTION THIS ISSUE EXISTS FOR: the refusal names the run it READ.
    expect(reason, 'the refusal does not name the run it evaluated').toContain(OTHER_RUN)
    expect(reason, 'the refusal names a run it did NOT evaluate').not.toContain(ACTIVE_RUN)
    // The decision agrees with its own sentence, and the gate-block payload agrees with both: one refusal,
    // one run — the record and the ask can no longer disagree, because both carry this.
    expect(denied.runId).toBe(OTHER_RUN)
    const ask = (denied as { ask?: { artifact: string; blocked: string } }).ask
    expect(ask, 'the strict lock-order refusal carried no ask').toBeDefined()
    expect(ask!.artifact).toBe('01-as-is.md')
    expect(ask!.blocked).toBe(reason)
    expect(ask!.blocked).toContain(OTHER_RUN)
  })

  it('(c) a PATH-SHAPED runId cannot point the guard at another tree', () => {
    const { root } = twoRuns()
    // An ESCAPE target that would ALLOW the lock — a directory outside the run layer holding a LOCKED
    // `00-requirements.md`. If a caller-supplied id could move the guard's read, this is the tree it would
    // read, and the verdict would flip to `allow`. It must not.
    const escape = join(root, 'elsewhere')
    mkdirSync(escape, { recursive: true })
    writeFileSync(join(escape, '00-requirements.md'), draftArtifact('escape'), 'utf8')
    writeFileSync(join(escape, '01-as-is.md'), draftArtifact('escape'), 'utf8')
    lockOnDisk({ root, runDir: escape, runId: 'escape' }, '00-requirements.md')
    // Precondition, ASSERTED: the escape tree really is a tree that would allow this lock.
    expect(getLockStatus(join(escape, '00-requirements.md'))).toBe('LOCKED')

    const unusable: Array<[string, string]> = [
      ['a relative path with a `..` segment', '../elsewhere'],
      ['an absolute, drive-qualified path', escape],
      ['a nested path', 'elsewhere/run'],
      ['a padded-then-path-shaped id', ' ../elsewhere '],
    ]
    for (const [what, runId] of unusable) {
      const decision = lockGuard(root, ACTIVE_RUN, { runId, artifact: '01-as-is.md' })
      expect(decision.runId, what + ': an unusable runId moved the guard').toBe(ACTIVE_RUN)
      expect(decision.kind, what + ': the guard did not judge the active run').toBe('deny')
      expect(reasonOf(decision), what).toContain(ACTIVE_RUN)
      expect(reasonOf(decision), what).not.toContain('elsewhere')
    }

    // CONTROL — the same id SHAPE is honoured when it is a NAME, so the refusals above are the validation
    // and not a guard that ignores `args.runId` entirely.
    const named = lockGuard(root, ACTIVE_RUN, { runId: OTHER_RUN, artifact: '01-as-is.md' })
    expect(named.runId).toBe(OTHER_RUN)
  })

  it("(d) a WRITE cannot re-point the phase-order rule by naming a run in an argument", () => {
    const { root, active, other } = twoRuns()
    // The active run is at phase 0 (its `00-requirements.md` is DRAFT), so writing its LAST phase is the
    // ordering violation the rule exists to refuse. The `runId` argument names the OTHER run — a write tool
    // declares no such parameter, so honouring it would be an escape hatch out of the active run's order.
    const escapeAttempt = evaluateToolGuard(
      { name: 'write', arguments: { file_path: relativeArtifact(active, PHASE_EIGHT), content: 'x', runId: OTHER_RUN } },
      root, ACTIVE_RUN, 'strict',
    )
    expect(escapeAttempt.kind, 'a runId argument re-pointed the phase-order rule: ' + reasonOf(escapeAttempt)).toBe('deny')
    expect(escapeAttempt.rule).toBe('phase-order')
    expect(escapeAttempt.runId).toBe(ACTIVE_RUN)

    // …and the SAME argument on a write into the other run's tree neither re-points nor denies: another
    // run's tree is the documented ABSTENTION of this rule (it is about THIS run's sequence), which is the
    // active-run behaviour the write rules rely on and which this fix deliberately leaves alone.
    const otherRunWrite = evaluateToolGuard(
      { name: 'write', arguments: { file_path: relativeArtifact(other, PHASE_EIGHT), content: 'x', runId: ACTIVE_RUN } },
      root, ACTIVE_RUN, 'strict',
    )
    expect(otherRunWrite.kind, 'another run\'s tree must keep the documented abstention: ' + reasonOf(otherRunWrite)).toBe('allow')
    expect(otherRunWrite.runId, 'the active run still governs a write').toBe(ACTIVE_RUN)
  })

  it('(e) the locked-artifact rule resolves no run at all, so no runId can move it', () => {
    const { root, other } = twoRuns()
    lockOnDisk(other, '00-requirements.md')
    // A write to the OTHER run's LOCKED artifact, with a `runId` naming the active run: the refusal comes
    // from the target's own `Status:`, which is why this rule needed no change in this fix.
    const decision = evaluateToolGuard(
      { name: 'write', arguments: { file_path: relativeArtifact(other, '00-requirements.md'), content: 'x', runId: ACTIVE_RUN } },
      root, ACTIVE_RUN, 'strict',
    )
    expect(decision.kind).toBe('deny')
    expect(decision.rule).toBe('locked-write')
    expect(reasonOf(decision)).toContain('locked-artifact write denial')
    // CONTROL — the same file while it is NOT locked is allowed, so the deny above is the lock status and
    // not a blanket refusal of another run's tree.
    expect(evaluateToolGuard(
      { name: 'write', arguments: { file_path: relativeArtifact(other, '01-as-is.md'), content: 'x' } },
      root, ACTIVE_RUN, 'strict',
    ).kind).toBe('allow')
  })
})
