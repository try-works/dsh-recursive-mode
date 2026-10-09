/**
 * T35 — delegation is ALWAYS continuable; one-shot must be asked for.
 *
 * THE RULE. A one-shot child is not resumable — the harness rejects a resume
 * with "subagent cannot be resumed" — so choosing one-shot forfeits the ability
 * to send a failed review back to the agent that did the work. A continuable
 * child has ONE durable Session across activations, so a REVISE reaches the SAME
 * child with its working context intact instead of spawning a fresh one that must
 * re-read the whole handoff to rediscover what it already knew. Verification that
 * cannot be followed by repair is just a complaint, so repair is the DEFAULT.
 *
 * THE FAILURE THIS PINS. `delegateReview` previously took the continuable branch
 * only on `mode === 'continuable'`, so a caller that simply omitted `mode` — every
 * caller — silently got the one-shot path and lost the repair capability without
 * asking. The mode is now reported as what ACTUALLY ran, and the loss of the
 * continuable capability is NAMED (`continuable-unavailable`) rather than hidden
 * behind a generic success.
 *
 * This spec is also `delegateReview`'s first coverage: before T35 the method had
 * no callers and no tests, so nothing observed which lifecycle it chose.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { operationId, findOperation, readOperations, recordOperation } from '../src/identity.ts'
import { lockHashFromContent } from '../src/lock.ts'
import type { SubagentsRuntimeLike, SubagentParentHandle, SubagentResultLike } from '../src/delegation.ts'

const POLICY = {
  version: 1,
  role_routes: {
    'code-reviewer': { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
  },
  cli_overrides: {},
  custom_clis: [],
}

const APPROVED: SubagentResultLike = {
  output: '{"verdict":"APPROVE"}',
  stopReason: 'completed',
  success: true,
  structured: { verdict: 'APPROVE' },
} as SubagentResultLike

/** A workspace with a router policy that resolves the role to a native provider. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-delegmode-'))
  const cfg = join(root, '.recursive', 'config')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'recursive-router.json'), JSON.stringify(POLICY), 'utf8')
  const runDir = join(root, '.recursive', 'run', 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, '03-implementation-summary.md'), '# Impl\n\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n', 'utf8')
  return root
}

/** Records which lifecycle the review path actually took. */
function fakeSubagents(options: { continuable: boolean }) {
  const calls: string[] = []
  const runtime: Record<string, unknown> = {
    start: async () => {
      calls.push('start')
      return APPROVED
    },
  }
  if (options.continuable) {
    runtime.startContinuable = async (spec: { childId?: string }) => {
      calls.push('startContinuable')
      return { childId: spec.childId ?? 'c1', messageId: 'm1' }
    }
    runtime.followup = async () => {
      calls.push('followup')
      return { messageId: 'm2' }
    }
  }
  return { calls, runtime: runtime as unknown as SubagentsRuntimeLike }
}

async function review(options: { continuable: boolean; mode?: 'one-shot' | 'continuable' }) {
  const root = makeRoot()
  const ctx = new Context()
  await ctx.plugin(RecursiveRuntime, { repoRoot: root })
  const fake = fakeSubagents({ continuable: options.continuable })
  const input = {
    root,
    runId: 'run-1',
    phase: '3',
    role: 'code-reviewer',
    delegationId: 'd1',
    childId: 'c1',
    artifactPath: join(root, '.recursive', 'run', 'run-1', '03-implementation-summary.md'),
    upstreamArtifacts: [] as string[],
    auditQuestions: ['does it work?'],
    requiredOutput: 'verdict',
    providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
    subagents: fake.runtime,
    parent: {} as SubagentParentHandle,
    awaitRoundResult: async () => APPROVED,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  }
  const result = await ctx.recursive.delegateReview(input as never)
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  return { result, calls: fake.calls }
}

