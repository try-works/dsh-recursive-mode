/**
 * R5 policy-render spec (RED): recursive:policy must render non-empty in a
 * recursive session with a run in cwd. The current wiring reads the RETIRED
 * recursive/phase-intent event signal (zero-emission removed the emitter), so
 * detectTransitionIntent is ALWAYS null and the section renders ''. The fix
 * derives intent from the FILESYSTEM (session cwd -> control-plane root ->
 * enumerateRuns -> current phase), keeping zero-emission.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'

/** Minimal agent-like object with a session header cwd (the shape the harness passes to section callbacks). */
function agentLike(cwd: string) {
  return { session: { header: { cwd }, events: [] } }
}

async function setupWithRun(repoRoot: string, runId: string) {
  const runDir = join(repoRoot, '.recursive', 'run', runId)
  mkdirSync(runDir, { recursive: true })
  // minimal DRAFT 00-requirements.md
  writeFileSync(join(runDir, '00-requirements.md'), [
    'Run: `/.recursive/run/' + runId + '/`',
    'Phase: `00 Requirements`',
    'Status: `DRAFT`',
    'Workflow version: recursive-mode-audit-v2',
    '',
    '## TODO',
    '',
    '- [ ] Elicit requirements',
    '',
    '## Requirements',
    '',
    '### `R1` x',
    '',
    'Description: x',
    'Acceptance criteria: observable',
    '',
    '## Out of Scope',
    '',
    '- none',
    '',
    '## Constraints',
    '',
    '- none',
    '',
    '## Coverage Gate',
    'Coverage: FAIL',
    '',
    '## Approval Gate',
    'Approval: FAIL',
  ].join('\n') + '\n', 'utf8')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, { serverSurface: true, repoRoot });
  return { ctx, runDir }
}

describe('R5 — recursive:policy renders from filesystem (zero-emission)', () => {
  it('policy section renders non-empty in a recursive session with a run in cwd', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'r5-pol-render-'))
    try {
      const { ctx } = await setupWithRun(repo, 'pol-render-run')
      const assembly = await ctx.systemPrompt.assemble({ agent: agentLike(repo), scope: {} } as never)
      const section = assembly.sections.find(s => s.name === 'recursive:policy')
      expect(section).toBeDefined()
      expect(section!.text.length).toBeGreaterThan(0)
      expect(section!.text).toContain('You are in a recursive-mode session')
      expect(section!.text).toContain('Current phase')
      expect(section!.text).toContain('Coverage')
      expect(section!.text).toContain('00-requirements.md')
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  /**
   * ⚠ THIS TEST USED TO ASSERT THE EMPTY STRING, AND THAT EMPTINESS WAS THE DEFECT.
   *
   * With no run active the section rendered `''`, so a recursive-mode session carried the workflow tools and
   * NOTHING that said when they may be used. The observed result was a session titled "Web app stack research
   * and plan" that began scaffolding a run from the first ordinary request: with no rule in the prompt, "the
   * workflow tools are here" reads as "the workflow is the task".
   *
   * The owner's requirement — the person starts the run by asking for a spec/requirement or to start/resume,
   * and until then the run is NOT active — is a rule the model must be TOLD. So the inactive session now
   * carries an explicit contract, and this test requires its load-bearing sentences rather than an absence.
   */
  it('an INACTIVE session states that no run is active and that it must not be started unasked', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'r5-pol-norun-'))
    try {
      mkdirSync(join(repo, '.recursive', 'run'), { recursive: true })
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin, { serverSurface: true, repoRoot: repo })
      const assembly = await ctx.systemPrompt.assemble({ agent: agentLike(repo), scope: {} } as never)
      const section = assembly.sections.find(s => s.name === 'recursive:policy')
      expect(section).toBeDefined()
      const text = section!.text
      // The state, the prohibition, and the ONE thing that licenses a start.
      expect(text).toContain('NO RUN IS ACTIVE')
      expect(text).toContain('Do not create a run for an ordinary request')
      expect(text).toContain('asks for a spec or requirements document')
      expect(text).toContain('explicitly asks to start or resume a run')
      // It must not license a unilateral start, and it must not answer the run-start gate for the person.
      expect(text).toContain('never answer that gate on their behalf')
      // And an inactive session has no phase contract to claim.
      expect(text).not.toContain('Current phase')
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('policy section renders empty when no agent is attached', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'r5-pol-noagent-'))
    try {
      await setupWithRun(repo, 'pol-render-run2')
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(plugin, { serverSurface: true, repoRoot: repo })
      const assembly = await ctx.systemPrompt.assemble({ scope: {} } as never)
      const section = assembly.sections.find(s => s.name === 'recursive:policy')
      expect(section).toBeDefined()
      expect(section!.text).toBe('')
      await ctx.fiber.dispose()
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})