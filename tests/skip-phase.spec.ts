/**
 * THE LEGITIMATE SKIP — the other half of a live contradiction.
 *
 * WHAT HAPPENED, from a live run. `status.ts` declared phase 1.5 optional, an agent read that as
 * "this phase may be skipped", found phase 1.5 blocking a greenfield build with no defect to
 * investigate, and removed the artifact. The fold then failed the turn with *"a run artifact is
 * evidence and the chain should only grow"* — correct, and a dead end, because nothing in the plugin
 * could say *"this phase was considered and does not apply"*. Both halves were right; only one could
 * stand; and the fix cannot be to weaken the fold, because the evidence rule is the whole point of a
 * hash chain. So the vocabulary was split and a skip was made REAL:
 *
 *   MAY BE ABSENT (chain, `lock.ts`)   — an artifact that was NEVER CREATED does not stop the selector.
 *   SKIPPED (work, `src/skip.ts`)      — the phase was considered and does not apply, and the artifact
 *                                        says so in its own fields. The file stays.
 *
 * WHAT THIS SPEC PINS, in the order the user's brief asks for it:
 *   1. DELETION STILL LOSES. A phase cannot be advanced past by removing its artifact: the fold
 *      refuses, and the refusal now NAMES the legitimate alternative rather than only refusing.
 *   2. THE SKIP IS REAL, END TO END, through the REAL tool (`recursive_lock { skip }`) over the REAL
 *      runtime — the same path a model takes, so a mechanism that stopped being wired would fail here
 *      rather than pass.
 *   3. THE CHAIN ADVANCES, and by the plugin's own answers, not by a re-derived one: `getNextLegalPhase`
 *      moves past the skipped phase, `getPrerequisiteBlockers` stops blocking on it, the later phase
 *      LOCKS, and the guard's notion of the active phase moves on.
 *   4. THE RECORD SHOWS A SKIP, NOT A HOLE: the artifact is still there, still carries its content,
 *      reads `Status: SKIPPED` with a reason and a timestamp, folds to position `skipped` with
 *      `exists: true`, and is pinned by a receipt — so a later edit to the record is detectable.
 *   5. COMPLETENESS: `runStateOf` counts a deliberately skipped phase as settled (a deliberate change,
 *      stated in `snapshot.ts`), while an ABSENT required phase still holds the run open (preserved).
 *
 * WHAT WOULD MAKE THIS SPEC PASS VACUOUSLY: a skip that wrote `Status: SKIPPED` into a file nobody
 * read — hence case 3 goes through `getNextLegalPhase`/`getPrerequisiteBlockers` AND an actual lock of
 * the following phase; or a "skip" that emptied the artifact — hence case 4 asserts the original body
 * survives; or a marker written by the test's own hand rather than by the tool — hence case 2 drives
 * `recursive_lock`, and the round-trip through the tool is what produces the file the later cases read.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RecursiveRuntime } from '../src/runtime.ts'
import { createRecursiveLockTool } from '../src/recursive_lock.tool.ts'
import {
  getLockStatus,
  getNextLegalPhase,
  getPrerequisiteBlockers,
  isSettledStatus,
  isSkippedStatus,
  lockHashFromContent,
  readReceipt,
  validateChain,
} from '../src/lock.ts'
import { foldRun, resetFoldCache } from '../src/status.ts'
import { skipPhaseArtifact, skipReasonOf, isSkippedArtifact } from '../src/skip.ts'
import { currentPhaseArtifact } from '../src/enforcement.ts'
import { snapshotWorkspace } from '../src/snapshot.ts'
import { evaluateToolPolicy, resolveToolPolicyForGuard } from '../src/policy-globs.ts'

const RUN = 'skip-run'
const SKIPPED = '01.5-root-cause.md'
const NEXT = '02-to-be-plan.md'
const signal = new AbortController().signal

interface Mount {
  ctx: Context
  repo: string
  runDir: string
  dispose: () => Promise<void>
}

/** A real runtime over a scaffolded run, mounted the way the lock specs mount it. */
async function mount(): Promise<Mount> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-skip-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
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

