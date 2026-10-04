import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

describe('preset/recursive — R2 absolute-file-URL server surface (addendum-r4-r2-mount-resolution)', () => {
  it('has a preset.yml with id order + name', () => {
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'preset.yml'), 'utf8')
    expect(yml).toContain('name:')
    expect(yml).toContain('order:')
  })

  it('single-quotes the description so an embedded "Phase A: status" colon+space is not a YAML mapping separator', () => {
    // Live-probe-caught bug (03-implementation-summary): the description contained
    // the ASCII substring "Phase A: status" (colon+space), which js-yaml 4.x reads
    // as a nested mapping key and rejects — readPresetMetadata catches that and
    // returns {}, so the preset listed with NO name/description. Single-quoting
    // the scalar makes the whole value one string.
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'preset.yml'), 'utf8')
    const line = yml.split(/\r?\n/).find(l => l.startsWith('description:')) ?? ''
    expect(line).toMatch(/^description: '.*'$/)
  })

  it('has an agent.cordis.yml composition with tool-presentation mode both', () => {
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'agent.cordis.yml'), 'utf8')
    expect(yml).toContain('mode: both')
  })

  it('isolates the recursive realm (no root-realm leak)', () => {
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'agent.cordis.yml'), 'utf8')
    expect(yml).toContain('isolate:')
    expect(yml).toContain('recursive: true')
  })

  it('carries a SINGLE placeholder server row (commands.ts is bundled into lib/index.js)', () => {
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'agent.cordis.yml'), 'utf8')
    expect(yml).toContain("'@@RECURSIVE_SERVER_ENTRY@@'")
    // No separate commands row: install-preset.js materializes ONE absolute
    // file URL into the profile-installed lib/index.js.
    expect(yml).not.toContain('src/commands.ts')
  })

  it('does not ship a resolved subpath server entry (machine-specific URL belongs to the materializer)', () => {
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'agent.cordis.yml'), 'utf8')
    expect(yml).not.toContain('@try-works/dsh-recursive-mode/src/index.ts')
  })

  it('copies the standard surface (persona, fs, skills, goals, subagents)', () => {
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'agent.cordis.yml'), 'utf8')
    for (const token of ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-tool-subagent']) {
      expect(yml).toContain(token)
    }
  })
})
