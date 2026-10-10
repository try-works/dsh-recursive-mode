/**
 * README §4.1 — THE LOCK STANDARD GATE.
 *
 * WHAT WAS MISSING, verified by a live pass before this spec existed:
 * `recursive_lock` promises that it *"refuses if the artifact does not meet the
 * standard"*, and `lockArtifact` checked existence, re-lock, lock ORDER and
 * quiescence — and never consulted the linter. A 14-FAIL artifact locked cleanly,
 * a 15-FAIL artifact locked cleanly, and an artifact whose own status view reports
 * an invalid lock position locked cleanly. A receipt is evidence that the artifact
 * was accepted; the gate is what makes that true.
 *
 * WHAT THIS PINS:
 *   1. the fixture helper's own artifact is COMPLIANT — `lintRun` over a run that
 *      holds it (and nothing else) returns `passed: true`, with zero FAILs. Without
 *      this, every other case here could pass for the wrong reason;
 *   2. an artifact below the standard is REFUSED, and the refusal NAMES the
 *      failures — asserted against the very strings `lintArtifact` returns, so the
 *      message cannot drift from the linter's verdict;
 *   3. a compliant artifact still LOCKS (the gate is a gate, not a wall);
 *   4. an already-LOCKED artifact is still refused for the PRE-EXISTING reason —
 *      including a below-standard one, which proves the LOCKED check precedes the
 *      standard gate;
 *   5. LOCK ORDER stays FIRST: an artifact that is BOTH out of order and below the
 *      standard still reports ordering, exactly as it did before the gate existed.
 *
 * Driven through the REAL runtime (`ctx.recursive.lockArtifact`), mounted the way
 * the identity and quiescence specs mount it — no mock stands in for the code under
 * test, so a gate that stopped being called would fail these cases rather than pass
 * them.
 *
 * WHAT WOULD MAKE THIS SPEC PASS VACUOUSLY: a `compliantArtifact` that satisfies the
 * linter trivially (which case 1 exists to prevent), or a run whose artifacts are
 * all ABSENT — a missing artifact is WARN-only in `lintRun`, so an empty run
 * "passes" — which is why case 2 asserts on the NAMED failures of a real, present
 * artifact rather than only on the refusal.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { lintRun } from '../src/ts-lint.ts'
import { getLockStatus, lockHashFromContent } from '../src/lock.ts'
import { compliantArtifact, ensureMemoryPlane, writeCompliantArtifact, writeCompliantRun } from './compliant-artifact.ts'

const RUN = 'gate-run'
const ARTIFACT = '00-requirements.md'
const NEXT = '00-worktree.md'

interface Mount {
  ctx: Context
  repo: string
  runDir: string
  dispose: () => Promise<void>
}

/** A real runtime over a scaffolded run — the same mount the sibling specs use. */
async function mount(): Promise<Mount> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-lockgate-'))
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

/**
 * The compliant requirements artifact with its requirement set REMOVED — one named
 * failure, and nothing else, so "the refusal names the failures" is checkable
 * exactly rather than approximately.
 */
