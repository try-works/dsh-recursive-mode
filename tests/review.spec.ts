import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildReviewBundle, contentSha256, reviewBundleDir } from '../src/review.ts'

function makeRun(root: string, runId: string, artifactName = '03-implementation-summary.md') {
  const runDir = join(root, '.recursive', 'run', runId)
  mkdirSync(runDir, { recursive: true })
  const artifactPath = join(runDir, artifactName)
  writeFileSync(artifactPath, '# artifact\n\nStatus: `DRAFT`\n', 'utf8')
  return { runDir, artifactPath }
}

describe('review.ts — review-bundle builder (R1)', () => {
  it('builds a bundle with the 8 canonical headings + Artifact Path + hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-review-'))
    const { artifactPath } = makeRun(root, '10-bundle')
    const rel = '.recursive/run/10-bundle/03-implementation-summary.md'
    const result = buildReviewBundle({
      root,
      runId: '10-bundle',
      phase: '03.5 Code Review',
      role: 'code-reviewer',
      artifactPath: rel,
      upstreamArtifacts: ['dsh-recursive-mode/src/workspace.ts'],
      auditQuestions: ['Is the root workspace-scoped?'],
      requiredOutput: 'Verdict + findings + references',
      codeRefs: ['dsh-recursive-mode/src/workspace.ts'],
      changedFiles: ['dsh-recursive-mode/src/workspace.ts'],
    })

    expect(result.repoRelativePath).toContain('evidence/review-bundles/')
    expect(result.repoRelativePath).toContain('10-bundle')
    expect(existsSync(result.bundlePath)).toBe(true)

    const md = result.markdown
    for (const h of ['## Diff Basis', '## Changed Files Reviewed', '## Upstream Artifacts To Re-read', '## Relevant Addenda', '## Prior Recursive Evidence', '## Targeted Code References', '## Audit Questions', '## Required Output']) {
      expect(md).toContain(h)
    }
    expect(md).toContain('Artifact Path: ' + rel)
    expect(md).toContain('Artifact Content Hash: ' + contentSha256(readFileSync(artifactPath, 'utf8')))
  })

  it('throws on a missing artifact path (fail loud, never a silent bundle)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-review-'))
    mkdirSync(join(root, '.recursive', 'run', '10-bundle'), { recursive: true })
    expect(() => buildReviewBundle({
      root,
      runId: '10-bundle',
      phase: '03.5 Code Review',
      role: 'code-reviewer',
      artifactPath: '.recursive/run/10-bundle/03-implementation-summary.md',
      upstreamArtifacts: [],
      auditQuestions: [],
      requiredOutput: 'x',
    })).toThrow(/does not exist/)
  })

  it('rejects a path escaping the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-review-'))
    makeRun(root, '10-bundle')
    expect(() => buildReviewBundle({
      root,
      runId: '10-bundle',
      phase: '03.5',
      role: 'code-reviewer',
      artifactPath: '../outside.md',
      upstreamArtifacts: [],
      auditQuestions: [],
      requiredOutput: 'x',
    })).toThrow(/escapes/)
  })

  it('contentSha256 matches LF-normalized sha256', () => {
    expect(contentSha256('a\r\nb')).toBe(contentSha256('a\nb'))
    expect(contentSha256('a\nb')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reviewBundleDir resolves under the run dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-review-'))
    expect(reviewBundleDir(root, '10-bundle')).toContain(join('.recursive', 'run', '10-bundle', 'evidence', 'review-bundles'))
  })
})
