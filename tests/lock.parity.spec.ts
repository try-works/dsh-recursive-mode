import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  lockHashFromContent,
  getLockStatus,
  getPrerequisites,
  getPrerequisiteBlockers,
  validateChain,
  getNextLegalPhase,
  writeReceipt,
  invalidateReceipt,
  serializeForReceiptHash,
} from '../src/lock.ts'

const FIXTURE_REPO = fileURLToPath(new URL('../tests/fixtures/repo', import.meta.url))
const FIXTURE_RUN = join(FIXTURE_REPO, '.recursive', 'run', 'fixture-run')
// Python oracle (recursive-lock.py lock_hash_from_content) on the committed fixture:
const ORACLE_HASH = '044f9ba58fa4a66b3739441f95871a0407a67b3cbd8e98c5b7fdc9db291fe6c8'

describe('lock.ts lock hash (R3)', () => {
  it('recomputes LockHash identical to the Python oracle on the fixture', () => {
    const content = readFileSync(join(FIXTURE_RUN, '00-requirements.md'), 'utf8')
    expect(lockHashFromContent(content)).toBe(ORACLE_HASH)
  })

  it('getLockStatus returns LOCKED for the fixture requirements', () => {
    expect(getLockStatus(join(FIXTURE_RUN, '00-requirements.md'))).toBe('LOCKED')
  })

  it('getLockStatus returns MISSING for nonexistent files', () => {
    expect(getLockStatus(join(FIXTURE_RUN, 'does-not-exist.md'))).toBe('MISSING')
  })
})

describe('lock.ts chain validation (R3)', () => {
  let tmpRun: string

  beforeAll(() => {
    tmpRun = mkdtempSync(join(tmpdir(), 'rm-lock-parity-'))
    mkdirSync(join(tmpRun, '.recursive', 'run', 'tmp-run'), { recursive: true })
    const run = join(tmpRun, '.recursive', 'run', 'tmp-run')
    // 00-requirements LOCKED with a valid self-consistent hash
    const req = [
      'Run: tmp-run',
      'Phase: 0',
      'Status: `LOCKED`',
      'Workflow version: recursive-mode-audit-v2',
      '',
      '## TODO',
      '',
      '- [x] done',
      '',
      'Coverage: PASS',
      'Approval: PASS',
      'LockedAt: `2026-01-15T10:00:00Z`',
      'LockHash: `PLACEHOLDER`',
      '',
    ].join('\n')
    // Compute the self-consistent hash: hash(content-with-LockHash-line)
    const reqHash = lockHashFromContent(req.replace('PLACEHOLDER', '0'.repeat(64)))
    writeFileSync(join(run, '00-requirements.md'), req.replace('PLACEHOLDER', reqHash), 'utf8')
    // 01-as-is DRAFT (no lock)
    writeFileSync(join(run, '01-as-is.md'), 'Run: tmp-run\nPhase: 1\nStatus: `DRAFT`\n\n## TODO\n\n- [ ] pending\n', 'utf8')
  })

  afterAll(() => {
    rmSync(tmpRun, { recursive: true, force: true })
  })

  it('getPrerequisites follows sequence order', () => {
    const run = join(tmpRun, '.recursive', 'run', 'tmp-run')
    const prereqs = getPrerequisites(run, '02-to-be-plan.md')
    expect(prereqs).toEqual(['00-requirements.md', '01-as-is.md'])
  })

  it('getPrerequisiteBlockers reports a DRAFT prerequisite', () => {
    const run = join(tmpRun, '.recursive', 'run', 'tmp-run')
    // 01-as-is is DRAFT -> blocks 02
    const blockers = getPrerequisiteBlockers(run, '02-to-be-plan.md')
    expect(blockers.length).toBeGreaterThan(0)
    expect(blockers[0].artifact).toBe('01-as-is.md')
    expect(blockers[0].status).toBe('DRAFT')
  })

  it('validateChain finds the break phase (first mandatory non-LOCKED phase)', () => {
    const run = join(tmpRun, '.recursive', 'run', 'tmp-run')
    const chain = validateChain(run, 'tmp-run')
    // 00-worktree.md is mandatory and missing -> it is the break phase,
    // not 01-as-is (which is present but DRAFT).
    expect(chain.breakPhase).toBe('00-worktree.md')
    expect(chain.complete).toBe(false)
  })

  it('getNextLegalPhase returns the first non-LOCKED mandatory phase', () => {
    const run = join(tmpRun, '.recursive', 'run', 'tmp-run')
    // 00-worktree.md is mandatory and missing -> next legal is 00-worktree.md
    expect(getNextLegalPhase(run)).toBe('00-worktree.md')
  })

  it('serializeForReceiptHash matches the Python oracle byte-for-byte', () => {
    // Deterministic input mirrored from the Python oracle run:
    const d = {
      artifact: '00-requirements.md',
      artifact_path: 'D:\\DEV\\tmp\\rm-py-deterministic\\.recursive\\run\\test-run\\00-requirements.md',
      artifact_hash: '044f9ba58fa4a66b3739441f95871a0407a67b3cbd8e98c5b7fdc9db291fe6c8',
      locked_at: '2026-01-15T10:00:00Z',
      prerequisite_hashes: {},
      previous_receipt_hash: null,
    }
    const compact = serializeForReceiptHash(d)
    const hash = createHash('sha256').update(compact, 'utf8').digest('hex')
    expect(hash).toBe('bd50689546d1bc925088e6169bfd0092d2a183bad0b7841f48a40c586e3271aa')
  })

  it('receipt write/invalidate round-trips', () => {
    const run = join(tmpRun, '.recursive', 'run', 'tmp-run')
    const receipt = writeReceipt(run, '01-as-is.md', join(run, '01-as-is.md'))
    expect(receipt.artifact).toBe('01-as-is.md')
    expect(receipt.artifact_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.prerequisite_hashes).toHaveProperty('00-requirements.md')
    expect(invalidateReceipt(run, '01-as-is.md')).toBe(true)
    expect(invalidateReceipt(run, '01-as-is.md')).toBe(false)
  })
})