function belowStandard(root: string): string {
  return compliantArtifact(ARTIFACT, RUN, { repoRoot: root })
    .replace(/## Requirements[\s\S]*?## Out of Scope/, '## Out of Scope')
}

/** `lintRun`, with the linter's console chatter silenced. */
function silentLintRun(root: string, runId: string): ReturnType<typeof lintRun> {
  const original = console.log
  console.log = () => {}
  try {
    return lintRun(root, runId)
  } finally {
    console.log = original
  }
}

/** The refusal message, for cases that assert on what a refusal NAMES. */
async function refusalMessage(m: Mount, artifact: string): Promise<string> {
  try {
    await m.ctx.recursive.lockArtifact(RUN, artifact)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the lock to be refused, but it succeeded: ' + artifact)
}

/**
 * The same refusal, WITH THE AGENT `recursive_lock` PASSES (`exec.agent`).
 *
 * ⚠ THE AGENT IS NOT INCIDENTAL: `lockArtifact`'s goal block routes through `blockRunToGoal(agent, …)`,
 * which is a no-op without one (`{ ok: false, reason: 'no agent' }`). A case about the goal block must
 * therefore call the runtime the way the TOOL calls it, or it would assert the absence of a block and call
 * it a property.
 */
async function refusalWithAgent(m: Mount, artifact: string): Promise<string> {
  try {
    await m.ctx.recursive.lockArtifact(RUN, artifact, false, { session: { header: { cwd: m.repo } } })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the lock to be refused, but it succeeded: ' + artifact)
}

describe('the fixture helper is compliant, so these cases cannot pass for the wrong reason', () => {
  it('lintRun over a run holding ONLY the authored artifact passes with zero FAILs', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-lockgate-proof-'))
    try {
      ensureMemoryPlane(root)
      const path = writeCompliantArtifact(root, RUN, ARTIFACT)
      expect(existsSync(path)).toBe(true)
      const result = silentLintRun(root, RUN)
      // ⚠ THE VACUITY GUARD: a MISSING artifact is WARN-only in `lintRun`, so an
      // assertion on FAILs alone would pass over an empty run. This proves the
      // artifact was actually found and linted, and that its zero FAILs were earned.
      expect(result.warnings.filter((warning) => warning.includes(ARTIFACT))).toEqual([])
      expect(result.errors).toEqual([])
      expect(result.failCount).toBe(0)
      expect(result.passed).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('README §4.1 — recursive_lock refuses an artifact below the phase standard', () => {
  it('REFUSES it, and the refusal NAMES the failures the linter reported', async () => {
    const m = await mount()
    try {
      // The run is otherwise clean — memory plane present, an executable diff basis —
      // so every failure in the refusal belongs to THIS artifact.
      writeCompliantRun(m.repo, RUN, [])
      writeFileSync(join(m.runDir, ARTIFACT), belowStandard(m.repo), 'utf8')

      const lint = await m.ctx.recursive.lintArtifact(RUN, ARTIFACT)
      expect(lint.passed).toBe(false)
      expect(lint.errors.join(' | ')).toContain('Missing required section heading: ## Requirements')

      const message = await refusalMessage(m, ARTIFACT)
      expect(message).toContain('does not meet the phase standard, so it was not locked')
      expect(message).toContain(ARTIFACT)
      // The refusal repeats the LINTER'S OWN failures, not a paraphrase of them.
      for (const failure of lint.errors) expect(message).toContain(failure)
      // And the artifact is untouched: a refused lock leaves no lock behind.
      expect(getLockStatus(join(m.runDir, ARTIFACT))).toBe('DRAFT')
    } finally {
      await m.dispose()
    }
  })

  it('a compliant artifact still LOCKS (the gate is a gate, not a wall)', async () => {
    const m = await mount()
    try {
      writeCompliantRun(m.repo, RUN, [ARTIFACT, NEXT])
      const result = await m.ctx.recursive.lockArtifact(RUN, ARTIFACT)
      expect(result.status).toBe('LOCKED')
      expect(result.lockHash).toMatch(/^[a-f0-9]{64}$/)
      expect(getLockStatus(join(m.runDir, ARTIFACT))).toBe('LOCKED')
      expect(readFileSync(join(m.runDir, ARTIFACT), 'utf8')).toContain('Status: `LOCKED`')
    } finally {
      await m.dispose()
    }
  })
})

describe('the pre-existing refusals keep their precedence', () => {
  it('an already-LOCKED artifact is refused for LOCKED, not for the standard', async () => {
    const m = await mount()
    try {
      writeCompliantRun(m.repo, RUN, [ARTIFACT, NEXT])
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT)
      const message = await refusalMessage(m, ARTIFACT)
      expect(message).toContain('Artifact already LOCKED')
      // The LOCKED check runs BEFORE the standard gate, so a re-lock is reported as
      // a re-lock and the standard is not re-litigated.
      expect(message).not.toContain('phase standard')
    } finally {
      await m.dispose()
    }
  })

  it('a BELOW-STANDARD artifact that is already LOCKED is reported as LOCKED', async () => {
    const m = await mount()
    try {
      writeCompliantRun(m.repo, RUN, [])
      // LOCKED on disk — with the lock fields a real lock writes, so `getLockStatus`
      // really classifies it LOCKED rather than STALE_LOCK — and below the standard:
      // the LOCKED check must win, because the standard gate sits after it and nothing
      // previously locked may be disturbed by it.
      const body = belowStandard(m.repo).replace('Status: `DRAFT`', 'Status: `LOCKED`')
        .replace(/\n*$/, '\n') + 'LockedAt: 2026-01-01T00:00:00Z\n'
      const path = join(m.runDir, ARTIFACT)
      writeFileSync(path, body + 'LockHash: ' + lockHashFromContent(body + 'LockHash: ' + '0'.repeat(64) + '\n') + '\n', 'utf8')
      expect(getLockStatus(path)).toBe('LOCKED')

      const lint = await m.ctx.recursive.lintArtifact(RUN, ARTIFACT)
      expect(lint.passed).toBe(false)
      const message = await refusalMessage(m, ARTIFACT)
      expect(message).toContain('Artifact already LOCKED')
      expect(message).not.toContain('phase standard')
    } finally {
      await m.dispose()
    }
  })

  it('LOCK ORDER stays FIRST: an out-of-order AND below-standard artifact reports ordering', async () => {
    const m = await mount()
    try {
      // The scaffolded worktree artifact is both (a) out of order — requirements is
      // still DRAFT — and (b) below the standard. Ordering is the canonical rule the
      // parity goldens and every existing test know, so it must still be what a
      // caller sees; the standard gate must not pre-empt it.
      const lint = await m.ctx.recursive.lintArtifact(RUN, NEXT)
      expect(lint.passed).toBe(false)

      const message = await refusalMessage(m, NEXT)
      expect(message).toContain('Prerequisite blockers:')
      expect(message).toContain(ARTIFACT)
      expect(message).not.toContain('phase standard')
    } finally {
      await m.dispose()
    }
  })

  /**
   * ISSUE 1 — THE TOOL LAYER BLOCKS THE RUN'S GOAL, EXACTLY ONCE.
   *
   * `lockArtifact` is one of the TWO layers that refuse an out-of-order lock, and it is the one that has
   * always coupled its refusal to the durable goal (`blockRunToGoal`, "a gate-block becomes a durable,
   * UI-visible goal block"). The guard's pre-dispatch refusal now blocks the goal too — from the boundary,
   * because a policy layer has no goals service — and this case pins the TOOL half of that pair so the two
   * cannot drift: one refusal, one block, whichever layer produced it.
   *
   * ⚠ "NOT TWICE" IS ASSERTED, NOT ARGUED. The fake records the ATTEMPT before validating the transition,
   * exactly like the live service (whose `block` requires an ACTIVE goal), so a second block of an
   * already-blocked goal is visible as an attempt and countable as a DURABLE transition. Two refusals of
   * the same lock therefore leave ONE phase change and a goal that is still blocked.
   */
  it('the ordering refusal blocks the run goal exactly once, and a repeat does not block it again', async () => {
    const m = await mount()
    const goal = { id: 'g1', revision: 1, objective: 'recursive-run:' + RUN + ' · active', phase: 'active' as const }
    const store: {
      current?: { id: string; revision: number; objective: string; phase: string }
      blocks: Array<{ code: string; message: string }>
      transitions: string[]
    } = { current: goal, blocks: [], transitions: [] }
    try {
      m.ctx.recursive.attachGoals({
        get: () => store.current as never,
        create: () => { throw new Error('the tool path never creates a goal') },
        block: (_agent: unknown, ref: { id: string; revision: number }, reason: { code: string; message: string }) => {
          store.blocks.push(reason)
          if (store.current?.phase !== 'active') throw new Error('goal is not active, so it cannot be blocked')
          store.transitions.push('blocked')
          store.current = { ...store.current, phase: 'blocked', revision: ref.revision + 1 }
          return store.current as never
        },
        pause: () => { throw new Error('not used') },
        resume: () => { throw new Error('not used') },
        complete: () => { throw new Error('not used') },
        clear: () => { throw new Error('not used') },
      } as never)

      const first = await refusalWithAgent(m, NEXT)
      expect(first).toContain('Prerequisite blockers:')
      expect(store.blocks, 'the tool refused the lock and the goal was not blocked').toHaveLength(1)
      expect(store.blocks[0].code).toBe('prerequisite-blockers')
      expect(store.blocks[0].message).toContain('monotonic lock-order')
      expect(store.blocks[0].message).toContain(ARTIFACT)
      expect(store.transitions.filter((t) => t === 'blocked')).toHaveLength(1)
      expect(store.current?.phase).toBe('blocked')

      // The SAME refusal again: the attempt is made (visible), the durable transition is NOT repeated.
      const second = await refusalWithAgent(m, NEXT)
      expect(second).toContain('Prerequisite blockers:')
      expect(store.transitions.filter((t) => t === 'blocked'), 'the goal was blocked twice').toHaveLength(1)
      expect(store.current?.phase).toBe('blocked')
      expect(store.blocks.length).toBe(2)
    } finally {
      await m.dispose()
    }
  })

  /**
   * …AND THE BLOCK IS THE TOOL'S, WHICH NEEDS THE LIVE AGENT.
   *
   * ⚠ FOUND WHILE WRITING THIS CASE, and worth stating because it is a property of the production path
   * rather than of the test: `lockArtifact`'s goal block is a no-op without an agent
   * (`blockRunToGoal` returns `{ ok: false, reason: 'no agent' }`), and `recursive_lock` is what supplies
   * it (`exec.agent`). So the case above passes the agent exactly as the tool does, and this one asserts
   * the difference out loud: the SAME refusal, with no agent, refuses the lock and blocks nothing. Without
   * this pair, "the tool blocks the goal" could be a claim about a code path no caller reaches.
   */
  it('the tool path blocks the goal only when it has the live agent — as the recursive_lock tool supplies', async () => {
    const m = await mount()
    const store = { blocks: 0 }
    try {
      m.ctx.recursive.attachGoals({
        get: () => ({ id: 'g1', revision: 1, objective: 'recursive-run:' + RUN + ' · active', phase: 'active' }),
        create: () => { throw new Error('not used') },
        block: () => { store.blocks += 1; return undefined as never },
        pause: () => { throw new Error('not used') },
        resume: () => { throw new Error('not used') },
        complete: () => { throw new Error('not used') },
        clear: () => { throw new Error('not used') },
      } as never)

      // No agent -> the ordering refusal still happens, and no block is attempted.
      const withoutAgent = await refusalMessage(m, NEXT)
      expect(withoutAgent).toContain('Prerequisite blockers:')
      expect(store.blocks, 'a lock with no agent must not attempt a goal block').toBe(0)

      // The agent the TOOL passes -> the block is attempted.
      const withAgent = await m.ctx.recursive.lockArtifact(RUN, NEXT, false, { session: { header: { cwd: m.repo } } })
        .then(() => 'LOCKED', (error: unknown) => (error instanceof Error ? error.message : String(error)))
      expect(withAgent).toContain('Prerequisite blockers:')
      expect(store.blocks, 'the tool path did not block the goal when it had the agent').toBe(1)
    } finally {
      await m.dispose()
    }
  })
})
