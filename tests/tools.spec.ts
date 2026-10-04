import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RecursiveRuntime } from '../src/runtime.ts'
import { createRecursiveInitTool } from '../src/recursive_init.tool.ts'
import { createRecursiveLockTool } from '../src/recursive_lock.tool.ts'
import { createRecursiveLintTool } from '../src/recursive_lint.tool.ts'
import { createRecursivePhaseTool } from '../src/recursive_phase.tool.ts'

const FIXTURE_REPO = fileURLToPath(new URL('../tests/fixtures/repo', import.meta.url))
const signal = new AbortController().signal

async function setup(repoRoot: string) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(RecursiveRuntime, { repoRoot })
  return ctx
}

describe('recursive-mode read-path tools (R4)', () => {
  let tmpRoot: string

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rm-tools-'))
    mkdirSync(join(tmpRoot, '.recursive', 'run'), { recursive: true })
  })

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('registers recursive_init/recursive_lock/recursive_lint/recursive_phase tools', async () => {
    const ctx = await setup(tmpRoot)
    const d1 = ctx.tools.register(createRecursiveInitTool(ctx.recursive))
    const d2 = ctx.tools.register(createRecursiveLockTool(ctx.recursive))
    const d3 = ctx.tools.register(createRecursiveLintTool(ctx.recursive))
    const d4 = ctx.tools.register(createRecursivePhaseTool(ctx.recursive))
    const names = ctx.tools.schemas().map(t => t.name)
    expect(names).toContain('recursive_init')
    expect(names).toContain('recursive_lock')
    expect(names).toContain('recursive_lint')
    expect(names).toContain('recursive_phase')
    d1(); d2(); d3(); d4()
    await ctx.fiber.dispose()
  })

  it('recursive_init scaffolds a run dir in the temp repo (idempotent)', async () => {
    const ctx = await setup(tmpRoot)
    const disposer = ctx.tools.register(createRecursiveInitTool(ctx.recursive))
    const out = await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'recursive_init', arguments: { runId: 'tmp-run' } })
    expect(out.isError).toBe(false)
    const value = out.value as { runId: string; created: string[]; existing: string[] }
    expect(value.runId).toBe('tmp-run')
    expect(value.created.length).toBeGreaterThan(0)
    // idempotent: second call creates nothing new
    const out2 = await ctx.tools.execute({ signal, callId: ToolCallId('c1b'), name: 'recursive_init', arguments: { runId: 'tmp-run' } })
    const value2 = out2.value as { created: string[] }
    expect(value2.created.length).toBe(0)
    disposer()
    await ctx.fiber.dispose()
  })

  it('recursive_lock rejects locking without prerequisites', async () => {
    const ctx = await setup(tmpRoot)
    const disposer = ctx.tools.register(createRecursiveLockTool(ctx.recursive))
    const out = await ctx.tools.execute({ signal, callId: ToolCallId('c2'), name: 'recursive_lock', arguments: { runId: 'tmp-run', artifact: '02-to-be-plan.md' } })
    expect(out.isError).toBe(false)
    const value = out.value as { error?: string }
    expect(value.error).toBeTruthy()
    disposer()
    await ctx.fiber.dispose()
  })

  it('recursive_lint reports issues on a DRAFT artifact', async () => {
    const ctx = await setup(FIXTURE_REPO)
    const disposer = ctx.tools.register(createRecursiveLintTool(ctx.recursive))
    const out = await ctx.tools.execute({ signal, callId: ToolCallId('c3'), name: 'recursive_lint', arguments: { runId: 'fixture-run', artifact: '00-requirements.md' } })
    expect(out.isError).toBe(false)
    const value = out.value as { passed: boolean; warnings: string[] }
    expect(typeof value.passed).toBe('boolean')
    disposer()
    await ctx.fiber.dispose()
  })

  it('recursive_phase returns { error } when no active run', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'rm-phase-empty-'))
    try {
      mkdirSync(join(emptyRoot, '.recursive', 'run'), { recursive: true })
      const ctx = await setup(emptyRoot)
      const disposer = ctx.tools.register(createRecursivePhaseTool(ctx.recursive))
      const out = await ctx.tools.execute({ signal, callId: ToolCallId('c4'), name: 'recursive_phase', arguments: {} })
      expect(out.isError).toBe(false)
      const value = out.value as { error?: string }
      expect(value.error).toBeTruthy()
      disposer()
      await ctx.fiber.dispose()
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })

  it('recursive_phase returns current phase rules JSON after initRun', async () => {
    const phaseRoot = mkdtempSync(join(tmpdir(), 'rm-phase-'))
    try {
      const ctx = await setup(phaseRoot)
      await ctx.recursive.initRun('ph-run', { session: { header: { cwd: phaseRoot } } })
      const disposer = ctx.tools.register(createRecursivePhaseTool(ctx.recursive))
      const out = await ctx.tools.execute({ signal, callId: ToolCallId('c5'), name: 'recursive_phase', arguments: { runId: 'ph-run' } })
      expect(out.isError).toBe(false)
      const value = out.value as { runId: string; phase: string; requiredSections: string[]; audited: boolean }
      expect(value.runId).toBe('ph-run')
      expect(value.phase).toBe('00-requirements.md')
      expect(Array.isArray(value.requiredSections)).toBe(true)
      expect(typeof value.audited).toBe('boolean')
      disposer()
      await ctx.fiber.dispose()
    } finally {
      rmSync(phaseRoot, { recursive: true, force: true })
    }
  })
})