/** The root of one review, KEPT on disk so the ACTION RECORD can be read as a reader of the run tree reads it. */
async function reviewOnDisk(options: {
  continuable?: boolean
  awaitRoundResult: () => Promise<SubagentResultLike | null>
}): Promise<{ root: string; result: Record<string, unknown> }> {
  const root = makeRoot()
  const ctx = new Context()
  await ctx.plugin(RecursiveRuntime, { repoRoot: root })
  const fake = fakeSubagents({ continuable: options.continuable ?? true })
  const result = await ctx.recursive.delegateReview({
    root,
    runId: 'run-1',
    phase: '3',
    role: 'code-reviewer',
    delegationId: 'd1',
    childId: 'c1',
    artifactPath: join(root, '.recursive', 'run', 'run-1', '03-implementation-summary.md'),
    upstreamArtifacts: [] as string[],
    auditQuestions: ['does it work?'],
    requiredOutput: 'verdict',
    providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
    subagents: fake.runtime,
    parent: {} as SubagentParentHandle,
    awaitRoundResult: options.awaitRoundResult,
  } as never)
  await ctx.fiber.dispose()
  return { root, result: result as unknown as Record<string, unknown> }
}

/** Every action record filed under the run's subagents/ directory, newest name last. */
function actionRecords(root: string): Array<{ name: string; path: string; text: string }> {
  const dir = join(root, '.recursive', 'run', 'run-1', 'subagents')
  return readdirSync(dir)
    .filter((name) => name.endsWith('-action.md'))
    .sort()
    .map((name) => ({ name, path: join(dir, name), text: readFileSync(join(dir, name), 'utf8') }))
}

/** The one action record a single-round review writes. */
function oneRecord(root: string): { name: string; path: string; text: string } {
  const records = actionRecords(root)
  expect(records, 'the delegation writes exactly one action record per attempt').toHaveLength(1)
  return records[0]!
}

describe('T35 — delegation is continuable by default', () => {
  it('an omitted mode uses the continuable lifecycle and NEVER start()', async () => {
    const { result, calls } = await review({ continuable: true })
    expect(calls).toContain('startContinuable')
    expect(calls).not.toContain('start')
    expect(result.delegationMode).toBe('continuable')
  })

  it('mode: "continuable" behaves the same as the default', async () => {
    const { result, calls } = await review({ continuable: true, mode: 'continuable' })
    expect(calls).not.toContain('start')
    expect(result.delegationMode).toBe('continuable')
  })

  it('only an EXPLICIT mode: "one-shot" gives up the repair path', async () => {
    const { result, calls } = await review({ continuable: true, mode: 'one-shot' })
    expect(calls).toContain('start')
    expect(calls).not.toContain('startContinuable')
    expect(result.delegationMode).toBe('one-shot')
  })

  it('a provider with no continuable capability is NAMED, not hidden behind success', async () => {
    // The delegation still happens, but the review can no longer be sent back to
    // the child that did the work — that loss must be visible to the caller.
    const { result, calls } = await review({ continuable: false })
    expect(calls).toContain('start')
    expect(result.delegationMode).toBe('continuable-unavailable')
  })

  it('the action record says which lifecycle ran, so the run history can be audited', async () => {
    const { result } = await review({ continuable: true })
    const record = JSON.stringify(result)
    expect(record).toContain('continuable')
  })
})

/**
 * ⚠ THE THREE STATES — a PARKED round is not a FAILED one, IN THE RECORD.
 *
 * THE DEFECT THIS PINS, from a live run's own records. A review's continuable child had not settled within the
 * wait, so the loop PARKED the round — which its own interface says is NOT a failure, and which
 * `recursive_review` already surfaces to the model as `parked: true`. The RECORD written into the run tree did
 * not: it said `Status: failed` / "the child never reported, or never ran", and `operations.jsonl` said
 * `unaccepted`. The main agent read that, concluded its child was dead, and obtained the review by other means
 * — while the child was still working and replied eighteen minutes later. The tool result was honest and the
 * durable record was not, and the durable record is what the run is judged by afterwards.
 *
 * WHY THE ASSERTIONS ARE ON THE FILES. Asserting the shape of an in-memory result would not have caught it: the
 * lie was in the artifacts (`subagents/*-action.md` and `operations/operations.jsonl`), so the tests read those
 * artifacts back the way a later reader does. The failed case is asserted BESIDE the parked one on purpose — a
 * fix that made everything read as "not failed" would satisfy the parked test alone, and it would be worse than
 * the defect.
 */
