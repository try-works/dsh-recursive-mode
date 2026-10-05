/**
 * Vitest globalSetup — establishes the fixture preconditions that GIT CANNOT CARRY.
 *
 * This file exists because the suite was green in one working tree and red in a
 * fresh clone of the same commit (`Test Files 6 failed | 41 passed`). Two classes
 * of fixture fact do not survive `git clone`:
 *
 * 1. MTIMES. `getLatestRunDirectory` (`src/run.ts`) picks the active run BY
 *    MTIME — `runs.sort((a, b) => mtimeMs(b) - mtimeMs(a))`. The fixture at
 *    `tests/fixtures/repo` deliberately holds two runs whose ORDER IS THE POINT:
 *    `fixture-run` must be newer than `older-run`. Git does not store mtimes, so
 *    a fresh clone stamps both directories with the checkout time, the comparison
 *    ties, and the winner depends on unspecified directory order. `status.parity`
 *    and `smoke` then fail with `expected 'older-run' to be 'fixture-run'`
 *    although no source, test or fixture content changed.
 *
 *    Fixing this by changing the production sort would be wrong: newest-by-mtime
 *    is the canonical behaviour. The test must instead establish the precondition
 *    it depends on, which is what this setup does.
 *
 * 2. EMPTY DIRECTORIES — handled in-tree rather than here. Git cannot store an
 *    empty directory, so `tests/fixtures/lint-golden/.recursive/memory/` would
 *    vanish on clone and the golden lint verdict would change from
 *    "MEMORY.md: memory router file is missing" to "memory plane directory is
 *    missing", failing `lint-parity`. It carries a committed zero-byte
 *    `.gitkeep` placeholder for that reason — DO NOT DELETE IT.
 *
 * Deliberately tolerant: a read-only or otherwise unwritable checkout must never
 * fail the suite because this stamping could not run. It is a precondition
 * helper, not an assertion.
 */
import { existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNS_DIR = fileURLToPath(new URL('./fixtures/repo/.recursive/run', import.meta.url))

/** The fixture's intended ordering, as (run directory, days after the epoch base). */
const ORDERED_RUNS: ReadonlyArray<readonly [string, number]> = [
  ['older-run', 0],
  ['fixture-run', 14],
]

/** 2026-01-01T00:00:00Z — a fixed base, so runs get stable distinct timestamps. */
const BASE_MS = Date.UTC(2026, 0, 1)
const DAY_MS = 86_400_000

export default function setup(): void {
  for (const [runId, dayOffset] of ORDERED_RUNS) {
    const dir = join(RUNS_DIR, runId)
    if (!existsSync(dir)) continue
    const when = new Date(BASE_MS + dayOffset * DAY_MS)
    try {
      utimesSync(dir, when, when)
    } catch {
      // Best effort only: never fail the run over a precondition stamp.
    }
  }
}
