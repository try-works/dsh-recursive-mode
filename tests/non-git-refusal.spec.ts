/**
 * FU-11 — WHICH LINE STOPPED THE WORK, AND THE GIT PRECONDITION SAID EARLY.
 *
 * WHAT WAS REPORTED, from a live diagnostic run in a workspace that is not a git repository
 * (`E:/tmp/rm-probe-2026-10-11-1836/REPORT.md` §5.1): two `recursive_lock` refusals, both naming git
 * preconditions, and a report that concluded *"the guard layer blamed a different cause ('## Effective
 * Inputs Re-read', not in phase-0's required sections)"*. The plugin was accused of naming the wrong
 * cause.
 *
 * WHAT THE STRINGS ACTUALLY ARE, measured through the live path rather than argued from the source:
 *
 *   - the REFUSAL is `Artifact <a> does not meet the phase standard, so it was not locked: … Unable to
 *     verify git diff basis: … not a git repository`, rendered by `recursive_lock` as `RM5501 runtime:
 *     the recursive runtime refused the operation - <that sentence>`. It names git, and it never names
 *     `## Effective Inputs Re-read`;
 *   - the `## Effective Inputs Re-read` line is the ADVISORY `console.warn` below, emitted by the guard
 *     for a call it ALLOWED and never a reason anything was refused.
 *
 * So the guard did NOT name the wrong cause in its refusal. It DID, however, publish that advisory in a
 * form a careful reader took for the verdict — `transition gate (report-only) failed: phase doc must
 * re-read effective inputs (## Effective Inputs Re-read)` — and the two lines carried no marker telling
 * them apart. These cases pin the markers, so the pair stays distinguishable by a reader with no access
 * to the source: an advisory that says it refused nothing, and a refusal that says the environment, not
 * the artifact, is what blocked it.
 *
 * ⚠ WHAT WOULD MAKE THESE CASES PASS VACUOUSLY:
 *   - asserting only the advisory's marker would pass over a call that was actually refused, so the
 *     first case also asserts the guard's OWN record (`kind: 'allow'`) and that the tool's refusal
 *     arrives SEPARATELY, after it;
 *   - the refusal case is only meaningful on a workspace that is genuinely not a git repository, so it
 *     asserts that precondition from `gitFacts` rather than assuming the temp dir is one, and it asserts
 *     the artifact was otherwise COMPLIANT (the run is otherwise lockable) so that "git is the cause" is
 *     a measured claim about this run and not an artifact that would have failed for other reasons;
 *   - the early-notice cases assert the notice DISAPPEARS once the checkout becomes a repository, which
 *     is what makes them about the checkout's state rather than about a constant string.
 */
import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { RecursiveRuntime } from '../src/runtime.ts'
import { readGuardDecisions } from '../src/guard-log.ts'
import { codeRuntimeRefusal } from '../src/errors.ts'
import { gitFacts } from '../src/git-context.ts'
import { GIT_REQUIRED_NOTICE, phaseRulesFor } from '../src/phase-rules.ts'
import { writeCompliantRun } from './compliant-artifact.ts'

const signal = new AbortController().signal
const RUN = 'nongit-run'
const ARTIFACT = '00-requirements.md'

interface Mounted {
  ctx: Context
  repo: string
  runDir: string
  /** The `[recursive]` lines the call emitted, in order, with `console.warn` captured. */
  dispose: () => Promise<void>
}

/**
 * A workspace that is NOT a git repository, holding a run whose `00-requirements.md` meets the phase
 * standard. The fixture is built WITH git (so the recorded diff basis is real and executable) and the
 * repository is then REMOVED — which is the probe workspace's shape: a scaffolded run, complaint
 * artifacts, and no `.git` anywhere above them.
 */
