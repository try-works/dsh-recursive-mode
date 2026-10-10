/**
 * THE TRAINING/LEARNING SURFACE IS TYPESCRIPT-ONLY — AND THIS IS THE GUARD THAT KEEPS IT SO.
 *
 * WHY THIS FILE EXISTS. The plugin's Python runtime was rewritten in TypeScript; the DOCUMENTATION was
 * not. `CLAUDE.md` told every agent to run
 * `python .recursive/scripts/recursive-training-loader.py --repo-root . --query "<task>" …`, the canonical
 * `RECURSIVE.md` told every agent to lock with `.recursive/scripts/recursive-lock.py`, and
 * `.recursive/AGENTS.md` routed "Working on memory behavior" to that same loader. The scaffold created
 * `.recursive/scripts/` so the paths looked real — and it was EMPTY, because the plugin vendors nothing
 * into it. Measured in three live runs: the directory held 0 files, the memory plane held nothing but
 * bootstrap placeholders, and not one phase ever locked. An agent following the shipped instructions was
 * sent to a script that does not exist, which is why the owner's complaint was *"havent seen the run
 * activate the training or learning functions"*.
 *
 * ⚠ THE HALF THAT MATTERS MOST IS THE SCAFFOLD, NOT THIS REPO'S OWN DOCS. The instructions that reached
 * those runs were WRITTEN INTO THE WORKSPACE by `bootstrapScaffold` from `references/bodies/*.md` and
 * `references/bootstrap/RECURSIVE.md`. Fixing this repo's checked-in copies would have left every future
 * workspace with the same broken instruction, so the first assertion below BUILDS a workspace with the
 * real scaffolder and reads what it produced.
 *
 * ⚠ AND IT IS A GUARD, NOT A GREP OF THE WORD "python". The corrected documents say the plugin has no
 * Python — a fact a reader needs. What is forbidden is naming a script to RUN: an interpreter invocation,
 * or a `.py`/`.ps1` path inside a `scripts/` directory. Those two shapes are what an agent acts on.
 *
 * ⚠ NON-VACUITY IS ASSERTED, TWICE: the predicate is shown to CATCH a planted invocation, and the scans
 * are shown to have read a real number of files. A docs guard whose scan silently matched nothing would
 * pass forever while every document drifted.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { bootstrapScaffold } from '../src/bootstrap.ts'
import { MEMORY_KINDS } from '../src/memory.ts'
import { ALL_VERBS } from '../src/commands.ts'
import { RecursiveRuntime } from '../src/runtime.ts'
import { createRecursivePhaseTool } from '../src/recursive_phase.tool.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readRepo(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** Every file under a repo-relative directory, repo-relative and posix-separated. */
function walkRepo(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name
    if (entry.isDirectory()) out.push(...walkRepo(rel))
    else out.push(rel)
  }
  return out
}

/** What a `files` entry expands to: the entry itself when it names a FILE, its tree when it names a dir. */
function shippedEntry(entry: string): string[] {
  return statSync(join(ROOT, entry)).isDirectory() ? walkRepo(entry) : [entry]
}

