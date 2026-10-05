/**
 * T36 — `recursive_review` is REACHABLE and HONEST.
 *
 * The driver, the observer and the verdict contract all have their own specs; what
 * this one proves is the layer the operator's requirement actually needs: that the
 * tool is registered, that a plugin mount can call it, and that when the continuable
 * seam is missing it reports `unavailable` naming the lost repair path instead of
 * pretending the review was a success. A review tool that silently degrades to
 * "approved" without being able to repair anything would be worse than no tool.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { TOOL_ERRORS } from '../src/errors.ts'

const signal = new AbortController().signal
const RUN_ID = 'review-run'

interface Mounted {
  ctx: Context
  repo: string
  dispose: () => Promise<void>
}

/** Mount the real plugin over a temp repo holding one run with a DRAFT artifact. */
async function mount(options: { artifact?: boolean } = {}): Promise<Mounted> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-reviewtool-'))
  const runDir = join(repo, '.recursive', 'run', RUN_ID)
  mkdirSync(runDir, { recursive: true })
  if (options.artifact !== false) {
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: `x`\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n', 'utf8')
  }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, { repoRoot: repo })
  return {
    ctx,
    repo,
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

function review(m: Mounted, args: Record<string, unknown> = {}) {
  return m.ctx.tools.execute({
    signal,
    callId: ToolCallId('rev-1'),
    name: 'recursive_review',
    arguments: { runId: RUN_ID, ...args },
    agent: { session: { header: { cwd: m.repo } } },
  } as never)
}

describe('T36 — recursive_review is registered and callable', () => {
  it('is a real tool on the registration surface', async () => {
    const m = await mount()
    try {
      expect(m.ctx.tools.get('recursive_review')).toBeTruthy()
    } finally {
      await m.dispose()
    }
  })

  it('with NO continuable seam it reports `unavailable`, naming the lost repair path', async () => {
    const m = await mount()
    try {
      const out = await review(m) as { isError?: boolean; value?: { status?: string; message?: string } }
      // The tool ran fine; what it REPORTS is that the repair path does not exist.
      expect(out.isError).toBeFalsy()
      expect(out.value?.status).toBe('unavailable')
      expect(out.value?.message).toContain('WITHOUT the continuable repair path')
    } finally {
      await m.dispose()
    }
  })

  it('refuses a phase with no artifact to review, with a CODED refusal', async () => {
    const m = await mount({ artifact: false })
    try {
      const out = await review(m)
      // The plugin's convention is a `{ error }` field in the returned value (all
      // nine other tools do the same), not the harness's isError flag — so that is
      // what a caller branches on, and it must carry the registry code.
      expect(JSON.stringify(out)).toContain(TOOL_ERRORS.NO_PHASE.code)
    } finally {
      await m.dispose()
    }
  })

  it('an unknown runId is NOT a refusal: status resolves the latest run instead', async () => {
    // Deliberate existing behaviour — `resolveRunDir` falls back to the latest run by
    // mtime, so an unknown id reviews what IS there rather than erroring. Pinned here
    // so a future change to that fallback shows up as a failure rather than as a
    // silently different review target.
    const m = await mount()
    try {
      const out = await review(m, { runId: 'no-such-run' })
      expect(JSON.stringify(out)).not.toContain(TOOL_ERRORS.NO_RUN.code)
    } finally {
      await m.dispose()
    }
  })
})