async function mountNonGit(withToolRuntime: boolean): Promise<Mounted & { refusal: string; warnings: string[] }> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-fu11-'))
  writeCompliantRun(repo, RUN, [ARTIFACT])
  rmSync(join(repo, '.git'), { recursive: true, force: true })

  const ctx = new Context()
  if (withToolRuntime) {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
  }
  await ctx.plugin(plugin, { repoRoot: repo })
  if (!withToolRuntime) return { ctx, repo, runDir: join(repo, '.recursive', 'run', RUN), dispose: async () => { await ctx.fiber.dispose(); rmSync(repo, { recursive: true, force: true }) }, refusal: '', warnings: [] }

  const warnings: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  })
  let refusal = ''
  try {
    // THE LIVE PATH: the registered tool, through the tool runtime, so the guard listener runs first.
    // A refusal here is the tool's own payload, which is what `recursive_lock` renders into its
    // `{ error }` text (`RM5501 runtime: … refused the operation - …`).
    await ctx.tools.execute({
      signal,
      callId: ToolCallId('fu11-lock'),
      name: 'recursive_lock',
      arguments: { runId: RUN, artifact: ARTIFACT },
      agent: { session: { header: { cwd: repo } } },
    } as never)
  } finally {
    spy.mockRestore()
  }
  // Read the tool's own error text from the direct runtime call: the harness's `execute` result shape
  // is not what the report quoted, and the quoted sentence is the one `lockArtifact` throws.
  try {
    await ctx.recursive.lockArtifact(RUN, ARTIFACT)
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  return {
    ctx,
    repo,
    runDir: join(repo, '.recursive', 'run', RUN),
    refusal,
    warnings: warnings.filter((line) => line.includes('[recursive]')),
    dispose: async () => { await ctx.fiber.dispose(); rmSync(repo, { recursive: true, force: true }) },
  }
}

describe('FU-11 — the advisory and the refusal are tellable apart by their own text', () => {
  it('the advisory SAYS it refused nothing, and the guard record says the call was ALLOWED', async () => {
    const m = await mountNonGit(true)
    try {
      // The precondition the case is about: this workspace really is not a git repository.
      expect(gitFacts(m.repo).gitDir, 'the fixture is a git repository, so the case is not about one').toBeNull()

      expect(m.warnings, 'no advisory was emitted: ' + JSON.stringify(m.warnings)).toHaveLength(1)
      const advisory = m.warnings[0]
      // 1. It is still the report-only advisory whose marker is pinned by guard-path.spec.ts.
      expect(advisory).toContain('transition gate (report-only) failed:')
      // 2. …and it now carries its own kind: a reader is told, in the line itself, that this did not
      //    refuse the call. The assertion is on the MARKER, so a mutation that deletes it fails here.
      expect(advisory).toContain('[REPORT ONLY: this did NOT refuse the call')
      expect(advisory).toContain('which was ALLOWED')
      // 3. The guard's own durable record agrees, and is READ rather than assumed: `kind: allow` is what
      //    makes "this was not the refusal" a fact about the run instead of a claim about wording.
      const record = readGuardDecisions(m.repo, 5)[0]
      expect(record.kind).toBe('allow')
      expect(record.tool).toBe('recursive_lock')
      expect(record.reason).toContain('[REPORT ONLY: this did NOT refuse the call')
      // 4. The refusal exists, and it is a DIFFERENT line: the advisory cannot be the reason the call
      //    failed, because the call was allowed and the refusal came from the tool afterwards.
      expect(m.refusal).toContain('does not meet the phase standard, so it was not locked')
      expect(advisory).not.toContain('does not meet the phase standard')
    } finally {
      await m.dispose()
    }
  })
})

