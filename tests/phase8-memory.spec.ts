/**
 * T40 — THE PHASE-8 MEMORY WRITE: the rule, the write surface, and the lock-time gate.
 *
 * ⚠ WHY THIS IS A NEW SPEC FILE. The enforcement proof for a lock refusal belongs beside the other
 * lock refusals in `tests/lock-gate.spec.ts` — which ANOTHER AGENT owns right now, so an edit there
 * would collide with work in flight. Everything here is ADDITIVE: it asserts the rule, the writer and
 * the gate, and it names (in `the refusal the Lead's insertion produces`) the exact string the
 * one-line insertion into `lockArtifact` will surface, so the two cannot drift apart.
 *
 * ⚠ WHAT THIS FILE CANNOT PROVE, stated rather than implied: that `lockArtifact` CALLS the gate. That
 * call site is `src/runtime.ts`, which is owned by the other agent, so the insertion is reported as a
 * diff instead of applied. What is proven here is every part of the decision — the predicate, its
 * three failure branches, its phase scoping, its refusal wording, its PRECEDENCE against the lint
 * gate, and the writer that satisfies it — so the insertion is the only unproven step left.
 *
 * ⚠ AND THE ASSERTIONS ARE BUILT TO FAIL. The "declared but not written" case uses the CITATION SHAPE
 * a run that never wrote its memory produces — the router line and nothing else, which is what
 * `tests/compliant-artifact.ts`'s phase-8 `## Affected Memory Docs` section carried until the harness
 * began WRITING the shard it declares. If the gate were satisfied by prose, or by a cited path, or by
 * the router file everyone already names, that assertion would pass vacuously. It must not.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { lintMemoryDoc, lintMemoryPlane, MEMORY_REQUIRED_FIELDS } from '../src/ts-lint.ts'
import {
  MEMORY_DOC_LOCATIONS,
  MEMORY_PLANE_PREFIX,
  MEMORY_PROVENANCE_FIELD,
  PHASE8_MEMORY_ARTIFACT,
  PHASE8_MEMORY_SECTION,
  PHASE8_MEMORY_WRITE_RULE,
  getArtifactRequiredSections,
  phase8MemoryWriteRuleFor,
  phaseBaselineRules,
  phaseLintRulesMessage,
  phaseRulesFor,
  withPhaseBaseline,
} from '../src/phase-rules.ts'
import {
  PHASE8_ARTIFACT,
  memoryDocProblems,
  memoryDocProvenance,
  memoryDocRelativePath,
  parseMemoryListField,
  phase8MemoryEvidence,
  phase8MemoryLockRefusal,
  phase8MemoryRefusal,
  phase8MemoryRefs,
  renderGroupShard,
  sanitizeMemorySlug,
  writeMemoryDoc,
  writeRunMemory,
  type MemoryDocSpec,
} from '../src/training.ts'
import type { TrainingGroup } from '../src/training.ts'
import { coerceAskToDecision, evaluateToolGuard } from '../src/enforcement.ts'
import { evaluateToolPolicy, resolveToolPolicy } from '../src/policy-globs.ts'
import { lockHashFromContent, getLockStatus, getPrerequisiteBlockers, PHASE_SEQUENCE } from '../src/lock.ts'
import { laterPhaseContent, requirementsContent } from '../src/init-templates.ts'
import { pendingWork } from '../src/status.ts'
import type { ToolPolicyContext } from '../src/policy-globs.ts'

const RUN_ID = 'r1'
const OTHER_RUN = 'r2'

const tempRoots: string[] = []
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), 'rm-t40-' + tag + '-'))
  tempRoots.push(root)
  return root
}

interface Run {
  root: string
  runDir: string
}

/**
 * A run tree with ALL TWELVE artifacts on disk, as `recursive_init` scaffolds them — the same shape
 * `tests/strict-run-tree.spec.ts` builds, rebuilt here rather than imported because a spec file is not
 * a fixture module and reaching into a spec another agent owns is exactly the collision to avoid.
 */
function scaffoldRun(root: string = tempRoot('run')): Run {
  const runDir = join(root, '.recursive', 'run', RUN_ID)
  mkdirSync(runDir, { recursive: true })
  for (const name of PHASE_SEQUENCE) {
    const content = name === '00-requirements.md' ? requirementsContent(RUN_ID) : laterPhaseContent(RUN_ID, name)
    writeFileSync(join(runDir, name), content, 'utf8')
  }
  return { root, runDir }
}

/** A REAL lock, then verified through `getLockStatus` so a hand-written digest cannot fake progress. */
function lockOnDisk(run: Run, name: string): void {
  const path = join(run.runDir, name)
  const body = readFileSync(path, 'utf8')
  const header = 'Status: LOCKED\nLockedAt: ' + new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\nLockHash: ' + '0'.repeat(64) + '\n'
  const hash = lockHashFromContent(header + body)
  writeFileSync(path, header.replace('0'.repeat(64), hash) + body, 'utf8')
  expect(getLockStatus(path), 'precondition: ' + name + ' must be lock-valid').toBe('LOCKED')
}

