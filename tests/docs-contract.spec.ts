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
 * FIVE ASSERTIONS — the plan's four, plus the README edge the measured drift added:
 *   (a) every repo-relative path a shipped document names as an existing file of
 *       THIS repo exists;
 *   (b) package.json's description agrees with the tool surface actually
 *       registered by src/index.ts;
 *   (c) every marker string the linter requires is emitted by the writer that
 *       produces it — proven by executing the repo's OWN linter over a record the
 *       repo's own writer produced;
 *   (d) no shipped prompt or skill names a withdrawn tool, phase artifact or verb;
 *   (e) README.md's ONLY tool enumeration — its §4.1 table — names exactly the tools
 *       package.json's description declares: none missing, none invented.
 *
 * (e) IS THE MEASURED FIX, AND NOT A NICETY. Nothing in this file used to read
 * README.md at all: (b) pins the description to the registered surface and
 * GUARDED_DOCS covers PROPOSAL.md, STRENGTHENING-PLAN.md and skills/**, which left
 * the README's own account of the tool surface unguarded — and that is where it
 * drifted. §4.1's table listed TWELVE tools and omitted `recursive_delegate`
 * ENTIRELY while every gate below stayed green. The table has since been corrected
 * to thirteen rows in the description's order; (e) makes the same drift fail.
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
  // FIXED BY T33: `ts-lint.ts` now ends those captures with `(?![\s\S])`, the faithful
  // JS translation of Python's absolute end-of-input `\Z`, so a section's final
  // sub-heading is readable. This test was `it.fails` while the hole existed; it flipped
  // to failing the moment T33 landed — which is exactly how the fix was detected — and is
  // now a real assertion. If it ever regresses, do NOT "fix" it by fabricating created files.
  it('a read-only review record (reviewed files only) is accepted by the linter (T33)', () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// (e) README §4.1 enumerates exactly the tools package.json declares
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY THIS EXISTS — a measured gap, not a nicety (see the file header).
 *
 * README.md was the ONE document this spec never read, and it drifted there: §4.1's
 * table listed twelve tools and omitted `recursive_delegate` entirely while every gate
 * stayed green. The table is now correct (thirteen rows); this guard is what makes the
 * same drift FAIL instead of shipping.
 *
 * THE README EDGE CLOSES THE TRIANGLE. (b) proves description ⟷ registered surface (the
 * stated count equals the registered count, every registered id is named, every name in
 * the description is registered). (e) proves README §4.1 ⟷ the description's own
 * enumeration, and refuses a description whose enumeration disagrees with its own count
 * claim. Composed, the README table is pinned to the code transitively: a tool that is
 * registered but absent from the README fails HERE, and a name the README invents — or a
 * tool the code withdrew while the README kept it — fails here too.
 *
 * HOW THE README'S ENUMERATION IS LOCATED, AND WHAT WOULD BREAK THAT. §4.1 is the
 * README's only enumeration: every other `recursive_*` occurrence is single-tool prose
 * ("`recursive_ask` is not a subagent tool"), a mermaid node (`REQ["recursive_review(phase)"]`)
 * or a row of the ✅/✅ feature matrix in §8 — a repo-wide regex would read those as the
 * enumeration and fail on text that is not drift. So the table is located by HEADING and
 * by ROW SHAPE:
 *   1. the heading `### 4.1 …` must appear EXACTLY ONCE (the anchor is the section
 *      number; two matches make "the §4.1 table" ambiguous);
 *   2. the table must be the FIRST markdown table under that heading, with a `| Tool | … |`
 *      header and a delimiter row of the same width;
 *   3. a data row counts as a tool row only when its first cell is EXACTLY one backticked
 *      `recursive_*` name — the shape §4.1 uses. A row that does not match is REPORTED,
 *      never skipped: skipping is how a table loses a tool behind the guard's back;
 *   4. any further tool-shaped row in the same section is REPORTED too, so a second
 *      enumeration cannot sit unread below the first.
 * What breaks it: renumbering §4.1, moving the table under another heading, retitling the
 * header cell away from `Tool`, inserting a different table between the heading and this
 * one, dropping the backticks from a tool cell, or adding a second tool table in §4.1.
 * Each of those fails LOUDLY, naming the heading, the row and the line — the fix is either
 * the document or this anchor, never a silent pass.
 */
