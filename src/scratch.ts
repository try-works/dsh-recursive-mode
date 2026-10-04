/**
 * Run-scoped disposable scratchpad (R5). Lives at <run-dir>/scratch/scratch.md
 * and <run-dir>/scratch/scratch.ts, is git-ignored, and is NEVER citable as an
 * Input in phase docs (enforced by the recursive:policy + lint, Phase C).
 * The plugin never creates a run implicitly: writing scratch requires an
 * existing run directory.
 *
 * Phase B R5 adds child-scoped scratch (PROPOSAL 10.7): each delegated child
 * gets its OWN disposable scratch under <run-dir>/scratch/<child-id>.md, while
 * the parent's scratch.md stays the main agent's working memory. A child MAY
 * read the parent scratch when the prompt includes it, but writes go only to
 * the child's own file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export type ScratchTarget = 'md' | 'ts'

export function scratchPathFor(runDir: string, target: ScratchTarget): string {
  if (target !== 'md' && target !== 'ts') {
    throw new Error('Unsupported scratch target: ' + String(target) + ' (expected md or ts)')
  }
  return join(runDir, 'scratch', 'scratch.' + target)
}

function assertRunExists(runDir: string): void {
  if (!existsSync(runDir)) {
    throw new Error('Run directory does not exist: ' + runDir + ' (scratch never creates runs)')
  }
}

export function readScratch(runDir: string, target: ScratchTarget): string {
  assertRunExists(runDir)
  const path = scratchPathFor(runDir, target)
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8')
}

export function writeScratch(runDir: string, target: ScratchTarget, content: string): string {
  assertRunExists(runDir)
  const path = scratchPathFor(runDir, target)
  mkdirSync(join(runDir, 'scratch'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

export function appendScratch(runDir: string, target: ScratchTarget, content: string): string {
  assertRunExists(runDir)
  const path = scratchPathFor(runDir, target)
  mkdirSync(join(runDir, 'scratch'), { recursive: true })
  appendFileSync(path, content + '\n', 'utf8')
  return path
}

/**
 * Child-scoped scratch path (Phase B R5): <run-dir>/scratch/<child-id>.md.
 * Resolved under the run dir; a child id escaping the scratch dir is rejected.
 */
export function childScratchPath(runDir: string, childId: string): string {
  assertRunExists(runDir)
  const scratchDir = resolve(runDir, 'scratch')
  const candidate = resolve(scratchDir, childId + '.md')
  const prefix = scratchDir.endsWith(sep) ? scratchDir : scratchDir + sep
  if (!candidate.startsWith(prefix)) {
    throw new Error('Child scratch escapes the run scratch dir: ' + childId)
  }
  return candidate
}

/** Read-only access to the PARENT's scratch (the main agent's working memory). */
export function readParentScratch(runDir: string, target: ScratchTarget = 'md'): string {
  return readScratch(runDir, target)
}

/**
 * Write ONLY the child's own scratch file. Refuses any target outside
 * <run-dir>/scratch/<child-id>.md (a child cannot overwrite the parent's
 * scratch.md through this writer).
 */
export function writeChildScratch(runDir: string, childId: string, content: string): string {
  const path = childScratchPath(runDir, childId)
  mkdirSync(join(runDir, 'scratch'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}
