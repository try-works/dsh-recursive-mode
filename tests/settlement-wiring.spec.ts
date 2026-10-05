/**
 * T36 — the `session/event` hookup is LIVE, not just written.
 *
 * The unit suite proves the recognition and the placement logic; this spec proves
 * the plugin actually SUBSCRIBES, which is the half that was missing. It mounts the
 * real plugin entry the same way `tests/guard-path.spec.ts` does — through
 * `ctx.plugin(plugin, { repoRoot })` — and delivers a settlement the way the
 * harness does: as a committed `session/event`.
 *
 * The listener is wired to EVERY session event in EVERY session, so the cases that
 * matter as much as the happy path are the ones it must IGNORE: a non-settlement
 * event, a settlement for a child no run owns, and a session whose cwd is unknown.
 * Each of those must leave the run's log untouched rather than filing something
 * plausible-looking into the wrong place.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { readSettlement, readSettlements, settlementLogPath } from '../src/settlement.ts'

const RUN_ID = 'settle-run'
const CHILD = 'child-abc'

interface Mounted {
  ctx: Context
  repo: string
  runDir: string
  dispose: () => Promise<void>
}

/**
 * Mount the REAL plugin over a temp repo holding one run whose delegation wrote a
 * `child-<CHILD>` directory — the on-disk fact that places a settlement.
 */
async function mount(options: { childDir?: boolean } = {}): Promise<Mounted> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-settlew-'))
  const runDir = join(repo, '.recursive', 'run', RUN_ID)
  mkdirSync(runDir, { recursive: true })
  if (options.childDir !== false) {
    mkdirSync(join(runDir, 'subagents', 'd1', 'child-' + CHILD), { recursive: true })
  }
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

/** The harness's settlement notice, as it is delivered to the listener. */
function settlementEvent(childId = CHILD) {
  const summary = 'Background subagent ' + childId + ' finished and will do no further work unless you send it more.'
  return {
    type: 'user/message',
    data: {
      id: 'm1',
      content: [
        { type: 'text', text: summary },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: '{"verdict":"REVISE"}' },
      ],
      source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: childId },
    },
  }
}

/**
 * Deliver one session event the way the harness does.
 *
 * Structural cast, exactly as the plugin's own listeners obtain `ctx.on`: the base
 * Context event map does not carry `session/event` (the session package augments
 * it), and the plugin deliberately depends on the shape rather than the concrete
 * type, so the spec does the same instead of pulling in an augmentation.
 */
function deliver(ctx: Context, session: unknown, event: unknown): void {
  ;(ctx as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit('session/event', session, event)
}

describe('T36 — the plugin captures settlements at delivery', () => {
  it('records a delivered settlement in the run that owns the child', async () => {
    const m = await mount()
    try {
      deliver(m.ctx, { header: { cwd: m.repo } }, settlementEvent())
      const recorded = readSettlement(m.runDir, CHILD)
      expect(recorded).not.toBeNull()
      expect(recorded!.closingText).toBe('{"verdict":"REVISE"}')
    } finally {
      await m.dispose()
    }
  })

  it('IGNORES every event that is not a settlement (it sees all of them)', async () => {
    const m = await mount()
    try {
      deliver(m.ctx, { header: { cwd: m.repo } }, { type: 'turn/start', data: { turn: 1 } })
      deliver(m.ctx, { header: { cwd: m.repo } }, { type: 'user/message', data: { content: [], source: { kind: 'human' } } })
      expect(readSettlements(m.runDir)).toEqual([])
      // Not even the log file should exist: a non-settlement does no filesystem work.
      expect(existsSync(settlementLogPath(m.runDir))).toBe(false)
    } finally {
      await m.dispose()
    }
  })

  it('files NOTHING for a child no run owns, rather than guessing a run', async () => {
    const m = await mount()
    try {
      deliver(m.ctx, { header: { cwd: m.repo } }, settlementEvent('a-different-child'))
      expect(readSettlements(m.runDir)).toEqual([])
    } finally {
      await m.dispose()
    }
  })

  it('files nothing when the session names no workspace', async () => {
    const m = await mount()
    try {
      deliver(m.ctx, { header: {} }, settlementEvent())
      expect(readSettlements(m.runDir)).toEqual([])
    } finally {
      await m.dispose()
    }
  })

  it('never THROWS out of the listener, whatever it is handed', async () => {
    const m = await mount()
    try {
      // This rides the hot path of every event in every session; a throw here
      // would break the session it merely observes.
      expect(() => {
        deliver(m.ctx, null, null)
        deliver(m.ctx, { header: { cwd: m.repo } }, undefined)
        deliver(m.ctx, { header: { cwd: m.repo } }, { type: 'user/message', data: { content: 'not-an-array', source: { kind: 'subagent-settled' } } })
      }).not.toThrow()
    } finally {
      await m.dispose()
    }
  })

  it('one settlement per delivery, in arrival order', async () => {
    const m = await mount()
    try {
      deliver(m.ctx, { header: { cwd: m.repo } }, settlementEvent())
      deliver(m.ctx, { header: { cwd: m.repo } }, settlementEvent())
      expect(readSettlements(m.runDir)).toHaveLength(2)
    } finally {
      await m.dispose()
    }
  })
})
