/**
 * A RUN ID IS A NAME, NOT A PATH — THE TOOL BOUNDARY, FOR THE THREE TOOLS THAT
 * NEVER HAD THE GATE. (`recursive_worktree` is covered in `tests/worktree.spec.ts`,
 * with its branch half; `recursive_init` in `tests/tools.spec.ts`.)
 *
 * WHY A BOUNDARY GATE AND NOT A RUNTIME ONE, MEASURED RATHER THAN ASSUMED.
 * `scratchRun` and `closeoutRun` DO scope themselves to the workspace —
 *
 *     const runDir = join(root, '.recursive', 'run', runId)
 *     const runRoot = join(root, '.recursive', 'run')
 *     if (!runDir.startsWith(runRoot) || !existsSync(runDir)) return { error: 'Run not found…' }
 *
 * — and that check is NOT the protection it reads as. `join` collapses `..`, so
 * the runId `..\run-away` resolves to `<root>\.recursive\run-away`, and a STRING
 * `startsWith` says yes: the resolved path begins with the characters
 * `<root>\.recursive\run`. The check proves a shared spelling, not containment,
 * so a `..\` id that lands on any sibling of the run layer whose name begins with
 * `run` passes it — and `scratchRun` then WRITES there, and `closeoutRun` writes
 * a receipt there. `recursive_phase` has no scoping check at all: `phaseRules` ->
 * `resolveRunDir` joins the id and `recordInjection` writes
 * `memory-injections.json` under the result.
 *
 * So all three resolve a run through a PATH, and a path-shaped id must be
 * refused where the name enters. The assertions below state the mess that must
 * not happen — the sibling stays untouched — as well as the refusal itself, and
 * each has a live positive control so "nothing was written" cannot pass merely
 * because the test root could never receive a write.
 *
 * MEASURED pre-fix by running this file against the unguarded sources: all 10
 * refusal tests fail and both positive controls keep passing (so the assertions
 * are non-vacuous, and the failures are the guards' absence rather than a broken
 * fixture). The escapes that a `..\` segment makes reachable were ACCEPTED and
 * acted on — `recursive_scratch` wrote `scratch.md` into the sibling for
 * `..\run-away` and `../run-away`, and `recursive_closeout` reached the closeout
 * report for both — while the other three ids were stopped one layer further
 * down, by their sibling not happening to exist. That is the layer the gate adds:
 * the answer no longer depends on what is on the operator's disk.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RecursiveRuntime } from '../src/runtime.ts'
import { createRecursiveScratchTool } from '../src/recursive_scratch.tool.ts'
import { createRecursiveCloseoutTool } from '../src/recursive_closeout.tool.ts'
import { TOOL_ERRORS } from '../src/errors.ts'

const signal = new AbortController().signal

async function setup(repoRoot: string) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(RecursiveRuntime, { repoRoot })
  return ctx
}

/**
 * A workspace holding ONLY a sibling of the run layer, named so that the escape
 * passes `startsWith(<root>/.recursive/run)`.
 *
 * The name is chosen for the reason above, not for tidiness: `..\run-away` is the
 * id that defeats the runtime's scoping check, so it is the id whose refusal this
 * file has to pin. There is deliberately NO `.recursive/run` here — a workspace
 * with no run layer at all is the weakest possible setup, and the reason the
 * sibling cannot be reached by accident.
 */
function workspaceWithSiblingRunLayer(tag: string): { root: string; sibling: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), 'rm-escape-' + tag + '-'))
  const sibling = join(root, '.recursive', 'run-away')
  mkdirSync(sibling, { recursive: true })
  return { root, sibling, runId: '..\\run-away' }
}

/**
 * One tool call the way the agent loop makes it: through the ToolRuntime, with a
 * session cwd, because `recursive_scratch`/`recursive_closeout` resolve the
 * control-plane root from it (there is no repoRoot fallback on that path). The
 * refused cases pass it too, deliberately: the refusal must not depend on the
 * workspace resolving at all.
 */
async function call(ctx: Context, name: string, args: Record<string, unknown>, cwd: string) {
  return await ctx.tools.execute({
    signal, callId: ToolCallId('run-id-boundary-' + name), name, arguments: args,
    agent: { session: { header: { cwd } } },
  } as never)
}

/** Refused ids that all resolve to a path OUTSIDE the run layer. */
const ESCAPING_RUN_IDS = ['..\\run-away', '../run-away', '..\\escaped-run', 'nested/child-run', '.hidden-run'] as const