/** `00`-`07` locked and `08-memory-impact.md` still DRAFT: the phase-8 baseline is in force. */
function phaseEightRun(): Run {
  const run = scaffoldRun()
  for (const name of PHASE_SEQUENCE) {
    if (name === PHASE8_ARTIFACT) continue
    lockOnDisk(run, name)
  }
  return run
}

/** `00`-`06` locked and `07-state-update.md` DRAFT: a late phase that owes NO memory write. */
function phaseSevenRun(): Run {
  const run = scaffoldRun()
  for (const name of PHASE_SEQUENCE) {
    if (name === PHASE8_ARTIFACT || name === '07-state-update.md') continue
    lockOnDisk(run, name)
  }
  return run
}

/** A doc spec that is valid by construction, so each test varies exactly ONE thing. */
function spec(overrides: Partial<MemoryDocSpec> = {}): MemoryDocSpec {
  return {
    kind: 'episode',
    runId: RUN_ID,
    slug: 'the-run-that-never-wrote-its-memory',
    title: 'The run that never wrote its memory',
    scope: 'What a phase-8 artifact claimed while the memory plane stayed untouched.',
    body: 'Three runs locked phase 8 and the plane still held only the bootstrap placeholders.',
    tags: ['phase8', 'memory'],
    validatedAtCommit: 'written-by-run-' + RUN_ID,
    lastValidated: '2026-10-10T00:00:00Z',
    ...overrides,
  }
}

/**
 * Every MARKDOWN file under a directory, relative and sorted — the TREE, not a returned list.
 * Directories are filtered out (a recursive listing reports them too, and "the directory exists" is not
 * a write), and temp leftovers are still visible because the filter is on `.md` only for the files.
 */
function treeOf(dir: string): string[] {
  if (!existsSync(dir)) return []
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.md') || entry.includes('.tmp-'))
    .sort()
}

/** Lint a doc's TEXT through the plane's own entry point, by materialising it the way the plane sees it. */
function lintText(root: string, relativePath: string, content: string): [number, number] {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return lintMemoryDoc(path)
}

/* -------------------------------------------------------------------------- */
/* THE RULE — phase 8 names the write, and only phase 8 does                   */
/* -------------------------------------------------------------------------- */

describe('T40 — the phase-8 memory write is a RULE, not a TODO line', () => {
  it('is attached to the phase-8 artifact and to nothing else', () => {
    expect(phase8MemoryWriteRuleFor(PHASE8_MEMORY_ARTIFACT)).not.toBeNull()
    for (const other of ['07-state-update.md', '06-decisions-update.md', '03-implementation-summary.md', '00-requirements.md']) {
      expect(phase8MemoryWriteRuleFor(other), other + ' owes no memory write').toBeNull()
    }
  })

  it('rides the CANONICAL section list instead of breaking parity with it', () => {
    // `SECTION_MAP` is byte-parity with the canonical linter and `tests/phase-rules.parity.spec.ts`
    // pins all twelve lists, so the requirement rides a section the template ALREADY scaffolds:
    // `## Affected Memory Docs`. If this ever needed a NEW section, that would be a parity break.
    const sections = getArtifactRequiredSections(PHASE8_MEMORY_ARTIFACT)
    expect(sections).toContain(PHASE8_MEMORY_SECTION)
    expect(sections.filter((section) => section === PHASE8_MEMORY_SECTION).length).toBe(1)
  })

  it('reaches the agent through PhaseRules — the object `recursive_phase` spreads into its payload', () => {
    const rules = phaseRulesFor(PHASE8_MEMORY_ARTIFACT)
    expect(rules.memoryWrite).toEqual(PHASE8_MEMORY_WRITE_RULE)
    expect(phaseRulesFor('03-implementation-summary.md').memoryWrite).toBeNull()
    // The rule names the three things a caller cannot guess: the plane, the section, the provenance field.
    expect(rules.memoryWrite?.plane).toBe(MEMORY_PLANE_PREFIX)
    expect(rules.memoryWrite?.section).toBe(PHASE8_MEMORY_SECTION)
    expect(rules.memoryWrite?.provenanceField).toBe(MEMORY_PROVENANCE_FIELD)
    expect(rules.memoryWrite?.alwaysAvailable).toContain('memory/episodes/')
  })

  it('is named in the once-per-phase pre-step reminder, and in no other phase’s', () => {
    const phaseEight = phaseLintRulesMessage(PHASE8_MEMORY_ARTIFACT)
    expect(phaseEight).toContain('Memory write (phase 8, HARD)')
    expect(phaseEight).toContain(MEMORY_PLANE_PREFIX)
    expect(phaseEight).toContain(MEMORY_PROVENANCE_FIELD)
    // The other phase messages are untouched by the new line — the requirement is scoped, not noise
    // injected into every phase's reminder. (The existing r5-parity assertions are `toContain`-only,
    // which is why this is additive rather than a rewrite.)
    for (const other of ['03-implementation-summary.md', '07-state-update.md']) {
      expect(phaseLintRulesMessage(other)).not.toContain('Memory write (phase 8, HARD)')
    }
    expect(phaseLintRulesMessage('03-implementation-summary.md')).toContain('Changes Applied')
  })

  it('pins the artifact name against the one the training surface already uses', () => {
    // Two constants, one artifact: if either drifted, the trigger would read a different run document
    // than the gate refuses to lock.
    expect(PHASE8_MEMORY_ARTIFACT).toBe('08-memory-impact.md')
    expect(PHASE8_ARTIFACT).toBe(PHASE8_MEMORY_ARTIFACT)
  })
})

