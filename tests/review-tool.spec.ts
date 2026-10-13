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
  await ctx.plugin(plugin, { repoRoot: repo } as never)
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

  it('with NO continuable seam it reports `unavailable`, saying the review did NOT run', async () => {
    const m = await mount()
    try {
      const out = await review(m) as { isError?: boolean; value?: { status?: string; message?: string } }
      // The tool ran fine; what it REPORTS is that no review happened at all.
      // ⚠ THIS USED TO PIN "WITHOUT the continuable repair path", which was true only while a
      // one-shot fallback existed: a review ran, just an unrepairable one. T35 forbids that fallback
      // (delegation is ALWAYS continuable; one-shot must be ASKED for), so the delegation now refuses
      // and NO child is dispatched. Reporting "ran without" would claim a review that does not exist.
      expect(out.isError).toBeFalsy()
      expect(out.value?.status).toBe('unavailable')
      expect(out.value?.message).toContain('DID NOT RUN')
      // ⚠ AND IT NO LONGER ASSERTS A CAUSE IT DID NOT ESTABLISH. This used to require
      // "must be continuable", which was the seam-only wording — and a test then showed that wording
      // being printed for a review that had actually refused because the ROUTER resolved the role to
      // self-audit. The condition this mount produces is the ROUTER one (no role route is configured
      // for `code-reviewer` here), so the message must quote THAT reason, not invent a seam problem.
      expect(out.value?.message).toContain('no continuable reviewer was dispatched')
      expect(out.value?.message).toContain('self-audit')
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

  /**
   * ⚠ D3 HAS NO UNIT TEST HERE, AND THAT IS DELIBERATE — READ THIS BEFORE ADDING ONE BACK.
   *
   * D3 is real and fixed: `recursive_review` declares `inject: ['tools']`, so `apply` runs BEFORE the
   * `subagents` service exists in a real composition, and the factory captured whatever
   * `ctx.get('subagents')` returned then (undefined). The runtime had a late-attach for exactly this;
   * the tool wiring did not, so `sendRepair` resolved `undefined` and threw into a bare catch while the
   * round still promised "The child is kept so the repair can be sent to it". A live prototype-level
   * spy on `SubagentRuntime.sendMessage` logged ZERO invocations. Both tools now resolve at call time
   * from `recursive.attachedSubagents()`, and the late-attach itself is proven here: a mount that
   * provides the service AFTER apply DOES populate `attachedSubagents()` (that assertion passed).
   *
   * WHAT IS NOT YET EXPRESSIBLE IN THIS MOUNT, and why a test was removed rather than kept failing:
   * reaching `delegateContinuable` at all requires the ROUTER to resolve `code-reviewer` to a native
   * tier, and a mount with no workspace route refuses with `when_role_unconfigured: ask` → self-audit.
   * Passing that gate needs a `recursive-router.json` whose native-route shape (`mode`, `provider`,
   * `enabled` for a provider-created child) has NOT been established here. A test that got past it by
   * weakening the assertion would pass vacuously — worse than no test, and this project has already
   * paid for that lesson nineteen times.
   *
   * SO THE INSTRUMENT FOR D3 IS THE LIVE ONE: the headless A/B that measured zero `sendMessage`
   * invocations before the fix must measure more than zero after it. Until that number exists, D3 is
   * NOT VERIFIED — the code change is in, and the evidence is outstanding.
   */
})