const README_TEXT = readRepo('README.md')

/** `| \`recursive_name\` | … |` — §4.1's row shape; any further columns are ignored. */
const TOOL_ROW_RE = /^\|\s*`(recursive_[a-z0-9_]+)`\s*\|/

/** Cells of a markdown row: the leading and trailing `|` are delimiters, not cells. */
function tableCells(raw: string): string[] {
  const trimmed = raw.trim()
  const withoutLeading = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const body = withoutLeading.endsWith('|') ? withoutLeading.slice(0, -1) : withoutLeading
  return body.split('|')
}

interface ToolTableRow {
  /** 0-based index into the readme text's lines — the falsification cases mutate by index. */
  index: number
  /** 1-based line number, so a failure names the line to fix. */
  line: number
  raw: string
  /** the tool this row names, or null when its first cell is not §4.1's row shape. */
  tool: string | null
}

interface ToolTable {
  heading: string
  headingLine: number
  rows: ToolTableRow[]
  /** Why the extraction cannot be trusted. Any entry ⇒ the guard fails instead of passing. */
  problems: string[]
}

/** Locate and read README §4.1's tool table. See the block comment above for the rules. */
function readToolTable(readme: string): ToolTable {
  const lines = readme.split(/\r?\n/)
  const problems: string[] = []
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#{2,4}\s+4\.1(?![0-9.])(\s|$)/.test(line))
  if (headings.length !== 1) {
    const first = headings[0]
    return {
      heading: first?.line ?? '',
      headingLine: first === undefined ? 0 : first.index + 1,
      rows: [],
      problems: [
        headings.length === 0
          ? 'README.md has no `### 4.1 …` heading. The anchor IS the section number, so a renumbering lands here — loudly — instead of silently checking nothing: update this anchor.'
          : `README.md has ${headings.length} headings numbered 4.1 (lines ${headings.map((h) => h.index + 1).join(', ')}), so "the §4.1 table" is ambiguous.`,
      ],
    }
  }
  const heading = headings[0] as { line: string; index: number }
  const headingLine = heading.index + 1

  // The section runs to the next heading of any level; the table is its first markdown table.
  let start = -1
  let sectionEnd = lines.length
  for (let i = heading.index + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^#{1,6}\s/.test(line)) {
      sectionEnd = i
      break
    }
    if (start < 0 && /^\s*\|/.test(line)) start = i
  }
  if (start < 0) {
    return {
      heading: heading.line,
      headingLine,
      rows: [],
      problems: [`no markdown table follows README.md:${headingLine} (${heading.line.trim()}): this section holds no enumeration to check.`],
    }
  }
  const block: { index: number; raw: string }[] = []
  for (let i = start; i < sectionEnd; i++) {
    const line = lines[i] ?? ''
    if (!/^\s*\|/.test(line)) break
    block.push({ index: i, raw: line })
  }

  const header = block[0]
  const delimiter = block[1]
  if (header === undefined || delimiter === undefined) {
    problems.push(`the table at README.md:${start + 1} has ${block.length} row(s); a header row and a delimiter row are required.`)
  }
  const headerCells = header ? tableCells(header.raw) : []
  const delimiterCells = delimiter ? tableCells(delimiter.raw) : []
  if (headerCells.length < 2) {
    problems.push(`the table at README.md:${(header?.index ?? start) + 1} has ${headerCells.length} column(s); the §4.1 tool table has at least two (tool, description).`)
  }
  if ((headerCells[0] ?? '').trim().toLowerCase() !== 'tool') {
    problems.push(
      `the first header cell at README.md:${(header?.index ?? start) + 1} is ${JSON.stringify((headerCells[0] ?? '').trim())}, not "Tool": this cell is the row shape that identifies the tool table, so the guard refuses to guess at another table.`,
    )
  }
  if (delimiterCells.length !== headerCells.length || !delimiterCells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()))) {
    problems.push(
      `the delimiter row at README.md:${(delimiter?.index ?? start + 1) + 1} (${delimiter?.raw.trim() ?? 'missing'}) does not match the header's ${headerCells.length} column(s).`,
    )
  }

  const rows: ToolTableRow[] = []
  for (const { index, raw } of block.slice(2)) {
    const tool = TOOL_ROW_RE.exec(raw)?.[1] ?? null
    rows.push({ index, line: index + 1, raw, tool })
    if (tool === null) {
      problems.push(
        `README.md:${index + 1} is a §4.1 row whose first cell is not a backticked \`recursive_*\` name, so no tool can be read from it: ${raw.trim()}`,
      )
    }
  }
  if (rows.length === 0) {
    problems.push(`the §4.1 table has no data rows (from README.md:${start + 1}): an empty table would make every membership assertion pass vacuously.`)
  }

  // The reader takes the FIRST table only, so a second enumeration in the same section
  // must be reported rather than ignored.
  for (let i = start + block.length; i < sectionEnd; i++) {
    const line = lines[i] ?? ''
    if (TOOL_ROW_RE.test(line)) {
      problems.push(
        `README.md:${i + 1} is another tool-shaped row inside §4.1 (${line.trim()}): the guard reads the first table only, so §4.1 must hold exactly one enumeration — or this reader must learn about the second.`,
      )
    }
  }

  return { heading: heading.line, headingLine, rows, problems }
}