describe('recursive_scratch refuses a run id that is a path, not a name', () => {
  for (const runId of ESCAPING_RUN_IDS) {
    it('refuses ' + JSON.stringify(runId) + ' and writes nothing outside the run layer', async () => {
      const { root, sibling } = workspaceWithSiblingRunLayer('scratch')
      try {
        // The escape could only produce a file if the sibling LOOKED like a run — hence a
        // `scratch/` inside it. It stays empty: that is the assertion, not the setup.
        mkdirSync(join(sibling, 'scratch'), { recursive: true })
        const ctx = await setup(root)
        const disposer = ctx.tools.register(createRecursiveScratchTool(ctx.recursive))
        const out = await call(ctx, 'recursive_scratch', { action: 'write', runId, target: 'md', content: 'escaped' }, root)
        expect(out.isError).toBe(false)
        const value = out.value as { error?: string; runId?: string; path?: string }
        expect(value.error, 'a path-shaped runId was not refused').toBeTruthy()
        expect(value.error!.startsWith(TOOL_ERRORS.BAD_RUN_ID.code + ' ' + TOOL_ERRORS.BAD_RUN_ID.klass + ': ')).toBe(true)
        expect(value.error).toContain('no path separator')
        // A refusal, not a write: no run reported, no path reported.
        expect(value.runId).toBeUndefined()
        expect(value.path).toBeUndefined()
        // THE MESS: the sibling received nothing — it did not even acquire a scratch file.
        expect(readdirSync(join(sibling, 'scratch'))).toEqual([])
        disposer()
        await ctx.fiber.dispose()
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }

  it('still writes the scratchpad for a legitimate run id (the control: this root CAN be written to)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-escape-ok-'))
    try {
      const ctx = await setup(root)
      await ctx.recursive.initRun('fixture-run', { session: { header: { cwd: root } } })
      const disposer = ctx.tools.register(createRecursiveScratchTool(ctx.recursive))
      const out = await call(ctx, 'recursive_scratch', { action: 'write', runId: 'fixture-run', target: 'md', content: 'kept' }, root)
      expect(out.isError).toBe(false)
      const value = out.value as { error?: string; runId?: string }
      expect(value.error, 'fixture-run was refused').toBeUndefined()
      expect(value.runId).toBe('fixture-run')
      expect(readdirSync(join(root, '.recursive', 'run', 'fixture-run', 'scratch'))).toContain('scratch.md')
      disposer()
      await ctx.fiber.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('recursive_closeout refuses a run id that is a path, not a name', () => {
  for (const runId of ESCAPING_RUN_IDS) {
    it('refuses ' + JSON.stringify(runId) + ' and writes no receipt outside the run layer', async () => {
      const { root, sibling } = workspaceWithSiblingRunLayer('closeout')
      try {
        // A real-looking artifact in the sibling, so a run resolved there would pass the
        // existence half of the runtime's check and reach the receipt write.
        writeFileSync(join(sibling, '04-test-summary.md'), '# Test Summary\n', 'utf8')
        const ctx = await setup(root)
        const disposer = ctx.tools.register(createRecursiveCloseoutTool(ctx.recursive))
        const out = await call(ctx, 'recursive_closeout', { phase: '04', runId }, root)
        expect(out.isError).toBe(false)
        const value = out.value as { error?: string; runId?: string; closeoutPhase?: string }
        expect(value.error, 'a path-shaped runId was not refused').toBeTruthy()
        expect(value.error!.startsWith(TOOL_ERRORS.BAD_RUN_ID.code + ' ' + TOOL_ERRORS.BAD_RUN_ID.klass + ': ')).toBe(true)
        expect(value.runId).toBeUndefined()
        expect(value.closeoutPhase).toBeUndefined()
        // THE MESS: the sibling still holds exactly the artifact it started with — no
        // `locks/` directory, no `<stem>.closeout.receipt.json`.
        expect(readdirSync(sibling).sort()).toEqual(['04-test-summary.md'])
        disposer()
        await ctx.fiber.dispose()
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  }

  it('still reaches the real run for a legitimate run id, and writes its receipt there (the control)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-escape-ok-'))
    try {
      const ctx = await setup(root)
      await ctx.recursive.initRun('fixture-run', { session: { header: { cwd: root } } })
      const disposer = ctx.tools.register(createRecursiveCloseoutTool(ctx.recursive))
      const out = await call(ctx, 'recursive_closeout', { phase: '04', runId: 'fixture-run' }, root)
      expect(out.isError).toBe(false)
      const value = out.value as { error?: string; runId?: string; closeoutPhase?: string }
      // Not a refusal: the call got all the way to the run — whatever the closeout
      // standard then reports about a DRAFT phase 04 is the closeout's business.
      expect(value.error ?? '').not.toContain(TOOL_ERRORS.BAD_RUN_ID.code)
      expect(value.runId).toBe('fixture-run')
      expect(value.closeoutPhase).toBe('04')
      // ⚠ THE RECEIPT IS ASSERTED, because this control is what makes the sibling-empty
      // assertion above non-vacuous: it shows this exact setup DOES reach a write, so
      // "the sibling is unchanged" is the boundary refusing, not a root nothing can reach.
      expect(existsSync(join(root, '.recursive', 'run', 'fixture-run', 'locks', '04-test-summary.closeout.receipt.json')), 'the control wrote no receipt, so the sibling assertion proves nothing').toBe(true)
      disposer()
      await ctx.fiber.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
