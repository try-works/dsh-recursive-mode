/**
 * Review-bundle builder (Phase B R1). TS port of the canonical
 * recursive-review-bundle minimum-input contract (PROPOSAL 10.4/10.6):
 * gathers the context-in bundle a delegated reviewer needs and materializes it
 * as a durable markdown bundle under evidence/review-bundles/ with an
 * Artifact Path + Artifact Content Hash (LF-normalized sha256) header.
 *
 * Workspace-scoped (run 03 R1): every path resolves under the given control-
 * plane root; this module never scans a registry or another workspace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

export interface ReviewBundleInput {
  root: string
  runId: string
  phase: string
  role: string
  artifactPath: string
  upstreamArtifacts: string[]
  auditQuestions: string[]
  requiredOutput: string
  diffBasis?: {
    baselineType: string
    baselineReference: string
    comparisonReference: string
    normalizedBaseline: string
    normalizedComparison: string
    normalizedDiffCommand: string
  }
  codeRefs?: string[]
  addenda?: string[]
  priorEvidence?: string[]
  memoryRefs?: string[]
  changedFiles?: string[]
}

export interface ReviewBundleResult {
  bundlePath: string
  repoRelativePath: string
  artifactContentHash: string
  markdown: string
}

/** LF-normalized sha256 (matches recursive-lock.py content_sha256). */
export function contentSha256(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

function norm(repoRelative: string): string {
  return repoRelative.replace(/\\/g, '/').replace(/^\/+/, '')
}

function resolveUnderRoot(root: string, repoRelative: string): string {
  const normalized = norm(repoRelative)
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, normalized)
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  if (abs !== rootAbs && !abs.startsWith(rootPrefix)) {
    throw new Error('Path escapes the workspace root: ' + repoRelative)
  }
  return abs
}

function pathList(title: string, values: string[]): string[] {
  const lines: string[] = [title]
  if (!values.length) {
    lines.push('- none')
    return lines
  }
  for (const v of values) lines.push('- `' + norm(v) + '`')
  return lines
}

/**
 * Build a canonical review bundle. Throws when the artifact path is missing or
 * when a path would escape the workspace root (fail loud, never a silent
 * bundle).
 */
export function buildReviewBundle(input: ReviewBundleInput): ReviewBundleResult {
  const { root, runId, phase, role } = input
  const runDir = resolveUnderRoot(root, '.recursive/run/' + runId)
  if (!existsSync(runDir)) {
    throw new Error('Run directory does not exist: ' + runId)
  }

  const artifactAbs = resolveUnderRoot(root, input.artifactPath)
  if (!existsSync(artifactAbs)) {
    throw new Error('Review-bundle artifact path does not exist: ' + input.artifactPath)
  }
  const artifactHash = contentSha256(readFileSync(artifactAbs, 'utf8'))

  const bundlesDir = join(runDir, 'evidence', 'review-bundles')
  mkdirSync(bundlesDir, { recursive: true })
  const slug = phase.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
  const bundleFileName = (slug || 'review') + '-bundle.md'
  const bundlePath = join(bundlesDir, bundleFileName)
  const rootNorm = resolve(root).replace(/\\/g, '/')
  const repoRelativePath = bundlePath.replace(/\\/g, '/').replace(rootNorm + '/', '')

  const diff = input.diffBasis
  const diffLines = diff
    ? [
        '- Baseline type: ' + diff.baselineType,
        '- Baseline reference: ' + diff.baselineReference,
        '- Comparison reference: ' + diff.comparisonReference,
        '- Normalized baseline: ' + diff.normalizedBaseline,
        '- Normalized comparison: ' + diff.normalizedComparison,
        '- Normalized diff command: ' + diff.normalizedDiffCommand,
      ]
    : [
        '- Baseline type: local commit',
        '- Baseline reference: (see 00-worktree.md)',
        '- Comparison reference: working-tree',
        '- Normalized baseline: (see 00-worktree.md)',
        '- Normalized comparison: working-tree',
        '- Normalized diff command: git diff --name-only (see 00-worktree.md)',
      ]

  const changedLines = input.changedFiles?.length
    ? input.changedFiles.map((f) => '- `' + norm(f) + '`')
    : ["- (derived from the run's Worktree Diff Audit; see the phase artifact)"]

  const lines: string[] = [
    '# ' + phase + ' review bundle',
    '',
    'Artifact Path: ' + norm(input.artifactPath),
    'Artifact Content Hash: ' + artifactHash,
    '',
    '## Diff Basis',
    ...diffLines,
    '',
    '## Changed Files Reviewed',
    ...changedLines,
    '',
    '## Upstream Artifacts To Re-read',
    ...pathList('', input.upstreamArtifacts).slice(1),
    '',
    '## Relevant Addenda',
    ...pathList('', input.addenda ?? []).slice(1),
    '',
    '## Prior Recursive Evidence',
    ...pathList('', input.priorEvidence ?? []).slice(1),
    '',
    '## Targeted Code References',
    ...pathList('', input.codeRefs ?? []).slice(1),
    '',
    '## Audit Questions',
    ...(input.auditQuestions.length
      ? input.auditQuestions.map((q, i) => String(i + 1) + '. ' + q)
      : ['- none']),
    '',
    '## Required Output',
    '',
    input.requiredOutput,
    '',
    '## Relevant Memory References',
    ...pathList('', input.memoryRefs ?? []).slice(1),
    '',
  ]

  const markdown = lines.join('\n')
  writeFileSync(bundlePath, markdown, 'utf8')

  return {
    bundlePath,
    repoRelativePath,
    artifactContentHash: artifactHash,
    markdown,
  }
}

/** Canonical bundle dir for a run: .recursive/run/<id>/evidence/review-bundles/. */
export function reviewBundleDir(root: string, runId: string): string {
  return join(resolveUnderRoot(root, '.recursive/run/' + runId), 'evidence', 'review-bundles')
}