/** Every file under an absolute directory, absolute paths. */
function walkTree(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTree(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * The two shapes a document can use to send an agent to a script that is not there.
 *
 * ⚠ NARROW ON PURPOSE, and the narrowness is documented rather than assumed: a guard on the WORD
 * "python" would fail the corrected documents, which say — correctly, and because a reader needs to know
 * it — that this plugin has no Python. A guard on the bare filename would fail the design records that
 * quote the reference implementation's script names as a measurement. What no shipped document may do is
 * tell a reader to RUN one.
 */
const FORBIDDEN_REFS: { name: string; re: RegExp }[] = [
  { name: 'an interpreter invocation of a script', re: /\bpython3?\s+[^\s`'"]*\.(?:py|ps1)/i },
  { name: 'a script path inside a scripts/ directory', re: /scripts[\\/][^\s`'"]*\.(?:py|ps1)/i },
]

/** The offending find, or null. Exported to the test below so non-vacuity is proven on the SAME rule. */
function forbiddenRef(text: string): { name: string; match: string } | null {
  for (const { name, re } of FORBIDDEN_REFS) {
    const match = re.exec(text)
    if (match !== null) return { name, match: match[0] }
  }
  return null
}

/** Every offending line of one document, so a failure names the file AND the sentence. */
function offendingLines(path: string, text: string): string[] {
  const problems: string[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const found = forbiddenRef(line)
    if (found !== null) problems.push(path + ':' + (index + 1) + ' — ' + found.name + ': ' + found.match)
  }
  return problems
}

/**
 * The documents a reader of THIS repo acts on, plus everything the PACKAGE ships as prose.
 *
 * ⚠ WHAT IS DELIBERATELY NOT SCANNED, and why the exclusion is not a hole: `PROPOSAL.md`,
 * `STRENGTHENING-PLAN.md`, `HANDOFF-review-and-opine.md`, `IMPLEMENTATION-NOTES.md` and `evidence/**` are
 * the PORT'S OWN RECORD — they describe the Python reference and the audit trail that produced this
 * rewrite, and rewriting them would be falsifying the record that explains the code. They are not
 * instructions to anyone. `TRAINING.md` and `WORKFLOW.md` ARE scanned: they describe the pipeline as it
 * is, so they carry the same obligation as the rest.
 */
const SCANNED_REPO_DOCS = [
  'README.md',
  'TRAINING.md',
  'WORKFLOW.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  '.codex/AGENTS.md',
  '.recursive/AGENTS.md',
  '.recursive/RECURSIVE.md',
  '.recursive/memory/MEMORY.md',
  '.recursive/STATE.md',
  ...walkRepo('references').filter((path) => extname(path) === '.md'),
  ...walkRepo('skills').filter((path) => extname(path) === '.md'),
  ...walkRepo('preset').filter((path) => ['.yml', '.yaml'].includes(extname(path))),
  // The GOLDEN SCAFFOLD is scaffold OUTPUT, checked in — so it carries the same obligation as the
  // templates that generate it, and this is what stops the fixture being hand-edited back to the old,
  // Python-pointing text while `bootstrap.parity` still compares against it.
  ...walkRepo('tests/fixtures/golden-bootstrap').filter((path) => ['.md', ''].includes(extname(path))),
]

describe('the scaffolded workspace docs name the TypeScript surface and no script that is not there', () => {
  it('every file bootstrap WRITES into a workspace is free of a python or scripts/ pointer', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-docs-boot-'))
    tempDirs.push(repo)
    bootstrapScaffold(repo)
    const files = walkTree(repo)
    // Non-vacuity: the scanner really read the scaffold, not an empty directory.
    expect(files.length).toBeGreaterThanOrEqual(25)
    const problems: string[] = []
    for (const file of files) {
      problems.push(...offendingLines(relative(repo, file).split(sep).join('/'), readFileSync(file, 'utf8')))
    }
    expect(problems).toEqual([])
  })

  it('the scaffolded pointer docs name the TS surfaces that CARRY the loader’s job', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-docs-boot2-'))
    tempDirs.push(repo)
    bootstrapScaffold(repo)
    // The loader is a call the agent makes, not a script it runs: `recursive_phase` injects the shards
    // that match the run and the phase, and `/recursive memory` is the same selection on demand.
    for (const rel of ['CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules', '.recursive/AGENTS.md']) {
      const text = readFileSync(join(repo, rel), 'utf8')
      expect(text, rel).toContain('recursive_phase')
    }
    expect(readFileSync(join(repo, '.recursive', 'RECURSIVE.md'), 'utf8')).toContain('`recursive_lock`')
  })

  it('and the empty .recursive/scripts/ directory itself is gone from a fresh scaffold', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-docs-boot3-'))
    tempDirs.push(repo)
    bootstrapScaffold(repo)
    // An empty directory that documents point into is the defect; with the documents repointed it would
    // merely be pointless, and pointless-but-documented is how it became a trap in the first place.
    expect(walkTree(repo).some((file) => file.includes(join('.recursive', 'scripts')))).toBe(false)
    expect(() => statSync(join(repo, '.recursive', 'scripts'))).toThrow()
  })
})

describe('this repo’s own docs and the shipped prose name no script that is not there', () => {
  it('scans a real set of documents and finds no pointer to a script', () => {
    // Non-vacuity: the guarded set is large and every member was read.
    expect(SCANNED_REPO_DOCS.length).toBeGreaterThanOrEqual(20)
    const problems: string[] = []
    for (const rel of SCANNED_REPO_DOCS) {
      problems.push(...offendingLines(rel, readRepo(rel)))
    }
    expect(problems).toEqual([])
  })

  it('the package ships no python file at all, in any of its `files` entries', () => {
    const pkg = JSON.parse(readRepo('package.json')) as { files?: string[] }
    expect(Array.isArray(pkg.files)).toBe(true)
    const shipped: string[] = []
    for (const entry of pkg.files ?? []) {
      // `files` mixes directories (`lib`, `src`) with single files (`cordis.patch.yml`), so each entry is
      // expanded by what it IS rather than assumed to be a directory.
      shipped.push(...shippedEntry(entry))
    }
    expect(shipped.length).toBeGreaterThanOrEqual(50)
    const pythons = shipped.filter((path) => ['.py', '.ps1'].includes(extname(path)))
    expect(pythons).toEqual([])
  })

  it('and `.recursive/scripts/` is not re-introduced by any shipped template', () => {
    // The directory has to be created by SOMETHING for the old instruction to look plausible. Nothing
    // creates it now, and this fails if a template grows a `noteDir('.recursive/scripts')` back.
    expect(readRepo('src/bootstrap.ts')).not.toContain("noteDir('.recursive/scripts')")
  })

  it('the parent methodology’s maintainer notes are BANNERED, not repointed command by command', () => {
    // `.recursive/README.md` is the PARENT repo's Python maintainer notes, committed here as the record of
    // the methodology this plugin ports. Repointing 200 Python commands individually would be inventing a
    // document nobody wrote; what a reader needs is to be told, first line, that none of them apply here.
    // So the banner is asserted, and the file is deliberately NOT scanned line by line.
    const notes = readRepo('.recursive/README.md')
    expect(notes.startsWith('# recursive-mode Maintainer Notes')).toBe(true)
    expect(notes).toContain('THIS FILE DESCRIBES THE PARENT')
    expect(notes).toContain('none of the commands below')
    expect(notes).toContain('no Python anywhere in the package')
  })
})

describe('the guard has teeth (asserted on the same rule the scans use)', () => {
  it('CATCHES a planted interpreter invocation and a planted scripts/ path', () => {
    const planted = 'run `python .recursive/scripts/recursive-training-loader.py --repo-root .`'
    expect(forbiddenRef(planted)?.name).toBe('an interpreter invocation of a script')
    expect(forbiddenRef('.\\scripts\\verify-locks.ps1 -RunId "x"')?.name).toBe('a script path inside a scripts/ directory')
    expect(forbiddenRef('run `python3 ./.recursive/scripts/lint-recursive-run.py`')?.name).toBe('an interpreter invocation of a script')
    // …and it does NOT fire on the corrected form, which mentions no script to run. A guard that could not
    // tell those apart would have to be switched off to ship the fix, which is how guards rot.
    expect(forbiddenRef('the `recursive_phase` tool returns the shards that match this run; there is no `.recursive/scripts/` step')).toBeNull()
  })
})

/**
 * ⚠ THE OTHER HALF OF "REACHABLE": the TS surface the documents now point AT has to exist. A document
 * that names a tool nobody registered is the same dead end as a script that is not there, one rewrite
 * later — so the names the scaffolded docs use are checked against the code, not against a list.
 */
describe('the TS surface the docs name is real', () => {
  it('registers `recursive_phase` — the loader the pointer docs now send the agent to', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rm-docs-tools-'))
    tempDirs.push(repo)
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(RecursiveRuntime, { repoRoot: repo })
      const dispose = ctx.tools.register(createRecursivePhaseTool(ctx.recursive))
      expect(ctx.tools.schemas().map((tool) => tool.name)).toContain('recursive_phase')
      dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers the `memory` verb the pointer docs now name, and `training` is a kind the loader reads', () => {
    expect(ALL_VERBS).toContain('memory')
    // The writer's own kind: `training.ts` writes `memory/training/<task-type>.md` and registers it in
    // `MEMORY.md`. With `training` absent from `MEMORY_KINDS` the loader could not see what the trigger
    // wrote, which is the loop being described rather than closed.
    expect([...MEMORY_KINDS]).toContain('training')
  })
})
