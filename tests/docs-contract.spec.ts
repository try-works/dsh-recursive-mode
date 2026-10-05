/**
 * T25 — EXECUTABLE DOCUMENTATION TESTS (tests/docs-contract.spec.ts).
 *
 * WHY THIS FILE EXISTS. The harness enforces its own documentation with a test
 * that fails the build when a shipped prompt names a removed id or a worker the
 * agent is meant to discover — and it exists because a removal once missed ALL
 * EIGHT provider identity prompts: the tool was gone, the prompts still told the
 * agent to reach for it, and agents kept doing exactly that. This repo had no
 * guard on its prose at all, and both audits found real drift as a result.
 * Everything asserted here is a fact about the tree, checked by RUNNING the code
 * that owns the contract — never by re-reading it.
 *
 * FOUR ASSERTIONS (plan T25 "What"):
 *   (a) every repo-relative path a shipped document names as an existing file of
 *       THIS repo exists;
 *   (b) package.json's description agrees with the tool surface actually
 *       registered by src/index.ts;
 *   (c) every marker string the linter requires is emitted by the writer that
 *       produces it — proven by executing the repo's OWN linter over a record the
 *       repo's own writer produced;
 *   (d) no shipped prompt or skill names a withdrawn tool, phase artifact or verb.
 *
 * (a) IS DELIBERATELY NOT "every referenced path exists". The plan's sentence, taken
 * literally, is unworkable, and a naive implementation would be wrong in three ways.
 * Refs are therefore classified and only ONE class is enforced:
 *
 *   class 1  repo-file   — a path that purports to be an existing file of this repo.
 *                          MUST exist. This is the only enforced class.
 *   class 2  planned     — a deliverable the document itself marks as not-yet-built:
 *                          `(planned)`/`(new)` (the plan's own §6 tracker convention:
 *                          "Evidence paths marked (planned) do not exist yet"), or any
 *                          path named inside a plan item whose heading is not
 *                          unambiguously `**done**`. Requiring these to exist would
 *                          forbid the plan from scheduling work.
 *   class 3  foreign     — cross-repo references: another top-level tree that is not in
 *                          this repo (the DSH checkout's packages/ docs/ apps/ vendor/,
 *                          the parent methodology repo's skills/**), absolute D:\... or
 *                          /... paths, fenced-code illustrations, directory/section
 *                          references, placeholders. Excluded because they are not this
 *                          repo's paths at all — plus a small, reasoned, self-cleaning
 *                          allow-list (TOLERATED_MISSING) for the parent-repo files
 *                          PROPOSAL.md names while describing the port.
 *
 * Bare filenames with no directory separator are NOT path references: that is why
 * this spec does not demand a root README.md (the plan names one; there deliberately
 * is none). The rule is also self-checked for non-vacuity below — a deliberately
 * bogus repo path IS caught, so the test cannot pass by classifying everything away.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeActionRecord } from '../src/delegation.ts'
import { buildReviewBundle } from '../src/review.ts'
import {
  SUBAGENT_ACTION_REQUIRED_HEADINGS,
  contentSha256,
  extractPathsFromNamedField,
  getHeadingBody,
  getMdFieldValue,
  hasMeaningfulValue,
  lintRun,
  lintSubagentActionRecordFile,
} from '../src/ts-lint.ts'
import { renderRecursivePolicy } from '../src/policy.ts'
import { PHASE_SEQUENCE } from '../src/lock.ts'
import { ALL_VERBS } from '../src/commands.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readRepo(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** Repo-relative files under a repo-relative directory (recursive). */
function walkRepo(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name
    if (entry.isDirectory()) out.push(...walkRepo(rel))
    else out.push(rel)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) referenced paths exist
// ─────────────────────────────────────────────────────────────────────────────

/** Path-looking backticked token: no spaces, quotes, backslashes, globs or placeholders. */
const PATH_TOKEN_RE = /^[A-Za-z0-9._@/-]+$/

interface DocRef {
  doc: string
  line: number
  token: string
  /** 'repo-file' = class 1 (enforced); 'excluded' = class 2/3 (never enforced). */
  klass: 'repo-file' | 'excluded'
  why: string
}

