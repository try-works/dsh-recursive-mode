/**
 * T19 — deterministic operation identity.
 *
 * WHY. `reopen` is the one genuinely destructive operation in the workflow, and a
 * retry after a partial failure is currently indistinguishable from a fresh request.
 * So a re-submitted reopen can run twice, and a delegated round can be executed
 * again when its first attempt was only interrupted. Two independent systems
 * converged on the same fix — Tardigrade's `InputDigest` (canonical JSON → SHA-256
 * plus byte length, inline below a size limit and digested above) and Effect's
 * `makeExecutionIdFromPayload` (`tag.length:tag:payload`, hashed) — so the shape of
 * the answer is not in doubt; what is missing here is any identity at all.
 *
 * ⚠ THE ITEM'S WORDING IS OFF IN TWO PLACES, checked against the code first:
 *   - It says to wire identity into `recursive_reopen`. **That tool does not exist.**
 *     Reopen is a `reopen: boolean` PARAMETER of `recursive_lock`, so the real seam
 *     is `RecursiveRuntime.lockArtifact(runId, artifact, reopen)`.
 *   - It puts the index in `ctx.storageDomain`. This module uses a bounded,
 *     git-ignored FILE for the same reason `guard-log.ts` does (§4.0, and that
 *     file's own header): the record must survive a restart and be inspectable
 *     out-of-band, and a file keeps the plugin free of a store that may be absent.
 *     The plan's real requirement — that the index is PERSISTED, not derived — is
 *     met either way; the degradation it asks for becomes the trivial "no index file
 *     yet", which is easier to test than an absent service.
 *
 * The point of the index is that it CANNOT be re-derived from the run's artifacts:
 * it records that an operation was already attempted, which no file on disk says.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { lockHashFromContent } from '../src/lock.ts'
import {
  canonicalInput,
  idempotencyKey,
  operationId,
  operationsPath,
  readOperations,
  findOperation,
  recordOperation,
  INLINE_LIMIT_BYTES,
} from '../src/identity.ts'

function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-identity-'))
  const dir = join(root, '.recursive', 'run', 'r1')
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('T19 — canonical input', () => {
  it('sorts object keys, so insertion order cannot change the id', () => {
    expect(canonicalInput({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalInput({ a: 2, b: 1 })).toBe('{"a":2,"b":1}')
  })

  it('sorts NESTED keys too, at every depth', () => {
    expect(canonicalInput({ z: { b: 1, a: [{ d: 1, c: 2 }] } }))
      .toBe('{"z":{"a":[{"c":2,"d":1}],"b":1}}')
  })

  it('PRESERVES array order, because order is part of the meaning', () => {
    expect(canonicalInput([1, 2, 3])).toBe('[1,2,3]')
    expect(canonicalInput([3, 2, 1])).toBe('[3,2,1]')
  })

  it('rejects a LONE SURROGATE rather than emitting invalid JSON', () => {
    // A lone surrogate cannot be encoded as valid UTF-8, so hashing it would be
    // hashing a replacement character — two different inputs, one identity.
    expect(() => canonicalInput({ s: '\uD800' })).toThrow(/surrogate/i)
    expect(() => canonicalInput('\uDFFF')).toThrow(/surrogate/i)
    // A well-formed PAIR is legitimate and must pass.
    expect(canonicalInput('\u{1F600}')).toContain('😀')
  })

  it('rejects a NON-FINITE number rather than serialising it as null', () => {
    expect(() => canonicalInput({ n: Number.NaN })).toThrow(/finite/i)
    expect(() => canonicalInput({ n: Number.POSITIVE_INFINITY })).toThrow(/finite/i)
    expect(() => canonicalInput([Number.NEGATIVE_INFINITY])).toThrow(/finite/i)
    expect(canonicalInput({ n: 0 })).toBe('{"n":0}')
  })
})

describe('T19 — operation identity', () => {
  it('is stable across key order and identical inputs', () => {
    expect(operationId({ act: 'reopen', input: { b: 1, a: 2 } }))
      .toBe(operationId({ act: 'reopen', input: { a: 2, b: 1 } }))
  })

  it('DIFFERS for a different act, even with identical input', () => {
    expect(operationId({ act: 'reopen', input: { a: 1 } }))
      .not.toBe(operationId({ act: 'lock', input: { a: 1 } }))
  })

  it('DIFFERS when array order changes (a materially different operation)', () => {
    expect(operationId({ act: 'audit', input: [1, 2] }))
      .not.toBe(operationId({ act: 'audit', input: [2, 1] }))
  })

  it('DIFFERS when a value changes', () => {
    expect(operationId({ act: 'reopen', input: { artifact: 'a' } }))
      .not.toBe(operationId({ act: 'reopen', input: { artifact: 'b' } }))
  })

  it('is a bounded, filesystem-safe token', () => {
    const id = operationId({ act: 'reopen', input: { a: 1 } })
    expect(id).toMatch(/^[a-f0-9]{32}$/)
  })

  it('INLINES a small input and DIGESTS a large one', () => {
    const small = idempotencyKey({ a: 1 })
    expect(small.startsWith('inline:')).toBe(true)
    // Just over the limit must switch representation, so the key stays bounded.
    const big = idempotencyKey({ pad: 'x'.repeat(INLINE_LIMIT_BYTES + 1) })
    expect(big.startsWith('sha256:')).toBe(true)
    expect(big.length).toBeLessThan(INLINE_LIMIT_BYTES)
  })
})

describe('T19 — the operation index records that an attempt happened', () => {
  it('records and finds an operation, across a fresh read', () => {
    const dir = runDir()
    try {
      const id = operationId({ act: 'reopen', input: { artifact: '01-as-is.md' } })
      expect(findOperation(dir, id)).toBeNull()
      recordOperation(dir, { id, act: 'reopen', at: '2026-01-01T00:00:00Z', outcome: 'applied' })
      // Read back FROM DISK, which is the property the index exists for.
      const found = findOperation(dir, id)
      expect(found).not.toBeNull()
      expect(found!.act).toBe('reopen')
      expect(found!.outcome).toBe('applied')
      expect(existsSync(operationsPath(dir))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recognises a RE-SUBMITTED identical operation and not a materially different one', () => {
    const dir = runDir()
    try {
      const first = operationId({ act: 'reopen', input: { artifact: 'a.md' } })
      recordOperation(dir, { id: first, act: 'reopen', at: '2026-01-01T00:00:00Z' })
      // The identical retry: same id, so the caller can recognise it as the same op.
      expect(findOperation(dir, operationId({ act: 'reopen', input: { artifact: 'a.md' } }))).not.toBeNull()
      // A different artifact is a different operation.
      expect(findOperation(dir, operationId({ act: 'reopen', input: { artifact: 'b.md' } }))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is APPEND-ONLY, so earlier attempts survive later ones', () => {
    const dir = runDir()
    try {
      recordOperation(dir, { id: 'a'.repeat(32), act: 'reopen', at: 't1' })
      recordOperation(dir, { id: 'b'.repeat(32), act: 'reopen', at: 't2' })
      expect(readOperations(dir).map((r) => r.at)).toEqual(['t1', 't2'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never throws on a MISSING index (degrade to no-op) or a corrupt one', () => {
    const dir = runDir()
    try {
      expect(readOperations(dir)).toEqual([])
      expect(findOperation(dir, 'x')).toBeNull()
      mkdirSync(join(dir, 'operations'), { recursive: true })
      writeFileSync(operationsPath(dir), 'not json\n{"id":"' + 'c'.repeat(32) + '","act":"reopen","at":"t3"}\n', 'utf8')
      // A corrupt line is skipped rather than making the run unreadable.
      expect(readOperations(dir).map((r) => r.at)).toEqual(['t3'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the index OUT of the artifact set (it is not evidence a reviewer reads)', () => {
    const dir = runDir()
    try {
      recordOperation(dir, { id: 'd'.repeat(32), act: 'lock', at: 't' })
      // The log lives under the run's own control-plane subdirectory, beside the
      // guard log, not among the phase artifacts.
      expect(operationsPath(dir)).toContain(join(dir, 'operations'))
      expect(readFileSync(operationsPath(dir), 'utf8')).toContain('d'.repeat(32))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * T19 — the wiring, at the seam that actually exists.
 *
 * `recursive_reopen` is not a tool (the item says to wire identity into it); reopen
 * is a parameter of `recursive_lock`. These cases drive `lockArtifact(..., reopen)`
 * through the REAL runtime, because the property that matters is behavioural: a
 * retry must be recognisable, and a DELIBERATE second reopen must still work. The
 * second half is the one a naive `{runId, artifact}` key would have broken.
 */
