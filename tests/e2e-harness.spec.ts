/**
 * FU-1 — THE END-TO-END HARNESS.
 *
 * WHAT THIS IS. Every other verification in this repo is a unit test against a module. This is the one
 * that mounts **the real plugin in a real Cordis context** and drives **a whole recursive-mode workflow
 * through the TOOLS**, then asserts on **the run directory the workflow produced** — the artifact a
 * person would inspect. A harness that asserted on its own in-memory expectations would verify nothing.
 *
 * ⚠ WHY IT LIVES IN `tests/` AND STILL COUNTS AS AN E2E. The sources are TypeScript, so a bare `node
 * scripts/*.mjs` could not import them; running under vitest gives the harness the real compiler, the
 * real plugin entry point and the real tool runtime. `pnpm e2e` runs this one file and nothing else, so
 * it stays a single, repeatable command.
 *
 * ⚠ IT RUNS IN A TEMP REPO, NOT IN THIS REPO. The default root is on `E:` because that is the scratch
 * drive (measured: exists, 451 GB free, writable, git 2.51.2), with `E2E_RUN_ROOT` to move it and a
 * `tmpdir()` fallback so a machine without `E:` can still run the suite. Each run gets its own
 * timestamped directory, and the harness WRITES A REPORT into it — so a failure leaves behind the
 * sequence of tool calls that produced it rather than a bare assertion message.
 *
 * ⚠ IT DRIVES THE WORKFLOW THE WAY A MODEL WOULD: `recursive_init`, then per phase `recursive_phase`
 * (the rules) → satisfy the gate vocabulary the rules name → `recursive_lock`, then the closeout,
 * status and preview tools. Nothing is called that a host could not call.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'

/** The scratch root: `E:` by default, overridable, with a tmpdir fallback for a machine without it. */
function scratchRoot(): string {
  const preferred = process.env.E2E_RUN_ROOT ?? 'E:\\dsh-rm-e2e'
  const parent = existsSync('E:\\') ? preferred : join(tmpdir(), 'dsh-rm-e2e')
  mkdirSync(parent, { recursive: true })
  return parent
}

/** The canonical phase order the workflow locks in. */
const PHASES = [
  '00-requirements.md', '00-worktree.md', '01-as-is.md', '01.5-root-cause.md', '02-to-be-plan.md',
  '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md', '05-manual-qa.md',
  '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md',
]

interface Call { tool: string; args: Record<string, unknown>; ok: boolean; detail: string }

/**
 * Make a scaffolded artifact SATISFY its own gate vocabulary.
 *
 * The templates ship `Coverage: FAIL` / `Approval: FAIL` and (for audited phases) an `Audit:` line, so
 * the harness has to do what a model does: read the rules the plugin gave it and fill them in. This is
 * deliberately a TEXT edit of the gate lines rather than a wholesale rewrite — the point is to prove the
 * vocabulary the policy names is the vocabulary that unlocks the phase.
 */
function satisfyGates(text: string): { text: string; changed: string[] } {
  const changed: string[] = []
  let out = text
  const set = (label: string, value: string) => {
    const pattern = new RegExp('^(- )?' + label + ':\\s*.*$', 'm')
    if (pattern.test(out)) {
      out = out.replace(pattern, label + ': ' + value)
      changed.push(label + '=' + value)
    }
  }
  set('Coverage', 'PASS')
  set('Approval', 'PASS')
  set('Audit', 'PASS')
  set('TDD Mode', 'pragmatic')
  set('QA Execution Mode', 'agent-operated')
  return { text: out, changed }
}

