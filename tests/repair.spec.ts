import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapScaffold } from '../src/bootstrap.ts'

/**
 * R3 (run 09): partial-scaffold REPAIR. A workspace that predates the full
 * scaffold (only .recursive/memory/ + .recursive/run/ + user files) must be
 * repaired to the complete canonical TS tree WITHOUT touching run/ or user
 * content, and WITHOUT introducing .py/.ps1 (TS-only scaffold).
 */
describe('R3 — partial-scaffold repair (upsert semantics, TS-only)', () => {
  it('repairs a dsh-righthand-style partial scaffold (memory/run only) to the full TS tree', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repair-'))
    try {
      // partial scaffold: memory/ (with a user shard) + run/ + a user file
      mkdirSync(join(repo, '.recursive', 'memory', 'patterns'), { recursive: true })
      writeFileSync(join(repo, '.recursive', 'memory', 'patterns', 'user-pattern.md'), '# user pattern\nkeep me\n', 'utf8')
      mkdirSync(join(repo, '.recursive', 'run', '01-demo'), { recursive: true })
      writeFileSync(join(repo, '.recursive', 'run', '01-demo', '02-to-be-plan.md'), '# in-flight plan\n', 'utf8')
      writeFileSync(join(repo, 'user-note.md'), 'user root file\n', 'utf8')

      const result = bootstrapScaffold(repo)

      // missing control-plane files added
      for (const rel of [
        '.recursive/RECURSIVE.md', '.recursive/AGENTS.md', '.recursive/STATE.md', '.recursive/DECISIONS.md',
        '.recursive/memory/MEMORY.md', '.recursive/memory/skills/SKILLS.md',
        '.recursive/config/recursive-router.json',
        '.codex/AGENTS.md', '.agent/PLANS.md', '.cursorrules', 'CLAUDE.md', '.github/copilot-instructions.md',
      ]) {
        expect(existsSync(join(repo, rel)), rel).toBe(true)
      }
      // ⚠ AND `.recursive/scripts/` IS DELIBERATELY NOT REPAIRED INTO EXISTENCE. The scaffold used to
      // create it EMPTY while two shipped documents pointed into it; the repair path must not put the
      // trap back, so this asserts the absence rather than the presence it used to require.
      expect(existsSync(join(repo, '.recursive', 'scripts'))).toBe(false)

      // user content untouched
      expect(readFileSync(join(repo, '.recursive', 'memory', 'patterns', 'user-pattern.md'), 'utf8')).toContain('keep me')
      expect(readFileSync(join(repo, '.recursive', 'run', '01-demo', '02-to-be-plan.md'), 'utf8')).toContain('in-flight plan')
      expect(readFileSync(join(repo, 'user-note.md'), 'utf8')).toContain('user root file')
      // pre-existing run dir content untouched; only .gitkeep is added
      expect(result.created.filter(c => c.startsWith('.recursive/run/'))).toEqual(['.recursive/run/.gitkeep'])
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('removes stale .py from an existing workspace .recursive/scripts/, then the emptied directory', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repair-'))
    try {
      // stale python-era scripts dir
      mkdirSync(join(repo, '.recursive', 'scripts'), { recursive: true })
      writeFileSync(join(repo, '.recursive', 'scripts', 'lint-recursive-run.py'), 'print(1)\n', 'utf8')
      writeFileSync(join(repo, '.recursive', 'scripts', 'recursive-status.ps1'), 'Write-Host x\n', 'utf8')

      bootstrapScaffold(repo)

      // stale .py/.ps1 removed (bootstrap does not copy them; the repair path
      // drops python-era artifacts so the scaffold is TS-only) …
      expect(existsSync(join(repo, '.recursive', 'scripts', 'lint-recursive-run.py'))).toBe(false)
      expect(existsSync(join(repo, '.recursive', 'scripts', 'recursive-status.ps1'))).toBe(false)
      // … AND the directory goes with them once it is empty. Leaving it behind is the same trap the
      // scaffold used to create: a documented-but-gone script path, with a directory to make it look real.
      expect(existsSync(join(repo, '.recursive', 'scripts'))).toBe(false)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('leaves a .recursive/scripts/ directory that still holds the USER’s own files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repair-'))
    try {
      mkdirSync(join(repo, '.recursive', 'scripts'), { recursive: true })
      writeFileSync(join(repo, '.recursive', 'scripts', 'lint-recursive-run.py'), 'print(1)\n', 'utf8')
      writeFileSync(join(repo, '.recursive', 'scripts', 'my-own-helper.mjs'), 'export const keep = true\n', 'utf8')

      bootstrapScaffold(repo)

      // The cleanup deletes .py/.ps1 and NOTHING else, and a directory it did not empty is the user's.
      expect(existsSync(join(repo, '.recursive', 'scripts', 'lint-recursive-run.py'))).toBe(false)
      expect(readFileSync(join(repo, '.recursive', 'scripts', 'my-own-helper.mjs'), 'utf8')).toContain('keep')
      expect(existsSync(join(repo, '.recursive', 'scripts'))).toBe(true)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('is idempotent: a second repair changes nothing and preserves user content', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repair-'))
    try {
      mkdirSync(join(repo, '.recursive', 'run', '01-demo'), { recursive: true })
      writeFileSync(join(repo, '.recursive', 'run', '01-demo', '00-requirements.md'), 'keep\n', 'utf8')
      const first = bootstrapScaffold(repo)
      const second = bootstrapScaffold(repo)
      expect(first.created.length).toBeGreaterThan(0)
      expect(second.created.length).toBe(0)
      expect(readFileSync(join(repo, '.recursive', 'run', '01-demo', '00-requirements.md'), 'utf8')).toBe('keep\n')
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })

  it('does not create .py/.ps1 files anywhere in a fresh scaffold', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repair-'))
    try {
      bootstrapScaffold(repo)
      const walk = (dir: string): string[] => {
        const out: string[] = []
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name)
          if (e.isDirectory()) out.push(...walk(full))
          else out.push(full)
        }
        return out
      }
      const files = walk(repo)
      expect(files.some(f => f.endsWith('.py'))).toBe(false)
      expect(files.some(f => f.endsWith('.ps1'))).toBe(false)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
})