describe('T19 — reopen identity at the real seam', () => {
  const RUN = 'id-run'
  const ARTIFACT = '00-requirements.md'

  async function mount() {
    const repo = mkdtempSync(join(tmpdir(), 'rm-idwire-'))
    const ctx = new Context()
    await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
    await ctx.recursive.initRun(RUN)
    const dir = join(repo, '.recursive', 'run', RUN)
    writeFileSync(
      join(dir, ARTIFACT),
      'Run: `x`\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n\nCoverage: PASS\nApproval: PASS\n',
      'utf8',
    )
    return {
      ctx,
      dir,
      dispose: async () => {
        await ctx.fiber.dispose()
        rmSync(repo, { recursive: true, force: true })
      },
    }
  }

  /** The id the runtime will compute for reopening the artifact's CURRENT state. */
  function currentReopenId(dir: string): string {
    const content = readFileSync(join(dir, ARTIFACT), 'utf8')
    // The state is the artifact's BODY (lock fields normalised out), not its
    // LockHash — which covers the wall-clock LockedAt and so is not stable across a
    // re-lock of identical content. See the T37 note in runtime.ts.
    const body = lockHashFromContent(
      content.replace(/^[ \t]*Status:.*$/m, '').replace(/^[ \t]*LockedAt:.*\n?/m, ''),
    )
    return operationId({ act: 'reopen', input: { runId: RUN, artifact: ARTIFACT, body } })
  }

  it('a completed reopen is RECORDED, so a retry is recognisable', async () => {
    const m = await mount()
    try {
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT)
      const id = currentReopenId(m.dir)
      expect(findOperation(m.dir, id)).toBeNull()
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT, true)
      const recorded = findOperation(m.dir, id)
      expect(recorded).not.toBeNull()
      expect(recorded!.act).toBe('reopen')
      expect(recorded!.outcome).toBe('applied')
    } finally {
      await m.dispose()
    }
  })

  it('a RECOGNISED repeat is refused rather than destroying evidence twice', async () => {
    const m = await mount()
    try {
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT)
      const id = currentReopenId(m.dir)
      // Seed the index as if this exact operation had already completed — the state
      // a retry-after-lost-response presents.
      recordOperation(m.dir, { id, act: 'reopen', at: 't', outcome: 'applied' })
      await expect(m.ctx.recursive.lockArtifact(RUN, ARTIFACT, true)).rejects.toThrow(/recognised repeat/)
    } finally {
      await m.dispose()
    }
  })

  it('BUT a legitimate second reopen still works (reopen -> FIX -> lock -> reopen)', async () => {
    // This is what keying on `{runId, artifact}` alone would have broken: after the
    // repair the artifact hashes DIFFERENTLY, so the second reopen opens a different
    // state and is genuinely a different operation.
    const m = await mount()
    try {
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT)
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT, true)
      // THE FIX — the step that makes this a different operation. Without it the
      // artifact would re-lock to the identical hash (see the boundary case below).
      writeFileSync(
        join(m.dir, ARTIFACT),
        'Run: `x`\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n\nCoverage: PASS\nApproval: PASS\n\n## Notes\n\nrepaired\n',
        'utf8',
      )
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT)
      const second = await m.ctx.recursive.lockArtifact(RUN, ARTIFACT, true)
      // A reopen RESULTS in DRAFT — that is what it is for.
      expect(second.status).toBe('DRAFT')
      expect(second.artifact).toBe(ARTIFACT)
      // Two distinct operations are on record, one per locked state.
      const reopens = readOperations(m.dir).filter((r) => r.act === 'reopen')
      expect(reopens).toHaveLength(2)
      expect(reopens[0].id).not.toBe(reopens[1].id)
    } finally {
      await m.dispose()
    }
  })

  it('BOUNDARY, documented: reopening an UNCHANGED re-locked artifact is a repeat', async () => {
    // Re-locking identical content yields an IDENTICAL LockHash, so the second
    // reopen targets a byte-identical state and cannot be told apart from a retry.
    // Refusing it is the deliberate choice: the alternative is to accept every
    // retry, which is the defect this item exists to fix. Repairing the artifact
    // first — as the case above does — makes the operation distinct.
    const m = await mount()
    try {
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT)
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT, true)
      await m.ctx.recursive.lockArtifact(RUN, ARTIFACT)
      await expect(m.ctx.recursive.lockArtifact(RUN, ARTIFACT, true)).rejects.toThrow(/recognised repeat/)
    } finally {
      await m.dispose()
    }
  })
})