describe('FU-11 — the non-git refusal names git as the cause, and says no artifact edit clears it', () => {
  it('refuses on the git precondition and names it as an ENVIRONMENT blocker', async () => {
    const m = await mountNonGit(true)
    try {
      expect(gitFacts(m.repo).gitDir, 'the fixture is a git repository, so the case is not about one').toBeNull()
      // ⚠ THE ANTI-VACUITY ASSERTION: the artifact is COMPLIANT. Without this, "the refusal is about
      // git" could be true of an artifact that would have been refused for its own content anyway.
      expect(phaseRulesFor(ARTIFACT).requiredSections).not.toContain('Effective Inputs Re-read')
      // The cause is named…
      expect(m.refusal).toContain('Unable to verify git diff basis')
      expect(m.refusal).toContain('not a git repository')
      // …as one that the artifact cannot fix.
      expect(m.refusal).toContain('ENVIRONMENT BLOCKER, not an artifact defect')
      expect(m.refusal).toContain('at least one commit')
      // …and it does NOT attribute the refusal to a section this phase does not owe.
      expect(m.refusal).not.toContain('Effective Inputs Re-read')

      // ⚠ AND THE CALLER-VISIBLE TEXT IS THE PAINTED ONE, not just the thrown message: `recursive_lock`
      // renders every refusal through `codeRuntimeRefusal`, which is what the report quoted
      // (`RM5501 runtime: the recursive runtime refused the operation - …`). Asserting only the thrown
      // sentence would leave the layer the reader actually sees unpinned.
      const rendered = codeRuntimeRefusal(m.refusal)
      expect(rendered).toContain('RM5501 runtime: the recursive runtime refused the operation')
      expect(rendered).toContain('not a git repository')
      expect(rendered).toContain('ENVIRONMENT BLOCKER, not an artifact defect')
      // The rendered sentence must READ as one sentence: the appended clause is followed by the registry's
      // own "Next: …", and a terminal period produced "… can clear it.. Next: …" in a live transcript.
      expect(rendered).toContain('can clear it. Next:')
      expect(rendered).not.toContain('can clear it..')
    } finally {
      await m.dispose()
    }
  })
})

describe('FU-11 — git is required, and the plugin says so at phase entry rather than at the lock', () => {
  it('recursive_phase reports `gitRequired` in a non-git workspace', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-fu11-phase-'))
    const ctx = new Context()
    const runtime = new RecursiveRuntime(ctx, { repoRoot: repo })
    try {
      await runtime.initRun(RUN)
      expect(gitFacts(repo).gitDir).toBeNull()
      const rules = await runtime.phaseRules(RUN)
      expect(rules).not.toBeNull()
      expect(rules?.gitRequired).toBe(GIT_REQUIRED_NOTICE)
      // The notice names the requirement, the consequence and the remedy — not just "git missing".
      expect(rules?.gitRequired).toContain('git is REQUIRED')
      expect(rules?.gitRequired).toContain('Every artifact lock is refused')
      expect(rules?.gitRequired).toContain('git init')
      // It NAMES the reason it is required, which is the honest answer to "should git be required?":
      // the tamper mechanism is the lock hash, and the diff basis is a git fact.
      expect(rules?.gitRequired).toContain('diff basis')
      expect(rules?.gitRequired).toContain('tamper')
    } finally {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('reports null once the workspace IS a repository — the notice tracks the checkout, not a constant', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-fu11-git-'))
    const ctx = new Context()
    const runtime = new RecursiveRuntime(ctx, { repoRoot: repo })
    try {
      await runtime.initRun(RUN)
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'fu11 fixture'], { cwd: repo, stdio: 'ignore' })
      writeFileSync(join(repo, 'README.md'), '# repo\n', 'utf8')
      execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: repo, stdio: 'ignore' })
      const rules = await runtime.phaseRules(RUN)
      expect(rules?.gitRequired).toBeNull()
    } finally {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('a bare phaseRulesFor call is unchanged: `gitRequired` is null, because a phase has no checkout', () => {
    // The split is deliberate — `phaseRulesFor` is pure and profile-derived, while whether git is
    // available is a fact about the checkout, filled in by `runtime.phaseRules`. A caller of the pure
    // function reads exactly what it read before this field existed.
    expect(phaseRulesFor('00-requirements.md').gitRequired).toBeNull()
    expect(phaseRulesFor('03-implementation-summary.md').gitRequired).toBeNull()
  })
})