/**
 * Cross-repo references PROPOSAL.md makes while describing the port: the parent
 * methodology repo's Python runtime scripts, its bridge doc and its subskills.
 * They are not this repo's files. Every entry is asserted to STILL be absent, so
 * the allow-list cannot rot: if one is ever ported here, this spec fails and the
 * entry must be deleted, at which point class 1 starts enforcing it.
 */
const TOLERATED_MISSING: { token: string; why: string }[] = [
  {
    token: 'skills/recursive-mode/scripts/recursive-status.py',
    why: "parent methodology repo's Python runtime scripts (PROPOSAL §4.7 cites them as the port's source of truth)",
  },
  {
    token: 'skills/recursive-mode/references/agents-block.md',
    why: "parent methodology repo's AGENTS.md bridge block; this bundle ships only skills/recursive-mode/SKILL.md",
  },
  {
    token: 'skills/recursive-mode/references/bootstrap/RECURSIVE.md',
    why: "parent methodology repo's packaged bootstrap copy of the spec",
  },
  {
    token: 'skills/recursive-review-bundle/SKILL.md',
    why: 'parent-repo subskill that was not ported into this bundle (bundle ships recursive-mode only)',
  },
]

/** Documents whose prose is guarded. Only documents that exist are scanned. */
const GUARDED_DOCS = ['PROPOSAL.md', 'STRENGTHENING-PLAN.md', ...walkRepo('skills')]

