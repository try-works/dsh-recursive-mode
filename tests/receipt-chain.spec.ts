/**
 * T32 — verify the receipt chain on read.
 *
 * FINDING E, RE-VERIFIED: `previous_receipt_hash` is declared and written and
 * nothing ever reads it. `validateChain` answers a different question — which phase
 * is the first mandatory non-LOCKED one — so receipts are never compared to each
 * other, and a receipt set that has been edited or spliced reads as healthy. Same
 * class of defect as T15: a written-and-exported mechanism with no live consumer.
 *
 * ⚠ THE PLAN'S STATED CHECK DOES NOT MATCH WHAT THE WRITER EMITS, so this spec pins
 * what is REAL rather than what the item describes. The item says to assert "each
 * receipt's `previous_receipt_hash` equals its predecessor's artifact hash" — an
 * inter-phase chain keyed by the previous phase's artifact. The writer does
 * something else: `writeReceipt` sets `previous_receipt_hash` from the SAME
 * artifact's PREVIOUS receipt, so it is a per-artifact version chain, it is `null`
 * on every first lock, and — because there is exactly ONE receipt file per artifact
 * (`locks/<stem>.receipt.json`) — the receipt it names has been overwritten and can
 * no longer be checked against anything. Implementing the item's sentence literally
 * would fail every real receipt set.
 *
 * What IS verifiable, and what this spec covers:
 *   1. RECEIPT INTEGRITY — recompute `receipt_hash` from the stored fields. This is
 *      the actual "written but never read" gap, and it catches a receipt edited
 *      after the fact.
 *   2. PREREQUISITE AGREEMENT — each recorded `prerequisite_hashes[p]` must still
 *      match p's current artifact hash, catching an upstream artifact changed after
 *      this one was locked (a splice).
 *   3. GAP — a receipt whose declared prerequisite has no receipt at all.
 *   4. MALFORMED `previous_receipt_hash` — a value the writer could never have
 *      produced. Its LINKAGE is explicitly NOT claimed: the receipt it names is
 *      gone, so a linkage check would be theatre.
 *
 * PHASE ORDER, measured rather than assumed: `getPrerequisites` returns every
 * EARLIER existing phase in `PHASE_SEQUENCE`, and the head of that sequence is
 * `00-requirements.md`, whose only follower here is `00-worktree.md`. So
 * requirements is the upstream and worktree the downstream in these fixtures.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { validateReceiptChain, receiptPath, readReceipt, lockHashFromContent } from '../src/lock.ts'
import { writeCompliantRun } from './compliant-artifact.ts'

const RUN = 'chain-run'
const HEAD = '00-requirements.md'
const NEXT = '00-worktree.md'

interface Mounted {
  ctx: Context
  repo: string
  runDir: string
  dispose: () => Promise<void>
}

/** A run with REAL receipts, produced by the real lock path, locked in chain order. */
async function mount(phases: string[]): Promise<Mounted> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-chain-'))
  const ctx = new Context()
  await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
  await ctx.recursive.initRun(RUN)
  const runDir = join(repo, '.recursive', 'run', RUN)
  // T32 locks these phases for real, and `lockArtifact` refuses an artifact below its
  // phase standard — so the fixtures are AUTHORED to it (see compliant-artifact.ts)
  // rather than written as skeletons. The scaffold's own `00-worktree.md` records the
  // placeholder diff basis the linter rejects at run level, which would refuse every
  // lock in the run and leave this spec testing nothing.
  writeCompliantRun(repo, RUN, phases)
  for (const phase of phases) await ctx.recursive.lockArtifact(RUN, phase)
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

/** Read a receipt as raw JSON so a test can edit one field without re-hashing. */
function rawReceipt(runDir: string, phase: string): Record<string, unknown> {
  return JSON.parse(readFileSync(receiptPath(runDir, phase), 'utf8')) as Record<string, unknown>
}

function writeRawReceipt(runDir: string, phase: string, value: Record<string, unknown>): void {
  writeFileSync(receiptPath(runDir, phase), JSON.stringify(value, null, 2) + '\n', 'utf8')
}

describe('T32 — the common case must not regress', () => {
  it('an untouched two-phase chain validates', async () => {
    const m = await mount([HEAD, NEXT])
    try {
      const result = validateReceiptChain(m.runDir, RUN)
      expect(result.breaks).toEqual([])
      expect(result.ok).toBe(true)
      expect(result.checked).toBe(2)
    } finally {
      await m.dispose()
    }
  })

  it('a SINGLE receipt validates', async () => {
    const m = await mount([HEAD])
    try {
      const result = validateReceiptChain(m.runDir, RUN)
      expect(result.ok).toBe(true)
      expect(result.checked).toBe(1)
    } finally {
      await m.dispose()
    }
  })

  it('a run with NO receipts validates vacuously and checks nothing', async () => {
    const m = await mount([])
    try {
      const result = validateReceiptChain(m.runDir, RUN)
      expect(result.ok).toBe(true)
      expect(result.checked).toBe(0)
    } finally {
      await m.dispose()
    }
  })
})

