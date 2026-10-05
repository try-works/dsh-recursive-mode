/**
 * T8 — reviewer references are validated by the native seam, ON THE DELEGATE PATH.
 *
 * ⚠ THE DEFECT THIS ITEM'S OWN RESCOPE IDENTIFIED, and it was worse than "hand-rolled
 * validation": `validateReferences` **existed, was exported, and was reachable through the
 * runtime — and was called by NOTHING on the delegate path.** The module header had always
 * claimed the opposite ("validates the child's references before writing an action record"),
 * and `evaluateDelegationResult` reads only `success`/`stopReason`, so the `references`
 * field the review schema REQUIRES was never examined anywhere. A reviewer could cite files
 * that do not exist, or paths that escape the workspace, and the review was recorded as a
 * PASS — a claim nobody checks is worse than no claim, because it reads as evidence.
 *
 * The acceptance has three clauses and all three are below: references are validated, an
 * ESCAPING path is still rejected, and the validation ACTUALLY RUNS on the delegate path
 * (asserted through `delegateReview`, not by calling the validator directly).
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { referencesFromResult, validateReferences, type SubagentsRuntimeLike } from '../src/delegation.ts'

const ARTIFACT = '03-implementation-summary.md'
const GOOD_REF = '.recursive/run/run-1/03-implementation-summary.md'

/**
 * A router policy that ROUTES the role to a provider. Without it `delegateReview` resolves
 * to self-audit and never reaches a child at all — which is what my first version of these
 * tests actually measured (the reason read "delegation resolved to self-audit"), a premise
 * about the harness rather than about the code under test.
 */
const POLICY = {
  version: 1,
  role_routes: {
    'code-reviewer': { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
  },
  cli_overrides: {},
  custom_clis: [],
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-t8-'))
  const runDir = join(root, '.recursive', 'run', 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, ARTIFACT), '# Impl\n\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n', 'utf8')
  const cfg = join(root, '.recursive', 'config')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'recursive-router.json'), JSON.stringify(POLICY), 'utf8')
  return root
}

/** A completed delegation carrying whatever references the case wants to claim. */
function completed(references: unknown): unknown {
  return {
    success: true,
    stopReason: 'completed',
    structured: { verdict: 'APPROVE', findings: [], references },
  }
}

function fakeSubagents(result: unknown) {
  const calls: string[] = []
  const runtime = {
    start: async () => { calls.push('start'); return result },
  }
  return { calls, runtime: runtime as unknown as SubagentsRuntimeLike }
}

async function review(root: string, result: unknown) {
  const ctx = new Context()
  await ctx.plugin(RecursiveRuntime, { repoRoot: root })
  const fake = fakeSubagents(result)
  const out = await ctx.recursive.delegateReview({
    root,
    runId: 'run-1',
    phase: '3',
    role: 'code-reviewer',
    delegationId: 'd1',
    childId: 'c1',
    artifactPath: join(root, '.recursive', 'run', 'run-1', ARTIFACT),
    upstreamArtifacts: [],
    auditQuestions: ['does it work?'],
    requiredOutput: 'verdict',
    mode: 'one-shot',
    subagents: fake.runtime,
    parent: {},
    providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
    awaitRoundResult: async () => result,
  } as never)
  await ctx.fiber.dispose()
  return { out, calls: fake.calls }
}

describe('T8 — reading the child’s claimed references', () => {
  it('reads structured claims', () => {
    const refs = referencesFromResult({ structured: { references: [{ path: 'a.ts', lineRange: '1-2' }] } })
    expect(refs).toEqual([{ path: 'a.ts', lineRange: '1-2' }])
  })

  it('reads claims from JSON text output when there is no structured value', () => {
    const refs = referencesFromResult({ output: JSON.stringify({ references: [{ path: 'b.ts' }] }) })
    expect(refs).toEqual([{ path: 'b.ts' }])
  })

  it('returns NOTHING for an unparseable result, so it cannot be mistaken for a verified one', () => {
    // The important direction: "no claims" means nothing to check, never a pass.
    expect(referencesFromResult({ output: 'not json at all' })).toEqual([])
    expect(referencesFromResult({})).toEqual([])
    expect(referencesFromResult({ structured: { references: 'nope' } })).toEqual([])
  })

  it('drops malformed ENTRIES rather than throwing on a model’s output', () => {
    // This reads untrusted text: one bad element must not lose the good ones.
    const refs = referencesFromResult({
      structured: { references: [{ path: 'good.ts' }, null, { noPath: 1 }, { path: '   ' }, 'nope'] },
    })
    expect(refs).toEqual([{ path: 'good.ts' }])
  })
})

describe('T8 — escaping paths are still rejected', () => {
  it('refuses a traversal path', () => {
    const root = makeRoot()
    try {
      const check = validateReferences(root, [{ path: '../../etc/passwd' }])
      expect(check.ok).toBe(false)
      expect(check.failures.join(' ')).toMatch(/escape|outside|root/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses an absolute path pointing outside the root', () => {
    const root = makeRoot()
    try {
      const check = validateReferences(root, [{ path: 'C:/Windows/System32/drivers/etc/hosts' }])
      expect(check.ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('T8 — and the validation ACTUALLY RUNS on the delegate path', () => {
  it('a review citing a REAL file is accepted', async () => {
    const root = makeRoot()
    try {
      const { out } = await review(root, completed([{ path: GOOD_REF }]))
      expect((out as { evaluation?: { accepted?: boolean } }).evaluation?.accepted).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a review citing a file that does NOT exist is refused, and names it', async () => {
    const root = makeRoot()
    try {
      const { out } = await review(root, completed([{ path: '.recursive/run/run-1/ghost.md' }]))
      const result = out as { evaluation?: { accepted?: boolean; reason?: string } }
      expect(result.evaluation?.accepted).toBe(false)
      expect(result.evaluation?.reason).toContain('review references failed')
      expect(result.evaluation?.reason).toContain('ghost.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a review citing an ESCAPING path is refused on the delegate path too', async () => {
    const root = makeRoot()
    try {
      const { out } = await review(root, completed([{ path: '../../../etc/passwd' }]))
      const result = out as { evaluation?: { accepted?: boolean; reason?: string } }
      expect(result.evaluation?.accepted).toBe(false)
      expect(result.evaluation?.reason).toContain('review references failed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a delegation claiming NOTHING is not refused — the documented boundary', async () => {
    // Refusing an empty list would be a POLICY change (is a reference-free review invalid?),
    // not a wiring fix, so it is a deliberate boundary rather than an oversight.
    const root = makeRoot()
    try {
      const { out } = await review(root, completed([]))
      expect((out as { evaluation?: { accepted?: boolean } }).evaluation?.accepted).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the refusal happens BEFORE the attempt is indexed, so a bad review stays retryable', async () => {
    // The order is the point: recording first and validating after would freeze a bad review
    // into T19's repeat guard, making it look like work that had already passed.
    const root = makeRoot()
    try {
      await review(root, completed([{ path: '.recursive/run/run-1/ghost.md' }]))
      const index = join(root, '.recursive', 'run', 'run-1', 'operations', 'operations.jsonl')
      expect(existsSync(index)).toBe(true)
      const records = readFileSync(index, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { outcome?: string })
      expect(records.some((record) => record.outcome === 'accepted')).toBe(false)
      expect(records.some((record) => record.outcome === 'unaccepted')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