/**
 * The tool enumeration package.json's description states: the parenthesised list that
 * follows its own count claim (`… 13 recursive_* tools (a, b, …)`). Anchored on the count
 * because the description makes TWO statements about its tool set — the number and the
 * list — and a source of truth that disagrees with itself is not one. The count is checked
 * against the list here and against the registered surface by (b); the enumeration is also
 * required to be the description's COMPLETE tool set, so a name mentioned only in prose
 * cannot sit outside the list the README is compared against.
 */
function declaredTools(description: string): { tools: string[]; problems: string[] } {
  const problems: string[] = []
  const claim = /(\d+)\s+recursive_\*\s+tools\s*\(([^)]*)\)/.exec(description)
  if (!claim) {
    return {
      tools: [],
      problems: [`package.json's description states no \`<n> recursive_* tools (…)\` enumeration: ${JSON.stringify(description)}`],
    }
  }
  const stated = Number(claim[1] ?? '')
  const tools: string[] = []
  for (const entry of (claim[2] ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '')) {
    if (!/^recursive_[a-z0-9_]+$/.test(entry)) {
      problems.push(`the description's enumeration has an entry that is not a tool name: ${JSON.stringify(entry)}`)
      continue
    }
    tools.push(entry)
  }
  if (tools.length !== stated) {
    problems.push(`the description states ${stated} tools but enumerates ${tools.length}: ${tools.join(', ')}`)
  }
  const mentioned = new Set([...description.matchAll(/\brecursive_[a-z0-9_]+\b/g)].map((match) => match[0]))
  const outside = [...mentioned].filter((name) => !tools.includes(name)).sort()
  if (outside.length > 0) {
    problems.push(`the description names ${outside.join(', ')} outside its enumeration, so the enumeration is not its complete tool set`)
  }
  return { tools, problems }
}

