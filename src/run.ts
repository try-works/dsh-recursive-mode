import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Run discovery for recursive-mode runs.
 *
 * Ports the discovery subset of recursive-status.py:
 * - discoverRuns: list run directories under <repoRoot>/.recursive/run/
 * - resolveRunDir: explicit run id, or the latest run by mtime (stable sort)
 *
 * R1 (run 02): dedicated module so tools and status share one discovery path.
 */

export interface RunDiscoveryResult {
  runDir: string
  runId: string
}

/**
 * List run ids under <repoRoot>/.recursive/run/, excluding non-directories.
 * Mirrors: runs = [p for p in run_root.iterdir() if p.is_dir()]
 */
export function discoverRuns(repoRoot: string): string[] {
  const runRoot = join(repoRoot, '.recursive', 'run')
  let runs: string[] = []
  try {
    runs = readdirSync(runRoot, { withFileTypes: true })
      // B5: accept directories AND junctions/symlinks — Windows junction run
      // dirs report isDirectory() === false but statSync().isDirectory() ===
      // true (it follows the link). Deliberate for this repo (keeps the
      // template /.recursive/ byte-pristine via a junction).
      .filter(d => {
        if (d.isDirectory()) return true
        if (!d.isSymbolicLink()) return false
        try { return statSync(join(runRoot, d.name)).isDirectory() } catch { return false }
      })
      .map(d => d.name)
  } catch {
    return []
  }
  return runs
}

/**
 * Resolve the run directory for an explicit run id, or the latest run by mtime.
 * Mirrors get_latest_run_directory: sort by st_mtime descending, stable sort
 * (ties preserve discovery order — no name-based tie-break).
 */
export function resolveRunDir(repoRoot: string, runId?: string): RunDiscoveryResult | null {
  const runRoot = join(repoRoot, '.recursive', 'run')
  if (runId && runId.trim() !== '') {
    return { runDir: join(runRoot, runId.trim()), runId: runId.trim() }
  }
  const latest = getLatestRunDirectory(runRoot)
  if (!latest) return null
  return { runDir: join(runRoot, latest), runId: latest }
}

/**
 * Latest run directory by mtime (descending), stable sort preserving
 * discovery order for exact ties. Returns null when no runs exist.
 */
export function getLatestRunDirectory(runRoot: string): string | null {
  let runs: string[] = []
  try {
    runs = readdirSync(runRoot, { withFileTypes: true })
      .filter(d => {
        if (d.isDirectory()) return true
        if (!d.isSymbolicLink()) return false
        try { return statSync(join(runRoot, d.name)).isDirectory() } catch { return false }
      })
      .map(d => d.name)
  } catch {
    return null
  }
  if (runs.length === 0) return null
  runs.sort((a, b) => {
    try {
      return statSync(join(runRoot, b)).mtimeMs - statSync(join(runRoot, a)).mtimeMs
    } catch {
      return 0
    }
  })
  return runs[0]
}
