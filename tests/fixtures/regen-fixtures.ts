/**
 * Regenerate the recursive-status parity FIXTURE RUNS (TS-only replacement for
 * regen_fixtures.py). Creates the fixture runs under tests/fixtures/repo/,
 * computes real LockHash values, tampers 05-manual-qa.md, and pins mtimes for
 * latest-run selection. The committed golden text files (expected-status*.txt)
 * are the canonical recursive-status.py oracle capture from run 07 and are NOT
 * rewritten here — the canonical skill repo remains the oracle for text output.
 *
 * Run:  npx tsx tests/fixtures/regen-fixtures.ts
 */
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockHashFromContent } from '../../src/status.ts'

const FIXTURES = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(FIXTURES, 'repo')
const RUN_ROOT = join(REPO, '.recursive', 'run')
const FIXTURE_RUN = join(RUN_ROOT, 'fixture-run')
const OLDER_RUN = join(RUN_ROOT, 'older-run')

const PLACEHOLDER_HASH = '0'.repeat(64)

const FIXTURE_RUN_MTIME = Date.UTC(2026, 0, 15, 9, 0, 0) / 1000   // newer
const OLDER_RUN_MTIME = Date.UTC(2026, 0, 1, 9, 0, 0) / 1000      // older

function lockHash(content: string): string {
  return lockHashFromContent(content)
}

function phase0Doc(runId: string, artifact: string, phaseLabel: string, lockedAt: string): string {
  return [
    `# Phase 0 (${phaseLabel}) — ${artifact}`,
    '',
    `Run: ${runId}`,
    'Phase: 0',
    'Status: LOCKED',
    'Workflow version: memory-phase8',
    'Inputs: none',
    'Outputs: none',
    'Scope note: fixture artifact for status-port parity tests.',
    '',
    '## TODO',
    '',
    '- [x] Complete phase 0 artifact',
    '',
    'Coverage: PASS',
    'Approval: PASS',
    `LockedAt: ${lockedAt}`,
    `LockHash: ${PLACEHOLDER_HASH}`,
    '',
  ].join('\n')
}

function draftDoc(runId: string, phase: string, artifact: string, inputs: string): string {
  return [
    `# Phase ${phase} — ${artifact}`,
    '',
    `Run: ${runId}`,
    `Phase: ${phase}`,
    'Status: DRAFT',
    'Workflow version: memory-phase8',
    `Inputs: ${inputs}`,
    'Outputs: none',
    'Scope note: fixture draft artifact.',
    '',
    '## TODO',
    '',
    '- [ ] Work in progress',
    '',
    'Coverage: MISSING',
    'Approval: MISSING',
    '',
  ].join('\n')
}

const QA_DOC = `# Phase 5 (Manual QA) — 05-manual-qa.md

Run: fixture-run
Phase: 5
Status: LOCKED
Workflow version: memory-phase8
Inputs: \`.recursive/run/fixture-run/02-to-be-plan.md\`
Outputs: none
Scope note: fixture artifact; intentionally tampered after locking.

## TODO

- [x] Complete manual QA

## QA Execution Record

- QA Execution Mode: human

## QA Scenarios and Results

- Manual QA scenarios were executed and passed.

## Evidence and Artifacts

- none

## User Sign-Off

- Approved by: Fixture Reviewer
- Date: 2026-01-15

Coverage: PASS
Approval: PASS
LockedAt: 2026-01-15T10:05:00Z
LockHash: 0000000000000000000000000000000000000000000000000000000000000000
`

/** Compute the real LockHash, then write with the real hash. Returns the hash. */
function finalizeArtifact(path: string, bodyWithPlaceholder: string): string {
  const real = lockHash(bodyWithPlaceholder)
  const finalized = bodyWithPlaceholder.replace(PLACEHOLDER_HASH, real)
  if (lockHash(finalized) !== real) throw new Error(`self-consistency failed for ${path}`)
  writeFileSync(path, finalized, 'utf8')
  return real
}

function pinMtime(path: string, ts: number): void {
  utimesSync(path, ts, ts)
}

function writeFixtureRun(): void {
  mkdirSync(FIXTURE_RUN, { recursive: true })
  finalizeArtifact(join(FIXTURE_RUN, '00-requirements.md'), phase0Doc('fixture-run', '00-requirements.md', 'Requirements', '2026-01-15T10:00:00Z'))
  finalizeArtifact(join(FIXTURE_RUN, '00-worktree.md'), phase0Doc('fixture-run', '00-worktree.md', 'Worktree', '2026-01-15T10:02:00Z'))
  writeFileSync(join(FIXTURE_RUN, '01-as-is.md'), draftDoc('fixture-run', '1', '01-as-is.md', '\`.recursive/run/fixture-run/00-requirements.md\`'), 'utf8')
  writeFileSync(join(FIXTURE_RUN, '02-to-be-plan.md'), draftDoc('fixture-run', '2', '02-to-be-plan.md', '\`.recursive/run/fixture-run/00-requirements.md\`, \`.recursive/run/fixture-run/01-as-is.md\`'), 'utf8')
  const qaPath = join(FIXTURE_RUN, '05-manual-qa.md')
  const qaHash = finalizeArtifact(qaPath, QA_DOC)
  // Tamper AFTER the LockHash line: stored hash no longer matches.
  const tampered = readFileSync(qaPath, 'utf8') + 'tamper-marker\n'
  writeFileSync(qaPath, tampered, 'utf8')
  if (lockHash(tampered) === qaHash) throw new Error('tamper must invalidate the stored hash')
}

function writeOlderRun(): void {
  mkdirSync(OLDER_RUN, { recursive: true })
  finalizeArtifact(join(OLDER_RUN, '00-requirements.md'), phase0Doc('older-run', '00-requirements.md', 'Requirements', '2026-01-01T09:00:00Z'))
}

function pinAllMtimes(): void {
  for (const [runDir, ts] of [[OLDER_RUN, OLDER_RUN_MTIME], [FIXTURE_RUN, FIXTURE_RUN_MTIME]] as const) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else pinMtime(full, ts)
      }
      pinMtime(dir, ts)
    }
    walk(runDir)
  }
}

function main(): void {
  writeFixtureRun()
  writeOlderRun()
  pinAllMtimes()
  console.log('fixture runs regenerated:')
  console.log('  ' + FIXTURE_RUN)
  console.log('  ' + OLDER_RUN)
  console.log('golden text files are NOT rewritten (canonical oracle capture from run 07).')
}

main()