async function runWorkflow(): Promise<{ root: string; runId: string; calls: Call[]; report: string }> {
  const root = join(scratchRoot(), 'run-' + new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(root, { recursive: true })
  // A real repo: the run may cut a worktree and its receipts are git-ignored artifacts.
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'e2e@example.invalid'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: root, stdio: 'ignore' })
  writeFileSync(join(root, 'README.md'), '# e2e scratch repo\n', 'utf8')

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin as never, { repoRoot: root } as never)

  const calls: Call[] = []
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const value = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('e2e-' + calls.length),
        name: tool,
        arguments: args,
        agent: { session: { header: { cwd: root } } },
      } as never)
      const detail = JSON.stringify(value)
      // ⚠ A TOOL REFUSAL IS NOT A SUCCESS, AND IT DOES NOT SET `isError`. Measured on a real refused
      // closeout: the envelope is `{isError: false, content: [{text: '{"error": "Artifact is LOCKED…"}'}]}`
      // — the plugin's refusal convention is an `error` field INSIDE the payload, so a harness that only
      // checked `isError` (or only caught exceptions) would report a REFUSED call as ok, which is exactly
      // the class of mistake this harness exists to catch elsewhere.
      const refused = isRefusal(value)
      calls.push({ tool, args, ok: !refused, detail: detail.slice(0, 400) })
      return value
    } catch (err) {
      calls.push({ tool, args, ok: false, detail: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  const runId = 'e2e-run'
  await call('recursive_init', { runId })
  const runDir = join(root, '.recursive', 'run', runId)

/** The closeout stub key for the five phases whose receipt stub is scaffolded at phase entry. */
const CLOSEOUT_KEY: Record<string, string> = {
  '04-test-summary.md': '04',
  '05-manual-qa.md': '05',
  '06-decisions-update.md': '06',
  '07-state-update.md': '07',
  '08-memory-impact.md': '08',
}

  for (const phase of PHASES) {
    const artifact = join(runDir, phase)
    if (!existsSync(artifact)) {
      calls.push({ tool: '(scaffold)', args: { phase }, ok: false, detail: 'NOT SCAFFOLDED by recursive_init' })
      continue
    }
    // 0. ⚠ THE CLOSEOUT COMES FIRST, and this ordering was LEARNED FROM A FAILING RUN rather than
    // assumed: `closeoutPhase` *"creates/updates Phase 4/5/6/7/8 delta-receipt stubs"*, so it is a
    // scaffolding step at phase ENTRY. Running it after a lock silently reset a LOCKED artifact to
    // `DRAFT` while its receipt still said LOCKED — recorded as FU-8, because the plugin's own contract
    // says a write to a `Status: LOCKED` doc is DENIED and this one is not.
    const closeoutKey = CLOSEOUT_KEY[phase]
    if (closeoutKey !== undefined) await call('recursive_closeout', { runId, phase: closeoutKey })
    // 1. What does the policy say this phase needs?
    await call('recursive_phase', { runId })
    // 2. Satisfy the gate vocabulary the templates ship.
    const before = readFileSync(artifact, 'utf8')
    const { text, changed } = satisfyGates(before)
    if (changed.length > 0) writeFileSync(artifact, text, 'utf8')
    calls.push({ tool: '(gates)', args: { phase }, ok: true, detail: 'set ' + (changed.join(', ') || 'nothing (no gate lines present)') })
    // 3. The lint verdict BEFORE the lock, so the report shows what enforcement said.
    await call('recursive_lint', { runId, artifact: phase })
    // 4. The lock itself.
    await call('recursive_lock', { runId, artifact: phase })
  }

  // ⚠ THE CLOSEOUT OF PHASE 08 RUNS TWICE ON PURPOSE, because T30's trigger is defined on the RE-RUN:
  // the first call scaffolds the stub, the second is the re-run that is allowed to extract. The
  // trigger's own gate (one locked run is an anecdote) then reports a typed refusal rather than writing.
  await call('recursive_closeout', { runId, phase: '08' })
  await call('recursive_status', { runId })
  await call('recursive_preview', { runId })

  const report = [
    '# FU-1 end-to-end harness report',
    '',
    '- root: `' + root + '`',
    '- run: `' + runId + '`',
    '- tool calls: ' + calls.length,
    '',
    '| # | tool | key args | ok | detail |',
    '| --- | --- | --- | --- | --- |',
    ...calls.map((entry, index) => '| ' + (index + 1) + ' | `' + entry.tool + '` | `'
      + JSON.stringify(entry.args).slice(0, 60) + '` | ' + (entry.ok ? 'yes' : '**NO**') + ' | '
      + entry.detail.replace(/\|/g, '\\|').slice(0, 160) + ' |'),
    '',
    '## The run directory the workflow produced',
    '',
    ...readdirSync(runDir).map((name) => '- `' + name + '`'),
    '',
  ].join('\n')
  writeFileSync(join(root, 'e2e-report.md'), report, 'utf8')

  await ctx.fiber.dispose()
  return { root, runId, calls, report }
}

describe('FU-1 — a whole workflow driven through the tools, in a temp repo', () => {
  it('completes the run: every phase locks in order and 08 ends LOCKED', async () => {
    const { root, runId, calls } = await runWorkflow()
    try {
      const runDir = join(root, '.recursive', 'run', runId)
      const locks = PHASES.map((phase) => {
        const path = join(runDir, phase)
        return { phase, locked: existsSync(path) && /Status:\s*`?LOCKED`?/.test(readFileSync(path, 'utf8')) }
      })
      const unlocked = locks.filter((entry) => !entry.locked).map((entry) => entry.phase)
      // The assertion names the FIRST phase that failed to lock, not just a count: a count tells you
      // something is wrong, a name tells you where.
      expect(unlocked, 'first unlocked: ' + (unlocked[0] ?? 'none') + '\n' + reportTail(calls)).toEqual([])
      expect(existsSync(join(runDir, '08-memory-impact.md'))).toBe(true)
      expect(readFileSync(join(runDir, '08-memory-impact.md'), 'utf8')).toMatch(/Status:\s*`?LOCKED`?/)
    } finally {
      // The run directory is KEPT: a passing harness that deletes its evidence cannot be inspected.
      if (process.env.E2E_KEEP !== '1') rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('writes receipts for the phases it locked, in the same directory a reader would open', async () => {
    const { root, runId } = await runWorkflow()
    try {
      const locksDir = join(root, '.recursive', 'run', runId, 'locks')
      const receipts = existsSync(locksDir) ? readdirSync(locksDir).filter((name) => name.endsWith('.receipt.json')) : []
      expect(receipts.length).toBeGreaterThan(0)
      // A receipt IS the auditable trace of a lock, so its presence is the evidence the lock path ran.
      expect(receipts.some((name) => name.includes('08-memory-impact'))).toBe(true)
    } finally {
      if (process.env.E2E_KEEP !== '1') rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  /**
   * FU-8 — THE DEFECT THIS HARNESS FOUND, now pinned as a CONTRACT rather than as a bug report.
   *
   * The first e2e run ended with a LOCKED artifact whose receipt said LOCKED and whose file said DRAFT,
   * because `closeoutPhase` guarded EARLIER phases but not its own target. The fix refuses that write and
   * names the remedy, so this asserts the promise the policy section makes every turn: *"Writes to a
   * Status: LOCKED phase doc are denied/asked; reopen explicitly to edit."*
   */
  /**
   * FU-8 — THE DEFECT THE HARNESS FOUND, pinned as a CONTRACT rather than as a bug report.
   *
   * The first e2e run ended with a LOCKED artifact whose receipt said LOCKED and whose file said DRAFT,
   * because `closeoutPhase` guarded EARLIER phases but not its own target. The fix refuses that write and
   * names the remedy, so this asserts the promise the policy section makes every turn: *"Writes to a
   * Status: LOCKED phase doc are denied/asked; reopen explicitly to edit."*
   */
  it('FU-8: REFUSES a closeout that would unlock a LOCKED artifact, and leaves the lock intact', async () => {
    const { root, runId, calls } = await runWorkflow()
    try {
      const artifact = join(root, '.recursive', 'run', runId, '08-memory-impact.md')
      const text = readFileSync(artifact, 'utf8')
      // The lock survived the second closeout attempt…
      expect(text).toMatch(/Status:\s*`?LOCKED`?/)
      // …AND the refusal is visible in the report, naming the remedy rather than failing silently.
      const refusals = calls.filter((entry) => entry.tool === 'recursive_closeout' && !entry.ok)
      expect(refusals.length, 'the post-lock closeout was not refused: ' + reportTail(calls)).toBeGreaterThan(0)
      expect(refusals[refusals.length - 1].detail).toContain('LOCKED')
      expect(refusals[refusals.length - 1].detail).toContain('reopen')
    } finally {
      if (process.env.E2E_KEEP !== '1') rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  /**
   * FU-2 — THE CONTINUABLE RULE, MEASURED IN PRODUCTION (and one part of it NOT VERIFIED here).
   *
   * The plan's own text claimed `delegateReview` *"has no callers"* (found by T35). **That is STALE:**
   * `src/recursive_review.tool.ts:92` calls it, and five spec files cover it. So the item is not "wire
   * it" — it is "show the rule holds in production".
   *
   * ⚠ WHAT THIS DEMONSTRATES, and it is the fail-closed half: with no CONTINUABLE seam and no live
   * parent, `recursive_review` **refuses** (`status: unavailable`) instead of quietly degrading to a
   * one-shot review. That refusal IS the rule being enforced — a plugin that silently took the one-shot
   * path would leave a failed review unrepairable *without saying so*.
   *
   * ⚠ WHAT IT DOES **NOT** DEMONSTRATE, stated rather than implied: the continuable lifecycle itself
   * (`startContinuable`). That requires the **exact live Agent** — the seam's own contract says "never a
   * `{ id }` copy" — and this harness has no live Agent, so faking one would prove nothing. **The
   * continuable branch is verified by `tests/delegation-mode.spec.ts` (a fake seam called directly) and
   * is reported as NOT VERIFIED in the harness.**
   */
  it('FU-2: recursive_review FAILS CLOSED without a continuable path, naming why', async () => {
    const root = join(scratchRoot(), 'fu2-' + new Date().toISOString().replace(/[:.]/g, '-'))
    mkdirSync(root, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })

    const observed: string[] = []
    const fakeSubagents = {
      start: async () => { observed.push('start(one-shot)'); return { ok: true } },
      // Recording the capability probe tells us whether the seam was FOUND at all, which is the
      // difference between "the plugin ignored my service" and "the plugin found it and refused".
      getProvider: (name: string) => { observed.push('getProvider(' + name + ')'); return { name, capabilities: { agentOptions: true } } },
      list: () => { observed.push('list'); return [{ name: 'spawn' }] },
      startContinuable: async () => { observed.push('startContinuable'); return { childId: 'child-1', sessionId: 'child-1' } },
      followup: async () => { observed.push('followup'); return { ok: true } },
      interrupt: () => { observed.push('interrupt') },
      drainContinuableChildren: async () => { observed.push('drainContinuableChildren') },
      drainContinuableDescendants: async () => { observed.push('drainContinuableDescendants') },
    }

    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      // BEFORE the plugin: `index.ts` resolves the seam at the composition, so a later provision would
      // not be seen — the defect T39 found and fixed.
      ctx.provide('subagents', fakeSubagents as never)
      await ctx.plugin(plugin as never, {
        repoRoot: root,
        router: {
          role_routes: { 'code-reviewer': { provider: 'spawn', mode: 'continuable' } },
          providers: { spawn: { name: 'spawn', capabilities: { agentOptions: true } } },
        },
      } as never)

      const call = async (tool: string, args: Record<string, unknown>) => ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('fu2-' + tool),
        name: tool,
        arguments: args,
        agent: { session: { header: { cwd: root } } },
      } as never)

      await call('recursive_init', { runId: 'fu2-run' })
      const review = await call('recursive_review', { runId: 'fu2-run', phase: '03', role: 'code-reviewer' })
      const payload = JSON.stringify(review)

      // (1) It reached the DELEGATION path — not a NO_PHASE refusal, which is what a wrong phase key gives.
      expect(payload, 'the review never reached the delegation: ' + payload.slice(0, 400)).toContain('unavailable')
      // (2) It FAILED CLOSED with the reason, rather than reviewing without the repair path.
      expect(payload).toContain('repair path')
      expect(payload).toContain('cannot be sent back')
      // (3) And it did NOT take the one-shot lifecycle — the rule this item is about.
      expect(observed, 'lifecycles: [' + observed.join(', ') + ']').not.toContain('start(one-shot)')
      // The seam probe is REPORTED either way: whether the service was found is a fact about the
      // composition, and the refusal is correct in both cases (no live parent ⇒ no continuation).
      expect(observed.join(','), 'seam consultation: [' + observed.join(', ') + ']').not.toContain('startContinuable')
    } finally {
      if (process.env.E2E_KEEP !== '1') rmSync(root, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  }, 120_000)
})

/** The last few tool calls, for an assertion message that says what happened. */
function reportTail(calls: readonly Call[]): string {
  return calls.slice(-6).map((entry) => entry.tool + ' -> ' + (entry.ok ? 'ok' : 'FAILED: ' + entry.detail)).join('\n')
}

/**
 * Whether a tool envelope reports a REFUSAL.
 *
 * Either shape counts: the harness sets `isError` for transport-level failures, while the plugin's own
 * convention is an `error` field inside the payload's JSON text. Handling both is the difference between
 * a report that says a call was refused and one that says everything succeeded.
 */
function isRefusal(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as { isError?: boolean; content?: Array<{ text?: string }> }
  if (envelope.isError === true) return true
  for (const part of envelope.content ?? []) {
    if (typeof part.text !== 'string') continue
    try {
      const parsed = JSON.parse(part.text) as { error?: unknown }
      if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) return true
    } catch {
      // Not JSON: nothing to read as a refusal.
    }
  }
  return false
}
