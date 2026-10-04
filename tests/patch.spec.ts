import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

describe('cordis.patch.yml — R4 client-discovery shell (addendum-r4-r2-mount-resolution)', () => {
  it('mounts an ENABLED bare-name row (client discovery requires it)', () => {
    const yml = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8')
    // ClientModuleRegistry.processOne qualifies only ENABLED bare-name entries
    // (entry.fiber !== undefined && !entry.disabled). A disabled row or a
    // subpath row would permanently lose /plugins/<id>/client.js.
    expect(yml).toContain("name: '@try-works/dsh-recursive-mode'")
    expect(yml).not.toContain('disabled: true')
    expect(yml).not.toContain("name: '@try-works/dsh-recursive-mode/src/index.ts'")
  })

  it('marks the row shellOnly so the server half registers nothing globally (BUG 4)', () => {
    const yml = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8')
    expect(yml).toContain('shellOnly: true')
  })

  it('contributes NO cordis:group realm, isolate, or nested config rows (R4)', () => {
    const yml = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8')
    expect(yml).not.toContain('name: cordis:group')
    expect(yml).not.toContain('isolate:')
    expect(yml).not.toContain('recursive: true')
  })
})