describe('the action record distinguishes PARKED from FAILED (three states, not two)', () => {
  it('a round with no settlement is recorded as PARKED — not failed, naming the childId and the resume step', async () => {
    const { root, result } = await reviewOnDisk({ awaitRoundResult: async () => null })
    try {
      // The round really did park, so the record is asserted on a park rather than on a mocked status line.
      expect(result.parked).toBe(true)
      expect(result.delegationMode).toBe('continuable')

      const record = oneRecord(root)
      // A parked child is still working. `failed` is the word that cost a live run its own review.
      expect(record.text).toContain('Status: parked')
      expect(record.text, 'a parked round must NOT be recorded as a failure').not.toContain('Status: failed')
      // The advice is only actionable with the id, so the record has to carry it.
      expect(record.text).toContain('childId c1')
      expect(record.text, 'the record names the round as not-failed').toContain('PARKED, not failed')
      // Not asserted as "never ran": the plugin does not know that, and asserting it would be the same overreach.
      expect(record.text).not.toContain('never ran')
      // The failure field is not borrowed for the park: a park gets its own label.
      expect(record.text).not.toContain('Failure:')
      expect(record.text).toContain('Parked:')
      // ⚠ AND THE RECORD IS STILL A VALID ACTION RECORD FOR `recursive_lint`. The parked and failed states are
      // linted against the canonical sections in `tests/docs-contract.spec.ts`, which has a fully-populated
      // record to lint (this fixture delegates with no upstream artifacts or diff basis, so it would fail the
      // linter for reasons that have nothing to do with the status — a test that asserted those failures away
      // would be weakening the contract rather than checking it).

      // The operation log said `unaccepted`, which claims the delegation was judged and refused. It was neither.
      const operation = readOperations(join(root, '.recursive', 'run', 'run-1'))
        .find((entry) => entry.act === 'delegate-review')
      expect(operation?.outcome, 'a park is not an evaluation outcome').toBe('parked')

      // NOTHING WAS ACCEPTED: the parked round is still exactly as retryable as any unfinished attempt.
      const id = findOperation(join(root, '.recursive', 'run', 'run-1'), operation!.id)
      expect(id?.outcome).not.toBe('accepted')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a delegation that genuinely FAILED still says failed, with its cause', async () => {
    // The control for the test above, and the reason the fix is a third state rather than a renamed second: a
    // reviewer whose run ended in error must still be distinguishable from one that is still working.
    const { root, result } = await reviewOnDisk({
      awaitRoundResult: async () => ({ success: false, stopReason: 'error', output: 'the reviewer crashed' }),
    })
    try {
      expect(result.parked, 'an observed but failed round is not parked').toBeFalsy()
      const record = oneRecord(root)
      expect(record.text).toContain('Status: failed')
      expect(record.text).not.toContain('Status: parked')
      expect(record.text, 'the cause survives').toContain('Failure:')
      expect(record.text).toContain('stop reason error')
      // ⚠ THE ASSERTION THAT NAMES THIS BUG. The child DID report, so the record must not blame a wait: the
      // runtime used to drop the settled-but-refused result and produce exactly this sentence, which reads as
      // "your child never ran" for a delegation that ran and was refused.
      expect(record.text, 'a child that reported is not a child that never reported')
        .not.toContain('NO SETTLEMENT arrived')

      const operation = readOperations(join(root, '.recursive', 'run', 'run-1'))
        .find((entry) => entry.act === 'delegate-review')
      expect(operation?.outcome).toBe('unaccepted')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an ACCEPTED round is unchanged: accepted, and indexed as accepted', async () => {
    const { root, result } = await reviewOnDisk({ awaitRoundResult: async () => APPROVED })
    try {
      expect(result.parked).toBeFalsy()
      const record = oneRecord(root)
      expect(record.text).toContain('Status: accepted')
      expect(record.text).not.toContain('Parked:')
      const operation = readOperations(join(root, '.recursive', 'run', 'run-1'))
        .find((entry) => entry.act === 'delegate-review')
      expect(operation?.outcome).toBe('accepted')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * T19 — operation identity for a delegation.
 *
 * The id must make a repeat recognisable WITHOUT making legitimate work
 * unrecognisable: a review of a REPAIRED artifact is a different operation, and a
 * FAILED review must stay retryable. These cases share one root, because the point
 * is what a SECOND call sees that the first one recorded.
 */
describe('T19 — delegateReview identity', () => {
  const ARTIFACT = '03-implementation-summary.md'

  /** One root, reused, so the operation index accumulates across calls. */
  async function setup() {
    const root = makeRoot()
    const ctx = new Context()
    await ctx.plugin(RecursiveRuntime, { repoRoot: root })
    const fake = fakeSubagents({ continuable: true })
    const artifactPath = join(root, '.recursive', 'run', 'run-1', ARTIFACT)
    const call = () => ctx.recursive.delegateReview({
      root,
      runId: 'run-1',
      phase: '3',
      role: 'code-reviewer',
      delegationId: 'd1',
      childId: 'c1',
      artifactPath,
      upstreamArtifacts: [] as string[],
      auditQuestions: ['does it work?'],
      requiredOutput: 'verdict',
      providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
      subagents: fake.runtime,
      parent: {} as SubagentParentHandle,
      awaitRoundResult: async () => APPROVED,
    } as never)
    return {
      root,
      call,
      artifactPath,
      runDir: join(root, '.recursive', 'run', 'run-1'),
      dispose: async () => {
        await ctx.fiber.dispose()
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  /** The id the runtime computes: inputs plus the artifact BODY, never a lock hash. */
  function expectedId(runDir: string): string {
    const content = readFileSync(join(runDir, ARTIFACT), 'utf8')
    const body = lockHashFromContent(
      content.replace(/^[ \t]*Status:.*$/m, '').replace(/^[ \t]*LockedAt:.*\n?/m, ''),
    )
    return operationId({
      act: 'delegate-review',
      input: { runId: 'run-1', phase: '3', role: 'code-reviewer', delegationId: 'd1', body },
    })
  }

  it('reports the id and RECORDS the attempt, so a restart can match it', async () => {
    const m = await setup()
    try {
      const id = expectedId(m.runDir)
      expect(findOperation(m.runDir, id)).toBeNull()
      const result = await m.call() as { operationId?: string }
      expect(result.operationId).toBe(id)
      const recorded = findOperation(m.runDir, id)
      expect(recorded).not.toBeNull()
      expect(recorded!.act).toBe('delegate-review')
    } finally {
      await m.dispose()
    }
  })

  it('an ACCEPTED review is recorded as accepted — which is what blocks a repeat', async () => {
    const m = await setup()
    try {
      await m.call()
      const record = readOperations(m.runDir).find((r) => r.act === 'delegate-review')
      expect(record).toBeDefined()
      expect(record!.outcome).toBe('accepted')
    } finally {
      await m.dispose()
    }
  })

  it('only an ACCEPTED record blocks a retry — an unaccepted one stays retryable', async () => {
    const m = await setup()
    try {
      const id = expectedId(m.runDir)
      // Every failure path records a non-accepted outcome precisely so the work can
      // be attempted again; this seeds that state directly.
      recordOperation(m.runDir, { id, act: 'delegate-review', at: 't', outcome: 'unaccepted' })
      await expect(m.call()).resolves.toBeTruthy()
    } finally {
      await m.dispose()
    }
  })

  it('a RECOGNISED repeat of an ACCEPTED review is refused, not re-delegated', async () => {
    const m = await setup()
    try {
      const id = expectedId(m.runDir)
      // Seed the index as if this exact review had already passed — the state a
      // retry-after-lost-response presents.
      recordOperation(m.runDir, { id, act: 'delegate-review', at: 't', outcome: 'accepted' })
      await expect(m.call()).rejects.toThrow(/recognised repeat/)
    } finally {
      await m.dispose()
    }
  })

  it('a REPAIRED artifact is a DIFFERENT operation, so it can be reviewed again', async () => {
    const m = await setup()
    try {
      const before = expectedId(m.runDir)
      recordOperation(m.runDir, { id: before, act: 'delegate-review', at: 't', outcome: 'accepted' })
      // The repair changes the artifact, and the BODY is part of the id — so the
      // recognised-repeat guard no longer matches and the review proceeds.
      writeFileSync(m.artifactPath, '# Impl\n\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n\nrepaired\n', 'utf8')
      expect(expectedId(m.runDir)).not.toBe(before)
      await expect(m.call()).resolves.toBeTruthy()
    } finally {
      await m.dispose()
    }
  })
})
