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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
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
