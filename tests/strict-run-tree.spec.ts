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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  currentPhaseArtifact, evaluateToolGuard, resolveToolPolicyForGuard, type ToolGuardDecision,
} from '../src/enforcement.ts'
import { resolveFrom, withPhaseBaseline } from '../src/phase-rules.ts'
import { evaluateToolPolicy, loadToolPolicyFile } from '../src/policy-globs.ts'
import { PHASE_SEQUENCE, getLockStatus, lockHashFromContent } from '../src/lock.ts'
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
})
