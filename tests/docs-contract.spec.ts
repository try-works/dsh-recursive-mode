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
 * SIX ASSERTIONS — the plan's four, plus the two README edges the measured drift added:
 *   (a) every repo-relative path a shipped document names as an existing file of
 *       THIS repo exists;
 *   (b) package.json's description agrees with the tool surface actually
 *       registered by src/index.ts;
 *   (c) every marker string the linter requires is emitted by the writer that
 *       produces it — proven by executing the repo's OWN linter over a record the
 *       repo's own writer produced;
 *   (d) no shipped prompt or skill names a withdrawn tool, phase artifact or verb;
 *   (e) README.md's ONLY tool enumeration — its §4.1 table — names exactly the tools
 *       package.json's description declares: none missing, none invented;
 *   (f) every `recursive_<name>` the README mentions ANYWHERE ELSE — §8's ✅/✅ capability
 *       matrix, the mermaid node labels, single-tool prose — is a tool src/index.ts really
 *       registers. (e) guards the table; (f) guards the promises around it, and it classifies
 *       EVERY `recursive_` occurrence the README does not use for a tool, so the list of
 *       non-tool forms cannot rot into a place where a withdrawn name hides.
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

  /**
   * ⚠ THE THIRD STATE MUST BE LINTABLE, because a record that fails the linter is a record a main agent
   * cannot cite in `Subagent Contribution Verification` — and the parked round is precisely the one the agent
   * has to come back to. This lints the REAL writer output with only the status lines swapped, so the state
   * itself is what is under test: if `Status: parked (still running; no settlement yet)` or the `Parked:` line
   * broke a canonical section, this would report the violation.
   *
   * The non-vacuity guard is the `after === before` assertion rather than `after === []`: the fixture's own
   * baseline is asserted to be zero in the test above, and a rewrite that accidentally FIXED an unrelated
   * violation would otherwise still pass.
   */
  it('the linter accepts a PARKED record and a FAILED record — the three states are all lintable', () => {
    const fixture = makeRecordFixture()
    const before = lintSubagentActionRecordFile(fixture.recordPath, fixture.root, fixture.runDir, null)
    expect(before).toEqual([])

    // ⚠ EVERY VARIANT IS DERIVED FROM THE WRITER'S ORIGINAL OUTPUT, never from the previous variant: the
    // first version of this helper rewrote the file in place, so the failed case was built on top of the
    // parked one, could no longer find `- Status: accepted`, and silently asserted against an unchanged
    // record. A status test that does not change the status is the exact vacuity it is meant to catch.
    //
    // The detail line is inserted BEFORE `- Timestamp:`, which is the writer's last Metadata field, so the
    // variant is anchored on a line the writer always emits rather than on one only some records carry.
    const withStatus = (status: string, detail: string): string => {
      const text = fixture.record
      expect(text, 'the writer emits the accepted status this variant replaces').toContain('- Status: accepted')
      expect(text, 'the writer always ends Metadata with Timestamp').toContain('\n- Timestamp: ')
      const rewritten = text
        .replace('- Status: accepted', '- Status: ' + status)
        .replace('\n- Timestamp: ', '\n- ' + detail + '\n- Timestamp: ')
      writeFileSync(fixture.recordPath, rewritten, 'utf8')
      return rewritten
    }

    try {
      const parked = withStatus(
        'parked (still running; no settlement yet)',
        'Parked: no settlement had landed when the wait ended, so this round is PARKED, not failed: the next step'
        + ' is to RESUME this round with childId child-a.',
      )
      expect(parked).toContain('- Status: parked')
      expect(parked).not.toContain('- Status: failed')
      expect(parked).not.toContain('- Failure:')
      expect(lintSubagentActionRecordFile(fixture.recordPath, fixture.root, fixture.runDir, null)).toEqual(before)

      const failed = withStatus('failed', 'Failure:the delegation returned without acceptance; stop reason error')
      expect(failed).toContain('- Status: failed')
      expect(failed).toContain('- Failure:')
      expect(failed, 'a failed record must not wear the parked label').not.toContain('Parked:')
      expect(lintSubagentActionRecordFile(fixture.recordPath, fixture.root, fixture.runDir, null)).toEqual(before)
    } finally {
      // Restore the writer's own output so a later test in this file cannot inherit an edited record.
      writeFileSync(fixture.recordPath, fixture.record, 'utf8')
    }
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
 * enumeration and fail on text that is not drift. (Those mentions are not left unguarded:
 * (f) below reads exactly them, for the different question of whether each one names a
 * registered tool. Reading them as THIS enumeration would still be wrong.) So the table is
 * located by HEADING and by ROW SHAPE:
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

// ─────────────────────────────────────────────────────────────────────────────
// (f) every `recursive_<name>` mention in README.md — not only §4.1's table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY THIS EXISTS — (e) guards ONE table, and README.md promises a tool in four more places.
 * Measured on this document, `recursive_review` alone is named seven times: README.md:180
 * (§4.1's row — the only one (e) reads), :349 and :434 (mermaid node labels), :481 and :490
 * (single-tool prose), :499 (§8's ✅/✅ capability matrix) and :508 (the "three delegation
 * paths" paragraph). Withdraw `recursive_review` from src/** and delete its §4.1 row — the edit
 * a withdrawal is supposed to make — and (e) is satisfied by the shrunken table while the
 * matrix still says it works, both diagrams still route through it and the prose still teaches
 * it: three places promising a tool that no longer exists, and no gate reading any of them.
 * (f) reads every `recursive_<name>` occurrence in the document, wherever it sits.
 *
 * (f) IS A DIFFERENT QUESTION FROM (e), NOT A WIDER VERSION OF IT. (e) asks "does the README's
 * ENUMERATION agree with package.json's?" — which is exactly why it must refuse to read
 * anything but the one table (a repo-wide regex would read the matrix as the enumeration and
 * fail on text that is not drift). (f) asks "is every tool NAME the README uses the name of a
 * registered tool?" — a MEMBERSHIP question the table cannot answer alone. Both are needed:
 * (e) catches a tool MISSING from the table, (f) catches a name still promised after its row
 * was correctly deleted. The registered set is REGISTERED_TOOL_IDS, the set (b)/(e) derive from
 * src/index.ts: the extraction is REUSED here, never re-derived, so there is one definition of
 * "the tool surface" in this file.
 *
 * THE PREFIX IS NOT TOOL-EXCLUSIVE, SO EVERY `recursive_` OCCURRENCE IS CLASSIFIED. The whole
 * difficulty is that the README legitimately uses the prefix for things that are not tools, and
 * a guard that skips whatever it does not recognise is how a withdrawn tool survives its own
 * withdrawal — a skipped line reads as "checked, clean". So the scan accounts for EVERY
 * `recursive_`-prefixed occurrence in the document, sorts it into one of three classes, and
 * REPORTS (`problems`) any occurrence that falls outside them instead of ignoring it:
 *
 *   class 1  name      `recursive_<lower-case letters, digits, underscores>` — a TOOL MENTION,
 *                      membership-checked. Measured when this guard was written: 31 mentions on
 *                      28 lines, naming all 13 registered tools.
 *   class 2  glob      `recursive_*` — README.md:120 (`TOOLSET["13 recursive_* tools"]`) and
 *                      README.md:935 (`| Surfaces | `recursive_*.tool.ts` (13), … |`). The `*`
 *                      is not a name and no tool id can contain one, so this form names NO
 *                      tool: nothing can be withdrawn from a glob, and a withdrawal cannot hide
 *                      in one. What it CAN hide is a stale COUNT, and that is the one thing (f)
 *                      does not cover — see the limits below.
 *   class 3  constant  the SCREAMING_SNAKE environment variables the memory-training plane
 *                      documents: RECURSIVE_TRAINING_EXTRACTOR_CMD (README.md:616, 635) and
 *                      RECURSIVE_TRAINING_RESPONSE_FILE (README.md:617, 635). They are operator
 *                      CONFIGURATION KEYS consumed by the injected extractor spawn and by the
 *                      response-file path — not tools. Every registered tool id is lower-case
 *                      (`name: 'recursive_…'` in src/**), so an upper-case prefix is a different
 *                      naming convention, and the excluded pair is an EXACT, TWO-WAY allow-list
 *                      (NON_TOOL_PREFIX_FORMS) asserted below: a constant that DISAPPEARS from
 *                      the README fails exactly as loudly as an unlisted one appearing, so the
 *                      exclusion can neither rot nor quietly grow to cover a new name.
 *
 * WHY THE HYPHEN/COLON/DOT FORMS NEED NO CLASS AT ALL — and are deliberately not allow-listed.
 * `recursive-mode` (the preset, the workflow and the package: README.md:1, 5, 51, 112),
 * `recursive-router.json` (267), the strict profiles `recursive-mode-audit-v2`/`-v1` (517),
 * `@try-works/dsh-recursive-mode` (730), `recursive-realm` (746, 819) and `dsh-recursive-mode`
 * (958) are hyphenated; `preset/recursive.patch.yml` (738, 780) and the `.recursive/` control
 * plane (69, 123, 264, 293) are dot-separated; `recursive:policy` (747) is colon-separated.
 * None of them contains the `recursive_` UNDERSCORE prefix — and every registered tool id does —
 * so the extraction cannot reach them, and none of them can spell a tool name. An allow-list
 * entry for a form the scan cannot produce would be dead weight whose rot nothing would catch;
 * the occurrence audit already reports any NEW `recursive_`-prefixed form that is not one of
 * the three classes, which is where a form this guard has not been taught lands.
 *
 * WHAT (f) DOES NOT CATCH — stated here so the gap is not mistaken for coverage:
 *   - COUNT claims. "13 recursive_* tools" (120), "the thirteen tools" (725), "13 tools" (747)
 *     and "`recursive_*.tool.ts` (13)" (935) name no tool, so a withdrawal that leaves a count
 *     stale is invisible to this assertion; (b) pins only package.json's own count, and pinning
 *     the README's numbers would be a separate guard. Made executable below, not assumed.
 *   - A name written with a different CASE (`Recursive_Review`). It is not read as a tool
 *     mention — tool ids are lower-case, so such text would not resolve at call time either —
 *     but it is NOT silently skipped: it lands in the occurrence audit's `problems`, which
 *     fails the guard and forces a human to classify the form.
 *   - A mention whose SEPARATOR was re-spelled (`recursive-review`). Distinguishing that from
 *     the hyphenated preset/workflow/profile names above would require allow-listing a form
 *     that CAN spell a tool name, which is the exclusion this guard refuses to make. So a
 *     withdrawal whose every prose mention was re-spelled that way would go unseen by (f).
 *   - The reverse direction ("every registered tool is mentioned"): (e) already requires §4.1
 *     to document each one; (f) only asserts its own scan is not vacuous.
 */

/** `recursive_<lower-case name>`: the tool-mention shape (b)/(d)/(e) also match. */
const TOOL_MENTION_SHAPE = /^recursive_[a-z0-9_]+$/

/**
 * Every `recursive_`-prefixed form the README uses that is NOT a tool mention, with the reason
 * it cannot hide a withdrawal. EXACT strings, not a pattern: a pattern would silently cover
 * names nobody has classified. The first test below asserts this list is exactly what the
 * document contains — both directions — so it fails on a removed entry as well as a new one.
 */
const NON_TOOL_PREFIX_FORMS: { token: string; why: string }[] = [
  {
    token: 'RECURSIVE_TRAINING_EXTRACTOR_CMD',
    why: "the memory-training gate's extractor command: an operator environment variable read by the injected spawn (README.md:616, 635), not a tool",
  },
  {
    token: 'RECURSIVE_TRAINING_RESPONSE_FILE',
    why: "the extractor's response-file environment variable (README.md:617, 635); upper-case by the environment-variable convention, while every registered tool id is lower-case",
  },
]

interface PrefixOccurrence {
  /** 1-based line in the scanned text, so a failure names the line to fix */
  line: number
  /** the occurrence as the document writes it: `recursive_review`, `recursive_*`, `RECURSIVE_…` */
  token: string
  /** 'name' = a tool mention (membership-checked); 'glob'/'constant' = the documented non-tools */
  klass: 'name' | 'glob' | 'constant'
}

interface PrefixScan {
  occurrences: PrefixOccurrence[]
  /** reasons the classification cannot be trusted; any entry makes the guard fail */
  problems: string[]
}

/** A short single-line excerpt around `at`, for failure text that can be acted on. */
function excerpt(line: string, at: number): string {
  const from = Math.max(0, at - 16)
  const to = Math.min(line.length, at + 44)
  return (from > 0 ? '…' : '') + line.slice(from, to) + (to < line.length ? '…' : '')
}

/**
 * Classify EVERY `recursive_`-prefixed occurrence in `readme`. PURE and taking the text as a
 * parameter, so the falsification cases below run it over MODIFIED COPIES without ever writing
 * README.md — the artefact under guard cannot be edited by the test that guards it.
 */
function scanPrefixOccurrences(readme: string): PrefixScan {
  const occurrences: PrefixOccurrence[] = []
  const problems: string[] = []
  const lines = readme.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const prefix = /recursive_/gi
    let match: RegExpExecArray | null
    while ((match = prefix.exec(line)) !== null) {
      const start = match.index
      const head = match[0] // `recursive_`, or a case variant of it (`RECURSIVE_`)
      const tail = /^[A-Za-z0-9_]*/.exec(line.slice(start + head.length))?.[0] ?? ''
      const token = head + tail
      prefix.lastIndex = start + token.length // never re-read a token, whatever its class
      const before = start === 0 ? '' : (line[start - 1] ?? '')
      if (/[A-Za-z0-9_]/.test(before)) {
        problems.push(
          `README.md:${index + 1} writes \`recursive_\` inside a longer word (${JSON.stringify(excerpt(line, start))}), so no tool mention can be read from it: a tool name is never written that way — classify the form instead of skipping it.`,
        )
        continue
      }
      if (TOOL_MENTION_SHAPE.test(token)) {
        occurrences.push({ line: index + 1, token, klass: 'name' })
        continue
      }
      // `recursive_*`: the `*` ends the name run, so `token` is the bare prefix and the glob's
      // own character is the next one. See class 2 above for why this names no tool.
      if (token === 'recursive_' && (line[start + token.length] ?? '') === '*') {
        occurrences.push({ line: index + 1, token: 'recursive_*', klass: 'glob' })
        continue
      }
      if (NON_TOOL_PREFIX_FORMS.some((form) => form.token === token)) {
        occurrences.push({ line: index + 1, token, klass: 'constant' })
        continue
      }
      problems.push(
        `README.md:${index + 1} has a \`recursive_\`-prefixed token that is neither a lower-case tool name, nor the \`recursive_*\` glob, nor one of the ${NON_TOOL_PREFIX_FORMS.length} documented non-tool environment variables: ${JSON.stringify(token)} in ${JSON.stringify(excerpt(line, start))} — either add it to NON_TOOL_PREFIX_FORMS with the reason it cannot hide a withdrawal, or register the tool it names.`,
      )
    }
  }
  return { occurrences, problems }
}

/** The class-1 mentions whose name is NOT registered: the drift this assertion exists for. */
function unregisteredToolMentions(readme: string, registered: readonly string[]): PrefixOccurrence[] {
  return scanPrefixOccurrences(readme)
    .occurrences.filter((occurrence) => occurrence.klass === 'name' && !registered.includes(occurrence.token))
    .sort((a, b) => a.line - b.line || a.token.localeCompare(b.token))
}

/** Failure text: which promise, on which line, with the line itself — fixable from the output. */
function mentionReport(readme: string, registered: readonly string[]): string {
  const scan = scanPrefixOccurrences(readme)
  const lines = readme.split(/\r?\n/)
  const out = [
    `every \`recursive_<name>\` README.md mentions — §4.1's table, §8's ✅/✅ matrix, the mermaid labels, prose — must be a tool the plugin registers (${registered.length} registered).`,
  ]
  for (const occurrence of unregisteredToolMentions(readme, registered)) {
    out.push(
      `  README.md:${occurrence.line} promises ${occurrence.token}, which is not registered: ${(lines[occurrence.line - 1] ?? '').trim().slice(0, 140)}`,
    )
  }
  if (scan.problems.length > 0) {
    out.push(`EXTRACTION PROBLEMS — the prefix scan could not be trusted:\n  - ${scan.problems.join('\n  - ')}`)
  }
  return out.join('\n')
}

// ── mutated copies of the REAL README, for the falsification cases ────────────

/** A mutated COPY with `lines` inserted after the first line matching `anchor`, plus their line numbers. */
function withLinesAfterAnchor(readme: string, anchor: RegExp, lines: string[]): { text: string; insertedAt: number[] } {
  const all = readme.split(/\r?\n/)
  const at = all.findIndex((line) => anchor.test(line))
  if (at < 0) throw new Error(`T25 (f): no README.md line matches ${anchor} — the falsification anchor moved; re-anchor it.`)
  const copy = [...all]
  copy.splice(at + 1, 0, ...lines)
  return { text: copy.join('\n'), insertedAt: lines.map((_, offset) => at + 2 + offset) }
}

/** A mutated COPY with `lines` appended — the excluded forms restated in the document's own voice. */
function withAppendedLines(readme: string, lines: string[]): string {
  return readme + '\n' + lines.join('\n') + '\n'
}

/** How many occurrences of a class a text holds; used to prove an exclusion was really exercised. */
function countClass(readme: string, klass: PrefixOccurrence['klass']): number {
  return scanPrefixOccurrences(readme).occurrences.filter((occurrence) => occurrence.klass === klass).length
}

describe('T25 (f) — every `recursive_<name>` mention in README.md names a registered tool', () => {
  it('the prefix scan classifies every `recursive_` occurrence, and its non-tool classes are exactly the documented ones', () => {
    const scan = scanPrefixOccurrences(README_TEXT)
    expect(scan.problems).toEqual([])
    const names = scan.occurrences.filter((occurrence) => occurrence.klass === 'name')
    // non-vacuity: the scan found the whole tool surface, not a token or two
    expect([...new Set(names.map((occurrence) => occurrence.token))].length).toBeGreaterThanOrEqual(REGISTERED_TOOL_IDS.length)
    // the glob exclusion is exercised by the REAL document, so it is a live rule and not a
    // branch nothing reaches (a rule no text exercises is a rule no test can falsify)
    expect(scan.occurrences.filter((occurrence) => occurrence.klass === 'glob').length).toBeGreaterThanOrEqual(1)
    // the constant allow-list is EXACT in BOTH directions: it may not keep an entry the document
    // no longer uses (rot), and it may not be missing one the document does use (a new form must
    // be classified by hand, never absorbed by a pattern)
    const found = [
      ...new Set(scan.occurrences.filter((occurrence) => occurrence.klass === 'constant').map((occurrence) => occurrence.token)),
    ].sort()
    expect(found).toEqual(NON_TOOL_PREFIX_FORMS.map((form) => form.token).sort())
    for (const form of NON_TOOL_PREFIX_FORMS) {
      expect(form.why.length, `${form.token} must record WHY it cannot hide a withdrawal`).toBeGreaterThan(20)
      // ... nor may it be a REGISTERED tool id in the wrong case. That entry is precisely the
      // exclusion that would let a real name slip through, so it is refused outright rather
      // than left to the `why` text: `RECURSIVE_TRAINING_EXTRACTOR_CMD` lower-cases to no tool,
      // while an allow-listed `RECURSIVE_REVIEW` would lower-case to a live tool id and fail here.
      expect(
        REGISTERED_TOOL_IDS,
        `${form.token} is a registered tool id in the wrong case — allow-listing it would hide that tool`,
      ).not.toContain(form.token.toLowerCase())
    }
  })

  it('every tool name the README mentions — in the table, the ✅ matrix, a diagram or prose — is registered', () => {
    const scan = scanPrefixOccurrences(README_TEXT)
    expect(scan.problems, mentionReport(README_TEXT, REGISTERED_TOOL_IDS)).toEqual([])
    const withdrawn = unregisteredToolMentions(README_TEXT, REGISTERED_TOOL_IDS)
    expect(withdrawn, mentionReport(README_TEXT, REGISTERED_TOOL_IDS)).toEqual([])
    // non-vacuity, and the point of the whole assertion: those mentions are NOT confined to
    // §4.1's table, which is the only thing (e) reads. If they ever were, (f) would be (e).
    const tableLines = new Set(readToolTable(README_TEXT).rows.map((row) => row.line))
    const outsideTable = scan.occurrences.filter(
      (occurrence) => occurrence.klass === 'name' && !tableLines.has(occurrence.line),
    )
    expect(outsideTable.length).toBeGreaterThan(0)
    expect(outsideTable.some((occurrence) => occurrence.token === 'recursive_review')).toBe(true)
  })

  /**
   * FALSIFICATION — the guard is shown to FAIL on a withdrawal and NOT to fire on the prefix's
   * legitimate non-tool uses, on MODIFIED COPIES of the real README built in memory. README.md is
   * never written: it is the artefact under guard, and a guard "proved" by editing the thing it
   * guards proves nothing. Injected text is placed under REAL anchors in the real forms, so the
   * evidence travels with the document — if a section these cases anchor on is rewritten, they
   * fail loudly instead of quietly testing a stale copy.
   */
  it('the guard has teeth: an unregistered promise anywhere is reported, while every non-tool form is not', () => {
    expect(unregisteredToolMentions(README_TEXT, REGISTERED_TOOL_IDS)).toEqual([])

    // (1) A NAME THE README PROMISES THAT NO TOOL REGISTERS, injected in the three places (e)
    //     cannot see: a mermaid node label, single-tool prose, and §8's ✅/✅ capability matrix.
    //     The insertions run in DOCUMENT ORDER (§7's diagram, then §8's prose, then the matrix),
    //     so each recorded line number stays valid in the text the next one is built from.
    const mermaid = withLinesAfterAnchor(README_TEXT, /^\s*REQ\["recursive_review\(phase\)"\]/, [
      '    WD["recursive_withdrawn(phase)"] --> NOPE["no such tool"]',
    ])
    const prose = withLinesAfterAnchor(mermaid.text, /\*\*`recursive_ask` is not a subagent tool\.\*\*/, [
      '4. **`recursive_withdrawn` is not a subagent tool.** It was withdrawn from src/**.',
    ])
    const matrix = withLinesAfterAnchor(prose.text, /^>\s*\|\s*`recursive_review` works\s*\|/, [
      '> | `recursive_withdrawn` works | ✅ | ✅ |',
    ])
    // EVERY injected site is reported, at its own line — not just the first one found
    expect(unregisteredToolMentions(matrix.text, REGISTERED_TOOL_IDS).map((occurrence) => `${occurrence.line}:${occurrence.token}`)).toEqual([
      `${mermaid.insertedAt[0]}:recursive_withdrawn`,
      `${prose.insertedAt[0]}:recursive_withdrawn`,
      `${matrix.insertedAt[0]}:recursive_withdrawn`,
    ])
    expect(mentionReport(matrix.text, REGISTERED_TOOL_IDS)).toContain('recursive_withdrawn')

    // ... AND THE §4.1 TABLE GUARD IS BLIND TO IT — the gap this assertion closes, made
    // executable: the table is untouched, so (e) reports no problem, no missing tool and no
    // invented tool on the very document that promises `recursive_withdrawn` three times.
    const enumeration = toolEnumerationDrift(PACKAGE_DESCRIPTION, matrix.text)
    expect(enumeration.problems).toEqual([])
    expect({ missing: enumeration.missing, invented: enumeration.invented }).toEqual({ missing: [], invented: [] })

    // (2) THE FALSE-POSITIVE GUARD: every non-tool use of the prefix, re-stated in the document's
    //     own voice. None of them may be reported — a guard that cried wolf here would be turned
    //     off, and turning it off is how the drift returns.
    const nonTools = withAppendedLines(README_TEXT, [
      '| Surfaces | `recursive_*.tool.ts` (13), `commands.ts` |',
      '| Files | `recursive_review.tool.ts` (a real tool stem in a filename) |',
      '**recursive-mode** is the workflow; the strict profiles are `recursive-mode-audit-v2` and `recursive-mode-audit-v1`.',
      'A preset is declared by `preset/recursive.patch.yml`; the surface lives inside `- id: recursive-realm`.',
      'The control plane lives in `.recursive/`, and the policy service is `recursive:policy`.',
      'One slash command, `/recursive <verb>` — e.g. `/recursive status` or `/recursive memory <query>`.',
      'The extractor reads `RECURSIVE_TRAINING_EXTRACTOR_CMD` or `RECURSIVE_TRAINING_RESPONSE_FILE`.',
    ])
    const nonToolScan = scanPrefixOccurrences(nonTools)
    expect(nonToolScan.problems).toEqual([])
    expect(unregisteredToolMentions(nonTools, REGISTERED_TOOL_IDS)).toEqual([])
    // the two exclusions were really EXERCISED by that text — a scan that never saw the excluded
    // forms would satisfy the two assertions above while proving nothing about them
    expect(countClass(nonTools, 'glob')).toBe(countClass(README_TEXT, 'glob') + 1)
    expect(countClass(nonTools, 'constant')).toBe(countClass(README_TEXT, 'constant') + 2)

    // (3) THE EXCLUSIONS CANNOT SWALLOW A WITHDRAWAL: one line carrying the glob, the hyphenated
    //     names, the service id and an environment variable — AND a withdrawn tool name. Exactly
    //     the withdrawn name is reported, so no exclusion is a hiding place.
    const mixed = withAppendedLines(README_TEXT, [
      '| Surfaces | `recursive_*.tool.ts` (13) — the withdrawn `recursive_withdrawn` shipped here; also `recursive-mode`, `recursive:policy` and `RECURSIVE_TRAINING_EXTRACTOR_CMD` |',
    ])
    expect(unregisteredToolMentions(mixed, REGISTERED_TOOL_IDS).map((occurrence) => occurrence.token)).toEqual([
      'recursive_withdrawn',
    ])

    // (4) WITHDRAWING A TOOL FROM THE CODE FAILS EVERY README MENTION OF IT — every form, every
    //     section. The registered set is a PARAMETER of the check, so the withdrawal is simulated
    //     by handing the scan the set without that tool; src/index.ts is never touched.
    const readmeLines = README_TEXT.split(/\r?\n/)
    for (const tool of REGISTERED_TOOL_IDS) {
      const reported = unregisteredToolMentions(README_TEXT, REGISTERED_TOOL_IDS.filter((id) => id !== tool))
      const mentionedOn = readmeLines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes(tool))
        .map(({ index }) => index + 1)
      expect(mentionedOn.length, `${tool} must be promised by README.md for this case to mean anything`).toBeGreaterThan(0)
      expect([...new Set(reported.map((occurrence) => occurrence.line))], `${tool}: EVERY README mention must fail`).toEqual(mentionedOn)
      expect(reported.every((occurrence) => occurrence.token === tool)).toBe(true)
    }
    // and for the tools whose promises live outside §4.1, the table guard alone would have missed
    // the withdrawal entirely: the review withdrawal is caught in all three forms the gap named.
    const tableLines = new Set(readToolTable(README_TEXT).rows.map((row) => row.line))
    expect([...tableLines].some((line) => readmeLines[line - 1]?.includes('recursive_review'))).toBe(true)
    const reviewLines = unregisteredToolMentions(README_TEXT, REGISTERED_TOOL_IDS.filter((id) => id !== 'recursive_review')).map(
      (occurrence) => readmeLines[occurrence.line - 1] ?? '',
    )
    expect(reviewLines.some((line) => line.includes('✅'))).toBe(true) // §8's ✅/✅ capability matrix
    expect(reviewLines.some((line) => line.includes('["recursive_review'))).toBe(true) // a mermaid node label
    expect(
      reviewLines.some((line) => /`recursive_review`/.test(line) && !/^\s*[>|]/.test(line) && !line.includes('["')),
    ).toBe(true) // single-tool prose

    // (5) THE DOCUMENTED LIMIT, made executable rather than assumed: `recursive_*` names no tool,
    //     so a stale COUNT standing behind it is invisible to this assertion. Pinning README's
    //     numbers is a separate guard; what matters here is that (f) does not pretend to do it.
    const recounted = withAppendedLines(README_TEXT, ['| Surfaces | `recursive_*.tool.ts` (99), `commands.ts` |'])
    expect(unregisteredToolMentions(recounted, REGISTERED_TOOL_IDS)).toEqual([])

    // (6) A NEW non-tool form is REPORTED, never skipped — the classification is exhaustive, so a
    //     form the guard has not been taught (here: a tool name in the wrong case, and a
    //     placeholder shape) cannot become a hiding place. Both would otherwise be silent.
    const miscased = withAppendedLines(README_TEXT, ['| `RECURSIVE_REVIEW` | a tool name in the wrong case |'])
    expect(scanPrefixOccurrences(miscased).problems.join('\n')).toContain('RECURSIVE_REVIEW')
    const placeholder = withAppendedLines(README_TEXT, ['| `recursive_<name>` | a shape, not a name |'])
    expect(scanPrefixOccurrences(placeholder).problems.join('\n')).toContain('recursive_<name>')
  })
})
