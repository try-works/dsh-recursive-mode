/**
 * T15 — the live enforcement path (plan §4 T15).
 *
 * What was wrong (verified, not assumed):
 *   1. `src/index.ts` called `evaluateToolGuard(exec, root, '', …)` — an EMPTY
 *      runId. `enforceToolGuard` builds `runDir` from that argument, so the
 *      monotonic lock-order and Phase-3 TDD branches resolved prerequisites
 *      against `<root>/.recursive/run` (which holds run DIRECTORIES, not
 *      artifacts) and could never match. The locked-write branch was unaffected
 *      because it resolves its target path directly.
 *   2. `validateTransition` was imported and never called.
 *   3. `detectTamper` had no caller in `index.ts`, and — contrary to the plan's
 *      §2 gap map — there was NO `fs/observed` listener at all; the string
 *      appeared only in comments.
 *
 * These specs drive the LIVE path through `ctx.tools.execute`, so they fail if
 * the listener stops being wired, not merely if a pure function regresses.
 *
 * Distinguishing the guard from the tool: `lockArtifact` has its own
 * prerequisite validation and throws
 *   `Prerequisite blockers: 00-requirements.md (DRAFT)`
 * whereas the guard denies BEFORE dispatch with
 *   `monotonic lock-order: 00-requirements.md (DRAFT)`.
 * Only the guard's wording can appear if the guard short-circuits, so asserting
 * on it proves the guard — not the tool — produced the refusal.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { lockHashFromContent } from '../src/lock.ts'
import { readGuardDecisions, readObservedTampers, guardDecisionLogPath } from '../src/guard-log.ts'

const signal = new AbortController().signal
const RUN_ID = 'guard-run'

/** A minimal DRAFT artifact: enough for Status/lock folding, no gates. */
function draft(runId: string, status = 'DRAFT'): string {
  return 'Run: `/.recursive/run/' + runId + '/`\nPhase: `00 Requirements`\nStatus: `' + status + '`\n\n## TODO\n\n- [ ] x\n'
}

/** A LOCKED artifact whose stored LockHash matches its content (lock-valid). */
function locked(runId: string, tamper = false): string {
  const body = draft(runId, 'LOCKED') + 'Coverage: PASS\nApproval: PASS\nLockedAt: 2026-01-01T00:00:00Z\n'
  const hash = lockHashFromContent(body + 'LockHash: ' + '0'.repeat(64) + '\n')
  const stored = tamper ? 'f'.repeat(64) : hash
  return body + 'LockHash: ' + stored + '\n'
}

interface Mounted {
  ctx: Context
  repo: string
  runDir: string
  dispose: () => Promise<void>
}

/**
 * Mount the REAL plugin (so the tools/pre-execute + fs/observed listeners are
 * live) over a temp repo holding one run.
 */
async function mount(files: Record<string, string>): Promise<Mounted> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-guard-'))
  const runDir = join(repo, '.recursive', 'run', RUN_ID)
  mkdirSync(runDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(runDir, name), content, 'utf8')

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, { repoRoot: repo })
  return {
    ctx,
    repo,
    runDir,
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

/** A stub tool so a WRITE_TOOL_NAMES call has something to dispatch to. */
function stubWriteTool() {
  return defineTool({
    name: 'write',
    description: 'test stub standing in for the host fs write tool',
    parameters: { file_path: { type: 'string' }, content: { type: 'string' } },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() {
      return { wrote: true } as never
    },
  })
}

describe('T15 — the guard resolves the ACTIVE RUN (was: empty runId)', () => {
  it('denies an out-of-order recursive_lock with the guard reason, not the tool reason', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID), '01-as-is.md': draft(RUN_ID) })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g1'),
        name: 'recursive_lock',
        arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      expect(out.isError).toBe(true)
      const message = (out as { error?: { message?: string } }).error?.message ?? ''
      // The GUARD's wording. If the guard let this through, `lockArtifact`'s own
      // check would produce 'Prerequisite blockers: …' instead.
      expect(message).toContain('monotonic lock-order')
      expect(message).toContain('00-requirements.md')
      expect(message).not.toContain('Prerequisite blockers')
    } finally {
      await m.dispose()
    }
  })

  it('records the decision with its rule, run and reason', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID), '01-as-is.md': draft(RUN_ID) })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g2'),
        name: 'recursive_lock',
        arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)

      expect(existsSync(guardDecisionLogPath(m.repo))).toBe(true)
      const decisions = readGuardDecisions(m.repo, 10)
      expect(decisions.length).toBeGreaterThan(0)
      const denied = decisions.filter(d => d.kind === 'deny')
      expect(denied).toHaveLength(1)
      expect(denied[0].rule).toBe('lock-order')
      expect(denied[0].runId).toBe(RUN_ID)
      expect(denied[0].tool).toBe('recursive_lock')
      expect(denied[0].reason).toContain('monotonic lock-order')
    } finally {
      await m.dispose()
    }
  })

  it('reaches validateTransition from the guard and reports its gate set', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID), '01-as-is.md': draft(RUN_ID) })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g3'),
        name: 'recursive_lock',
        arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)

      const [record] = readGuardDecisions(m.repo, 1)
      // Proof the transition gate is ON the live path, not merely exported.
      expect(record.transition).toBeDefined()
      expect(record.transition!.passed).toBe(false)
      // The gate reports failures the guard's own predicates never check — the
      // whole point of consulting it.
      expect(record.transition!.failures.join(' | ')).toMatch(/Effective Inputs Re-read/)
    } finally {
      await m.dispose()
    }
  })

  it('logs an allow too, so the log shows what the guard decided and not only refusals', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID) })
    try {
      const out = await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g4'),
        name: 'recursive_status',
        arguments: { runId: RUN_ID },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      expect(out.isError).toBe(false)
      const decisions = readGuardDecisions(m.repo, 5)
      expect(decisions.some(d => d.kind === 'allow' && d.tool === 'recursive_status')).toBe(true)
    } finally {
      await m.dispose()
    }
  })

  it('still denies a write to a LOCKED artifact through the live path', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID) })
    try {
      m.ctx.tools.register(stubWriteTool())
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g5'),
        name: 'write',
        arguments: { file_path: join(m.runDir, '00-requirements.md'), content: 'x' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      expect(out.isError).toBe(true)
      expect((out as { error?: { message?: string } }).error?.message).toContain('locked-artifact write denial')
      expect(readGuardDecisions(m.repo, 5)[0].rule).toBe('locked-write')
    } finally {
      await m.dispose()
    }
  })
})

