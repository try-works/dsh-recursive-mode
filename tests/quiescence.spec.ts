/**
 * T18 — quiescence: a lock is only sound at a point where nothing is in flight.
 *
 * THE IN-FLIGHT FACT THIS ENFORCES. A delegation writes
 * `subagents/<delegationId>/handoff.md` BEFORE the child is started — verified:
 * `runtime.ts` writes the handoff, then the bundle, then starts the child — and
 * the child's submission is `subagents/<delegationId>/child-<childId>/reply.md`.
 * The window between those two is where a crash or a hang leaves residue, and a
 * phase locked inside that window certifies work that no reply ever supported.
 *
 * DERIVED, NOT STORED (plan §4.0). `pendingWork` reads the run directory; there
 * is no ledger, no queue and no new structure. Tardigrade reaches the same
 * property the same way — its pending work IS `EffectRequested` without
 * `EffectSettled`, recovered from the log on replay.
 *
 * WHERE THE PLAN'S OWN LIST DID NOT SURVIVE CONTACT WITH THE CODE (recorded on
 * the item): it also names "a reopen plan without a completion marker" and "a
 * closeout phase scaffolded without a receipt". Neither exists on disk —
 * `reopenArtifact` reverts the artifact in place and invalidates receipts, and a
 * scaffolded-but-unlocked closeout artifact is the normal pre-lock state of every
 * phase. Enforcing either would make locking impossible, so only the delegation
 * case is implemented, and the omission is deliberate rather than forgotten.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { pendingWork } from '../src/status.ts'
import { createHandoff, replyPath } from '../src/handoff.ts'
import { TOOL_ERRORS } from '../src/errors.ts'

const RUN = 'q-run'

interface Mount {
  ctx: Context
  repo: string
  runDir: string
  dispose: () => Promise<void>
}

async function mount(): Promise<Mount> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-quiesce-'))
  const ctx = new Context()
  await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
  await ctx.recursive.initRun(RUN)
  return {
    ctx,
    repo,
    runDir: join(repo, '.recursive', 'run', RUN),
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

/** Write the delegation handoff exactly as the runtime does. */
function startDelegation(m: Mount, delegationId = 'd1'): void {
  createHandoff({
    root: m.repo,
    runId: RUN,
    delegationId,
    role: 'code-reviewer',
    objective: 'review the implementation',
    runDocRefs: [],
    codeRefs: [],
    auditQuestions: ['did it work?'],
    requiredOutput: 'verdict',
    decisionBasis: 'independent review required',
  })
}

/** The child's submission. */
function writeReply(m: Mount, body: string, childId = 'c1', delegationId = 'd1'): string {
  const p = replyPath({ root: m.repo, runId: RUN, delegationId, childId })
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body, 'utf8')
  return p
}

