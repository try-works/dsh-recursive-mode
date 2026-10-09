import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
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
import { TOOL_ERRORS } from '../src/errors.ts'

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

  /**
   * A RUN ID IS A NAME, NOT A PATH — and the tool boundary refuses a path-shaped
   * one BEFORE the runtime can mkdir it.
   *
   * MEASURED on this host, not assumed: `initRun` starts with
   * `mkdirSync(join(root, '.recursive', 'run', runId), { recursive: true })`, and
   * that call SUCCEEDS for a separator-shaped id — `nested/child-run` creates
   * `.recursive/run/nested/child-run`, and `..\escaped-run` creates
   * `.recursive/escaped-run`, one level OUT of the run layer. (The live
   * diagnostic's `E:\…` id fails ENOENT instead, which is how it was noticed.)
   * So every id below runs against a PRISTINE root and the assertion is that
   * `.recursive` was never created — an assertion that FAILS without the
   * boundary check, because `mkdirSync` would have created it.
   */
  const PATH_SHAPED_RUN_IDS = [
    'E:\\tmp\\rm-live-diagnostics\\01-calculator-lib', // the live diagnostic's id
    '/tmp/rm-live-diagnostics/01-calculator-lib',
    'nested/child-run',
    '..\\escaped-run',
    '../../escaped-again',
    '..',
    'C:relative-drive-run',
    '.hidden-run',
    '03-trailing-dot.',
    '03 interior space',
  ] as const

  describe('recursive_init refuses a run id that is a path, not a name', () => {
    for (const runId of PATH_SHAPED_RUN_IDS) {
      it('refuses ' + JSON.stringify(runId) + ' and creates nothing', async () => {
        const root = mkdtempSync(join(tmpdir(), 'rm-init-path-'))
        try {
          const ctx = await setup(root)
          const disposer = ctx.tools.register(createRecursiveInitTool(ctx.recursive))
          const out = await ctx.tools.execute({ signal, callId: ToolCallId('c-path'), name: 'recursive_init', arguments: { runId } })
          expect(out.isError).toBe(false)
          const value = out.value as { error?: string; runId?: string }
          expect(value.error, 'a path-shaped runId was not refused').toBeTruthy()
          expect(value.error!.startsWith(TOOL_ERRORS.BAD_RUN_ID.code + ' ' + TOOL_ERRORS.BAD_RUN_ID.klass + ': ')).toBe(true)
          // The message says what a valid id looks like, so the caller can correct it.
          expect(value.error).toContain('no path separator')
          expect(value.error).toContain('01-calculator-lib')
          // A refusal, not a run.
          expect(value.runId).toBeUndefined()
          // THE MESS: nothing was created — no run dir, no run layer, no workspace layer.
          expect(existsSync(join(root, '.recursive')), '.recursive was created by a refused runId').toBe(false)
          disposer()
          await ctx.fiber.dispose()
        } finally { rmSync(root, { recursive: true, force: true }) }
      })
    }

    it('still scaffolds every legitimate naming shape (the rule is not over-restrictive)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'rm-init-ok-'))
      try {
        const ctx = await setup(root)
        const disposer = ctx.tools.register(createRecursiveInitTool(ctx.recursive))
        const legit = ['01-calculator-lib', '01-calculator', 'fixture-run', '01.5-root-cause', 'T25_record']
        for (const [i, runId] of legit.entries()) {
          const out = await ctx.tools.execute({ signal, callId: ToolCallId('c-ok-' + i), name: 'recursive_init', arguments: { runId } })
          expect(out.isError).toBe(false)
          const value = out.value as { runId?: string; created?: string[]; error?: string }
          expect(value.error, runId + ' was refused').toBeUndefined()
          expect(value.runId).toBe(runId)
          expect(value.created!.length).toBeGreaterThan(0)
          expect(existsSync(join(root, '.recursive', 'run', runId, '00-worktree.md'))).toBe(true)
        }
        disposer()
        await ctx.fiber.dispose()
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
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

  /**
   * A RUN ID IS A NAME, NOT A PATH — and this tool's id is the OPTIONAL one, so
   * the gate has to separate three cases that a single truthiness check would
   * blur:
   *
   *   - OMITTED      => the documented default, the latest run by mtime. Must keep working.
   *   - `""`         => refused. `resolveRunDir` reads an empty id as "latest"
   *                     (`if (runId && runId.trim() !== '')`), so silence here
   *                     would answer a mistyped id with a different run's rules.
   *   - path-shaped  => refused (RM1107, the same refusal recursive_init gives).
   *
   * ⚠ WHY THE PATH CASE MATTERS EVEN THOUGH THIS TOOL LOOKS READ-ONLY: it is not.
   * `phaseRules` resolves the id through `resolveRunDir` (a `join`) with NO
   * scoping check, then `recordInjection` WRITES `memory-injections.json` under
   * whatever directory came back. The assertions below therefore check the
   * refusal AND that the record did not land beside the run layer.
   */
  describe('recursive_phase refuses a path-shaped run id but keeps the omitted-id default', () => {
    it('refuses a supplied empty runId instead of silently reading it as "the latest run"', async () => {
      const root = mkdtempSync(join(tmpdir(), 'rm-phase-emptyid-'))
      try {
        const ctx = await setup(root)
        await ctx.recursive.initRun('ph-run', { session: { header: { cwd: root } } })
        const disposer = ctx.tools.register(createRecursivePhaseTool(ctx.recursive))
        const out = await ctx.tools.execute({ signal, callId: ToolCallId('c-empty'), name: 'recursive_phase', arguments: { runId: '' } })
        expect(out.isError).toBe(false)
        const value = out.value as { error?: string; runId?: string; phase?: string }
        expect(value.error, 'an empty runId was accepted').toBeTruthy()
        expect(value.error!.startsWith(TOOL_ERRORS.BAD_RUN_ID.code + ' ' + TOOL_ERRORS.BAD_RUN_ID.klass + ': ')).toBe(true)
        expect(value.runId).toBeUndefined()
        expect(value.phase).toBeUndefined()
        disposer()
        await ctx.fiber.dispose()
      } finally { rmSync(root, { recursive: true, force: true }) }
    })

    for (const runId of ['..\\escaped-run', 'nested/child-run', '.hidden-run'] as const) {
      it('refuses ' + JSON.stringify(runId) + ' and records nothing beside the run layer', async () => {
        const root = mkdtempSync(join(tmpdir(), 'rm-phase-path-'))
        try {
          const ctx = await setup(root)
          await ctx.recursive.initRun('ph-run', { session: { header: { cwd: root } } })
          const disposer = ctx.tools.register(createRecursivePhaseTool(ctx.recursive))
          const out = await ctx.tools.execute({ signal, callId: ToolCallId('c-path'), name: 'recursive_phase', arguments: { runId } })
          expect(out.isError).toBe(false)
          const value = out.value as { error?: string; phase?: string; memory?: string }
          expect(value.error, 'a path-shaped runId was not refused').toBeTruthy()
          expect(value.error!.startsWith(TOOL_ERRORS.BAD_RUN_ID.code + ' ' + TOOL_ERRORS.BAD_RUN_ID.klass + ': ')).toBe(true)
          expect(value.error).toContain('no path separator')
          expect(value.phase).toBeUndefined()
          // THE MESS: `.recursive` holds ONLY the run layer — the id did not resolve
          // to `.recursive\<something>` and leave a record there.
          expect(readdirSync(join(root, '.recursive')).sort()).toEqual(['run'])
          disposer()
          await ctx.fiber.dispose()
        } finally { rmSync(root, { recursive: true, force: true }) }
      })
    }

    it('still defaults to the latest run by mtime when runId is omitted entirely', async () => {
      const root = mkdtempSync(join(tmpdir(), 'rm-phase-latest-'))
      try {
        const ctx = await setup(root)
        await ctx.recursive.initRun('older-run', { session: { header: { cwd: root } } })
        await ctx.recursive.initRun('newer-run', { session: { header: { cwd: root } } })
        const disposer = ctx.tools.register(createRecursivePhaseTool(ctx.recursive))
        const out = await ctx.tools.execute({ signal, callId: ToolCallId('c-latest'), name: 'recursive_phase', arguments: {} })
        expect(out.isError).toBe(false)
        const value = out.value as { runId?: string; phase?: string; error?: string }
        expect(value.error).toBeUndefined()
        expect(value.runId).toBe('newer-run')
        expect(value.phase).toBe('00-requirements.md')
        disposer()
        await ctx.fiber.dispose()
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  })
})
