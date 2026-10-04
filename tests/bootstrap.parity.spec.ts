import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { bootstrapScaffold } from '../src/bootstrap.ts'

const GOLDEN = fileURLToPath(new URL('./fixtures/golden-bootstrap', import.meta.url))

/** Walk a dir, returning plugin-relative posix paths + byte content. */
function walkTree(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { visit(full); continue }
      if (!entry.isFile()) continue
      const rel = relative(root, full).split(sep).join('/')
      out.set(rel, readFileSync(full))
    }
  }
  visit(root)
  return out
}

describe('R3/R2 — canonical scaffold parity (bootstrap vs TS-only golden)', () => {
  let repo: string

  beforeAll(() => {
    // The golden fixture is the TS-only bootstrapScaffold output (R2: no
    // vendored .py/.ps1; 27 files). bootstrapScaffold must reproduce it
    // byte-for-byte.
    const golden = walkTree(GOLDEN)
    expect(golden.size).toBe(27)
    for (const [rel] of golden) {
      expect(rel.endsWith('.py'), rel).toBe(false)
      expect(rel.endsWith('.ps1'), rel).toBe(false)
    }
  })

  it('bootstraps the FULL TS-only tree (27 files, byte-identical to golden)', () => {
    repo = mkdtempSync(join(tmpdir(), 'bootstrap-parity-'))
    try {
      const result = bootstrapScaffold(repo)
      expect(result.bootstrapped).toBe(true)
      expect(result.created.length).toBeGreaterThan(0)

      const got = walkTree(repo)
      const golden = walkTree(GOLDEN)
      const missing: string[] = []
      const diffs: string[] = []
      for (const [rel, gbytes] of golden) {
        if (!got.has(rel)) { missing.push(rel); continue }
        const pbytes = got.get(rel)!
        if (pbytes.length !== gbytes.length || !pbytes.equals(gbytes)) {
          diffs.push(rel + ' (' + pbytes.length + ' vs ' + gbytes.length + ' B)')
        }
      }
      expect(missing).toEqual([])
      expect(diffs).toEqual([])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('writes RECURSIVE.md marker-wrapped (canonical 110,543 B body)', () => {
    repo = mkdtempSync(join(tmpdir(), 'bootstrap-parity-'))
    try {
      bootstrapScaffold(repo)
      const content = readFileSync(join(repo, '.recursive', 'RECURSIVE.md'), 'utf8')
      expect(content.startsWith('# RECURSIVE.md\n\n<!-- RECURSIVE-MODE-CANONICAL:START -->')).toBe(true)
      expect(content.endsWith('<!-- RECURSIVE-MODE-CANONICAL:END -->\n')).toBe(true)
      expect(Buffer.byteLength(content, 'utf8')).toBe(110543)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('writes the cross-tool bridges (codex AGENTS, plans, memory pointers, gitignore)', () => {
    repo = mkdtempSync(join(tmpdir(), 'bootstrap-parity-'))
    try {
      bootstrapScaffold(repo)
      for (const rel of [
        '.codex/AGENTS.md',
        '.agent/PLANS.md',
        '.cursorrules',
        'CLAUDE.md',
        '.github/copilot-instructions.md',
        '.gitignore',
        '.recursive/AGENTS.md',
        '.recursive/STATE.md',
        '.recursive/DECISIONS.md',
        '.recursive/memory/MEMORY.md',
        '.recursive/memory/skills/SKILLS.md',
        '.recursive/config/recursive-router.json',
      ]) {
        expect(existsSync(join(repo, rel)), rel).toBe(true)
      }
      expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('/.recursive/config/recursive-router-discovered.json')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('scaffold .recursive/scripts/ is TS-only (no .py/.ps1)', () => {
    repo = mkdtempSync(join(tmpdir(), 'bootstrap-parity-'))
    try {
      bootstrapScaffold(repo)
      expect(existsSync(join(repo, '.recursive', 'scripts'))).toBe(true)
      const got = walkTree(join(repo, '.recursive', 'scripts'))
      expect(got.size).toBe(0)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('is idempotent: re-run preserves user content and does not clobber marked blocks', () => {
    repo = mkdtempSync(join(tmpdir(), 'bootstrap-parity-'))
    try {
      bootstrapScaffold(repo)
      // user content outside marked blocks survives
      const statePath = join(repo, '.recursive', 'STATE.md')
      const userNote = '\n\n## User note\n\nkeep me\n'
      const stateBefore = readFileSync(statePath, 'utf8')
      const stateAfter = stateBefore + userNote
      writeFileSync(statePath, stateAfter, 'utf8')
      const second = bootstrapScaffold(repo)
      expect(second.created.length).toBe(0)
      expect(readFileSync(statePath, 'utf8')).toContain('keep me')
      // marked blocks are re-upserted without duplication
      const agents = readFileSync(join(repo, '.recursive', 'AGENTS.md'), 'utf8')
      const startCount = agents.split('<!-- RECURSIVE-MODE-AGENTS:START -->').length - 1
      expect(startCount).toBe(1)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})