interface ToolEnumerationDrift {
  /** tools the description declares, in the order it names them */
  declared: string[]
  /** tools README §4.1 documents, in the order the rows appear */
  documented: string[]
  /** declared minus documented — the README forgot a tool (`recursive_delegate`, historically) */
  missing: string[]
  /** documented minus declared — the README invented a tool, or code withdrew one it kept */
  invented: string[]
  /** a name repeated inside ONE enumeration: set equality would pass while a row is wrong */
  duplicated: string[]
  /** the extraction itself could not be trusted, so no membership claim below is meaningful */
  problems: string[]
}

/** Names appearing more than once, sorted. */
function duplicatedNames(names: string[]): string[] {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) twice.add(name)
    seen.add(name)
  }
  return [...twice].sort()
}

/**
 * PURE, and taking both texts as parameters so the falsification cases below can run it
 * over modified copies without touching README.md.
 *
 * MEMBERSHIP IS ENFORCED; ORDER IS NOT, DELIBERATELY.
 *
 * The description's order carries no code meaning: src/index.ts registers
 * `recursive_audit_team` OUTSIDE the array that registers the other twelve (it is
 * conditional on the optional `agentTeams` seam), so "…audit_team, review, delegate…" is a
 * documentation convention, not the registration order. Asserting order would therefore
 * fail on a harmless — arguably better — edit (alphabetising the table, or moving a tool
 * next to its peers) while catching no drift membership does not already catch: any real
 * drift (a tool added, removed or renamed) changes the SET. What not asserting order lets
 * through is rows in a different sequence than the description; nothing reads that
 * sequence. Set equality in BOTH directions plus a duplicate check pins the row count
 * itself, so a guard that merely counted rows cannot be fooled by a swap.
 */
function toolEnumerationDrift(description: string, readme: string): ToolEnumerationDrift {
  const declared = declaredTools(description)
  const table = readToolTable(readme)
  const documented = table.rows.map((row) => row.tool).filter((tool): tool is string => tool !== null)
  return {
    declared: declared.tools,
    documented,
    missing: declared.tools.filter((tool) => !documented.includes(tool)),
    invented: documented.filter((tool) => !declared.tools.includes(tool)),
    duplicated: [
      ...duplicatedNames(declared.tools).map((name) => `package.json description: ${name}`),
      ...duplicatedNames(documented).map((name) => `README §4.1: ${name}`),
    ],
    problems: [...declared.problems, ...table.problems],
  }
}

/** The failure text: enough to fix the drift from the output alone. */
function driftReport(drift: ToolEnumerationDrift): string {
  const lines = [
    "README §4.1 is the README's ONLY tool enumeration; package.json's description is its source of truth.",
    `declared by package.json (${drift.declared.length}): ${drift.declared.join(', ')}`,
    `documented by README §4.1 (${drift.documented.length}): ${drift.documented.join(', ')}`,
  ]
  if (drift.missing.length > 0) {
    lines.push(`MISSING from the README table — add a row for each: ${drift.missing.join(', ')}`)
  }
  if (drift.invented.length > 0) {
    lines.push(`INVENTED by the README table — no tool of this name is declared (delete the row, or fix the name): ${drift.invented.join(', ')}`)
  }
  if (drift.duplicated.length > 0) {
    lines.push(`named TWICE inside one enumeration — a duplicate row is how a table loses a tool while keeping its length: ${drift.duplicated.join(', ')}`)
  }
  if (drift.problems.length > 0) {
    lines.push(`EXTRACTION PROBLEMS — the enumeration could not be read:\n  - ${drift.problems.join('\n  - ')}`)
  }
  return lines.join('\n')
}

// ── mutated copies of the REAL texts, for the falsification cases ─────────────

/** The §4.1 data row naming `tool`, located by the same reader the guard uses. */
function toolRow(readme: string, tool: string): ToolTableRow {
  const row = readToolTable(readme).rows.find((candidate) => candidate.tool === tool)
  if (!row) throw new Error(`no README §4.1 table row names ${tool}`)
  return row
}

function withoutToolRow(readme: string, tool: string): string {
  const lines = readme.split(/\r?\n/)
  lines.splice(toolRow(readme, tool).index, 1)
  return lines.join('\n')
}

