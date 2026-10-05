#!/usr/bin/env node
/**
 * FU-1 — the one-command end-to-end runner.
 *
 * Runs the E: harness (`tests/e2e-harness.spec.ts`) and then points at the run directory it produced, so
 * a human can open the artifacts the workflow actually wrote. It KEEPS the run by default: a harness
 * that deletes its own evidence is not debuggable, which is the whole reason this exists.
 *
 * Why a wrapper at all: the harness must import TypeScript sources, so it runs under vitest rather than
 * bare node. This is the thin, repeatable entry point; the assertions live in the spec.
 *
 * Usage:  pnpm e2e            (keeps the run)
 *         E2E_RUN_ROOT=D:\x pnpm e2e
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const preferred = process.env.E2E_RUN_ROOT ?? 'E:\\dsh-rm-e2e'
const root = existsSync('E:\\') ? preferred : join(process.env.TEMP ?? '.', 'dsh-rm-e2e')

console.log('[e2e] scratch root: ' + root)
const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', 'tests/e2e-harness.spec.ts'],
  {
    // ⚠ `shell: true` IS REQUIRED ON WINDOWS: spawning `pnpm.cmd` directly fails with EINVAL because
    // Node cannot execute a batch file without a shell, and the failure is a NULL status with no output —
    // the runner would exit 1 having printed nothing about why. The error is reported below for the same
    // reason: a silent runner is worse than a failing one.
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, E2E_KEEP: '1', E2E_RUN_ROOT: root },
  },
)
if (result.error) console.error('[e2e] could not run vitest: ' + result.error.message)
if (result.status !== 0 && !result.error) console.error('[e2e] vitest exited ' + result.status)

// Point at the newest run so the artifacts can be inspected without hunting for them.
if (existsSync(root)) {
  const runs = readdirSync(root)
    .map((name) => ({ name, path: join(root, name), at: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  if (runs.length > 0) {
    console.log('\n[e2e] newest run: ' + runs[0].path)
    console.log('[e2e] report:     ' + join(runs[0].path, 'e2e-report.md'))
    console.log('[e2e] run dir:    ' + join(runs[0].path, '.recursive', 'run', 'e2e-run'))
  }
}

process.exit(result.status ?? 1)