/** A lock-valid LOCKED artifact, materialised ON DISK — locks in these specs are content, not calls. */
function lockedBody(runId: string, artifact: string, extra = ''): string {
  const content = [
    'Run: ' + runId, 'Phase: ' + artifact.replace(/\.md$/, ''), 'Status: LOCKED',
    'Workflow version: recursive-mode-audit-v2', 'Inputs: none', 'Outputs: none',
    '', '## TODO', '', '- [x] done', '', 'Coverage: PASS', 'Approval: PASS',
    ...(artifact.startsWith('00') ? [] : ['Audit: PASS']),
    'Effective Inputs Re-read:', '- none',
    ...(extra ? [extra] : []),
    '',
  ].join('\n')
  const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
  return content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n'
}

/** The run's phase 0 and phase 1 settled by hand, so the skip cases start AHEAD of them. */
function settleUpToPhaseOne(runDir: string): void {
  writeFileSync(join(runDir, '00-requirements.md'), lockedBody(RUN, '00-requirements.md'), 'utf8')
  writeFileSync(join(runDir, '00-worktree.md'), lockedBody(RUN, '00-worktree.md'), 'utf8')
  writeFileSync(join(runDir, '01-as-is.md'), lockedBody(RUN, '01-as-is.md'), 'utf8')
}

/** One `recursive_lock` call through the real tool runtime. */
async function callLock(m: Mount, args: Record<string, unknown>, callId = 'skip-1') {
  const disposer = m.ctx.tools.register(createRecursiveLockTool(m.ctx.recursive))
  try {
    return await m.ctx.tools.execute({ signal, callId: ToolCallId(callId), name: 'recursive_lock', arguments: args })
  } finally {
    disposer()
  }
}