function withToolRowAfter(readme: string, tool: string, row: string): string {
  const lines = readme.split(/\r?\n/)
  lines.splice(toolRow(readme, tool).index + 1, 0, row)
  return lines.join('\n')
}

/** A second enumeration under the same §4.1 heading: `row`, detached by a blank line. */
function withSecondTableAfter(readme: string, tool: string, row: string): string {
  return withToolRowAfter(withToolRowAfter(readme, tool, row), tool, '')
}

/** The §4.1 data rows in reverse — a cosmetic edit that is NOT drift. */
function withToolRowsReversed(readme: string): string {
  const rows = readToolTable(readme).rows
  const lines = readme.split(/\r?\n/)
  const reversed = [...rows].reverse()
  rows.forEach((row, position) => lines.splice(row.index, 1, reversed[position]?.raw ?? ''))
  return lines.join('\n')
}

describe('T25 (e) — README §4.1 enumerates exactly the tools package.json declares', () => {
  it('the description is a self-consistent enumeration (the source of truth is guarded too)', () => {
    const declared = declaredTools(PACKAGE_DESCRIPTION)
    expect(declared.problems).toEqual([])
    // (b) pins this count to the registered surface; pinning it here as well means the
    // README edge cannot pass vacuously through a shrunken enumeration.
    expect(declared.tools.length).toBe(REGISTERED_TOOL_IDS.length)
  })

  it('README §4.1 lists every declared tool, and nothing the description does not name', () => {
    const drift = toolEnumerationDrift(PACKAGE_DESCRIPTION, README_TEXT)
    expect(drift.problems, driftReport(drift)).toEqual([])
    expect({ missing: drift.missing, invented: drift.invented, duplicated: drift.duplicated }, driftReport(drift)).toEqual({
      missing: [],
      invented: [],
      duplicated: [],
    })
    // non-vacuity: the table really was located, really read, and really is that size
    expect(drift.documented.length).toBe(drift.declared.length)
  })

  /**
   * FALSIFICATION — the guard is shown to FAIL on drift, using MODIFIED COPIES of the real
   * texts built here in memory. README.md is never written: it is the artefact under guard,
   * and a guard "proved" by editing the thing it guards proves nothing. Every case mutates
   * the REAL text, so the evidence travels with the document — reshape §4.1 and these cases
   * break with it instead of quietly testing a stale copy of a table that no longer exists.
   */
  it('the guard has teeth: a dropped row, an invented row, a swap and a duplicate are each reported', () => {
    const clean = toolEnumerationDrift(PACKAGE_DESCRIPTION, README_TEXT)
    expect(clean.problems).toEqual([])
    expect(clean.missing).toEqual([])
    expect(clean.invented).toEqual([])

    // (1) DROP THE ROW THAT DRIFTED — `recursive_delegate`, the tool the real table once
    //     omitted. A guard that cannot see this cannot see the drift it exists for.
    const dropped = toolEnumerationDrift(PACKAGE_DESCRIPTION, withoutToolRow(README_TEXT, 'recursive_delegate'))
    // The SAME object the passing test asserts to be empty, over the drifted table: this is
    // what the guard's own expect() would have compared, and it is not the empty object.
    expect({ missing: dropped.missing, invented: dropped.invented, duplicated: dropped.duplicated }).toEqual({
      missing: ['recursive_delegate'],
      invented: [],
      duplicated: [],
    })
    expect(driftReport(dropped)).toContain('recursive_delegate')

    // (2) INVENT A TOOL no description names.
    const invented = toolEnumerationDrift(
      PACKAGE_DESCRIPTION,
      withToolRowAfter(README_TEXT, 'recursive_preview', '| `recursive_not_a_tool` | invented by this test |'),
    )
    expect(invented.invented).toEqual(['recursive_not_a_tool'])
    expect(invented.missing).toEqual([])

    // (3) A SWAP — the counterexample that rules out a count-only guard: the table still has
    //     thirteen rows, so "13 rows" passes while the set is wrong in BOTH directions.
    const swapped = toolEnumerationDrift(
      PACKAGE_DESCRIPTION,
      withToolRowAfter(withoutToolRow(README_TEXT, 'recursive_delegate'), 'recursive_preview', '| `recursive_not_a_tool` | invented by this test |'),
    )
    expect(swapped.documented.length).toBe(clean.documented.length)
    expect(swapped.missing).toEqual(['recursive_delegate'])
    expect(swapped.invented).toEqual(['recursive_not_a_tool'])

    // (4) A DUPLICATE keeps the length at thirteen while losing a tool — the other half of
    //     the same counterexample.
    const duplicated = toolEnumerationDrift(
      PACKAGE_DESCRIPTION,
      withToolRowAfter(withoutToolRow(README_TEXT, 'recursive_delegate'), 'recursive_preview', '| `recursive_preview` | a duplicate row |'),
    )
    expect(duplicated.documented.length).toBe(clean.documented.length)
    expect(duplicated.duplicated).toEqual(['README §4.1: recursive_preview'])
    expect(duplicated.missing).toEqual(['recursive_delegate'])
  })

  it('the guard reports unreadable input, refuses a second enumeration, and does not fire on a harmless reorder', () => {
    // (5) A ROW THAT LOSES ITS SHAPE is reported as a problem, never skipped — skipping is
    //     how a table could shrink behind the guard's back.
    const unshaped = toolEnumerationDrift(PACKAGE_DESCRIPTION, README_TEXT.replace('| `recursive_delegate` |', '| recursive_delegate |'))
    expect(unshaped.problems.join('\n')).toContain('recursive_delegate')
    expect(unshaped.missing).toEqual(['recursive_delegate'])

    // (6) A SECOND ENUMERATION under §4.1 is refused: the reader takes the first table only,
    //     so it must say so rather than let the second one go unchecked.
    const second = toolEnumerationDrift(
      PACKAGE_DESCRIPTION,
      withSecondTableAfter(README_TEXT, 'recursive_preview', '| `recursive_shadow` | a second enumeration the guard must not ignore |'),
    )
    expect(second.problems.join('\n')).toContain('another tool-shaped row inside §4.1')

    // (7) A SHRUNKEN SOURCE OF TRUTH is caught on the description side: dropping a name from
    //     the enumeration breaks its own count claim, and the README row then reads invented.
    const shrunk = toolEnumerationDrift(PACKAGE_DESCRIPTION.replace(', recursive_preview', ''), README_TEXT)
    expect(shrunk.problems.join('\n')).toContain('states 13 tools but enumerates 12')
    expect(shrunk.invented).toEqual(['recursive_preview'])

    // (8) A NAME MENTIONED ONLY IN PROSE would otherwise never be required of the README.
    const stray = toolEnumerationDrift(PACKAGE_DESCRIPTION + ' Not to be confused with recursive_stray.', README_TEXT)
    expect(stray.problems.join('\n')).toContain('outside its enumeration')

    // (9) REORDERING IS NOT DRIFT — the decision not to assert order, made executable: the
    //     description's order is a documentation convention (src/index.ts registers
    //     `recursive_audit_team` conditionally, outside the array that registers the other
    //     twelve), so a reordered table is a cosmetic difference, not drift.
    const reordered = toolEnumerationDrift(PACKAGE_DESCRIPTION, withToolRowsReversed(README_TEXT))
    expect(reordered.problems).toEqual([])
    expect(reordered.missing).toEqual([])
    expect(reordered.invented).toEqual([])
    expect(reordered.duplicated).toEqual([])
    expect(reordered.documented).not.toEqual(toolEnumerationDrift(PACKAGE_DESCRIPTION, README_TEXT).documented)
  })
})