/* -------------------------------------------------------------------------- */
/* THE WRITE SURFACE — atomic, provenance-carrying, idempotent, refusing to guess */
/* -------------------------------------------------------------------------- */

describe('T40 — the write surface produces docs the memory plane ACCEPTS', () => {
  it('renders a doc that the linter’s own memory-doc rule passes', () => {
    const root = tempRoot('lint')
    const path = memoryDocRelativePath('episode', spec().slug)
    expect(path).toBe('.recursive/memory/episodes/the-run-that-never-wrote-its-memory.md')
    const written = writeMemoryDoc(root, spec())
    expect(written.code).toBe('WRITTEN')
    expect(written.written).toBe(true)
    // The REAL rule, not a re-implementation of it: `lint_memory_doc` is what the plane runs.
    expect(lintMemoryDoc(join(root, written.path))).toEqual([0, 0])
    // And the nine fields the linter demands are all present, read from the doc itself.
    const text = readFileSync(join(root, written.path), 'utf8')
    for (const field of MEMORY_REQUIRED_FIELDS) expect(text, 'field ' + field).toMatch(new RegExp('^' + field + ':', 'm'))
    expect(text).toContain('Type: `episode`')
    expect(text).toContain('Status: `CURRENT`')
    expect(text).toContain('# The run that never wrote its memory')
  })

  it('passes the whole PLANE lint, not only the per-doc rule', () => {
    const root = tempRoot('plane')
    const result = writeRunMemory(root, RUN_ID, [spec()])
    expect(result.reason).toContain('wrote 1 memory doc(s)')
    // `lint_memory_plane` walks the tree and FAILs a doc with a bad header; a writer that produced one
    // would be a writer that breaks the plane it exists to fill.
    const [failCount] = lintMemoryPlane(root)
    expect(failCount).toBe(0)
  })

  it('never leaves a temp file behind, and never writes on a refusal', () => {
    const root = tempRoot('atomic')
    writeMemoryDoc(root, spec())
    // Atomic = temp-then-rename. A leftover `.tmp-` file would mean the rename never completed, which
    // is the state a reader must never see.
    expect(treeOf(join(root, '.recursive', 'memory')).filter((name) => name.includes('.tmp-'))).toEqual([])
    expect(treeOf(join(root, '.recursive', 'memory'))).toEqual(['episodes/the-run-that-never-wrote-its-memory.md'])

    // ⚠ AND THE REFUSAL PATH WRITES NOTHING AT ALL — asserted against the TREE, because a result
    // object can claim zero writes while a file exists.
    const otherRoot = tempRoot('atomic-refusal')
    const refused = writeMemoryDoc(otherRoot, spec({ slug: '  ' }))
    expect(refused.code).toBe('INVALID')
    expect(refused.written).toBe(false)
    expect(treeOf(otherRoot)).toEqual([])
    const empty = writeMemoryDoc(otherRoot, spec({ body: '   ' }))
    expect(empty.code).toBe('INVALID')
    expect(empty.reason).toContain('not memory')
    expect(treeOf(otherRoot)).toEqual([])
  })

  it('stamps provenance, and reads it back with EXACT run matching', () => {
    const root = tempRoot('provenance')
    const result = writeMemoryDoc(root, spec())
    const text = readFileSync(join(root, result.path), 'utf8')
    expect(memoryDocProvenance(text)).toEqual([RUN_ID])
    // A substring match would let `r1` be satisfied by `r10`, which is a write by a DIFFERENT run.
    expect(memoryDocProvenance(text)).not.toContain('r10')
    expect(parseMemoryListField(text, 'Tags')).toEqual(['phase8', 'memory'])
    expect(parseMemoryListField(text, 'Owns-Paths')).toEqual([])
  })

  it('is IDEMPOTENT for the same run: a re-run of phase 8 changes no byte', () => {
    const root = tempRoot('idempotent')
    const first = writeMemoryDoc(root, spec())
    const before = readFileSync(join(root, first.path), 'utf8')
    const second = writeMemoryDoc(root, spec())
    expect(second.code).toBe('UNCHANGED')
    expect(second.written).toBe(false)
    expect(second.reason).toContain('no-op')
    expect(readFileSync(join(root, second.path), 'utf8')).toBe(before)
  })

  it('lets the SAME run correct its own doc, keeping every earlier contributor', () => {
    const root = tempRoot('self-update')
    writeMemoryDoc(root, spec({ priorRuns: ['r0'] }))
    const updated = writeMemoryDoc(root, spec({ body: 'Corrected: the plane was untouched, and the box was ticked anyway.' }))
    expect(updated.code).toBe('UPDATED')
    expect(updated.written).toBe(true)
    const text = readFileSync(join(root, updated.path), 'utf8')
    expect(text).toContain('Corrected:')
    expect(memoryDocProvenance(text)).toEqual(['r1', 'r0'])
  })

  it('REFUSES another run’s shard rather than overwriting its evidence', () => {
    const root = tempRoot('refuse')
    const theirs = writeMemoryDoc(root, spec({ runId: OTHER_RUN }))
    const before = readFileSync(join(root, theirs.path), 'utf8')
    const mine = writeMemoryDoc(root, spec())
    expect(mine.code).toBe('REFUSED')
    expect(mine.written).toBe(false)
    expect(mine.reason).toContain(OTHER_RUN)
    expect(mine.reason).toContain('supersede')
    // BYTE-IDENTICAL: the refusal is the guarantee, and the bytes are the proof of it.
    expect(readFileSync(join(root, theirs.path), 'utf8')).toBe(before)
  })

  it('supersedes only when asked, and ARCHIVES the previous revision instead of deleting it', () => {
    const root = tempRoot('supersede')
    const theirs = writeMemoryDoc(root, spec({ runId: OTHER_RUN, body: 'What the earlier run learned.' }))
    const previous = readFileSync(join(root, theirs.path), 'utf8')
    const mine = writeMemoryDoc(root, spec({ body: 'What this run adds.' }), { supersede: true })
    expect(mine.code).toBe('WRITTEN')
    expect(mine.archived).not.toBeNull()
    expect(mine.archived).toContain('memory/archive/')
    // The archive holds the PREVIOUS revision byte-for-byte, and it still declares who wrote it.
    expect(readFileSync(join(root, mine.archived ?? ''), 'utf8')).toBe(previous)
    expect(memoryDocProvenance(readFileSync(join(root, mine.archived ?? ''), 'utf8'))).toEqual([OTHER_RUN])
    // The shard itself now carries BOTH runs: supersede, never erase.
    expect(memoryDocProvenance(readFileSync(join(root, mine.path), 'utf8'))).toEqual([RUN_ID, OTHER_RUN])
  })

  it('sanitises a slug that is not a name, so no write can land outside the plane', () => {
    expect(sanitizeMemorySlug('../../etc/passwd')).toBe('etc-passwd')
    expect(sanitizeMemorySlug('a/b\\c')).toBe('a-b-c')
    expect(sanitizeMemorySlug('.hidden')).toBe('hidden')
    expect(sanitizeMemorySlug('03-x.md')).toBe('03-x')
    expect(memoryDocRelativePath('episode', '../../escape')).toBe('.recursive/memory/episodes/escape.md')
    // A slug that sanitises to nothing is INVALID rather than written somewhere surprising.
    expect(memoryDocRelativePath('episode', '..')).toBeNull()
    expect(memoryDocRelativePath('episode', '///')).toBeNull()
  })

  it('refuses a doc the linter would reject, and says which field', () => {
    const problems = memoryDocProblems('Type: `nonsense`\nStatus: `MAYBE`\n\n# x\n')
    expect(problems.join('\n')).toContain('missing required memory metadata field(s)')
    expect(problems.join('\n')).toContain("Type 'nonsense'")
    expect(problems.join('\n')).toContain("Status 'MAYBE'")
  })

  it('gives every location the plane accepts a Type the plane accepts', () => {
    // A location whose Type the linter rejects would make the writer produce invalid docs by design,
    // and a location outside `.recursive/memory/` would put the plugin's memory somewhere the plane
    // lint does not look — which is the defect this table exists to prevent.
    for (const [kind, location] of Object.entries(MEMORY_DOC_LOCATIONS)) {
      expect(location.dir.startsWith(MEMORY_PLANE_PREFIX), kind + ' must be in the plane').toBe(true)
      expect(['domain', 'pattern', 'incident', 'episode', 'index'], kind).toContain(location.type)
    }
  })
})