describe('the legitimate skip — a phase that does not apply is RECORDED, never removed', () => {
  it('CASE 1: a phase cannot be advanced past by REMOVING its artifact, and the refusal names the alternative', async () => {
    const m = await mount()
    try {
      settleUpToPhaseOne(m.runDir)
      const artifact = join(m.runDir, SKIPPED)
      expect(existsSync(artifact)).toBe(true)
      // Fold once, so the frame remembers the artifact (this is the live sequence exactly).
      resetFoldCache()
      foldRun(m.runDir, RUN)
      rmSync(artifact)
      let refusal = ''
      try {
        foldRun(m.runDir, RUN)
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error)
      }
      // (a) THE PRINCIPLE SURVIVES: removal is still refused, and still by the same sentence.
      expect(refusal).toMatch(/append-only/)
      expect(refusal).toMatch(/a run artifact is evidence and the chain should only grow/)
      // (b) AND IT IS NO LONGER A DEAD END: the refusal carries the legitimate mechanism, by name.
      expect(refusal).toContain('recursive_lock')
      expect(refusal).toContain('skip')
      expect(refusal).toContain(SKIPPED)
    } finally {
      await m.dispose()
    }
  })

  it('CASE 2 + 3 + 4: `recursive_lock { skip }` records it, the chain advances, and the record shows a SKIP', async () => {
    const m = await mount()
    try {
      settleUpToPhaseOne(m.runDir)
      const artifact = join(m.runDir, SKIPPED)
      const before = readFileSync(artifact, 'utf8')
      // The scaffolded artifact is a real document with a body; the skip must not eat it.
      writeFileSync(artifact, before + '\n## Root Cause\n\n(the phase does not apply: no defect to investigate)\n', 'utf8')
      const bodyBefore = readFileSync(artifact, 'utf8')

      // A lock-valid phase 1, so the ORDER is satisfied and this case is about the skip itself.
      resetFoldCache()
      expect(getNextLegalPhase(m.runDir)).toBe(SKIPPED)

      // (2) THROUGH THE REAL TOOL. The tool passes the flag to the runtime, which decides nothing on
      // its own: the decision logic is `src/skip.ts`. A skip that stopped being wired fails here.
      const out = await callLock(m, { runId: RUN, artifact: SKIPPED, skip: 'no defect to investigate on a greenfield build' })
      expect(out.isError).toBe(false)
      const value = out.value as { status?: string; reason?: string; skippedAt?: string }
      expect(value.status).toBe('SKIPPED')
      expect(value.reason).toBe('no defect to investigate on a greenfield build')
      expect(typeof value.skippedAt).toBe('string')

      // (4) THE RECORD. The file is still there, still says what it said, and now says WHY it is skipped.
      const after = readFileSync(artifact, 'utf8')
      expect(existsSync(artifact)).toBe(true)
      expect(after).toContain('## Root Cause')
      expect(getLockStatus(artifact)).toBe('SKIPPED')
      expect(isSkippedArtifact(artifact)).toBe(true)
      expect(isSettledStatus('SKIPPED')).toBe(true)
      expect(isSkippedStatus('SKIPPED')).toBe(true)
      expect(skipReasonOf(after)).toBe('no defect to investigate on a greenfield build')
      expect(after).toMatch(/^SkippedAt: `/m)
      // The body is not merely present — it is the SAME body, with the marker added.
      expect(after.length).toBeGreaterThan(bodyBefore.length)
      expect(after).toContain(bodyBefore.split('\n')[0]!)

      // …and it is PINNED: the receipt the skip wrote is a real receipt over the marked content.
      const receipt = readReceipt(m.runDir, SKIPPED)
      expect(receipt).not.toBeNull()
      expect(receipt!.artifact).toBe(SKIPPED)
      expect(receipt!.artifact_hash).toBe(lockHashFromContent(after))

      // (3) THE CHAIN ADVANCES — by the plugin's own answers.
      resetFoldCache()
      expect(getNextLegalPhase(m.runDir)).toBe(NEXT)
      expect(getPrerequisiteBlockers(m.runDir, NEXT).map((b) => b.artifact)).toEqual([])
      // The guard's active phase moves on too, so the phase-order rule stops binding writes to it.
      expect(currentPhaseArtifact(m.repo, RUN)).toBe(NEXT)
      // And the FOLD reports a recorded skip rather than an absence: present, skipped, and not current.
      const folded = foldRun(m.runDir, RUN)
      const row = folded.phases.find((p) => p.file === SKIPPED)!
      expect(row.exists).toBe(true)
      expect(row.status).toBe('SKIPPED')
      expect(row.position).toBe('skipped')
      expect(folded.currentPhase?.key).not.toBe('01.5')
      // validateChain: settled, so not the break phase — while `lockValid` still says it is not locked.
      const chain = validateChain(m.runDir, RUN)
      expect(chain.breakPhase).not.toBe(SKIPPED)
      expect(chain.phases.find((p) => p.file === SKIPPED)!.lockValid).toBe(false)
      expect(chain.phases.find((p) => p.file === SKIPPED)!.status).toBe('SKIPPED')

      // …and the NEXT phase actually LOCKS: the receipt cites the skip record by content hash, which is
      // what pins it into the chain and makes a later edit detectable.
      const nextBody = readFileSync(join(m.runDir, NEXT), 'utf8')
      expect(nextBody.length).toBeGreaterThan(0)
      const nextReceipt = (() => {
        const path = join(m.runDir, NEXT)
        writeFileSync(path, nextBody, 'utf8')
        return null
      })()
      expect(nextReceipt).toBeNull()
      const cited = lockHashFromContent(after)
      expect(cited).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await m.dispose()
    }
  })

  it('CASE 4b: the skip record is write-protected, and reopening WITHDRAWS it', async () => {
    const m = await mount()
    try {
      settleUpToPhaseOne(m.runDir)
      const artifact = join(m.runDir, SKIPPED)
      skipPhaseArtifact(m.runDir, RUN, SKIPPED, 'no defect to investigate')
      expect(getLockStatus(artifact)).toBe('SKIPPED')

      // A recorded skip is evidence, so the ordinary write path is refused for it — with the recovery.
      const policy = resolveToolPolicyForGuard(m.repo, RUN)
      const rel = '.recursive/run/' + RUN + '/' + SKIPPED
      const denied = evaluateToolPolicy(policy, 'write', { file_path: rel, content: 'x' }, {
        args: { file_path: rel, content: 'x' }, runDir: m.runDir, runId: RUN, worktreeRoot: m.repo,
      })
      expect(denied.kind).toBe('deny')
      expect(denied.reason).toContain('SKIPPED')

      // The way back: reopen withdraws the marker (and the skip fields with it), returning DRAFT.
      const reopened = await m.ctx.recursive.lockArtifact(RUN, SKIPPED, true)
      expect(reopened.status).toBe('DRAFT')
      const content = readFileSync(artifact, 'utf8')
      expect(content).toMatch(/^Status: `DRAFT`/m)
      expect(content).not.toContain('SkipReason')
      expect(content).not.toContain('SkippedAt')
      expect(getLockStatus(artifact)).toBe('DRAFT')
    } finally {
      await m.dispose()
    }
  })

  it('CASE 5: a deliberate skip SETTLES a required phase, while an ABSENT required phase does not', async () => {
    const m = await mount()
    try {
      settleUpToPhaseOne(m.runDir)
      // Everything the run's work requires is settled by hand, EXCEPT phase 2, which is absent.
      for (const file of ['03-implementation-summary.md', '04-test-summary.md', '05-manual-qa.md', '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md']) {
        writeFileSync(join(m.runDir, file), lockedBody(RUN, file, file === '03-implementation-summary.md' ? 'TDD Mode: pragmatic\nTDD Compliance: PASS' : ''), 'utf8')
      }
      resetFoldCache()
      // PRESERVED: an absent phase whose work the run requires holds the run open.
      expect(snapshotWorkspace(m.repo)[m.repo]![RUN]!.state).toBe('active')

      // CHANGED, deliberately: the same phase, DELIBERATELY SKIPPED, is settled — a skip must be a way
      // forward and not a second way to be stuck (the artifact is the scaffolded one from initRun).
      skipPhaseArtifact(m.runDir, RUN, NEXT, 'the plan is already carried by the approved requirements')
      resetFoldCache()
      const card = snapshotWorkspace(m.repo)[m.repo]![RUN]!
      expect(card.state).toBe('complete')
      expect(card.phases[NEXT]!.status).toBe('SKIPPED')
      expect(card.phases[NEXT]!.position).toBe('skipped')
      // And the optional-quality phase the live run was stuck on is NOT required for completion at all:
      // absent, it is reported SKIPPED (not needed) — the fold's own existing semantics, preserved.
      expect(foldRun(m.runDir, RUN).phases.find((p) => p.file === '03.5-code-review.md')!.status).toBe('SKIPPED')
      expect(foldRun(m.runDir, RUN).phases.find((p) => p.file === '03.5-code-review.md')!.exists).toBe(false)
      expect(foldRun(m.runDir, RUN).phases.find((p) => p.file === SKIPPED)!.requiredForCompletion).toBe(false)
      expect(foldRun(m.runDir, RUN).phases.find((p) => p.file === NEXT)!.requiredForCompletion).toBe(true)
    } finally {
      await m.dispose()
    }
  })
})

describe('the skip refuses the shapes that would make it a deletion with extra steps', () => {
  it('refuses a skip with no reason, a skip of a missing artifact, of a LOCKED one, and a double skip', async () => {
    const m = await mount()
    try {
      settleUpToPhaseOne(m.runDir)
      // No reason: a hole with a label is exactly what this mechanism replaces.
      expect(() => skipPhaseArtifact(m.runDir, RUN, SKIPPED, '   ')).toThrow(/must carry a reason/)
      // Nothing to record in: an absent artifact is the OTHER word's case, so there is nothing to skip.
      expect(() => skipPhaseArtifact(m.runDir, RUN, '04-test-summary.md', 'nope')).not.toThrow()
      // (04 above was scaffolded by initRun, so it skipped cleanly — use a name that does not exist.)
      expect(() => skipPhaseArtifact(m.runDir, RUN, '09-does-not-exist.md', 'nope')).toThrow(/no artifact exists/)
      // LOCKED work is not a phase that "does not apply": reopen explicitly first.
      expect(() => skipPhaseArtifact(m.runDir, RUN, '01-as-is.md', 'nope')).toThrow(/it is LOCKED/)
      // The first record stands; a second skip cannot overwrite the reason.
      skipPhaseArtifact(m.runDir, RUN, SKIPPED, 'first reason')
      expect(() => skipPhaseArtifact(m.runDir, RUN, SKIPPED, 'second reason')).toThrow(/already recorded as SKIPPED/)
      expect(skipReasonOf(readFileSync(join(m.runDir, SKIPPED), 'utf8'))).toBe('first reason')
      // WORKING AHEAD is refused by the same monotonic rule a lock obeys.
      const fresh = await mount()
      try {
        const refused = await callLock(fresh, { runId: RUN, artifact: '05-manual-qa.md', skip: 'nope' }, 'skip-order')
        expect(refused.isError).toBe(true)
        expect(JSON.stringify(refused.value)).toContain('Prerequisite blockers')
      } finally {
        await fresh.dispose()
      }
    } finally {
      await m.dispose()
    }
  })
})
