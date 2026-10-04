import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveControlPlaneRoot, makeWorkspaceResolver } from '../src/workspace.ts'

function fakeWorkspaceRegistry(owned: Map<string, string>) {
  return {
    async resolveByPath(path: string) {
      const canonical = owned.get(path) ?? null
      return canonical ? { path: canonical, id: 'ws-' + canonical } : undefined
    },
    list() { throw new Error('list() must not be called (workspace-scoping invariant)') },
    get() { return undefined },
  }
}

describe('workspace.ts — resolveControlPlaneRoot (R1)', () => {
  it('resolves the control-plane root from the session cwd only', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ws-a-'))
    const b = mkdtempSync(join(tmpdir(), 'ws-b-'))
    const registry = fakeWorkspaceRegistry(new Map([[a, a], [b, b]]))
    const resolve = makeWorkspaceResolver(registry as never)
    expect(await resolve(a)).toBe(a)
    expect(await resolve(b)).toBe(b)
  })

  it('returns null for an unregistered cwd (defer, never fail hard)', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ws-a-'))
    const registry = fakeWorkspaceRegistry(new Map())
    const resolve = makeWorkspaceResolver(registry as never)
    expect(await resolve(a)).toBeNull()
  })

  it('never calls list() (two-workspace isolation)', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ws-a-'))
    const b = mkdtempSync(join(tmpdir(), 'ws-b-'))
    let listCalled = false
    const registry = {
      async resolveByPath(path: string) {
        return path === a ? { path: a, id: 'a' } : path === b ? { path: b, id: 'b' } : undefined
      },
      list() { listCalled = true; return [] },
    }
    const resolve = makeWorkspaceResolver(registry as never)
    await resolve(a)
    await resolve(b)
    expect(listCalled).toBe(false)
  })

  it('resolves fresh per call (no long-lived global root)', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ws-a-'))
    const b = mkdtempSync(join(tmpdir(), 'ws-b-'))
    let current = a
    const registry = {
      async resolveByPath(path: string) {
        return path === current ? { path: current, id: 'x' } : undefined
      },
    }
    const resolve = makeWorkspaceResolver(registry as never)
    expect(await resolve(a)).toBe(a)
    current = b
    expect(await resolve(a)).toBeNull() // switched workspace; a no longer owned
    expect(await resolve(b)).toBe(b)
  })

  it('resolveControlPlaneRoot falls back to the session cwd when no workspaceRegistry is available (B4)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ws-x-'))
    const root = await resolveControlPlaneRoot({} as never, null, cwd)
    expect(root).toBe(cwd)
  })
})
