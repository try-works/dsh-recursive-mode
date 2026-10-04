import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RecursiveRuntime } from '../src/runtime.ts'
import { createRecursiveStatusTool } from '../src/recursive_status.tool.ts'

const FIXTURE_REPO = fileURLToPath(new URL('../tests/fixtures/repo', import.meta.url))
const signal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('recursive-mode walking skeleton', () => {
  it('R2: RecursiveRuntime service provides and mounts exactly once (no collision)', async () => {
    const ctx = await setup()
    const fiber = await ctx.plugin(RecursiveRuntime, { repoRoot: FIXTURE_REPO })
    expect(fiber).toBeDefined()
    expect(ctx.recursive).toBeDefined()
    expect(typeof ctx.recursive.status).toBe('function')
    await expect(ctx.plugin(RecursiveRuntime, { repoRoot: FIXTURE_REPO })).rejects.toThrow(/service "recursive" has been registered/)
    await ctx.fiber.dispose()
  })

  it('R4: recursive_status tool reads through the service (no duplicated parsing)', async () => {
    const ctx = await setup()
    await ctx.plugin(RecursiveRuntime, { repoRoot: FIXTURE_REPO })
    const disposer = ctx.tools.register(createRecursiveStatusTool(ctx.recursive))
    const out = await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'recursive_status', arguments: {} })
    expect(out.isError).toBe(false)
    const value = out.value as { runId: string; phases: unknown[] }
    expect(value.runId).toBe('fixture-run')
    expect(value).toHaveProperty('currentPhase')
    expect(value.phases).toHaveLength(12)
    disposer()
    await ctx.fiber.dispose()
  })

  it('R5: register() accepts recursive_status and its disposer unregisters it', async () => {
    const ctx = await setup()
    await ctx.plugin(RecursiveRuntime, { repoRoot: FIXTURE_REPO })
    const disposer = ctx.tools.register(createRecursiveStatusTool(ctx.recursive))
    expect(ctx.tools.schemas().map(t => t.name)).toContain('recursive_status')
    disposer()
    expect(ctx.tools.schemas().map(t => t.name)).not.toContain('recursive_status')
    await ctx.fiber.dispose()
  })
})