describe('T15 — observed-write tamper path (fs/observed had NO listener)', () => {
  it('records a tamper when a locked artifact is observed with a mismatched hash', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID, true) })
    try {
      const emit = (m.ctx as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit.bind(m.ctx)
      emit(
        'fs/observed',
        { displayPath: join(m.runDir, '00-requirements.md') },
        { kind: 'present', version: 'v1' },
        { agent: { session: { header: { cwd: m.repo } } } },
      )
      const tampers = readObservedTampers(m.repo, 5)
      expect(tampers).toHaveLength(1)
      expect(tampers[0].reason).toContain('tampered')
      expect(tampers[0].runId).toBe(RUN_ID)
    } finally {
      await m.dispose()
    }
  })

  it('the listener never throws and never records a clean locked write', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID) })
    try {
      const emit = (m.ctx as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit.bind(m.ctx)
      const actor = { agent: { session: { header: { cwd: m.repo } } } }
      expect(() => emit('fs/observed', { displayPath: join(m.runDir, '00-requirements.md') }, { kind: 'present', version: 'v1' }, actor)).not.toThrow()
      // absent observations and unrelated paths are ignored, never errors
      expect(() => emit('fs/observed', { displayPath: join(m.runDir, '00-requirements.md') }, { kind: 'absent' }, actor)).not.toThrow()
      expect(() => emit('fs/observed', { displayPath: join(m.repo, 'notes.md') }, { kind: 'present', version: 'v1' }, actor)).not.toThrow()
      expect(readObservedTampers(m.repo, 5)).toHaveLength(0)
    } finally {
      await m.dispose()
    }
  })
})

describe('T15 — the board can see tamper facts (foldRunCard hardcoded tampers: {})', () => {
  it('derives a tamper row from the folded lock problems, with no stored state', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID, true) })
    try {
      const { snapshotWorkspace } = await import('../src/snapshot.ts')
      const projection = snapshotWorkspace(m.repo)
      const card = projection[m.repo][RUN_ID]
      const tamperPaths = Object.keys(card.tampers)
      expect(tamperPaths).toHaveLength(1)
      expect(tamperPaths[0]).toBe('00-requirements.md')
      expect(card.tampers['00-requirements.md'].reason).toContain('LockHash mismatch')
    } finally {
      await m.dispose()
    }
  })

  it('a lock-valid run has no tamper rows', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID) })
    try {
      const { snapshotWorkspace } = await import('../src/snapshot.ts')
      const projection = snapshotWorkspace(m.repo)
      expect(Object.keys(projection[m.repo][RUN_ID].tampers)).toHaveLength(0)
    } finally {
      await m.dispose()
    }
  })
})

describe('T15 — recursive_status surfaces the guard decisions', () => {
  it('includes the recent guard decisions for the active run', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID), '01-as-is.md': draft(RUN_ID) })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g6'),
        name: 'recursive_lock',
        arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      const out = await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g7'),
        name: 'recursive_status',
        arguments: { runId: RUN_ID },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      expect(out.isError).toBe(false)
      const value = out.value as { guardDecisions?: Array<{ kind: string; rule: string }> }
      expect(Array.isArray(value.guardDecisions)).toBe(true)
      expect(value.guardDecisions!.some(d => d.kind === 'deny' && d.rule === 'lock-order')).toBe(true)
    } finally {
      await m.dispose()
    }
  })
})