describe('T18 — pendingWork derives in-flight work from the run directory', () => {
  it('a run with nothing in flight reports nothing (the common case must not regress)', async () => {
    const m = await mount()
    try {
      expect(pendingWork(m.runDir)).toEqual([])
    } finally {
      await m.dispose()
    }
  })

  it('an unanswered delegation is pending, and names the delegation', async () => {
    const m = await mount()
    try {
      startDelegation(m)
      const pending = pendingWork(m.runDir)
      expect(pending).toHaveLength(1)
      expect(pending[0].kind).toBe('unanswered-delegation')
      expect(pending[0].delegationId).toBe('d1')
      expect(pending[0].detail).toContain('d1')
    } finally {
      await m.dispose()
    }
  })

  it('a landed reply clears it', async () => {
    const m = await mount()
    try {
      startDelegation(m)
      writeReply(m, '# Verdict: APPROVE\n')
      expect(pendingWork(m.runDir)).toEqual([])
    } finally {
      await m.dispose()
    }
  })

  it('a ZERO-BYTE reply is not a submission — still pending', async () => {
    const m = await mount()
    try {
      startDelegation(m)
      writeReply(m, '')
      const pending = pendingWork(m.runDir)
      expect(pending).toHaveLength(1)
      expect(pending[0].kind).toBe('empty-reply')
    } finally {
      await m.dispose()
    }
  })

  it('reports every unresolved delegation, not just the first', async () => {
    const m = await mount()
    try {
      startDelegation(m, 'd1')
      startDelegation(m, 'd2')
      writeReply(m, 'ok', 'c1', 'd1')
      const pending = pendingWork(m.runDir)
      expect(pending).toHaveLength(1)
      expect(pending[0].delegationId).toBe('d2')
    } finally {
      await m.dispose()
    }
  })

  it('is a pure read: it creates nothing', async () => {
    const m = await mount()
    try {
      startDelegation(m)
      const before = existsSync(join(m.runDir, 'subagents'))
      pendingWork(m.runDir)
      pendingWork(m.runDir)
      expect(existsSync(join(m.runDir, 'subagents'))).toBe(before)
    } finally {
      await m.dispose()
    }
  })

  it('a missing run directory is an empty set, never a throw', () => {
    expect(pendingWork(join(tmpdir(), 'definitely-not-a-run-9f3a'))).toEqual([])
  })
})

describe('T18 — lockArtifact refuses to lock with work in flight', () => {
  it('refuses and names the unresolved delegation', async () => {
    const m = await mount()
    try {
      startDelegation(m)
      await expect(m.ctx.recursive.lockArtifact(RUN, '00-requirements.md')).rejects.toThrow(/d1/)
    } finally {
      await m.dispose()
    }
  })

  it('the refusal is a CODED, routed sentence (T24 registry)', async () => {
    const m = await mount()
    try {
      startDelegation(m)
      await expect(m.ctx.recursive.lockArtifact(RUN, '00-requirements.md')).rejects.toThrow(
        new RegExp('^' + TOOL_ERRORS.PENDING_WORK.code),
      )
    } finally {
      await m.dispose()
    }
  })

  it('the SAME lock succeeds once the reply lands', async () => {
    const m = await mount()
    try {
      startDelegation(m)
      writeReply(m, '# Verdict: APPROVE\n')
      const result = await m.ctx.recursive.lockArtifact(RUN, '00-requirements.md')
      expect(result.status).toBe('LOCKED')
    } finally {
      await m.dispose()
    }
  })

  it('a run with nothing in flight locks normally', async () => {
    const m = await mount()
    try {
      const result = await m.ctx.recursive.lockArtifact(RUN, '00-requirements.md')
      expect(result.status).toBe('LOCKED')
    } finally {
      await m.dispose()
    }
  })

  it('an empty reply still refuses — a 0-byte submission is not a reply', async () => {
    const m = await mount()
    try {
      startDelegation(m)
      writeReply(m, '')
      await expect(m.ctx.recursive.lockArtifact(RUN, '00-requirements.md')).rejects.toThrow(/RM4403/)
    } finally {
      await m.dispose()
    }
  })
})

describe('T18 — the pending set is visible, not just enforced', () => {
  it('recursive_status carries pendingWork so a human sees why a lock is refused', async () => {
    const m = await mount()
    try {
      startDelegation(m)
      const status = await m.ctx.recursive.status(RUN)
      expect(status).not.toBeNull()
      const pending = (status as { pendingWork?: Array<{ delegationId: string }> }).pendingWork ?? []
      expect(pending).toHaveLength(1)
      expect(pending[0].delegationId).toBe('d1')
    } finally {
      await m.dispose()
    }
  })

  it('an empty pending set is still present and empty, so consumers need no null dance', async () => {
    const m = await mount()
    try {
      const status = await m.ctx.recursive.status(RUN)
      expect((status as { pendingWork?: unknown[] }).pendingWork).toEqual([])
    } finally {
      await m.dispose()
    }
  })
})
