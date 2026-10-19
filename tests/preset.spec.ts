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

  /**
   * ⚠ THIS TEST USED TO ASSERT `mode: both` — the exact value that made the preset UNMOUNTABLE.
   *
   * DSH 0.2.1-rc.2 narrowed `ToolPresentationMode` to `'native' | 'ptc'`. The preset kept `mode: both`,
   * `dsh-agent-presets` rejected the whole composition at mount, and the only symptom a person saw was
   * that "recursive" was missing from the new-session preset picker — while this suite stayed GREEN because
   * it pinned the retired literal. A test that repeats a constant from the source it guards proves nothing
   * about that constant's validity.
   *
   * So it now asserts the MODE IS ONE THE HOST ACCEPTS, and that it is set explicitly rather than omitted:
   * an unparseable or absent mode fails, and the next narrowing of the union fails here instead of silently
   * unlisting the preset.
   */
  it('sets tool-presentation to a mode the host accepts (native | ptc)', () => {
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'agent.cordis.yml'), 'utf8')
    // The row's config block, ignoring comments: the `mode:` line that follows the tool-presentation row.
    const rows = yml.split(/\r?\n(?=- id: )/)
    const row = rows.find(r => r.includes("'@deepseek-ai/dsh-agent-tool-presentation'")) ?? ''
    expect(row, 'the tool-presentation row must exist').not.toBe('')
    const modeLine = row.split(/\r?\n/).find(l => /^\s+mode:/.test(l)) ?? ''
    expect(modeLine, 'the row must set mode explicitly').not.toBe('')
    const mode = modeLine.split(':')[1]?.trim()
    expect(['native', 'ptc'], `mode "${String(mode)}" is not one the host accepts`).toContain(mode)
  })

  it('isolates the recursive realm (no root-realm leak)', () => {
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'agent.cordis.yml'), 'utf8')
    expect(yml).toContain('isolate:')
    expect(yml).toContain('recursive: true')
  })

  it('carries a SINGLE placeholder server row (commands.ts is bundled into lib/index.js)', () => {
    const yml = readFileSync(join(pkgRoot, 'preset', 'recursive', 'agent.cordis.yml'), 'utf8')
    expect(yml).toContain("'@@RECURSIVE_SERVER_ENTRY@@'")
    // No separate commands row: the plugin row in preset/recursive.patch.yml names the PACKAGE, so the loader
    // resolves it from the profile node_modules and no absolute file URL is ever written.
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