describe('T32 — a receipt edited after the fact is CAUGHT', () => {
  it('a changed artifact_hash no longer matches its own receipt_hash', async () => {
    const m = await mount([HEAD])
    try {
      const receipt = rawReceipt(m.runDir, HEAD)
      writeRawReceipt(m.runDir, HEAD, { ...receipt, artifact_hash: 'f'.repeat(64) })
      const result = validateReceiptChain(m.runDir, RUN)
      expect(result.ok).toBe(false)
      expect(result.breaks).toHaveLength(1)
      expect(result.breaks[0].kind).toBe('receipt-hash-mismatch')
      expect(result.breaks[0].phase).toBe(HEAD)
      // It names BOTH values, so the break is diagnosable without a debugger.
      expect(result.breaks[0].detail).toContain('f'.repeat(64))
      expect(result.breaks[0].detail).toContain(String(receipt.receipt_hash))
    } finally {
      await m.dispose()
    }
  })

  it('a changed locked_at is caught too (every field is covered by the hash)', async () => {
    const m = await mount([HEAD])
    try {
      const receipt = rawReceipt(m.runDir, HEAD)
      writeRawReceipt(m.runDir, HEAD, { ...receipt, locked_at: '1999-01-01T00:00:00Z' })
      const result = validateReceiptChain(m.runDir, RUN)
      expect(result.ok).toBe(false)
      expect(result.breaks[0].kind).toBe('receipt-hash-mismatch')
    } finally {
      await m.dispose()
    }
  })
})

describe('T32 — a SPLICED or GAPPED chain is reported, never silently healthy', () => {
  it('an upstream artifact changed after locking is a prerequisite mismatch', async () => {
    const m = await mount([HEAD, NEXT])
    try {
      // Rewrite the upstream artifact AFTER the downstream receipt recorded its hash.
      const body = 'Run: `x`\nStatus: `LOCKED`\n\n## TODO\n\n- [x] done\n\nCoverage: PASS\nApproval: PASS\nLockedAt: 2026-01-01T00:00:00Z\n'
      writeFileSync(join(m.runDir, HEAD), body + 'LockHash: ' + lockHashFromContent(body + 'LockHash: ' + '0'.repeat(64) + '\n') + '\n', 'utf8')
      const result = validateReceiptChain(m.runDir, RUN)
      const splice = result.breaks.find((b) => b.kind === 'prerequisite-hash-mismatch')
      expect(splice).toBeDefined()
      // The FAULT is on the downstream receipt; the detail names the upstream it cites.
      expect(splice!.phase).toBe(NEXT)
      expect(splice!.detail).toContain(HEAD)
    } finally {
      await m.dispose()
    }
  })

  it('a downstream receipt whose prerequisite has NO receipt is a GAP', async () => {
    const m = await mount([HEAD, NEXT])
    try {
      unlinkSync(receiptPath(m.runDir, HEAD))
      const result = validateReceiptChain(m.runDir, RUN)
      const gap = result.breaks.find((b) => b.kind === 'missing-prerequisite-receipt')
      expect(gap).toBeDefined()
      expect(gap!.phase).toBe(NEXT)
      expect(gap!.detail).toContain(HEAD)
    } finally {
      await m.dispose()
    }
  })

  it('a malformed previous_receipt_hash is reported rather than trusted', async () => {
    const m = await mount([HEAD])
    try {
      const receipt = rawReceipt(m.runDir, HEAD)
      writeRawReceipt(m.runDir, HEAD, { ...receipt, previous_receipt_hash: 'not-a-hash' })
      const result = validateReceiptChain(m.runDir, RUN)
      expect(result.ok).toBe(false)
      expect(result.breaks.map((b) => b.kind)).toContain('malformed-previous-hash')
    } finally {
      await m.dispose()
    }
  })

  it('claims NO linkage it cannot prove: a legitimate null previous_receipt_hash passes', async () => {
    // A first lock carries null, and the receipt it would chain to has been
    // overwritten — so linkage is unverifiable and is deliberately NOT asserted.
    const m = await mount([HEAD])
    try {
      expect(readReceipt(m.runDir, HEAD)!.previous_receipt_hash).toBeNull()
      expect(validateReceiptChain(m.runDir, RUN).ok).toBe(true)
    } finally {
      await m.dispose()
    }
  })
})

describe('T32 — verification is READ-ONLY', () => {
  it('does not rewrite, repair or touch a single receipt', async () => {
    const m = await mount([HEAD, NEXT])
    try {
      const path = receiptPath(m.runDir, HEAD)
      writeRawReceipt(m.runDir, HEAD, { ...rawReceipt(m.runDir, HEAD), artifact_hash: 'a'.repeat(64) })
      const brokenText = readFileSync(path, 'utf8')
      validateReceiptChain(m.runDir, RUN)
      validateReceiptChain(m.runDir, RUN)
      // A verification that mutates what it verifies is worthless.
      expect(readFileSync(path, 'utf8')).toBe(brokenText)
      expect(rawReceipt(m.runDir, HEAD).artifact_hash).toBe('a'.repeat(64))
    } finally {
      await m.dispose()
    }
  })
})

describe('T32 — a missing locks directory is empty, not an error', () => {
  it('never throws on a run directory with no locks at all', () => {
    const bare = mkdtempSync(join(tmpdir(), 'rm-chain-bare-'))
    try {
      mkdirSync(join(bare, 'locks'), { recursive: true })
      expect(validateReceiptChain(bare, 'no-such-run').ok).toBe(true)
      expect(validateReceiptChain(join(bare, 'nope'), 'x').ok).toBe(true)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})
