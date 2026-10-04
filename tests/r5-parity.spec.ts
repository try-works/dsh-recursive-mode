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
import { getArtifactRequiredSections, phaseLintRulesMessage, phaseRulesFor } from '../src/phase-rules.ts'


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

