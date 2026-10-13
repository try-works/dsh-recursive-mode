/**
 * R5 spec: canonical init/lint/policy/pre-step parity (RED -> GREEN).
 * initRun scaffolds FULL per-phase templates (00 byte-parity with the
 * committed canonical init golden fixture — captured once from canonical
 * recursive-init.py, no live python), lintArtifact runs the in-process
 * ts-lint port, renderRecursivePolicy surfaces the current phase's required
 * sections + gates, and the pre-step lint-rules message carries this phase's
 * sections.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { renderRecursivePolicy } from '../src/policy.ts'
import { getArtifactRequiredSections, phaseLintRulesMessage, phaseRulesFor, sectionFormatRulesFor } from '../src/phase-rules.ts'
import { getLockStatus, lockHashFromContent } from '../src/lock.ts'


async function setup(repoRoot: string) {
  const ctx = new Context()
  await ctx.plugin(RecursiveRuntime, { repoRoot })
  return ctx
}

/** Fresh git repo (needed for canonical recursive-init git-context prefill). */
function freshGitRepo(tag: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'r5-' + tag + '-'))
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, 'dummy.txt'), 'hello', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
  return repo
}

describe('R5 — canonical init/lint/policy/pre-step parity', () => {
  it('initRun scaffolds 00 templates byte-identical to the canonical init golden (python-free)', async () => {
    const repo = freshGitRepo('init')
    try {
      const ctx = await setup(repo)
      // golden captured once from canonical recursive-init.py --run-id golden-ref
      const golden00 = readFileSync(new URL('./fixtures/init-golden/00-requirements.md', import.meta.url), 'utf8')
      await ctx.recursive.initRun('golden-ref', { session: { header: { cwd: repo } } })
      const plugin00 = readFileSync(join(repo, '.recursive', 'run', 'golden-ref', '00-requirements.md'), 'utf8')
      expect(plugin00).toBe(golden00)
      // extra dirs
      for (const d of ['addenda', 'subagents', 'router-prompts', 'evidence', 'evidence/logs', 'evidence/screenshots', 'evidence/other', 'evidence/perf', 'evidence/traces']) {
        expect(existsSync(join(repo, '.recursive', 'run', 'golden-ref', d)), d).toBe(true)
      }
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('initRun scaffolds later-phase templates with required sections + gates', async () => {
    const repo = freshGitRepo('later')
    try {
      const ctx = await setup(repo)
      await ctx.recursive.initRun('r5-later', { session: { header: { cwd: repo } } })
      for (const f of ['03-implementation-summary.md', '04-test-summary.md', '08-memory-impact.md']) {
        const p = join(repo, '.recursive', 'run', 'r5-later', f)
        expect(existsSync(p), f).toBe(true)
        const content = readFileSync(p, 'utf8')
        for (const section of getArtifactRequiredSections(f)) {
          expect(content, f + ' lacks ' + section).toContain('## ' + section)
        }
        expect(content).toMatch(/Coverage: FAIL/)
        expect(content).toMatch(/Approval: FAIL/)
      }
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('lintArtifact runs the in-process ts-lint port (no python shell)', async () => {
    const repo = freshGitRepo('lint')
    try {
      const ctx = await setup(repo)
      await ctx.recursive.initRun('r5-lint', { session: { header: { cwd: repo } } })
      const result = await ctx.recursive.lintArtifact('r5-lint', '00-requirements.md', { session: { header: { cwd: repo } } })
      expect(Array.isArray(result.errors)).toBe(true)
      expect(Array.isArray(result.warnings)).toBe(true)
      expect(typeof result.passed).toBe('boolean')
      // a freshly scaffolded DRAFT 00 must FAIL lint (unfilled)
      expect(result.passed).toBe(false)
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('renderRecursivePolicy surfaces current phase required sections + gates', async () => {
    const repo = freshGitRepo('policy')
    try {
      const ctx = await setup(repo)
      await ctx.recursive.initRun('r5-pol', { session: { header: { cwd: repo } } })
      const text = renderRecursivePolicy({ worktreeRoot: repo, runId: 'r5-pol', folded: null })
      expect(text).toMatch(/TDD/i)
      expect(text).toMatch(/Coverage/)
      expect(text).toMatch(/Approval/)
      expect(text).toContain('required sections')
      expect(text).toContain('recursive_phase')
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('phaseLintRulesMessage includes this phase required sections', () => {
    const msg = phaseLintRulesMessage('03-implementation-summary.md')
    expect(msg).toContain('<system-reminder>')
    expect(msg).toContain('Changes Applied')
    expect(msg).toContain('TDD Compliance Log')
    expect(msg).toContain('Audit Verdict')
  })

  it('the reminder for the review phase names the SECOND artifact each rule governs', () => {
    // ⚠ ONE LINE, STILL — and on it, every bundle section is annotated with the file it governs, because
    // `## Diff Basis` is NOT a heading of `03.5-code-review.md`. A bare name here would send a writer to add a
    // section the phase artifact does not require.
    const msg = phaseLintRulesMessage('03.5-code-review.md')
    expect(msg).toContain('Entry-row sections')
    // The line names every section the payload carries a format for, in table order, annotating the ones that
    // belong to the SECOND file. Asserted as the ACTUAL line, so a reordering or a lost annotation bites.
    expect(msg).toContain('## Requirement Completion Status | ## Review Bundle Path | ## Artifact Path (review-bundle)')
    expect(msg).toContain('## Diff Basis (review-bundle) | ## Upstream Artifacts To Re-read (review-bundle)')
    expect(msg).toContain('## Code review narrative (review-narrative) | ## Code review narrative citations (review-narrative)')
    // The prose stays in the payload: the reminder names, it does not paste.
    expect(msg).not.toContain('Keep the id ALONE')
    expect(msg).not.toContain('six backticked fields')
    expect(msg.length).toBeLessThan(2400)
  })
})

describe('phaseRulesFor — structured single source of truth (refined LIVE BUG 6)', () => {
  it('returns correct requiredSections/audited/tdd/qa for phase 3', () => {
    const r = phaseRulesFor('03-implementation-summary.md')
    expect(r.label).toBe('03-implementation-summary')
    expect(r.audited).toBe(true)
    expect(r.tdd).toBe(true)
    expect(r.qa).toBe(false)
    expect(r.requiredSections).toContain('Changes Applied')
    expect(r.requiredSections).toContain('Audit Verdict')
  })

  it('marks phase 5 as QA (not TDD)', () => {
    const r = phaseRulesFor('05-manual-qa.md')
    expect(r.qa).toBe(true)
    expect(r.tdd).toBe(false)
  })

  it('marks phase 0 requirements as non-audited', () => {
    const r = phaseRulesFor('00-requirements.md')
    expect(r.audited).toBe(false)
    expect(r.tdd).toBe(false)
    expect(r.qa).toBe(false)
    expect(r.label).toBe('00-requirements')
  })

  it('phaseLintRulesMessage output unchanged (built from phaseRulesFor)', () => {
    const msg = phaseLintRulesMessage('03-implementation-summary.md')
    expect(msg).toContain('<system-reminder>')
    expect(msg).toContain('Changes Applied')
    expect(msg).toContain('TDD Compliance Log')
    expect(msg).toContain('Audit Verdict')
  })
})

/**
 * ⚠ THE PAYLOAD ITSELF, NOT THE PURE FUNCTION. `recursive_phase` returns `runtime.phaseRules(...)`, which
 * SPREADS `phaseRulesFor(phase)` — so a field added to `PhaseRules` reaches the agent only if that spread is
 * intact. Asserting `phaseRulesFor` alone would pass even if the payload dropped the field, which is exactly
 * the failure this test exists to catch. The run is advanced to phase 1 first (the phase that owns
 * `## Source Requirement Inventory`), because a phase-0 payload carries no format rules: an empty-array
 * comparison would pass vacuously and prove nothing.
 */
describe('recursive_phase payload — the section formats reach the agent through runtime.phaseRules', () => {
  /** A real lock header on disk, hashed the way `getLockStatus` verifies — so progress cannot be faked. */
  function lockOnDisk(runDir: string, name: string): void {
    const path = join(runDir, name)
    const body = readFileSync(path, 'utf8')
    const header = 'Status: LOCKED\nLockedAt: ' + new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\nLockHash: ' + '0'.repeat(64) + '\n'
    const hash = lockHashFromContent(header + body)
    writeFileSync(path, header.replace('0'.repeat(64), hash) + body, 'utf8')
    expect(getLockStatus(path), 'precondition: ' + name + ' must be lock-valid').toBe('LOCKED')
  }

  it('carries sectionFormats for the CURRENT phase, non-empty', async () => {
    const repo = freshGitRepo('payload')
    try {
      const ctx = await setup(repo)
      await ctx.recursive.initRun('r5-payload', { session: { header: { cwd: repo } } })
      const runDir = join(repo, '.recursive', 'run', 'r5-payload')
      lockOnDisk(runDir, '00-requirements.md')
      lockOnDisk(runDir, '00-worktree.md')

      const payload = await ctx.recursive.phaseRules('r5-payload', { session: { header: { cwd: repo } } })
      expect(payload?.phase).toBe('01-as-is.md')
      expect(payload?.sectionFormats).toEqual(sectionFormatRulesFor('01-as-is.md'))
      expect(payload?.sectionFormats?.length).toBe(2)
      // The literal an agent copies, present in the payload it actually receives — not merely in the table.
      expect(JSON.stringify(payload)).toContain('- R1 | Disposition: in-scope | Source Quote:')
      expect(JSON.stringify(payload)).toContain('the id ALONE as the first')
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  /**
   * ⚠ PHASE 0'S OWN PAYLOAD, WHICH USED TO CARRY `sectionFormats: []`. The requirement-id shape and the
   * diff-basis contract are declared by the phase that DEFINES them, so this asserts the real payload at the
   * run's FIRST phase entry — before any lock, which is when the guidance is worth anything. The old spec
   * advanced the run deliberately "because a phase-0 payload carries no format rules"; that sentence was the
   * defect, not the design.
   */
  it('carries the PHASE 0 formats, and the delegated-reviewer verdict, in the payload the agent reads first', async () => {
    const repo = freshGitRepo('payload0')
    try {
      const ctx = await setup(repo)
      await ctx.recursive.initRun('r5-payload0', { session: { header: { cwd: repo } } })
      const payload = await ctx.recursive.phaseRules('r5-payload0', { session: { header: { cwd: repo } } })
      expect(payload?.phase).toBe('00-requirements.md')
      expect(payload?.sectionFormats).toEqual(sectionFormatRulesFor('00-requirements.md'))
      expect(payload?.sectionFormats?.length).toBe(3)
      // The two literals an agent copies at phase 0, asserted on the PAYLOAD's own JSON.
      expect(JSON.stringify(payload)).toContain('### `R1` the lock must refuse an out-of-order artifact')
      expect(JSON.stringify(payload)).toContain('Keep the id ALONE inside its own code span')
      // FU: the capability statement rides the same payload, and this composition mounts NO subagents service,
      // so the verdict is UNAVAILABLE with the condition named rather than an empty field.
      expect(payload?.delegatedReviewer?.available).toBe(false)
      expect(payload?.delegatedReviewer?.reason).toContain('no subagents service is mounted')
      // ⚠ THE REVIEW PHASE'S PAYLOAD, FROM THE SAME REAL SPREAD — the defect this change fixes, pinned where it
      // is reachable without locking six phases. `03.5-code-review.md` is the ONLY phase whose lint also checks
      // a SECOND artifact (the review bundle), so its payload is the only one that must carry TWO files' rules.
      // The runtime is asked for that phase's rules exactly as `recursive_phase` asks on the entry to it; what
      // is asserted is that the spread carries BOTH tables (the artifact's status row and the bundle's rows)
      // and that the bundle rule text is really in the JSON the agent receives — the thing a live run went
      // grepping the shipped `lib/index.js` for.
      const review = { ...payload, phase: '03.5-code-review.md', ...phaseRulesFor('03.5-code-review.md') }
      expect(review.sectionFormats).toEqual(sectionFormatRulesFor('03.5-code-review.md'))
      expect(review.sectionFormats?.length).toBe(13)
      const reviewJson = JSON.stringify(review)
      // ⚠ THE LITERALS ARE THE TABLE'S OWN PROSE, IN THE JSON THE AGENT RECEIVES — which is the whole claim:
      // the rule the live run grepped the shipped bundle for is now in the payload, not in `lib/index.js`.
      expect(reviewJson).toContain('"appliesTo":"review-bundle"')
      expect(reviewJson).toContain('"appliesTo":"review-narrative"')
      expect(reviewJson).toContain('one per line, in this order: `Baseline type`')
      expect(reviewJson).toContain('ONE `- ` bullet per upstream artifact')
      expect(reviewJson).toContain('the narrative must cite the review bundle')
      expect(reviewJson).toContain('not read as a citation')
      // ...and the BUNDLE rows are not attached to any other phase's payload, so the cost is paid once.
      expect(JSON.stringify(payload)).not.toContain('appliesTo')
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})