describe('T40 — writeRunMemory writes the docs AND registers them', () => {
  it('writes, refreshes the PLANE registry, and replaces a shard’s line instead of duplicating it', () => {
    const root = tempRoot('registry')
    mkdirSync(join(root, '.recursive', 'memory'), { recursive: true })
    writeFileSync(join(root, '.recursive', 'memory', 'MEMORY.md'), '# MEMORY.md\n', 'utf8')

    const first = writeRunMemory(root, RUN_ID, [spec()])
    expect(first.writes).toEqual(['.recursive/memory/episodes/the-run-that-never-wrote-its-memory.md'])
    expect(first.registry?.code).toBe('WRITTEN')
    expect(first.registry?.path).toBe('.recursive/memory/MEMORY.md')
    const registry = readFileSync(join(root, '.recursive', 'memory', 'MEMORY.md'), 'utf8')
    expect(registry).toContain('- `.recursive/memory/episodes/the-run-that-never-wrote-its-memory.md` — task type: episode')
    expect(registry.split('\n').filter((line) => line.includes('the-run-that-never-wrote-its-memory')).length).toBe(1)

    // A second call with a second doc adds exactly one more line — never a second line for the first.
    const second = writeRunMemory(root, RUN_ID, [spec({ slug: 'second-lesson' })])
    expect(second.writes).toEqual(['.recursive/memory/episodes/second-lesson.md'])
    const after = readFileSync(join(root, '.recursive', 'memory', 'MEMORY.md'), 'utf8')
    expect(after.split('\n').filter((line) => line.includes('the-run-that-never-wrote-its-memory')).length).toBe(1)
    expect(after.split('\n').filter((line) => line.includes('second-lesson')).length).toBe(1)
  })

  it('registers into the PLANE, and never writes the trigger’s older registry beside it', () => {
    const root = tempRoot('registry-legacy')
    // The training trigger's seam joins `memory/…` onto the WORKSPACE root, so a workspace can hold a
    // registry there. It is READ — its lines are carried forward so a previous call site's index is not
    // silently discarded — and it is never written to: two registries in one workspace would be two
    // answers to "what does this plane hold".
    mkdirSync(join(root, 'memory'), { recursive: true })
    const legacy = '# Legacy\n\n- `memory/domains/lock.md` — task type: winner-only\n'
    writeFileSync(join(root, 'memory', 'MEMORY.md'), legacy, 'utf8')

    const result = writeRunMemory(root, RUN_ID, [spec()])
    expect(result.writes).toHaveLength(1)
    expect(readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8')).toBe(legacy)
    const registry = readFileSync(join(root, '.recursive', 'memory', 'MEMORY.md'), 'utf8')
    expect(registry).toContain('`memory/domains/lock.md` — task type: winner-only')
    expect(registry).toContain('.recursive/memory/episodes/the-run-that-never-wrote-its-memory.md')
  })

  it('stamps the run from the CALL, so a spec cannot claim another run’s write', () => {
    const root = tempRoot('stamp')
    writeRunMemory(root, RUN_ID, [spec({ runId: OTHER_RUN })])
    const text = readFileSync(join(root, '.recursive', 'memory', 'episodes', 'the-run-that-never-wrote-its-memory.md'), 'utf8')
    expect(memoryDocProvenance(text)).toEqual([RUN_ID])
  })

  it('writes NOTHING — not even a registry line — when every doc is refused', () => {
    const root = tempRoot('nothing')
    const result = writeRunMemory(root, RUN_ID, [])
    expect(result.writes).toEqual([])
    expect(result.registry).toBeNull()
    expect(result.reason).toContain('always available')
    expect(treeOf(root)).toEqual([])

    const refused = writeRunMemory(root, RUN_ID, [spec({ body: '' })])
    expect(refused.writes).toEqual([])
    expect(refused.registry).toBeNull()
    expect(refused.reason).toContain('NOTHING was written')
    expect(treeOf(root)).toEqual([])
  })
})

describe('T40 — the training trigger’s own shards stop failing the plane they write to', () => {
  /** A group spanning two runs — the minimum the trigger will train on at all. */
  const group: TrainingGroup = {
    subsystem: 'policy',
    runs: 2,
    mode: 'winner-only',
    items: [
      { runId: 'r1', paths: ['src/policy.ts'], text: 'the narrowing was dropped' },
      { runId: 'r2', paths: ['src/policy.ts'], text: 'the narrowing held' },
    ],
  }

  it('renders a group shard the memory-plane lint accepts, naming both runs', () => {
    const root = tempRoot('shard')
    const content = renderGroupShard(group, { lastValidated: '2026-10-10T00:00:00Z' })
    expect(lintText(root, 'memory/domains/policy.md', content)).toEqual([0, 0])
    expect(memoryDocProvenance(content)).toEqual(['r1', 'r2'])
    // The learnings themselves are untouched by the header: the extraction is not what was wrong.
    expect(content).toContain('# Learnings: policy')
    expect(content).toContain('- [r1] the narrowing was dropped')
  })
})

/* -------------------------------------------------------------------------- */
/* THE GATE — the three branches, and the exact refusal                        */
/* -------------------------------------------------------------------------- */

describe('T40 — the phase-8 gate refuses a run that has not written its memory', () => {
  it('branch 1: the artifact declares no path under the plane at all', () => {
    const root = tempRoot('branch1')
    const evidence = phase8MemoryEvidence(root, RUN_ID, '## Affected Memory Docs\n\n- nothing was promoted this run.\n')
    expect(evidence.ok).toBe(false)
    expect(evidence.declared).toEqual([])
    expect(evidence.reason).toContain('declares no path under ' + MEMORY_PLANE_PREFIX)
  })

  it('branch 2: the artifact declares a path that does not exist — a declaration is not a write', () => {
    const root = tempRoot('branch2')
    const artifactText = '## Affected Memory Docs\n\n- `.recursive/memory/episodes/' + RUN_ID + '.md` — promoted this run.\n'
    const evidence = phase8MemoryEvidence(root, RUN_ID, artifactText)
    expect(evidence.ok).toBe(false)
    expect(evidence.declared).toEqual(['.recursive/memory/episodes/' + RUN_ID + '.md'])
    expect(evidence.existing).toEqual([])
    expect(evidence.reason).toContain('none of them exists')
  })

  it('branch 3: the doc EXISTS but this run did not write it — a run that only CITED the plane', () => {
    const root = tempRoot('branch3')
    mkdirSync(join(root, '.recursive', 'memory'), { recursive: true })
    writeFileSync(join(root, '.recursive', 'memory', 'MEMORY.md'), '# MEMORY.md\n', 'utf8')
    // ⚠ THE LINE `tests/compliant-artifact.ts`'S PHASE-8 BODY USED TO CARRY, kept here as the negative
    // case: the fixture now declares — and WRITES — the episode shard its run owns, and this line is what
    // a run that only reviewed the router produces. It cites the PLANE, it names an EXISTING file, and it
    // is still not a write: a gate that accepted this would be satisfied by every run that ever mentions
    // MEMORY.md.
    const compliantLine = '## Affected Memory Docs\n\n- `/.recursive/memory/MEMORY.md` — the router: reviewed, and no shard needed a change for this run.\n'
    const evidence = phase8MemoryEvidence(root, RUN_ID, compliantLine)
    expect(evidence.existing).toEqual(['.recursive/memory/MEMORY.md'])
    expect(evidence.written).toEqual([])
    expect(evidence.ok).toBe(false)
    expect(evidence.reason).toContain('citing a shard this run did not write is not a write')
  })

  it('branch 4: a shard written by ANOTHER run does not satisfy this one', () => {
    const root = tempRoot('branch4')
    writeMemoryDoc(root, spec({ runId: OTHER_RUN }))
    const artifactText = '## Affected Memory Docs\n\n- `.recursive/memory/episodes/the-run-that-never-wrote-its-memory.md`\n'
    const evidence = phase8MemoryEvidence(root, RUN_ID, artifactText)
    expect(evidence.existing).toHaveLength(1)
    expect(evidence.written).toEqual([])
    expect(evidence.ok).toBe(false)
    expect(evidence.reason).toContain('naming run ' + RUN_ID)
  })

  it('PASSES once the run has written a declared doc — the surface satisfies the gate end to end', () => {
    const root = tempRoot('passes')
    const result = writeRunMemory(root, RUN_ID, [spec()])
    const artifactText = '## Affected Memory Docs\n\n' + result.writes.map((path) => '- `' + path + '` — written by this run.').join('\n') + '\n'
    const evidence = phase8MemoryEvidence(root, RUN_ID, artifactText)
    expect(evidence.ok).toBe(true)
    expect(evidence.written).toEqual(result.writes)
    expect(evidence.reason).toContain(MEMORY_PROVENANCE_FIELD + ' naming ' + RUN_ID)
    expect(phase8MemoryRefusal(root, RUN_ID, artifactText)).toBeNull()
  })

  it('recognises both spellings a model writes, and nothing that is not the plane', () => {
    const artifactText = [
      '`/.recursive/memory/episodes/a.md`',
      '`.recursive/memory/domains/b.md`',
      '`memory/patterns/c.md`',
      '`/tmp/elsewhere/memory/episodes/d.md`',
      '`src/memory.ts`',
    ].join('\n')
    expect(phase8MemoryRefs(artifactText)).toEqual([
      '.recursive/memory/domains/b.md',
      '.recursive/memory/episodes/a.md',
      '.recursive/memory/patterns/c.md',
    ])
  })

  it('is PHASE-SCOPED, and a missing artifact is not its refusal', () => {
    const root = tempRoot('scoped')
    scaffoldRun(root)
    // Some other phase's lock is none of this gate's business...
    expect(phase8MemoryLockRefusal(root, RUN_ID, '07-state-update.md')).toBeNull()
    // The scaffolded phase-8 artifact EXISTS, so the gate speaks — and it refuses, because a scaffold
    // that has written no memory declares none.
    expect(existsSync(join(root, '.recursive', 'run', RUN_ID, PHASE8_ARTIFACT))).toBe(true)
    expect(phase8MemoryLockRefusal(root, RUN_ID, PHASE8_ARTIFACT)).not.toBeNull()
    // ...and an ABSENT phase-8 artifact belongs to `lockArtifact`'s own earlier refusal, not to a
    // sentence about memory, which would replace a true diagnosis with a misleading one.
    rmSync(join(root, '.recursive', 'run', RUN_ID, PHASE8_ARTIFACT))
    expect(phase8MemoryLockRefusal(root, RUN_ID, PHASE8_ARTIFACT)).toBeNull()
  })

  it('the refusal the Lead’s insertion produces names the FAULT, the RULE and the REMEDY', () => {
    // ⚠ THIS STRING IS THE CONTRACT WITH THE INSERTION. `lockArtifact` throws it verbatim, so it is
    // pinned here: a refusal that only says "no memory doc" leaves an agent to guess a nine-field
    // format, which is how this requirement became a ticked box in the first place.
    const root = tempRoot('message')
    const run = scaffoldRun(root)
    const refusal = phase8MemoryLockRefusal(root, RUN_ID, PHASE8_ARTIFACT)
    expect(refusal).not.toBeNull()
    expect(refusal).toContain('locking ' + PHASE8_ARTIFACT + ' requires this run to have WRITTEN a doc under ' + MEMORY_PLANE_PREFIX)
    expect(refusal).toContain('memory/episodes/' + RUN_ID + '.md is always available')
    expect(refusal).toContain('`## ' + PHASE8_MEMORY_SECTION + '`')
    expect(refusal).toContain('`' + MEMORY_PROVENANCE_FIELD + ': ' + RUN_ID + '`')
    expect(refusal).toContain('then retry the lock')
    // And it is non-null for exactly the artifact whose lock it guards, through the real run tree.
    expect(join(run.root, '.recursive', 'run', RUN_ID, PHASE8_ARTIFACT)).toBe(join(run.runDir, PHASE8_ARTIFACT))
  })
})

/* -------------------------------------------------------------------------- */
/* THE INSERTION POINT — precedence, composed from the REAL chain              */
/* -------------------------------------------------------------------------- */

describe('T40 — where the gate belongs in lockArtifact’s refusal chain', () => {
  /**
   * `lockArtifact`'s refusals, in the order it applies them, composed from the SAME functions it
   * calls: prerequisite blockers, then quiescence (`pendingWork`), then the memory gate, then the
   * lint gate. This mirror exists because the real chain lives in an owned file; what it proves is
   * the ORDER, which is the part of the design that a later edit could quietly change.
   */
  function firstRefusal(run: Run, artifact: string): string | null {
    const blockers = getPrerequisiteBlockers(run.runDir, artifact)
    if (blockers.length > 0) return 'monotonic lock-order: ' + blockers.map((blocker) => blocker.artifact + ' (' + blocker.status + ')').join(', ')
    const inFlight = pendingWork(run.runDir)
    if (inFlight.length > 0) return 'PENDING_WORK: ' + inFlight.map((entry) => entry.detail).join('; ')
    const memory = phase8MemoryLockRefusal(run.root, RUN_ID, artifact)
    if (memory !== null) return memory
    return null
  }

  it('keeps LOCK ORDER first: an out-of-order run reports ordering, not memory', () => {
    const run = scaffoldRun()
    // Nothing is locked, so `00-requirements.md` HAS blockers — and its memory state is irrelevant.
    const refusal = firstRefusal(run, '08-memory-impact.md')
    expect(refusal).toContain('monotonic lock-order')
    expect(refusal).not.toContain('requires this run to have WRITTEN')
  })

  it('fires BEFORE the lint gate, so a below-standard artifact reports the memory it is missing', () => {
    const run = phaseEightRun()
    // The scaffolded phase-8 artifact IS below standard (TODO unchecked, gates FAIL), so the lint gate
    // would refuse it too — and the memory refusal is what a caller must see, because it is the one
    // the run can act on with a write it has not made.
    const artifactText = readFileSync(join(run.runDir, PHASE8_ARTIFACT), 'utf8')
    expect(artifactText).toMatch(/Coverage: FAIL/)
    expect(firstRefusal(run, PHASE8_ARTIFACT)).toContain('requires this run to have WRITTEN')
  })

  it('stops refusing once the run has written its memory and declared it', () => {
    const run = phaseEightRun()
    const written = writeRunMemory(run.root, RUN_ID, [spec()])
    const artifactPath = join(run.runDir, PHASE8_ARTIFACT)
    const body = readFileSync(artifactPath, 'utf8')
    writeFileSync(
      artifactPath,
      body.replace(
        '## ' + PHASE8_MEMORY_SECTION,
        '## ' + PHASE8_MEMORY_SECTION + '\n\n' + written.writes.map((path) => '- `' + path + '` — written by this run.').join('\n'),
      ),
      'utf8',
    )
    expect(firstRefusal(run, PHASE8_ARTIFACT)).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* MODE SEMANTICS — strict permits the write; advisory warns, never blocks      */
/* -------------------------------------------------------------------------- */

describe('T40 — strict versus advisory, and what the carve-out does NOT widen', () => {
  const policyContext = (run: Run, target: string): ToolPolicyContext => ({
    args: { file_path: target, content: 'x' },
    runDir: run.runDir,
    runId: RUN_ID,
    worktreeRoot: run.root,
  })

  it('at phase 8 STRICT allows the memory plane and still denies everything else outside the run tree', () => {
    const run = phaseEightRun()
    const policy = withPhaseBaseline(resolveToolPolicy(run.root), PHASE8_MEMORY_ARTIFACT)
    const allowed = ['.recursive/memory/episodes/' + RUN_ID + '.md', '.recursive/memory/MEMORY.md', '.recursive/memory/skills/patterns/x.md', join(run.root, '.recursive', 'memory', 'domains', 'x.md')]
    for (const target of allowed) {
      const decision = evaluateToolPolicy(policy, 'write', { file_path: target, content: 'x' }, policyContext(run, target))
      expect(decision.kind, 'target ' + target + ': ' + decision.reason).toBe('allow')
    }
    const denied = ['src/something.ts', join(run.root, 'src', 'something.ts'), 'README.md', '.recursive/DECISIONS.md', '.recursive/STATE.md']
    for (const target of denied) {
      const decision = evaluateToolPolicy(policy, 'write', { file_path: target, content: 'x' }, policyContext(run, target))
      expect(decision.kind, 'target ' + target + ' must stay denied').toBe('deny')
      expect(decision.reason).toContain('documentation phase')
    }
    // The run's own artifact is still writable — the old rule's one legitimate case, unchanged.
    const artifact = '.recursive/run/' + RUN_ID + '/' + PHASE8_ARTIFACT
    expect(evaluateToolPolicy(policy, 'write', { file_path: artifact, content: 'x' }, policyContext(run, artifact)).kind).toBe('allow')
  })

  it('leaves phases 6 and 7 exactly as they were: the memory plane is still denied there', () => {
    const run = phaseSevenRun()
    const policy = withPhaseBaseline(resolveToolPolicy(run.root), '07-state-update.md')
    for (const target of ['.recursive/memory/episodes/' + RUN_ID + '.md', '.recursive/memory/MEMORY.md']) {
      const decision = evaluateToolPolicy(policy, 'write', { file_path: target, content: 'x' }, policyContext(run, target))
      expect(decision.kind, 'phase 7 must still deny ' + target).toBe('deny')
      // Either of phase 7's own rules may be the one that fires (the memory-plane rule is the more
      // specific statement about this path, the run-tree rule the general one) — what matters is that
      // the path is refused, by a rule that says WHY.
      expect(decision.reason).toMatch(/writes no memory plane|documentation phase/)
    }
    // The carve-out is phase-8-only, asserted at the rule level too, so a future widening is caught
    // even if the guard's precedence changed.
    const sevenRules = phaseBaselineRules('07-state-update.md').filter((rule) => rule.pattern === 'write*')
    expect(sevenRules.length).toBe(2)
    const eightRules = phaseBaselineRules(PHASE8_MEMORY_ARTIFACT).filter((rule) => rule.pattern === 'write*')
    expect(eightRules.length).toBe(1)
  })

  it('never lets an UNRESOLVABLE target through the carve-out', () => {
    // ⚠ THE CARVE-OUT IS THE PERMISSIVE BRANCH, so it must fail closed: a path the rules cannot place
    // is not a memory path. Asserted on the RULE'S OWN predicate, because that is where the decision
    // is made — the guard around it only relays the verdict.
    const run = phaseEightRun()
    const rules = withPhaseBaseline(resolveToolPolicy(run.root), PHASE8_MEMORY_ARTIFACT).rules.filter((rule) => rule.pattern === 'write*')
    expect(rules).toHaveLength(1)
    const predicate = rules[0].predicate
    expect(typeof predicate).toBe('function')
    const args = { file_path: '.recursive/memory/episodes/' + RUN_ID + '.md' }
    // Placeable, and under the plane: this rule abstains (the write is not ITS business to deny).
    expect(predicate?.('write', args, { args, runDir: run.runDir, runId: RUN_ID, worktreeRoot: run.root })).toBeNull()
    // The SAME path with no worktree root cannot be placed at all, so the rule still DENIES it: the
    // carve-out never swallows a target it cannot resolve. (A relative path with no root is exactly
    // the shape that made FIX 2 necessary, so this is not a hypothetical.)
    expect(predicate?.('write', args, { args, runDir: run.runDir, runId: RUN_ID })).toEqual({ verdict: 'deny' })
  })

  it('under ADVISORY the guard WARNS rather than blocking, for the write it now permits', () => {
    const run = phaseEightRun()
    const memory = evaluateToolGuard({ name: 'write', arguments: { file_path: '.recursive/memory/episodes/' + RUN_ID + '.md', content: 'x' } }, run.root, RUN_ID, 'advisory')
    expect(memory.kind).toBe('allow')
    // And the source write it refuses under strict is NOT blocked by advisory: the guard answers `ask`,
    // and the caller's ask→decision bridge turns that into an allow carrying the warning. Asserted
    // through the bridge rather than trusted, because "advisory warns" is only true if it reaches the
    // caller as a warning.
    const source = evaluateToolGuard({ name: 'write', arguments: { file_path: 'src/something.ts', content: 'x' } }, run.root, RUN_ID, 'advisory')
    expect(source.kind).not.toBe('deny')
    expect(source.kind).toBe('ask')
    const bridged = coerceAskToDecision(source, 'advisory')
    expect(bridged.kind).toBe('allow')
    expect(bridged.kind === 'allow' ? bridged.warn ?? '' : '').toBeTruthy()
  })
})
