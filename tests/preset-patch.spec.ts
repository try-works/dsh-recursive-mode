/**
 * The preset is declared TWICE in this repository, on purpose, and this spec is what keeps that honest.
 *
 * `preset/recursive/agent.cordis.yml` is the source composition the plugin has always shipped, and
 * `preset/recursive.patch.yml` is the same composition wrapped in the `- insert:` row that DSH actually reads,
 * because a preset is declared by a plugin row rather than discovered in a directory. Two files free to drift is
 * how a "working" fix silently stops matching its source, so the equality is asserted mechanically here rather
 * than trusted.
 *
 * ⚠ WHAT THESE ASSERTIONS TARGET, and why it matters: the patch carries a COMMENT BLOCK, and prose legitimately
 * mentions things a value must not contain — it explains that the loader resolves package rows from node_modules.
 * So the path checks are scoped to ROWS. The first version of this spec matched the whole file and failed on its
 * own documentation, which is a test measuring the wrong thing rather than a code defect.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const source = readFileSync(join(root, 'preset', 'recursive', 'agent.cordis.yml'), 'utf8')
const patch = readFileSync(join(root, 'preset', 'recursive.patch.yml'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dsh?: { bundle?: { patch?: unknown } }
}

/** The value rows only: comment lines removed, so prose cannot satisfy or violate a value assertion. */
const rowsOf = (text: string): string => text.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n')

describe('the preset patch agrees with its source composition', () => {
  it('carries EVERY non-empty source line, indented into the preset row', () => {
    // The ONE documented substitution: the source row names the placeholder, the patch names the package.
    const normalised = source.replace(/@@RECURSIVE_SERVER_ENTRY@@/g, '@try-works/dsh-recursive-mode')
    const missing = normalised
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .filter((line) => !patch.includes('          ' + line))
      .map((line) => line.trim().slice(0, 60))
    expect(missing, 'lines of the source composition absent from the patch').toEqual([])
  })

  it('resolves the server-entry placeholder to the PACKAGE NAME, not to a guessed absolute path', () => {
    expect(source, 'the source still carries the placeholder for the plugin row').toContain('@@RECURSIVE_SERVER_ENTRY@@')
    expect(rowsOf(patch), 'no row may leave the placeholder for the loader').not.toContain('@@RECURSIVE_SERVER_ENTRY@@')
    expect(rowsOf(patch)).toContain("name: '@try-works/dsh-recursive-mode'")
    expect(rowsOf(patch), 'no row may point at a file URL').not.toMatch(/file:\/\/\//)
    expect(rowsOf(patch), 'and no row may name a path inside node_modules').not.toMatch(/name:.*node_modules/)
  })

  it('preserves the !!js expressions rather than baking them into values', () => {
    const sourceExprs = (source.match(/!!js/g) ?? []).length
    const patchExprs = (patch.match(/!!js/g) ?? []).length
    expect(sourceExprs, 'the source composes at least one platform switch').toBeGreaterThan(0)
    expect(patchExprs, 'every source expression survives into the patch as an expression').toBe(sourceExprs)
  })

  it('declares the preset the canonical way: a row naming dsh-agent-preset', () => {
    expect(patch).toContain('- insert:')
    expect(patch).toContain("name: '@deepseek-ai/dsh-agent-preset'")
    expect(patch).toContain('id: preset-recursive')
    expect(patch).toMatch(/config:\s*\r?\n\s+id: recursive/)
  })

  it('lists the preset patch in the bundle manifest, as an ARRAY like the harness web-app bundle', () => {
    const declared = pkg.dsh?.bundle?.patch
    expect(Array.isArray(declared), 'a package that ships a preset lists patches as an array').toBe(true)
    expect(declared).toContain('./cordis.patch.yml')
    expect(declared).toContain('./preset/recursive.patch.yml')
  })
})