function collectPathRefs(doc: string, text: string): DocRef[] {
  const refs: DocRef[] = []
  const lines = text.split(/\r?\n/)
  let inFence = false
  let item: { id: string; done: boolean } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (/^##\s/.test(line)) item = null // narrative section: no item context (the §6 tracker lives here)
    if (/^###\s/.test(line)) {
      const heading = /^###\s+(T-?\d+[a-z]?)\b/.exec(line)
      item = heading ? { id: heading[1] ?? '', done: /\*\*done\*\*\s*$/.test(line.trim()) } : null
    }
    const re = /`([^`\n]+)`/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const token = (m[1] ?? '').trim()
      // Bare filenames are not repo-relative references (this is why no root README.md is required).
      if (!token.includes('/')) continue
      if (!PATH_TOKEN_RE.test(token)) continue // absolute D:\... or /..., placeholders, brace globs, urls
      if (token.startsWith('/') || token.includes('..')) continue
      const top = token.split('/')[0] ?? ''
      // class 3: a top-level tree that does not exist in this repo (DSH checkout, parent repo).
      if (!existsSync(join(ROOT, top))) continue
      if (existsSync(join(ROOT, token))) {
        refs.push({ doc, line: index + 1, token, klass: 'repo-file', why: 'exists' })
        continue
      }
      const excluded = (why: string) => refs.push({ doc, line: index + 1, token, klass: 'excluded', why })
      if (inFence) {
        excluded('illustrative path inside a fenced code block')
        continue
      }
      if (token.endsWith('/')) {
        excluded('directory/section reference, not a file')
        continue
      }
      if (!extname(token)) {
        excluded('not a file reference (no extension: verb, event name or directory)')
        continue
      }
      if (/\(planned\)|\(new\)/.test(line)) {
        excluded('marked (planned)/(new) by the document itself')
        continue
      }
      if (item && !item.done) {
        excluded(`class 2: deliverable declared by open plan item ${item.id}`)
        continue
      }
      if (/^\s*\|/.test(line)) {
        const status = line.split('|').map((cell) => cell.trim())[4] ?? ''
        if (status !== '**done**') {
          excluded(`tracker row whose status is not done (${status || 'n/a'})`)
          continue
        }
      }
      const tolerated = TOLERATED_MISSING.find((t) => t.token === token)
      if (tolerated) {
        excluded('tolerated cross-repo reference: ' + tolerated.why)
        continue
      }
      refs.push({
        doc,
        line: index + 1,
        token,
        klass: 'repo-file',
        why: 'names an existing file of this repo',
      })
    }
  }
  return refs
}

function class1Refs(): DocRef[] {
  return GUARDED_DOCS.flatMap((doc) => collectPathRefs(doc, readRepo(doc)))
}

describe('T25 (a) — documented paths exist', () => {
  it('every path a shipped document names as an existing file of this repo exists', () => {
    const missing = class1Refs()
      .filter((ref) => ref.klass === 'repo-file' && !existsSync(join(ROOT, ref.token)))
      .map((ref) => `${ref.doc}:${ref.line} -> ${ref.token}`)
    expect([...new Set(missing)].sort()).toEqual([])
  })

  it('the class-1 rule is neither vacuous nor over-broad', () => {
    const synthetic = [
      '# Synthetic document',
      '',
      '- a real file: `src/index.ts`',
      '- a bogus repo file: `src/t25-does-not-exist.ts`',
      '- a planned file: `src/t25-planned.ts` (planned)',
      '- a foreign tree: `packages/core/tools/src/index.ts`',
      '- a bare filename: `README.md`',
      '- an absolute path: `D:\\DEV\\recursive-mode\\skills\\recursive-mode\\SKILL.md`',
      '',
      '```',
      '- an illustration: `src/t25-inside-a-fence.ts`',
      '```',
      '',
      '### T99 — synthetic backlog item · **backlog**',
      '',
      '- **GREEN:** `src/t25-backlog-deliverable.ts` (new)',
      '',
    ].join('\n')
    const refs = collectPathRefs('SYNTHETIC.md', synthetic)
    const class1 = refs.filter((ref) => ref.klass === 'repo-file').map((ref) => ref.token)
    // the rule catches a bogus repo path ...
    expect(class1).toContain('src/t25-does-not-exist.ts')
    expect(class1).toContain('src/index.ts')
    // ... while each excluded class really is excluded
    for (const token of [
      'packages/core/tools/src/index.ts',
      'README.md',
      'src/t25-planned.ts',
      'src/t25-inside-a-fence.ts',
      'src/t25-backlog-deliverable.ts',
    ]) {
      expect(refs.some((ref) => ref.token === token && ref.klass === 'repo-file')).toBe(false)
    }
    expect(refs.some((ref) => ref.token.includes('recursive-mode\\SKILL.md'))).toBe(false)
    // the real documents do carry a non-empty class-1 set
    expect(class1Refs().filter((ref) => ref.klass === 'repo-file').length).toBeGreaterThan(20)
  })

  it('every tolerated cross-repo reference is still absent (the allow-list cannot rot)', () => {
    const nowPresent = TOLERATED_MISSING.filter((t) => existsSync(join(ROOT, t.token))).map((t) => t.token)
    expect(nowPresent).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (b) package.json description agrees with the registered tool surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tool surface the plugin ACTUALLY registers: every
 * `ctx.tools.register(createRecursive*Tool(...))` call in src/index.ts, resolved
 * to the tool name its module declares. Counting factories alone would miss a
 * factory that is imported but never registered.
 */
function registeredToolIds(): string[] {
  const indexSrc = readRepo('src/index.ts')
  const factories = new Set<string>()
  const registerRe = /ctx\.tools\.register\(\s*(createRecursive\w+Tool)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = registerRe.exec(indexSrc)) !== null) factories.add(m[1] ?? '')
  const ids: string[] = []
  for (const factory of factories) {
    const importMatch = new RegExp(`import\\s*\\{\\s*${factory}\\s*\\}\\s*from\\s*'\\./([^']+)'`).exec(indexSrc)
    if (!importMatch) throw new Error(`registered factory ${factory} has no import in src/index.ts`)
    const moduleSrc = readRepo('src/' + (importMatch[1] ?? ''))
    const name = /name:\s*'(recursive_[a-z0-9_]+)'/.exec(moduleSrc)?.[1]
    if (!name) throw new Error(`registered factory ${factory} declares no tool name in src/${importMatch[1]}`)
    ids.push(name)
  }
  return ids.sort()
}

const REGISTERED_TOOL_IDS = registeredToolIds()
const PACKAGE_DESCRIPTION = (JSON.parse(readRepo('package.json')) as { description?: string }).description ?? ''

describe('T25 (b) — package.json description agrees with the registered tool count', () => {
  it('the registration surface is discoverable and unambiguous', () => {
    expect(REGISTERED_TOOL_IDS.length).toBeGreaterThanOrEqual(2)
    expect(new Set(REGISTERED_TOOL_IDS).size).toBe(REGISTERED_TOOL_IDS.length)
  })

  it('the description states the real count and names every registered tool', () => {
    expect(PACKAGE_DESCRIPTION).toContain(`${REGISTERED_TOOL_IDS.length} recursive_* tools`)
    const unlisted = REGISTERED_TOOL_IDS.filter((id) => !PACKAGE_DESCRIPTION.includes(id))
    expect(unlisted).toEqual([])
  })

  it('the description names no tool that is not registered', () => {
    const mentioned = [...PACKAGE_DESCRIPTION.matchAll(/\brecursive_[a-z0-9_]+\b/g)].map((match) => match[0])
    const withdrawn = [...new Set(mentioned)].filter((id) => !REGISTERED_TOOL_IDS.includes(id))
    expect(withdrawn).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (c) the writer emits what the linter requires — proven by EXECUTING the linter
// ─────────────────────────────────────────────────────────────────────────────

interface RecordFixture {
  root: string
  runId: string
  runDir: string
  artifactRel: string
  artifactAbs: string
  upstreamRel: string
  reviewBundleRel: string
  recordPath: string
  record: string
}

/**
 * One realistic action record for a REAL artifact file: a run whose only linted
 * content is the record this writer produced, a review bundle from the repo's own
 * bundle builder, and claimed files that exist.
 *
 * `reviewedOnly` models this plugin's PRIMARY delegation case — a read-only review
 * that creates and modifies nothing — which additionally exposes the linter's
 * final-sub-heading hole (plan item T33).
 */
function makeRecordFixture(options: { reviewedOnly?: boolean } = {}): RecordFixture {
  const reviewedOnly = options.reviewedOnly === true
  const root = mkdtempSync(join(tmpdir(), 'rm-docs-record-'))
  tempDirs.push(root)
  const runId = 'T25-record'
  const runDir = join(root, '.recursive', 'run', runId)
  const inputsDir = join(runDir, 'inputs')
  mkdirSync(inputsDir, { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })

  const artifactRel = `.recursive/run/${runId}/inputs/03-implementation-summary.md`
  const upstreamRel = `.recursive/run/${runId}/inputs/02-to-be-plan.md`
  const createdRel = 'src/t25-created.ts'
  const modifiedRel = 'src/t25-modified.ts'
  const artifactAbs = join(root, ...artifactRel.split('/'))
  writeFileSync(artifactAbs, '# 03 implementation summary\n\n- R25: guard the prose.\n', 'utf8')
  writeFileSync(join(root, ...upstreamRel.split('/')), '# 02 to-be plan\n\n- Plan: executable documentation.\n', 'utf8')
  writeFileSync(join(root, ...createdRel.split('/')), 'export const created = true\n', 'utf8')
  writeFileSync(join(root, ...modifiedRel.split('/')), 'export const modified = true\n', 'utf8')

  const bundle = buildReviewBundle({
    root,
    runId,
    phase: '03',
    role: 'code-reviewer',
    artifactPath: artifactRel,
    upstreamArtifacts: [upstreamRel],
    auditQuestions: ['Does the record satisfy the linter?'],
    requiredOutput: 'verdict',
    codeRefs: reviewedOnly ? [] : [modifiedRel],
    changedFiles: reviewedOnly ? [] : [modifiedRel],
  })

  const recordPath = writeActionRecord({
    root,
    runId,
    subagentId: 'child-a',
    phase: '03',
    purpose: 'audit 03-implementation-summary',
    executionMode: 'spawn',
    artifactPath: artifactRel,
    upstreamArtifacts: [upstreamRel],
    reviewBundle: bundle.repoRelativePath,
    diffBasis: 'git diff --name-only HEAD',
    codeRefs: reviewedOnly ? [] : [modifiedRel],
    auditQuestions: ['Does the record satisfy the linter?'],
    actionsTaken: ['Executed the linter over the record the writer produced.'],
    createdFiles: reviewedOnly ? undefined : [createdRel],
    modifiedFiles: reviewedOnly ? undefined : [modifiedRel],
    reviewedFiles: [modifiedRel],
    findings: ['The writer must emit the marker strings the linter reads.'],
    success: true,
    stopReason: 'completed',
  })

  return {
    root,
    runId,
    runDir,
    artifactRel,
    artifactAbs,
    upstreamRel,
    reviewBundleRel: bundle.repoRelativePath,
    recordPath,
    record: readFileSync(recordPath, 'utf8'),
  }
}

/** Run lintRun with the linter's console chatter silenced. */
function runLint(root: string, runId: string): ReturnType<typeof lintRun> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    return lintRun(root, runId)
  } finally {
    spy.mockRestore()
  }
}

describe('T25 (c) — the action-record writer emits what the linter requires', () => {
  it('the linter, EXECUTED over the writer output, reports zero violations', () => {
    const fixture = makeRecordFixture()
    // The run dir holds only subagents/, so every FAIL lintRun reports belongs to
    // the record — this is the repo's own linter reaching the writer's own output.
    const result = runLint(fixture.root, fixture.runId)
    expect(result.errors).toEqual([])
    expect(result.failCount).toBe(0)
  })

  it('the record-level linter accepts the record directly', () => {
    const fixture = makeRecordFixture()
    const issues = lintSubagentActionRecordFile(fixture.recordPath, fixture.root, fixture.runDir, null)
    expect(issues).toEqual([])
  })

  it('the required marker strings resolve through the linter helpers', () => {
    const fixture = makeRecordFixture()
    const { record } = fixture
    expect(record).toContain('# Subagent Action Record')
    for (const heading of SUBAGENT_ACTION_REQUIRED_HEADINGS) {
      expect(getHeadingBody(record, heading), `## ${heading} must be non-empty`).not.toBe('')
    }
    const metadata = getHeadingBody(record, 'Metadata')
    for (const field of ['Subagent ID', 'Run ID', 'Phase', 'Purpose', 'Execution Mode', 'Timestamp']) {
      expect(hasMeaningfulValue(getMdFieldValue(metadata, field)), `Metadata.${field} must be meaningful`).toBe(true)
    }
    const inputs = getHeadingBody(record, 'Inputs Provided')
    expect(getMdFieldValue(inputs, 'Current Artifact')).toBe(fixture.artifactRel)
    expect(getMdFieldValue(inputs, 'Artifact Content Hash')).toBe(contentSha256(readFileSync(fixture.artifactAbs, 'utf8')))
    expect(getMdFieldValue(inputs, 'Diff Basis')).toBe('git diff --name-only HEAD')
    expect(getMdFieldValue(inputs, 'Review Bundle')).toBe(fixture.reviewBundleRel)
    expect([...extractPathsFromNamedField(inputs, 'Upstream Artifacts')]).toEqual([fixture.upstreamRel])
  })

  it('a record whose artifact was edited after it was written is reported stale', () => {
    const fixture = makeRecordFixture()
    writeFileSync(fixture.artifactAbs, '# 03 implementation summary\n\n- R25: edited after the record.\n', 'utf8')
    const issues = lintSubagentActionRecordFile(fixture.recordPath, fixture.root, fixture.runDir, null)
    expect(issues).toContain('Inputs Provided Artifact Content Hash does not match the current artifact content')
  })

  // ── KNOWN LIMITATION, tracked as plan item T33 (the linter's `\Z` anchor) ──────
  // The same JS-not-Python `\Z` defect that makes a document's FINAL section read as
  // empty also makes the final SUB-heading of a section read as empty: a section body
  // is sliced by getHeadingBody (which stops at the next `##`), so its last `###`
  // sub-heading has no following heading to terminate the body and `\Z` (a literal
  // `Z`) never matches. Consequence: for a READ-ONLY review delegation — reviewed
  // files, nothing created or modified, which is this plugin's primary delegation use
  // case — `getSubheadingBody(claimedFileImpact, 'Reviewed')` returns '' , the claimed
  // file set is empty, and the linter reports "Claimed File Impact must cite at least
  // one created, modified, reviewed, or relevant untouched file". No writer, however
  // correct, can satisfy the linter for that case; the fix belongs in ts-lint.ts (T33:
  // the faithful JS translation of Python's absolute end-of-input `\Z` is `(?![\s\S])`).
  //
  // `it.fails` PINS the hole instead of hiding it: it passes while the limitation
  // exists and FAILS the moment T33 lands — which is the signal to delete the `.fails`
  // and assert the record is accepted. Do not "fix" this by fabricating created files.
  it.fails('T33: a read-only review record (reviewed files only) is accepted by the linter', () => {
    const fixture = makeRecordFixture({ reviewedOnly: true })
    expect(lintSubagentActionRecordFile(fixture.recordPath, fixture.root, fixture.runDir, null)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (d) no shipped prompt or skill names a withdrawn tool, phase or verb
// ─────────────────────────────────────────────────────────────────────────────

/** The shipped prose a model actually reads, plus the policy section's render text. */
function shippedPromptSurfaces(): { name: string; text: string }[] {
  const surfaces = [
    { name: 'skills/recursive-mode/SKILL.md', text: readRepo('skills/recursive-mode/SKILL.md') },
    { name: 'preset/recursive/agent.cordis.yml', text: readRepo('preset/recursive/agent.cordis.yml') },
    { name: 'preset/recursive/preset.yml', text: readRepo('preset/recursive/preset.yml') },
  ]
  // The recursive:policy render text, produced by the real renderer (a context
  // whose run does not exist yet still renders the enforcement contract).
  const root = mkdtempSync(join(tmpdir(), 'rm-docs-policy-'))
  tempDirs.push(root)
  surfaces.push({
    name: 'recursive:policy (rendered)',
    text: renderRecursivePolicy({ worktreeRoot: root, runId: 'T25-policy' }),
  })
  return surfaces
}

describe('T25 (d) — no shipped prompt or skill names a withdrawn tool, phase or verb', () => {
  it('every recursive_* tool named by shipped prose is registered', () => {
    const named = new Set<string>()
    for (const surface of shippedPromptSurfaces()) {
      for (const match of surface.text.matchAll(/\brecursive_[a-z0-9_]+\b/g)) named.add(match[0])
    }
    expect(named.size).toBeGreaterThanOrEqual(3) // the scan is not vacuous
    const withdrawn = [...named].filter((id) => !REGISTERED_TOOL_IDS.includes(id)).sort()
    expect(withdrawn).toEqual([])
  })

  it('the policy render text advertises registered tools and locks only', () => {
    const rendered = renderRecursivePolicy({ worktreeRoot: tmpdir(), runId: 'T25-policy' })
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered).toContain('recursive_phase')
  })

  it('every /recursive verb a shipped prompt advertises is a registered verb', () => {
    const advertised = new Set<string>()
    // (i) An ENUMERATED verb list is an advertisement: the preset description and the
    //     slash command's own hint (the text the harness shows for /recursive).
    const presetDescription = readRepo('preset/recursive/preset.yml')
    for (const run of presetDescription.matchAll(/(?:[a-z]+\/)+[a-z]+/g)) {
      for (const verb of (run[0] ?? '').split('/')) advertised.add(verb)
    }
    const hint = /input:\s*\{\s*hint:\s*'([^']+)'/.exec(readRepo('src/commands.ts'))?.[1] ?? ''
    for (const verb of hint.split('|')) if (verb) advertised.add(verb)
    // (ii) A CODE SPAN that shows the command with a verb (`/recursive scratch <run-id>`)
    //      advertises that verb. Bare prose does not: "the /recursive command" would
    //      otherwise be read as advertising a verb named `command`, which is not a verb
    //      and is not drift. Only real drift is flagged.
    for (const surface of shippedPromptSurfaces()) {
      for (const span of surface.text.matchAll(/`([^`\n]+)`/g)) {
        const verb = /\/recursive\s+([a-z]+)/.exec(span[1] ?? '')?.[1]
        if (verb) advertised.add(verb)
      }
    }
    expect(advertised.size).toBeGreaterThanOrEqual(5) // the scan is not vacuous
    const withdrawn = [...advertised].filter((verb) => !ALL_VERBS.includes(verb as (typeof ALL_VERBS)[number])).sort()
    expect(withdrawn).toEqual([])
  })

  it('every phase artifact a shipped skill names is in the phase sequence', () => {
    const named = new Set<string>()
    for (const surface of shippedPromptSurfaces()) {
      for (const match of surface.text.matchAll(/\b\d\d(?:\.\d)?-[a-z-]+\.md\b/g)) named.add(match[0])
    }
    expect(named.size).toBeGreaterThanOrEqual(5) // the scan is not vacuous
    const withdrawn = [...named].filter((file) => !(PHASE_SEQUENCE as readonly string[]).includes(file)).sort()
    expect(withdrawn).toEqual([])
  })
})
